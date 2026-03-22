# Agent Flow — Design Document

## Overview

Desktop app for composing and executing agent workflows as state machines. Users visually build workflows that automate sequences of prompts they'd normally type into Claude Code manually. The app generates and runs these workflows through Claude Code's channel system.

## Core Problem

When debugging issues, reviewing code, or performing multi-step agent tasks, users manually babysit the agent — typing prompts one at a time, evaluating output, deciding next steps. Agent Flow automates this by letting users define the workflow upfront and review the final result instead of interrupting at every step.

## Data Model

```typescript
interface Workflow {
  id: string
  name: string
  description: string
  states: State[]
  transitions: Transition[]
}

interface State {
  id: string
  name: string
  subagent?: boolean
  actions?: Action[]
  subflow?: WorkflowRef
}

interface Action {
  type: "prompt" | "script"
  content: string
  agent?: string            // for prompt with subagent, e.g. "sdd:developer"
  shell?: "bash" | "python" // for script
}

interface WorkflowRef {
  workflowId: string
}

interface Transition {
  from: string
  to: string
  description: string
}
```

### Key Rules

- A state can have actions, a subflow, or both
- Multiple actions in a state run in parallel
- `subagent: true` → entire state runs in a forked Claude Code subagent
- Each action can specify which agent definition to use (when subagent is on)
- Transitions are LLM-evaluated: after a state completes, Claude sees all outgoing transition descriptions and picks one
- If no transition matches → pause and ask user via channel
- Import is a per-action UI feature that appends skill content to the action's prompt

### Execution Rules

- Each state executes once, then transitions are evaluated
- Transitions evaluated in priority order, first match wins
- Loop-backs (e.g., judge → implement) are regular transitions — the state re-executes
- No special convergence handling — loops are just conditional transitions in the graph

## Architecture

```
┌─────────────────┐     HTTP (localhost)     ┌──────────────┐
│   Tauri App     │ <───────────────────────> │  Agent Flow  │
│   (UI)          │                           │  Channel     │
└─────────────────┘                           │  Server      │
                                              └──────┬───────┘
                                                     │ stdio (MCP)
                                              ┌──────┴───────┐
                                              │  Claude Code  │
                                              └──────────────┘
```

### Channel Server (MCP)

Built as a Claude Code channel plugin following the fakechat pattern:

- Claude Code spawns it as a subprocess (`claude --channels plugin:agent-flow`)
- Declares `capabilities.experimental['claude/channel']`
- Opens an HTTP port on localhost for the Tauri app to connect
- Two-way communication via MCP:
  - **Notifications** (server → Claude): `notifications/claude/channel` with state instructions
  - **Tools** (Claude → server): `report_action_complete`, `reply`
- Events arrive in Claude as `<channel source="agent-flow" ...>` tags

### Multi-Session Support

Each Claude Code session spawns its own channel server subprocess. They can't share ports, so each instance:

1. Binds to port 0 (OS picks available port)
2. Writes session file to `~/.agent-flow/sessions/<id>.json`
3. Cleans up on exit

```typescript
interface SessionFile {
  sessionId: string
  claudeSessionId: string
  port: number
  workflowId: string
  workflowName: string
  pid: number
  startedAt: string
}
```

Tauri app watches `~/.agent-flow/sessions/` to discover and connect to active sessions.

### Two Launch Modes

1. **From app** — Tauri runs `claude --channels plugin:agent-flow`, channel starts, Tauri connects to its HTTP port
2. **From terminal** — User runs `claude --channels plugin:agent-flow` themselves, Tauri discovers via session file and connects

Both modes work the same once connected. The constraint: Claude Code must be started with `--channels plugin:agent-flow` — channels cannot be attached to running sessions.

### Execution Flow

```
Tauri App                          Claude Code
    │                                  │
    │── channel: execute_state ───────>│
    │   { state, actions }             │
    │                            (executes actions)
    │<── report_action_complete ──────│
    │   { results }                    │
    │                                  │
    │── channel: pick_transition ─────>│
    │   { options: [                   │
    │     "commit: no issues",         │
    │     "fix: issues found"          │
    │   ]}                             │
    │<── reply ───────────────────────│
    │   { picked: "commit" }           │
    │                                  │
    │  (app updates UI, next state)    │
```

If no transition matches → app pauses, asks user what to do via the UI.

## Tech Stack

- **Tauri** — Cross-platform desktop (macOS + Linux), Rust backend for file I/O and process management
- **React + TypeScript** — Frontend framework
- **React Flow (@xyflow/react)** — Node-based graph editor for workflow canvas
- **Dagre (@dagrejs/dagre)** — Automatic graph layout (left-to-right, respects edge direction)
- **TypeScript + MCP SDK** — Channel server (runs via Bun/Node as MCP subprocess)

## UI Design

### Top Bar

```
┌─────────────────────────────────────────────────────────┐
│  Agent Flow  │  [workflow name]  │ Editor | Run │ + State │ Export │ Run │
└─────────────────────────────────────────────────────────┘
```

- App logo (left)
- Workflow name in a chip (left)
- Editor/Run tab switcher (center)
- Action buttons (right): + State, Export JSON, Run workflow

