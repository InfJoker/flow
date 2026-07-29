# Agent Flow

Visual state machine composer for Claude Code workflows. Tauri v2 desktop app.

## Project Structure

- `app/` — Tauri v2 app (React frontend + Rust backend)
- `channel-server/` — MCP channel server (TypeScript, bridges Tauri ↔ Claude Code)
- `prototype/` — Original React-only prototype (reference, not actively developed)

## Build & Run

```bash
# Channel server (build once)
cd channel-server && npm install && npm run build

# App (dev mode)
cd app && npm install && npx tauri dev

# Rust tests
cd app/src-tauri && cargo test
```

### Keep the Tauri npm and Rust versions on the same minor

`tauri build` refuses to run when the `tauri` crate and `@tauri-apps/api` differ
on major/minor, and **nothing else catches it** — `vite build`, `vitest` and
`cargo test` all pass with a mismatch. Adding any `@tauri-apps/plugin-*` can
re-resolve `@tauri-apps/api` upward and silently break the release build.

After touching Tauri dependencies, run the real thing:

```bash
cd app && npx tauri build --debug --bundles app
```

### CI

Three workflows on push to `main`: **Test** (app vitest + `tsc --noEmit`,
channel-server vitest + build, `cargo test --lib`), **Dev Release** (bundles for
three targets), and **Audit** (`npm audit --audit-level=moderate` across
`app`, `channel-server`, `prototype`).

The Rust test job deliberately skips the frontend build — `cargo test --lib`
compiles with `app/dist` absent, so installing and building the frontend for it
would be cost for nothing.

GitHub disables scheduled workflows after ~60 days of repository inactivity;
Audit had been off since June before being re-enabled. If a workflow seems not
to run, check `gh workflow list --all` before debugging its triggers.

## Architecture

The app does NOT talk to Claude Code directly. The channel server sits between them:

```
Tauri App ←HTTP/SSE→ Channel Server ←MCP stdio→ Claude Code
```

- Channel server is spawned by Claude Code (`--dangerously-load-development-channels server:agent-flow`)
- Each session gets a dynamic port, writes a session file to `~/.agent-flow/sessions/`
- Tauri discovers sessions by scanning that directory

### Execution backends

The channel server has two interchangeable backends behind the same HTTP/SSE
contract, so the app's `StateMachineEngine` is unaffected by the choice:

| `AGENT_FLOW_BACKEND` | How Claude is driven |
| --- | --- |
| `channel` (default) | Waits for a Claude Code session to attach over MCP stdio and call back via the `report_action_complete` / `pick_transition` tools |
| `sdk` | Drives Claude directly via `@anthropic-ai/claude-agent-sdk` — no manual `claude` launch, and no MCP stdio |

SDK backend env vars:

- `AGENT_FLOW_MODEL` — model override (e.g. `sonnet`)
- `AGENT_FLOW_CWD` — working directory for the spawned Claude
- `AGENT_FLOW_PERMISSION_MODE` — SDK `permissionMode`, default `acceptEdits`. Workflows with `script` actions need bash, so a stricter mode makes those states no-op; denials are appended to the state's result rather than failing it.

The SDK backend authenticates with the existing Claude Code login — no
`ANTHROPIC_API_KEY` required. It captures Claude's own session id from the first
turn and `resume`s onto it for every later state, so context carries across the
whole workflow run. Transitions use structured output with an enum constrained to
the offered target ids, which the channel backend does not validate at all.

`interactive` states are refused by the SDK backend rather than executed: they
are a human gate, and a headless turn has no user to answer it. Run those
workflows on the channel backend.

### Channel invariants

These are load-bearing and easy to break by accident — each one caused a real
hang or a corrupted run before it was fixed.

- **`/execute` and `/transition` must answer before the work finishes.** The
  engine arms its SSE waiter around the POST, and the channel backend just fires
  an MCP notification and returns. A backend that `await`s the turn inside the
  HTTP handler holds the request past the WebView's fetch timeout. Hence
  `void sdk.execute(payload)` in `index.ts`.
- **Anything fired without `await` must never reject.** An unhandled rejection
  kills the server and orphans the session file, so every failure inside
  `SdkBackend` becomes an `error` SSE event instead.
- **Events are scoped to a run.** `/register` mints a `runId` and clears the
  buffer; every event carries it; the engine drops events from other runs and
  only settles a waiter for the state it is actually awaiting. Without this a
  finished run's completion settles the next run's state. Registration failure is
  therefore fatal to a run, not best-effort.
