# pi-tasks — Leo's customized fork

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. This fork adds a strict completion contract: unfinished work cannot be skipped, agents receive the full task context, interrupted work remains open, newly discovered work is captured before progression, and a fully completed list is cleaned up.

Customized repository: [dantetekanem/pi-tasks](https://github.com/dantetekanem/pi-tasks)

> **Status:** Early release, customized from `@tintinweb/pi-tasks`.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/dantetekanem/pi-tasks/raw/main/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **8 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TasksDone`, `TaskOutput`, `TaskStop`, `TaskExecute` — matching Claude Code's task workflow
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts
- **System-reminder injection** — periodic `<system-reminder>` nudges injected into the upcoming LLM request (via the `context` hook, transient and never persisted) when task tools haven't been used recently (matches Claude Code's behavior exactly)
- **Strict completion contract** — the active list is treated as a spec: work proceeds in dependency/task-ID order, unfinished earlier tasks cannot be bypassed, and only an explicit `TaskExecute` batch permits parallel progression
- **Full agent context** — `TaskExecute` sends the task's description, acceptance metadata, status, ownership, dependency edges, timestamps, and complete prerequisite task records to the subagent
- **No false completion** — stopped subagents and background work return to `pending` with their partial result/error preserved instead of being marked complete
- **Discovered-work capture** — prompt guidelines require newly discovered required work to be added or connected with dependencies before moving ahead
- **Whole-list cleanup** — once every task is completed and verified, `TasksDone` removes every completed record in one call so `TaskList` returns `No tasks found`
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop
- **Subagent integration** — tasks with `agentType` can be executed as subagents via `TaskExecute` (requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)). Auto-cascade mode flows through the task DAG automatically when enabled.
- **Manual draft handoff** — `/add-task <task>` inserts a raw `[draft]` task and immediately sends it to the agent to improve before execution.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ✳ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Icon | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

### Widget display settings

How tasks are sorted and how many are shown can be configured via `/tasks` → Settings (saved to `~/.pi/tasks/tasks-config.json`). All defaults preserve the original behaviour.

| Setting | Values | Default | Behaviour |
|---------|--------|---------|-----------|
| `sortOrder` | `id` / `status` / `recent` / `oldest` | `id` | `id` = creation order; `status` groups completed → in-progress → pending; `recent`/`oldest` = by last-updated time |
| `maxVisible` | `5`–`100` | `10` | Caps how many task lines the widget shows (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | When `true`, every task is shown regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | `bottom` | When the list overflows `maxVisible`, where the `… and N more` collapse happens. `top` pairs well with `sortOrder: status` to keep active work visible and fold completed tasks away |

> Note: the widget's `status` order is completed-first (so finished work collapses at the top with `hiddenAt: top`), which is the reverse of the `TaskList` tool's pending-first order.

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `agentType` | string | no | Agent type for subagent execution (e.g., `"general-purpose"`, `"Explore"`) |
| `metadata` | object | no | Arbitrary key-value pairs |

```
→ Task #1 created successfully: Fix authentication bug
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests (agent-1)
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Blocked by: #1
Blocks: #3
```

Shows owner (if set) and open (non-completed) dependency edges. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

```
→ Updated task #1 status
→ Updated task #2 owner, status
→ Updated task #3 blocks
→ Updated task #3 blocks (warning: cycle: #3 and #1 block each other)
→ Updated task #1 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

### `TasksDone`

Clear the entire task list in one call after every task is completed and verified. The tool refuses to remove anything while a task is still pending or in progress.

```
→ Cleared 5 completed tasks. No tasks found
```

### `TaskOutput`

Retrieve output from a background task process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID or agent ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

Both task IDs and agent IDs (including partial prefixes) are accepted — agent IDs are resolved via the internal `agentTaskMap`.

### `TaskStop`

Stop a running background task process. Sends SIGTERM, waits 5 seconds, then SIGKILL. For subagent tasks, sends a stop RPC.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID or agent ID to stop |

### `TaskExecute`

Execute one or more tasks as background subagents. Requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context appended to each agent's prompt |
| `model` | string | Model override (e.g., `"sonnet"`, `"haiku"`) |
| `max_turns` | number | Max turns per agent |

Tasks must be `pending`, have `agentType` set, and all `blockedBy` dependencies `completed`. A later task is rejected while an earlier task remains unfinished. Passing multiple task IDs in the same `TaskExecute` call is the explicit opt-in for independent parallel work.

Each spawned agent receives a structured **Complete task context** section containing the full task record and full prerequisite records, plus a prominent prerequisite-result summary and the strict completion contract. This means task descriptions and metadata are agent context, not merely widget text.

With **auto-cascade** enabled (via `/tasks` → Settings), completed tasks automatically trigger execution of their unblocked dependents — flowing through the task DAG without skipping unresolved work.

## Slash commands

### `/add-task <task>`

Insert a raw next task without an interactive prompt or duplicate filtering. The task subject is stored as `[draft] <task>`, and Pi immediately sends a follow-up user message telling the agent to:

1. read the new task with `TaskGet`,
2. improve the draft subject/description with `TaskUpdate`,
3. remove the `[draft]` prefix as part of that improvement,
4. mark the task `in_progress`, execute it, and only then mark it `completed`.

If the agent is already busy, the message is queued as a follow-up.

## Task Lifecycle and completion contract

```
pending → in_progress → completed → deleted (after the whole list is verified)
             ↓
      stopped/failed → pending
```

The active task list is a completion contract:

1. Work in dependency and task-ID order; do not start a later task while an earlier task is unfinished.
2. An explicit multi-ID `TaskExecute` call is the only opt-in for parallel task progression.
3. Do not abandon the current task to move ahead. Finish it with evidence, or leave it open and continue it.
4. Add newly discovered required work before moving on, placing it after existing work or connecting it with dependencies.
5. Mark work `completed` only when its acceptance criteria and verification are satisfied. Stopping work never counts as completion.
6. After every task is completed and verified, delete the completed records so the list is empty.

Task IDs never reset.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows ALL edges, including completed blockers
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `~/.pi/tasks/sessions/<sessionId>/tasks.json` | Per-Pi-session folder — isolated between sessions, survives resume |
| `project` | `~/.pi/tasks/projects/<cwd-derived-name>.json` | Shared across all sessions in the project without writing to the project directory |

On new session start, if all persisted tasks are completed they are auto-cleared for a clean slate. On session resume, all tasks (including completed) are shown so the user can review progress. Empty session files are automatically deleted when all tasks are cleared.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared after all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`, plus the [widget display settings](#widget-display-settings) `sortOrder` / `maxVisible` / `showAll` / `hiddenAt`) are saved to `~/.pi/tasks/tasks-config.json`.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path, except paths inside `<cwd>/.pi` are redirected to `~/.pi/tasks/env/` |
| `PI_TASKS` | `./tasks.json` | Relative path stored under `~/.pi/tasks/env/` instead of the project directory |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |
| `PI_TASKS_DEBUG` | `1` | Trace RPC communication (request/reply/timeout) and spawn errors to stderr |

Named and explicit paths use a file-locked store with stale-lock detection — safe for multiple pi sessions coordinating on the same task list.

**CI example** (`.envrc`):
```bash
export PI_TASKS=off
```

**Shared team list** (`.envrc`):
```bash
export PI_TASKS=my-project
```

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Clear completed** — remove all completed tasks
- **Clear all** — remove all tasks regardless of status
- **Settings** — configure task storage, auto-cascade, auto-clear completed tasks, and [widget display](#widget-display-settings) (sort order, max visible, show all, hidden position) — saved to `tasks-config.json`

## Cross-extension Communication with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)

[`pi-tasks`](https://github.com/tintinweb/pi-tasks) communicates with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) via pi's eventbus using a scoped request/reply RPC protocol. No shared global state — just events.

### Presence Detection

Load order doesn't matter. Two handshake paths ensure detection regardless of which extension loads first:

1. **Ping on init** — [`pi-tasks`](https://github.com/tintinweb/pi-tasks) emits `subagents:rpc:ping` with a unique `requestId` and listens for `subagents:rpc:ping:reply:{requestId}`. If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is already loaded, it replies immediately.
2. **Ready broadcast** — [`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits `subagents:ready` when it initializes. If [`pi-tasks`](https://github.com/tintinweb/pi-tasks) loaded first, it picks this up.

```
┌─────────────┐                    ┌──────────────────┐
│  pi-tasks   │                    │  pi-subagents    │
└──────┬──────┘                    └────────┬─────────┘
       │                                    │
       │──── subagents:rpc:ping ───────────▶│
       │◀─── subagents:rpc:ping:reply ──────│
       │                                    │
       │◀─── subagents:ready ───────────────│  (broadcast on init)
       │                                    │
```

### Spawning Subagents

When `TaskExecute` runs, it sends a spawn RPC with a scoped reply channel:

```
pi-tasks                                pi-subagents
   │                                         │
   │── subagents:rpc:spawn ─────────────────▶│  { requestId, type, prompt, options }
   │◀─ subagents:rpc:spawn:reply:{reqId} ───│  { id }  (or { error })
   │                                         │
```

The returned `id` is stored in an in-memory `agentTaskMap` (agentId → taskId) for O(1) completion lookup. A 30-second timeout rejects the Promise if no reply arrives.

### Lifecycle Events

[`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits lifecycle events that [`pi-tasks`](https://github.com/tintinweb/pi-tasks) listens to:

| Event | Payload | Action |
|-------|---------|--------|
| `subagents:completed` | `{ id, result? }` | Mark task `completed`, trigger auto-cascade if enabled |
| `subagents:failed` | `{ id, error?, status }` | Revert task to `pending`, store error in metadata |

### Standalone Mode

If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is not installed, everything works except `TaskExecute`, which returns a friendly message explaining the agent can fall back to plain Agent-tool spawns — with the caveat that pi-tasks won't track those (status stays `pending`, auto-cascade won't fire, `TaskOutput` stays empty). All core task tools (create, list, get, update, dependencies, widget, system-reminder injection) function independently.

## Architecture

```
src/
├── index.ts            # Extension entry: 7 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── tasks-config.ts     # Config persistence (taskScope, autoCascade, autoClearCompleted) → ~/.pi/tasks/tasks-config.json
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    ├── task-widget.ts  # Persistent widget with status icons and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
