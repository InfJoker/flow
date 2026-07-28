import { query, type PermissionMode, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type {
  ActivityData,
  ChatTurnPayload,
  ExecuteStatePayload,
  PickTransitionPayload,
  SSEEvent,
} from "./types.js";

// The channel backend hands work to a Claude Code session that the user launched
// themselves, and waits for it to call back through MCP tools. This backend drives
// Claude directly instead: each state is one query() resumed onto the same Claude
// session, so context carries across states without the user launching anything.
//
// Both backends speak the same HTTP/SSE contract, so the Tauri app's execution
// engine cannot tell them apart — except that this one can also stream what the
// agent is doing as it happens, and accept a chat message into the same session.

type Emit = (event: SSEEvent) => void;

// Transition targets come from workflow JSON, which is user-authored and may
// contain anything. The schema below embeds them as enum values, so keep the
// prompt free of interpolated option text and let the schema do the constraining.
export function transitionSchema(options: { to: string }[]) {
  return {
    type: "object",
    properties: {
      next_state: { type: "string", enum: options.map((o) => o.to) },
      reason: { type: "string", description: "Why this transition fits what just happened." },
    },
    required: ["next_state", "reason"],
    additionalProperties: false,
  };
}

function formatActionLine(a: ExecuteStatePayload["actions"][number], index: number): string {
  const prefix = a.type === "prompt" ? "Prompt" : `Script (${a.shell ?? "bash"})`;
  const agent = a.agent ? ` [use the ${a.agent} subagent]` : "";
  return `${index + 1}. ${prefix}${agent}: ${a.content}`;
}

export function formatSdkExecutePrompt(payload: ExecuteStatePayload): string {
  const actionsText = payload.actions.map(formatActionLine).join("\n");
  const subagentNote = payload.subagent ? " Run these as subagents." : "";

  return (
    `Execute workflow state "${payload.stateName}" (id: ${payload.stateId}).\n\n` +
    `Actions to perform:${subagentNote}\n${actionsText}\n\n` +
    `When you have finished, summarize what you did and what you found. ` +
    `That summary is the state's result and is shown to the user.`
  );
}

const MAX_DETAIL = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_DETAIL ? flat : `${flat.slice(0, MAX_DETAIL - 1)}…`;
}

