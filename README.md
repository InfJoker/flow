# Agent Flow

A desktop app that turns agent workflows into visual state machines. Build once, run hands-free.

![Editor with debug workflow](screenshots/02-editor.png)

**Platforms:** macOS, Linux

## The Problem

Multi-step agent tasks require constant supervision. Debug an issue? You type "fetch the issue," read the output, type "trace the root cause," evaluate, type "implement a fix," review, type "run tests" — back and forth until done. Agent Flow removes you from the loop. Define the workflow upfront, click Run, review the result.

## How It Works

You compose workflows as state machines in a visual editor. Each state holds actions — prompts or scripts — that Claude Code executes. Transitions between states carry descriptions that Claude reads to decide where to go next. Loops ("review score below 4 → go back to implement") work as regular transitions.

A channel server sits between the desktop UI and Claude, and it can drive Claude two ways. By default it bridges to a Claude Code session you launch yourself over MCP. Alternatively it drives Claude directly through the Agent SDK, with no terminal step — see [Execution backends](#execution-backends). Either way you see each state light up as it executes, read Claude's output in real time, and watch transition decisions appear.

## Installation

### Download (recommended)

Grab the latest dev build from [Releases](https://github.com/InfJoker/flow/releases/tag/dev):

- **macOS (Apple Silicon):** download the `aarch64.dmg`, open it, drag Agent Flow to Applications
- **macOS (Intel):** download the `x64.dmg`
- **Linux:** download the `.AppImage` (`chmod +x` and run) or `.deb` (`sudo dpkg -i`)

macOS 12 or later is required.

You still need the channel server to connect workflows to Claude Code:

```bash
git clone https://github.com/InfJoker/flow.git && cd flow
cd channel-server && npm install && npm run build
```

### Build from source

Requires [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) 18+.

**macOS** also needs Xcode Command Line Tools (`xcode-select --install`).

**Linux** also needs: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

```bash
git clone https://github.com/InfJoker/flow.git && cd flow

# Build the channel server
cd channel-server && npm install && npm run build && cd ..

# Run in development mode
cd app && npm install && npx tauri dev
```

For a production binary:

```bash
cd app && npx tauri build
```

## Quick Start

1. Open Agent Flow
2. Click **+ State** to add states, or load the built-in debug workflow template
3. Draw transitions by dragging between state handles
4. Click a state to edit its actions, set transition descriptions
5. Start Claude Code with the channel: `claude --dangerously-load-development-channels server:agent-flow`
6. Click **Run** in the app

## Building Workflows

### States

A state holds one or more actions. Multiple actions in a single state run in parallel.

- **Prompt actions** send instructions to Claude Code. Click *Import Skill* to pull content from your installed Claude Code skills, commands, or plugin skills.
- **Script actions** run shell commands (bash or python).

![State panel with actions and transitions](screenshots/03-state-panel.png)

Toggle **Subagents** on a state to run each prompt action as a separate Claude Code subagent. Each action gets an agent picker — choose from built-in agents (general-purpose, Explore, Plan) or any agent discovered from your installed plugins.

### Transitions

Transitions connect states. Each carries a description explaining when to take that path: "tests pass," "review score below 4," "root cause identified." After Claude finishes a state, it reads all outgoing transition descriptions and picks the best match. If nothing matches, the app pauses and asks you.

Loop-back transitions (edges pointing earlier in the flow) appear as dashed yellow lines. Forward transitions are solid blue.

### Importing Skills

Each prompt action has an *Import Skill* button. It opens a searchable picker showing everything from:

- `~/.claude/commands/` — your custom commands
- `~/.claude/plugins/cache/` — all installed plugin skills and agents

Selecting a skill appends its content to the action. You can stack multiple skills into one action.

![Skill picker modal](screenshots/04-skill-picker.png)

## The Editor

The canvas fills the screen. Click a state to open the side panel with its name, subagent toggle, actions, and transitions. Double-click the workflow name in the top bar to rename it. Click the workflow name to open the library dropdown — switch between saved workflows, create new ones, or delete old ones.

Workflows auto-save to `~/.agent-flow/workflows/`. Node positions persist, so your layout stays where you left it.

## Running Workflows

Switch to the **Run** tab. Three panels:

- **Sessions** (left) — lists active Claude Code sessions connected through the channel
- **Live Flow** (center) — the same canvas, read-only, with states colored by status: faded grey for done, blue glow for active, dashed outline for pending
- **Live Output** (right) — streams Claude's output and shows each transition decision

Controls: **Pause** holds after the current state finishes. **Stop** kills the session.

![Run view with live tracking](screenshots/05-run-view.png)

## Channel Setup

Agent Flow connects to Claude Code through an MCP channel server. Register it in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-flow": {
      "command": "node",
      "args": ["/path/to/agent-flow/channel-server/dist/index.js"]
    }
  }
}
```

Build the channel server once:

```bash
cd channel-server && npm install && npm run build
```

Then start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:agent-flow
```

The channel server picks a random port, writes a session file to `~/.agent-flow/sessions/`, and the app discovers it automatically. Multiple sessions run side by side — each gets its own port.

## Execution backends

The channel server can drive Claude two ways. Both serve the same HTTP/SSE
contract, so the app behaves identically either way.

**`channel` (default)** — what the section above sets up. The server waits for a
Claude Code session you launched to attach over MCP, and that session reports
back through tool calls. Use this when you want the workflow to run inside an
existing session's context, or when a workflow has interactive states.

**`sdk`** — the server drives Claude itself via the Agent SDK. No `.mcp.json`
entry, no special launch flag, no terminal step. It signs in with your existing
Claude Code login, so there is no API key to configure.

```bash
cd channel-server
AGENT_FLOW_BACKEND=sdk \
AGENT_FLOW_CWD=/path/to/your/project \
node dist/index.js
```

| Variable | Meaning |
| --- | --- |
| `AGENT_FLOW_BACKEND` | `channel` (default) or `sdk` |
| `AGENT_FLOW_CWD` | Directory the workflow's actions run in. Defaults to the server's working directory — set it deliberately, since this is what a run can read and write. |
| `AGENT_FLOW_MODEL` | Model override, e.g. `sonnet` |
| `AGENT_FLOW_PERMISSION_MODE` | How much the run may do without asking. Defaults to `acceptEdits`, which allows file edits but blocks shell commands — workflows with `script` actions need a broader mode. Blocked tools are noted in the state's result rather than failing it. |

The Sessions panel shows which backend a session uses and the directory it runs
in.

Two differences worth knowing. The SDK backend keeps one Claude session for the
whole run, so context carries from state to state, and it constrains transition
choices to the offered targets. It cannot run `interactive` states — those need a
human to answer, so run those workflows on the channel backend.

## Example: Debug Workflow

The built-in template demonstrates a complete debug loop:

```
Fetch Issue → Summarize → Root Cause Tracing → Review Investigation
                                    ↑                    ↓
                                    └──── needs depth ───┘
                                                         ↓ looks good
                              Implement Fix ← score < 4 ← Judge Fix Quality
                                    ↓
                              Run Tests → fail → Implement Fix
                                    ↓ pass
                                  Commit
```

Eight states, ten transitions, two convergence loops. The "Judge Fix Quality" state runs two parallel subagent reviews (code reviewer + security auditor). Claude drives the entire flow, looping until the fix meets quality standards.