- **Replay resumes from `Last-Event-ID`, it does not repeat.** Events carry a
  monotonic SSE `id`, so a first-time client gets the whole buffer (closing the
  gap between POST and EventSource handshake) while a reconnecting one gets only
  what it missed. Re-sending history would settle the current iteration of a
  cyclic workflow with an earlier iteration's result.
- **Activity and control events are buffered separately.** Activity outnumbers
  control events by orders of magnitude during a busy state, and one shared
  bounded buffer let a burst evict a buffered `action_complete` before the client
  attached — hanging the run on a completion that was silently dropped. Two
  buffers make that impossible by construction; ids still come from one counter,
  so replay merges them back into one ascending sequence.
- **Chat failures must never use the `error` event type.** The engine treats
  `error` as a fatal channel drop and rejects the in-flight action *and*
  transition waiters, so a failed chat message would abort a healthy run. Chat
  reports on `chat_complete`, which carries an optional `error` field.
- **Attaching is not registering.** `/register` mints a run id and clears the
  buffer. Selecting a session merely to watch it must only open the SSE stream —
  registering would destroy the transcript of the run already in flight and
  orphan whichever client was attached, since every later event then fails that
  client's run-id check.

### Projects, and how a run is launched

A **project** is a folder, stored in `~/.agent-flow/projects.json` (deliberately
not `settings.json`, which is `UpdateSettings` serialized at the top level).
It is the working directory a run reads and writes, so it is a consent surface,
not a preference — runs default to `acceptEdits`.

Pressing Run spawns a channel server on the SDK backend via `launcher.rs`. Two
details there were established by experiment and fail silently if changed:

- **Never `env_clear()` on the child.** `claude` reads its stored login from the
  macOS Keychain and that lookup needs `USER`; without it every turn fails with
  "Not logged in". `LOGNAME` and `SHELL` do not substitute.
- **Resolve `node` to an absolute path.** A Finder-launched `.app` gets
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which contains no Homebrew, nvm, fnm or
  volta directory.

Sessions are scoped to the open project by `cwd`. `pickSession` must never fall
back across folders: it previously chose the newest session anywhere on the
machine, which could hand an edit-capable Claude a directory the user never
picked.

### Attempts, not states

`ExecutionState.history` holds one record per state and is overwritten in place.
That is fine for colouring the graph and nothing else. Anything that needs to
survive a loop lives in `attempts`, which is append-only: one entry per *visit*,
each with its own activity, result and the transition that followed it. A
research loop revisiting a state five times produces five attempts; the old
model destroyed four of them.

`attemptId` is minted by the **engine**, before it POSTs, and echoed by the
server onto every event it produces. It cannot be minted server-side:
fire-and-ack routinely delivers events before the POST resolves, so only a value
the client already holds can file them. `pickTransition` must carry the state's
attempt id too, or the transition turn's activity has nothing to attach to and
is dropped.

### Claude Code interop

A run driven by the SDK backend *is* an ordinary Claude Code session. It writes
`~/.claude/projects/<mangled-cwd>/<claude-session-id>.jsonl`, and
`claude --resume <id>` reopens it with full context — including any chat sent
from the app. `SdkBackend` captures that id from the first turn's `system/init`
and it is persisted to the session file and announced as `session_meta`.

The directory name is `cwd` with every non-alphanumeric character replaced by
`-`. **That is lossy** (`/a/b` and `/a-b` collide), so `claude_sessions.rs`
confirms each transcript against the `cwd` recorded inside it rather than
trusting the directory name.

### Backend capabilities

Sessions advertise `{ activity, chat, interrupt }`. All three are false on the
channel backend: it learns nothing until Claude calls `report_action_complete`,
and owns no session to send a message into. `/chat` and `/interrupt` answer 501
there. The UI must degrade against these flags rather than rendering empty
panels that read as broken.

## Key Conventions

- Workflow IDs must be alphanumeric + hyphens + underscores (sanitized in Rust)
- Skill/agent names follow `plugin:item` format (e.g., `code-review:bug-hunter`)
- Node positions are stored on `WorkflowState.position` and persisted with the workflow
- The execution engine uses an iterative loop (not recursion) to handle cyclic workflows
- `isTauri()` from `@tauri-apps/api/core` for platform detection — static import only, no dynamic imports

## Context7 Libraries

- `/websites/v2_tauri_app` — Tauri v2
- `/websites/reactflow_dev` — React Flow
- `/websites/react_dev` — React
