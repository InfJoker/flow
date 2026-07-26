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
