# pi-tasks

A focused task-tracking extension for [pi](https://pi.dev). It keeps multi-step work explicit, prevents unfinished tasks from being skipped, and clears a completed list in one call.

This is Leo's customized fork.

## Tools

- `TaskCreate` — create a task
- `TaskList` — list tracked work
- `TaskGet` — inspect one task
- `TaskUpdate` — update status, ownership, metadata, or dependencies
- `TasksDone` — clear the list after every task is completed
- `TaskOutput` — read background task output
- `TaskStop` — stop background task execution
- `TaskExecute` — run eligible tasks through the pi-subagents extension

## Development

Load the extension directly:

```bash
pi -e ./src/index.ts
```

Run checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Behavior

- Work proceeds in task and dependency order.
- A task is completed only after its acceptance criteria are verified.
- Interrupted work stays open.
- Required follow-up work is added to the list before progression.
- `TasksDone` refuses cleanup while any task is pending or in progress.