### Editor View — Default (no selection)

```
┌─────────────────────────────────────────────────────────┐
│  Top Bar                                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│              React Flow Canvas (100% width)             │
│              Dagre layout: left-to-right                │
│              Nodes connected by smoothstep edges        │
│                                                         │
│  Controls (bottom-left)         MiniMap (bottom-right)  │
└─────────────────────────────────────────────────────────┘
```

Empty canvas shows centered prompt: "Start building your workflow" with "Add first state" and "Start from template" buttons.

### Editor View — State Selected

Click a state node → State View panel slides in from the right. Escape key or clicking canvas closes it.

```
┌─────────────────────────────────────────────────────────┐
│  Top Bar                                                │
├────────────────────────────────────────┬────────────────┤
│                                        │  State View    │
│     React Flow Canvas (75%)            │  [Delete] [X]  │
│                                        │                │
│                                        │  Name: [____]  │
│                                        │  [ ] Subagent  │
│                                        │                │
│                                        │  ACTIONS       │
│                                        │  ┌──────────┐  │
│                                        │  │ prompt   x│  │
│                                        │  │ [text]    │  │
│                                        │  │ Import    │  │
│                                        │  └──────────┘  │
│                                        │  + Prompt      │
│                                        │  + Script      │
│                                        │                │
│                                        │  TRANSITIONS ▾ │
│                                        │  → [target] x  │
│                                        │    [when...]   │
│                                        │  + Add         │
└────────────────────────────────────────┴────────────────┘
```

State View sections (top to bottom):
1. **Header**: "State" title, Delete button, Close (X) icon
2. **Identity**: Name input + Subagent checkbox (combined block, no separator)
3. **Actions** (primary section, takes most space):
   - Each action is a card with: type badge, shell picker (script) or agent picker (prompt+subagent), remove button, textarea, "Import Skill" button (prompt only)
   - Import Skill appends content (supports stacking multiple skills per action)
   - + Prompt / + Script buttons
4. **Transitions** (collapsible):
   - Each transition: arrow → target dropdown, remove button, description input
   - + Add button
   - Empty state: "No transitions — will ask user"

### Skill Picker Modal

Triggered per action via "Import Skill" button. Modal overlay with:
- Search input (filters by name and content)
- Grouped list: commands, agents, skills
- Each item shows name (monospace) and content preview
- Clicking an item appends its content to the action's textarea and closes

Sources scanned:
- `~/.claude/commands/*.md`
- `~/.claude/agents/*.md`
- `~/.claude/plugins/cache/*/skills/**/*.md`
- App's own saved workflows

### Run View

```
┌─────────────────────────────────────────────────────────┐
│  Top Bar (Pause, Stop)                                  │
├───────────┬──────────────────────────┬──────────────────┤
│ Sessions  │   Live Flow (read-only)  │  Live Output     │
│ (180px)   │                          │  (340px)         │
│           │   Done states: faded     │                  │
│ ● Debug   │   Active state: blue     │  State: Review   │
│   2m ago  │     glow + pulse badge   │  Claude is...    │
│           │   Pending: dashed/faded  │  Reading file... │
│ ○ Review  │                          │                  │
│   15m ago │                          │  TRANSITION      │
│           │                          │  Picked: Fix     │
│ ◦ Fix     │                          │                  │
│   1h ago  │                          │                  │
└───────────┴──────────────────────────┴──────────────────┘
```

- **Sessions sidebar**: workflow name + relative timestamp, color-coded dots (green=running, yellow=paused, grey=done)
- **Live flow**: same React Flow canvas but read-only, non-draggable. State nodes show execution status via visual styling.
- **Live output**: streaming Claude output for current state, transition decisions

### State Node Visual

```
┌─────────────────────────────┐
│  State Name    [subagent]   │  ← purple left border if subagent
├─────────────────────────────┤
│  > Prompt content preview.. │  ← blue icon for prompt
│  $ npm test           bash  │  ← green icon for script, shell badge
│  ~ subflow: lint-flow       │  ← yellow icon for subflow
│  ─── parallel (2) ───────  │  ← shown when multiple actions
└─────────────────────────────┘
```

Run status variants:
- **Done**: 50% opacity, "done" badge
- **Active**: blue border glow, pulsing "running" badge
- **Pending**: 30% opacity, dashed border

### Edge Styling

- **Forward transitions**: solid blue line, arrow marker
- **Loop-back transitions**: dashed yellow line, animated, arrow marker
- **Labels**: shortened to max 4 words on canvas. Full description editable in panel.

### Graph Layout

- Dagre layout engine, left-to-right (`rankdir: "LR"`)
- `nodesep: 80`, `ranksep: 200` for readability
- Loop-back edges routed underneath by dagre

## Export

Workflows stored as JSON internally. Export to `.md` generates a Claude Code command file that can be run independently without the app.

## Future Considerations (Not in V1)

- Script-based transitions (exit code matching, output patterns)
- Workflow marketplace / sharing
- Workflow versioning
- Variables / context passing between states
- Convergence detection (auto-stop loops)
- opencode integration
- Workflow templates library
- Undo/redo
- Keyboard shortcuts beyond Escape