/**
 * A one-line summary of a tool call, for the activity feed.
 *
 * Deliberately lossy. The feed is glanceable narration — "what is it doing right
 * now" — not an audit log, and a full Write payload is a whole file. The fields
 * picked are the ones that identify the call at a glance.
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };

  const primary =
    pick("command", "file_path", "path", "pattern", "query", "url", "prompt", "description") ??
    // Fall back to any short string field rather than dumping JSON at the user.
    Object.values(o).find((v): v is string => typeof v === "string" && v.length < 400);

  return primary ? clip(primary) : "";
}

export class SdkBackend {
  // Claude's own session id, captured from the init message. Resuming onto it is
  // what makes state N+1 aware of state N, and it is the argument the user needs
  // for `claude --resume` to open the same run in a terminal.
  private claudeSessionId: string | undefined;
  // The engine awaits an SSE event before issuing the next call, but a stray
  // double-POST would otherwise interleave two queries onto one session. Chat
  // messages join the same chain, which is what makes them arrive in order.
  private chain: Promise<unknown> = Promise.resolve();
  // Aborting this kills the spawned Claude child. Without it, shutting the
  // server down mid-turn leaves that child running — still editing files in
  // `cwd` and spending tokens — after the user believes the run has stopped.
  private inFlight: AbortController | null = null;
  // The running query, retained only so it can be interrupted. Unlike aborting,
  // interrupting ends the turn and leaves the session resumable, which is what
  // steering a run needs.
  private currentQuery: { interrupt(): Promise<unknown> } | null = null;
  // Set by interrupt(), cleared when a turn starts. Distinguishes "the user
  // ended this turn" from "the turn failed", which read identically in the
  // result message's subtype.
  private interruptRequested = false;
  private stopped = false;
  // Bumped whenever a new run registers. Work started under an earlier
  // generation must not report anything: `broadcastSSE` stamps events with the
  // run id current at *emit* time, so a turn still in flight when the next run
  // registers would have its completion relabelled as the new run's and settle
  // that run's waiter — precisely the desync run ids exist to prevent.
  private generation = 0;

  constructor(
    private readonly emit: Emit,
    private readonly cwd: string,
    private readonly defaultModel?: string,
    // Workflow actions are model-authored and `script` actions run bash, so a
    // workflow cannot do useful work under the SDK's default deny-everything
    // posture. This stays caller-supplied rather than hardcoded permissive.
    private readonly permissionMode: PermissionMode = "acceptEdits",
    // Called the first time Claude reports its session id, so the server can
    // record it where the app can find it. Only knowable after the first turn.
    private readonly onClaudeSessionId?: (id: string) => void
  ) {}

  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  /**
   * Abort the running turn and refuse further work. Safe to call more than once,
   * and safe to call when nothing is running.
   */
  stop(): void {
    this.stopped = true;
    this.inFlight?.abort();
    this.inFlight = null;
    this.currentQuery = null;
  }

  /**
   * Abandon whatever is in flight because a new run has started.
   *
   * The Claude session itself survives — the next run resumes onto it — but the
   * previous run's turn is aborted and anything it would still have reported is
   * suppressed.
   */
  abandonRun(): void {
    this.generation++;
    this.inFlight?.abort();
    this.inFlight = null;
    this.currentQuery = null;
  }

  /**
   * End the current turn without ending the session.
   *
   * The turn stops where it is and its partial work is reported as the attempt's
   * result; the Claude session stays alive, so the next state or chat message
   * still has the full conversation behind it.
   */
  async interrupt(): Promise<void> {
    const q = this.currentQuery;
    if (!q) return;
    this.interruptRequested = true;
    try {
      await q.interrupt();
    } catch (err) {
      // An interrupt that fails must not take down the server; the turn simply
      // runs to completion and the user can stop the run instead.
      this.note(`Interrupt failed: ${String(err)}`);
    }
  }

  // Callers fire these without awaiting (see the fire-and-ack note in index.ts),
  // so a rejection here would surface as an unhandled rejection and take down the
  // process. Every failure must become an `error` SSE event instead.
  /** True once a newer run has superseded the generation `work` began under. */
  private superseded(startedAt: number): boolean {
    return this.generation !== startedAt;
  }

  private serialize(label: string, work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(
      () => work(),
      () => work()
    );
    this.chain = next.catch(() => undefined);
    return next.catch((err) => {
      // This handler is the last line of defence for an unawaited call, so it
      // must not throw either — emit writes to live sockets and can fail.
      try {
        this.emit({ type: "error", data: { message: `${label}: ${String(err)}` } });
      } catch {
        process.stderr.write(`${label} failed, and reporting it also failed: ${String(err)}\n`);
      }
    });
  }

  /** Runs `work` with a fresh abort controller registered for stop(). */
  private async withAbort(work: (signal: AbortController) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await work(controller);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /**
   * Activity is narration, never control flow. A failure to publish one must not
   * fail the turn that produced it.
   */
  private activity(data: ActivityData): void {
    try {
      this.emit({ type: "activity", data });
    } catch {
      /* the feed is best-effort by design */
    }
  }

  private note(text: string): void {
    this.activity({ attemptId: "", stateId: null, kind: "note", text });
  }

  private baseOptions(model?: string, abortController?: AbortController) {
    return {
      cwd: this.cwd,
      ...(abortController ? { abortController } : {}),
      // Load ~/.claude and .claude so workflows can name plugin-scoped agents and
      // skills (e.g. "code-review:code-reviewer") the way the channel backend does.
      settingSources: ["user", "project"] satisfies SettingSource[] as SettingSource[],
      permissionMode: this.permissionMode,
      ...(model ?? this.defaultModel ? { model: model ?? this.defaultModel } : {}),
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
    };
  }

  private captureSessionId(id: string): void {
    if (this.claudeSessionId === id) return;
    const first = this.claudeSessionId === undefined;
    this.claudeSessionId = id;
    if (first) this.onClaudeSessionId?.(id);
  }

  /**
   * Drive one Claude turn, streaming what it does as activity events.
   *
   * Shared by state execution, transition picking and chat so all three narrate
   * identically — the UI renders one timeline and does not care which produced a
   * given entry.
   *
   * Returns the turn's result message. Throws only on a genuinely failed turn.
   */
  private async runTurn(opts: {
    prompt: string;
    attemptId: string;
    stateId: string | null;
    options: Record<string, unknown>;
  }): Promise<{ result: string; structured?: unknown; deniedTools: string[]; interrupted: boolean }> {
    const { prompt, attemptId, stateId } = opts;
    let result = "";
    let structured: unknown;
    let deniedTools: string[] = [];
    let interrupted = false;

    // tool_result blocks reference a tool_use_id, not a name, so remember what
    // each id was for; otherwise the feed reports results from anonymous tools.
    const toolNames = new Map<string, string>();

    this.interruptRequested = false;
    const q = query({ prompt, options: opts.options as never });
    this.currentQuery = q as never;

    try {
      for await (const message of q as AsyncIterable<Record<string, unknown>>) {
        const type = message.type as string;

        if (type === "system" && message.subtype === "init") {
          this.captureSessionId(message.session_id as string);
        }

        if (type === "assistant") {
          const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
          for (const raw of content) {
            const block = raw as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              this.activity({ attemptId, stateId, kind: "assistant_text", text: block.text });
            } else if (block.type === "tool_use") {
              const tool = String(block.name ?? "tool");
              if (typeof block.id === "string") toolNames.set(block.id, tool);
              this.activity({
                attemptId,
                stateId,
                kind: "tool_use",
                tool,
                detail: summarizeToolInput(tool, block.input),
              });
            }
          }
        }

        // Tool results arrive as a synthetic user message.
        if (type === "user") {
          const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
          for (const raw of content) {
            const block = raw as Record<string, unknown>;
            if (block.type !== "tool_result") continue;
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            this.activity({
              attemptId,
              stateId,
              kind: "tool_result",
              tool: toolNames.get(id) ?? "tool",
              ok: block.is_error !== true,
            });
          }
        }

        if (type === "result") {
          const subtype = message.subtype as string;
          if (subtype !== "success") {
            // An interrupted turn is a user action, not a failure: report what it
            // managed to do and let the caller decide what that means. Only the
            // explicit flag distinguishes the two — the subtype does not.
            if (this.interruptRequested) {
              interrupted = true;
              result = typeof message.result === "string" ? message.result : "";
              break;
            }
            throw new Error(`Claude ended the turn with: ${subtype}`);
          }
          result = (message.result as string) ?? "";
          structured = message.structured_output;
          const denials = message.permission_denials as { tool_name: string }[] | undefined;
          if (denials?.length) {
            deniedTools = [...new Set(denials.map((d) => d.tool_name))];
          }
        }
      }
    } finally {
      if ((this.currentQuery as unknown) === (q as unknown)) this.currentQuery = null;
    }

    return { result, structured, deniedTools, interrupted };
  }

  async execute(payload: ExecuteStatePayload): Promise<void> {
    return this.serialize(`State "${payload.stateId}"`, async () => {
      // Interactive states are a human gate: the channel backend tells Claude to
      // address the user and wait for a real reply. The SDK backend drives a
      // headless Claude with no user in the loop, so it cannot honour that — and
      // completing anyway would march the workflow past the gate on a fabricated
      // answer. Refuse loudly instead.
      if (payload.interactive) {
        this.emit({
          type: "error",
          data: {
            message:
              `State "${payload.stateId}" is interactive and needs real user input, ` +
              `which the SDK backend cannot collect. Run this workflow on the channel backend.`,
          },
        });
        return;
      }

      if (this.stopped) return;

      const generation = this.generation;
      const attemptId = payload.attemptId ?? "";
      // A state's actions may each request a model; the state runs as one turn, so
      // the first explicit model wins rather than silently ignoring all of them.
      const model = payload.actions.find((a) => a.model)?.model;
      let results = "";

      try {
        await this.withAbort(async (controller) => {
          const turn = await this.runTurn({
            prompt: formatSdkExecutePrompt(payload),
            attemptId,
            stateId: payload.stateId,
            options: this.baseOptions(model, controller),
          });

          results = turn.result;

          if (turn.interrupted) {
            results += `${results ? "\n\n" : ""}(Interrupted before this step finished.)`;
          }

          // A denied tool does not mean the state failed — Claude often retries
          // by another route and succeeds. But a state whose tools were all
          // denied reports success while having done nothing, so make the
          // denials visible in the result rather than judging the outcome here.
          if (turn.deniedTools.length) {
            results +=
              `\n\n---\nPermission note: denied ${turn.deniedTools.join(", ")} ` +
              `(permissionMode="${this.permissionMode}"). ` +
              `If this state did not do what you expected, widen AGENT_FLOW_PERMISSION_MODE.`;
          }
        });
      } catch (err) {
        // A stop aborts the turn on purpose; reporting that as a channel error
        // would surface a phantom failure and, since events are buffered, poison
        // the next run.
        if (this.stopped || this.superseded(generation)) return;
        this.emit({ type: "error", data: { message: `State "${payload.stateId}": ${String(err)}` } });
        return;
      }

      // A stopped run has no listener that cares, and reporting completion would
      // walk the engine on to the next state. A superseded one is worse: the
      // event would be stamped with the *new* run's id and settle its waiter.
      if (this.stopped || this.superseded(generation)) return;

      this.emit({
        type: "action_complete",
        // Omitted rather than sent empty when the app did not supply one, so an
        // older app's events stay byte-identical to what it sent before.
        data: {
          sessionId: payload.sessionId,
          stateId: payload.stateId,
          results,
          ...(attemptId ? { attemptId } : {}),
        },
      });
    });
  }

  async transition(payload: PickTransitionPayload): Promise<void> {
    return this.serialize(`Transition from "${payload.stateId}"`, async () => {
      let picked: string | undefined;
      let reason = "";
      const generation = this.generation;
      const attemptId = payload.attemptId ?? "";

      if (this.stopped) return;

      try {
        await this.withAbort(async (controller) => {
          const turn = await this.runTurn({
            prompt:
              `You just finished workflow state "${payload.stateId}". ` +
              `Choose the transition that best matches what actually happened, ` +
              `using the descriptions attached to each option:\n` +
              payload.options.map((o) => `- ${o.to}: ${o.description}`).join("\n"),
            attemptId,
            stateId: payload.stateId,
            options: {
              ...this.baseOptions(undefined, controller),
              outputFormat: { type: "json_schema" as const, schema: transitionSchema(payload.options) },
            },
          });

          const out = turn.structured as { next_state?: string; reason?: string } | undefined;
          picked = out?.next_state;
          reason = out?.reason ?? "";
        });
      } catch (err) {
        if (this.stopped || this.superseded(generation)) return;
        this.emit({ type: "error", data: { message: `Transition from "${payload.stateId}": ${String(err)}` } });
        return;
      }

      if (this.stopped || this.superseded(generation)) return;

      // The schema constrains next_state to the offered targets, but a dropped or
      // malformed structured_output would otherwise send the engine to undefined.
      if (!picked || !payload.options.some((o) => o.to === picked)) {
        this.emit({
          type: "error",
          data: { message: `Transition from "${payload.stateId}": no valid target chosen (got ${JSON.stringify(picked)})` },
        });
        return;
      }

      this.emit({
        type: "transition_picked",
        data: {
          sessionId: payload.sessionId,
          stateId: payload.stateId,
          picked,
          reason,
          ...(attemptId ? { attemptId } : {}),
        },
      });
    });
  }

  /**
   * Deliver a user message into the same Claude session.
   *
   * Joins the same chain as state execution, so a message sent while a state is
   * running is answered once that state's turn finishes — it is never interleaved
   * into the middle of one. To be answered sooner, the caller interrupts first.
   *
   * Failures are reported on `chat_complete`, never as an `error` event: the
   * engine treats `error` as a fatal channel drop and would abort a healthy
   * workflow run because a chat message failed.
   */
  async chat(payload: ChatTurnPayload): Promise<void> {
    return this.serialize(`Chat ${payload.attemptId}`, async () => {
      if (this.stopped) return;

      const generation = this.generation;
      let result = "";
      try {
        await this.withAbort(async (controller) => {
          const turn = await this.runTurn({
            prompt: payload.text,
            attemptId: payload.attemptId,
            stateId: null,
            options: this.baseOptions(undefined, controller),
          });
          result = turn.result;
        });
      } catch (err) {
        if (this.stopped || this.superseded(generation)) return;
        this.emit({
          type: "chat_complete",
          data: { attemptId: payload.attemptId, result: "", error: String(err) },
        });
        return;
      }

      if (this.stopped || this.superseded(generation)) return;

      this.emit({ type: "chat_complete", data: { attemptId: payload.attemptId, result } });
    });
  }
}
