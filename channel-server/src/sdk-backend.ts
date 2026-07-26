import { query, type PermissionMode, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ExecuteStatePayload, PickTransitionPayload, SSEEvent } from "./types.js";

// The channel backend hands work to a Claude Code session that the user launched
// themselves, and waits for it to call back through MCP tools. This backend drives
// Claude directly instead: each state is one query() resumed onto the same Claude
// session, so context carries across states without the user launching anything.
//
// Both backends speak the same HTTP/SSE contract, so the Tauri app's execution
// engine cannot tell them apart.

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

export class SdkBackend {
  // Claude's own session id, captured from the init message. Resuming onto it is
  // what makes state N+1 aware of state N.
  private claudeSessionId: string | undefined;
  // The engine awaits an SSE event before issuing the next call, but a stray
  // double-POST would otherwise interleave two queries onto one session.
  private chain: Promise<unknown> = Promise.resolve();
  // Aborting this kills the spawned Claude child. Without it, shutting the
  // server down mid-turn leaves that child running — still editing files in
  // `cwd` and spending tokens — after the user believes the run has stopped.
  private inFlight: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly emit: Emit,
    private readonly cwd: string,
    private readonly defaultModel?: string,
    // Workflow actions are model-authored and `script` actions run bash, so a
    // workflow cannot do useful work under the SDK's default deny-everything
    // posture. This stays caller-supplied rather than hardcoded permissive.
    private readonly permissionMode: PermissionMode = "acceptEdits"
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
  }

  // Callers fire these without awaiting (see the fire-and-ack note in index.ts),
  // so a rejection here would surface as an unhandled rejection and take down the
  // process. Every failure must become an `error` SSE event instead.
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

      // A state's actions may each request a model; the state runs as one turn, so
      // the first explicit model wins rather than silently ignoring all of them.
      const model = payload.actions.find((a) => a.model)?.model;
      let results = "";

      try {
        await this.withAbort(async (controller) => {
        for await (const message of query({
          prompt: formatSdkExecutePrompt(payload),
          options: this.baseOptions(model, controller),
        })) {
          if (message.type === "system" && message.subtype === "init") {
            this.claudeSessionId = message.session_id;
          }
          if (message.type === "result") {
            if (message.subtype !== "success") {
              throw new Error(`Claude ended the turn with: ${message.subtype}`);
            }
            results = message.result ?? "";
            // A denied tool does not mean the state failed — Claude often retries
            // by another route and succeeds. But a state whose tools were all
            // denied reports success while having done nothing, so make the
            // denials visible in the result rather than judging the outcome here.
            if (message.permission_denials?.length) {
              const denied = [...new Set(message.permission_denials.map((d) => d.tool_name))].join(", ");
              results +=
                `\n\n---\nPermission note: denied ${denied} ` +
                `(permissionMode="${this.permissionMode}"). ` +
                `If this state did not do what you expected, widen AGENT_FLOW_PERMISSION_MODE.`;
            }
          }
        }
        });
      } catch (err) {
        this.emit({ type: "error", data: { message: `State "${payload.stateId}": ${String(err)}` } });
        return;
      }

      // A stopped run has no listener that cares, and reporting completion would
      // walk the engine on to the next state.
      if (this.stopped) return;

      this.emit({
        type: "action_complete",
        data: { sessionId: payload.sessionId, stateId: payload.stateId, results },
      });
    });
  }

  async transition(payload: PickTransitionPayload): Promise<void> {
    return this.serialize(`Transition from "${payload.stateId}"`, async () => {
      let picked: string | undefined;
      let reason = "";

      if (this.stopped) return;

      try {
        await this.withAbort(async (controller) => {
        for await (const message of query({
          prompt:
            `You just finished workflow state "${payload.stateId}". ` +
            `Choose the transition that best matches what actually happened, ` +
            `using the descriptions attached to each option:\n` +
            payload.options.map((o) => `- ${o.to}: ${o.description}`).join("\n"),
          options: {
            ...this.baseOptions(undefined, controller),
            outputFormat: { type: "json_schema" as const, schema: transitionSchema(payload.options) },
          },
        })) {
          if (message.type === "system" && message.subtype === "init") {
            this.claudeSessionId = message.session_id;
          }
          if (message.type === "result") {
            if (message.subtype !== "success") {
              throw new Error(`Claude ended the turn with: ${message.subtype}`);
            }
            const out = message.structured_output as { next_state?: string; reason?: string } | undefined;
            picked = out?.next_state;
            reason = out?.reason ?? "";
          }
        }
        });
      } catch (err) {
        this.emit({ type: "error", data: { message: `Transition from "${payload.stateId}": ${String(err)}` } });
        return;
      }

      if (this.stopped) return;

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
        data: { sessionId: payload.sessionId, stateId: payload.stateId, picked, reason },
      });
    });
  }
}
