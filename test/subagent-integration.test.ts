/**
 * Tests for task-subagent integration: task_execute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances.
beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

// ---- Mock pi ----

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

/** Minimal mock ExtensionContext. */
function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

// ---- Mock subagents extension (RPC responders) ----

/** Simulates the @tintinweb/pi-subagents extension: responds to ping + spawn RPCs and emits ready. */
function installSubagentsMock(pi: { events: MockEventBus }, opts?: { spawnError?: string }) {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];
  const stopped: string[] = [];

  // Respond to ping — reply on scoped channel
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });

  // Respond to spawn — reply on scoped channel
  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId, type, prompt, options } = data as {
      requestId: string; type: string; prompt: string; options?: any;
    };
    if (opts?.spawnError) {
      pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: opts.spawnError });
      return;
    }
    const id = `agent-${++idCounter}`;
    spawned.push({ id, type, prompt, options });
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  // Respond to stop — reply on scoped channel
  const unsubStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    const known = spawned.some(s => s.id === agentId);
    if (known) {
      stopped.push(agentId);
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    } else {
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "Agent not found" });
    }
  });

  // Broadcast readiness
  pi.events.emit("subagents:ready", {});

  return {
    spawned,
    stopped,
    unsub() { unsubPing(); unsubSpawn(); unsubStop(); },
  };
}

// ---- Tests ----

describe("session-scoped storage", () => {
  let tasksDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    delete process.env.PI_TASKS;
    tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-sessions-"));
    process.env.PI_TASKS_DIR = tasksDir;
  });

  afterEach(async () => {
    delete process.env.PI_TASKS_DIR;
    const fs = await import("node:fs");
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  it("stores each Pi session in its own folder", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" }, {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "session-a" },
    });
    await mock.executeTool("task_create", { subject: "A", description: "Task A" });

    await mock.fireLifecycle("session_start", { reason: "new" }, {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "session-b" },
    });
    await mock.executeTool("task_create", { subject: "B", description: "Task B" });

    expect(fs.existsSync(path.join(tasksDir, "sessions", "session-a", "tasks.json"))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, "sessions", "session-b", "tasks.json"))).toBe(true);

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toContain("#1 [pending] B");
    expect(list.content[0].text).not.toContain("A");
  });
});

describe("/add-task", () => {
  it("creates a draft task from raw arguments and sends it to the agent", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const command = mock.commands.get("add-task");
    expect(command).toBeDefined();

    await command.handler("ship the manual task", { ...mockCtx(), isIdle: () => true });

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toContain("#1 [pending] [draft] ship the manual task");

    const task = await mock.executeTool("task_get", { taskId: "1" });
    expect(task.content[0].text).toContain("Manual draft task inserted with /add-task.");
    expect(task.content[0].text).toContain("Metadata: {\"draft\":true");

    expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Work on task #1 next."));
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Improve the task by using task_update"));
  });

  it("queues the draft task prompt as a follow-up when the agent is busy", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const command = mock.commands.get("add-task");
    await command.handler("handle this after the current turn", { ...mockCtx(), isIdle: () => false });

    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Work on task #1 next."),
      { deliverAs: "followUp" },
    );
  });

  it("does not prompt when no task text is provided", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = { ...mockCtx(), isIdle: () => true };

    const command = mock.commands.get("add-task");
    await command.handler("   ", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /add-task <task>", "error");
    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("task_execute", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    // Install mock BEFORE init so ping reply is received during extension init
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("is registered as a tool", () => {
    expect(mock.tools.has("task_execute")).toBe(true);
  });

  it("returns error when subagent extension is not loaded", async () => {
    // Re-init without mock to simulate missing extension
    const freshMock = mockPi();
    initExtension(freshMock.pi as any);

    await freshMock.executeTool("task_create", {
      subject: "Test task",
      description: "Do something",
      agentType: "general-purpose",
    });

    const result = await freshMock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
  });

  it("rejects non-existent tasks", async () => {
    const result = await mock.executeTool("task_execute", { task_ids: ["999"] });
    expect(result.content[0].text).toContain("#999: not found");
  });

  it("rejects tasks without agentType", async () => {
    await mock.executeTool("task_create", {
      subject: "No agent type",
      description: "Plain task",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: no agentType set");
  });

  it("rejects non-pending tasks", async () => {
    await mock.executeTool("task_create", {
      subject: "Already started",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "1", status: "in_progress" });

    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: not pending");
  });

  it("rejects a later task while an earlier task is unfinished", async () => {
    await mock.executeTool("task_create", {
      subject: "Earlier task",
      description: "Must finish first",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Later task",
      description: "Must not skip ahead",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("earlier tasks unfinished");
    expect(result.content[0].text).toContain("#1 [pending]");
    expect(rpc.spawned).toHaveLength(0);
  });

  it("allows an explicit parallel batch despite task ID order", async () => {
    await mock.executeTool("task_create", {
      subject: "Parallel A",
      description: "First parallel lane",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Parallel B",
      description: "Second parallel lane",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1", "2"] });
    expect(result.content[0].text).toContain("Launched 2 agent(s)");
    expect(rpc.spawned).toHaveLength(2);
  });

  it("rejects tasks with unresolved blockers", async () => {
    await mock.executeTool("task_create", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Blocked",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("task_execute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("#2: blocked by #1");
  });

  it("spawns agent for valid task and updates metadata", async () => {
    await mock.executeTool("task_create", {
      subject: "Run tests",
      description: "Run the test suite",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(result.content[0].text).toContain("#1 → agent agent-1");

    // Verify the RPC responder was called
    expect(rpc.spawned).toHaveLength(1);
    expect(rpc.spawned[0].type).toBe("general-purpose");
    expect(rpc.spawned[0].prompt).toContain("Run the test suite");
    expect(rpc.spawned[0].options.isBackground).toBe(true);
  });

  it("passes full task context, additional context, and the completion contract", async () => {
    await mock.executeTool("task_create", {
      subject: "Explore codebase",
      description: "Find all API endpoints and verify the route inventory",
      activeForm: "Exploring endpoints",
      agentType: "Explore",
      metadata: { acceptance: "Every route has evidence", source: "user" },
    });

    await mock.executeTool("task_execute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
      max_turns: 10,
    });

    const prompt = rpc.spawned[0].prompt;
    expect(prompt).toContain("## Complete task context");
    expect(prompt).toContain('"activeForm": "Exploring endpoints"');
    expect(prompt).toContain('"acceptance": "Every route has evidence"');
    expect(prompt).toContain('"blocks": []');
    expect(prompt).toContain("Focus on REST endpoints only");
    expect(prompt).toContain("The active task list is a completion contract");
    expect(prompt).toContain("Do not claim success for partial, stopped, failing, or unverified work");
    expect(rpc.spawned[0].options.maxTurns).toBe(10);
  });

  it("allows executing tasks whose blockers are all completed", async () => {
    await mock.executeTool("task_create", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Dependent",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("task_update", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("task_execute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
  });

  it("handles mixed valid and invalid tasks in one call", async () => {
    await mock.executeTool("task_create", {
      subject: "Valid",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "No agent type",
      description: "Desc",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1", "2", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("Launched 1 agent");
    expect(text).toContain("#2: no agentType set");
    expect(text).toContain("#999: not found");
  });
});

describe("task_execute via ready broadcast", () => {
  it("detects subagents when ready fires after tasks init", async () => {
    // Init tasks WITHOUT the mock — subagents not available yet
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Now install the mock (simulates subagents loading later) and broadcast ready
    const rpc = installSubagentsMock(mock.pi);

    // Create a task and execute — should work because ready was received
    await mock.executeTool("task_create", {
      subject: "Late-loaded test",
      description: "Desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(rpc.spawned).toHaveLength(1);

    rpc.unsub();
  });
});

describe("Completion listener", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("marks task completed on subagents:completed event", async () => {
    await mock.executeTool("task_create", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["1"] });

    // Simulate agent completion
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("returns intentionally stopped agent work to pending instead of completing it", async () => {
    await mock.executeTool("task_create", {
      subject: "Interrupted task",
      description: "Must remain open",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["1"] });

    mock.emitEvent("subagents:failed", {
      id: "agent-1",
      result: "Partial output",
      status: "stopped",
    });

    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
    expect(result.content[0].text).toContain("Partial output");
    expect(result.content[0].text).toContain("stopped before completion");
  });

  it("reverts task to pending on subagents:failed event", async () => {
    await mock.executeTool("task_create", {
      subject: "Failing task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["1"] });

    // Simulate agent failure
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "Out of turns", status: "error" });

    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("ignores events for unknown agent IDs", async () => {
    await mock.executeTool("task_create", {
      subject: "Unrelated",
      description: "Desc",
    });

    // Should not throw or modify anything
    mock.emitEvent("subagents:completed", { id: "unknown-agent" });
    mock.emitEvent("subagents:failed", { id: "unknown-agent", error: "boom", status: "error" });

    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });
});

describe("Auto-cascade", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("does NOT cascade when auto-cascade is off (default)", async () => {
    // Create A → B chain
    await mock.executeTool("task_create", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    // Execute A
    await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Complete A
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // B should NOT have been auto-started
    expect(rpc.spawned).toHaveLength(1);

    // B should still be pending
    const result = await mock.executeTool("task_get", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("does NOT cascade on failure (branch stops)", async () => {
    await mock.executeTool("task_create", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("task_execute", { task_ids: ["1"] });
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "crashed", status: "error" });

    // B should not start
    expect(rpc.spawned).toHaveLength(1);
    const result = await mock.executeTool("task_get", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("tasks without agentType are not cascaded even if unblocked", async () => {
    await mock.executeTool("task_create", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Manual task",
      description: "Desc",
      // No agentType — manual
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("task_execute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // Manual task should stay pending
    expect(rpc.spawned).toHaveLength(1);
  });
});


describe("Standalone operation (no subagents extension)", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(() => {
    // Init WITHOUT installSubagentsMock — no subagents extension present
    mock = mockPi();
    initExtension(mock.pi as any);
  });

  it("all core task tools are registered", () => {
    for (const name of ["task_create", "task_list", "task_get", "task_update", "tasks_done", "task_execute"]) {
      expect(mock.tools.has(name)).toBe(true);
    }
  });

  it("publishes the strict completion and cleanup contract in prompt guidelines", () => {
    const guidelines = mock.tools.get("task_create").promptGuidelines.join("\n");
    expect(guidelines).toContain("active task list is a completion contract");
    expect(guidelines).toContain("Do not start a later task while an earlier task is unfinished");
    expect(guidelines).toContain("When required work is discovered");
    expect(guidelines).toContain("task_list returns No tasks found");
  });

  it("task_create works without subagents", async () => {
    const result = await mock.executeTool("task_create", {
      subject: "Write tests",
      description: "Add unit tests for the parser",
    });
    expect(result.content[0].text).toContain("Write tests");
  });

  it("task_list works without subagents", async () => {
    await mock.executeTool("task_create", { subject: "A", description: "desc" });
    await mock.executeTool("task_create", { subject: "B", description: "desc" });
    const result = await mock.executeTool("task_list", {});
    expect(result.content[0].text).toContain("#1");
    expect(result.content[0].text).toContain("#2");
  });

  it("task_get works without subagents", async () => {
    await mock.executeTool("task_create", { subject: "Read me", description: "details here" });
    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("Read me");
    expect(result.content[0].text).toContain("details here");
  });

  it("task_update works without subagents", async () => {
    await mock.executeTool("task_create", { subject: "Update me", description: "desc" });
    await mock.executeTool("task_update", { taskId: "1", status: "in_progress" });
    const result = await mock.executeTool("task_get", { taskId: "1" });
    expect(result.content[0].text).toContain("in_progress");
  });

  it("task_update cannot move to a later task while earlier work is unfinished", async () => {
    await mock.executeTool("task_create", { subject: "First", description: "finish first" });
    await mock.executeTool("task_create", { subject: "Second", description: "do not skip" });

    const update = await mock.executeTool("task_update", { taskId: "2", status: "in_progress" });
    expect(update.content[0].text).toContain("cannot start while earlier tasks remain unfinished");
    const task = await mock.executeTool("task_get", { taskId: "2" });
    expect(task.content[0].text).toContain("Status: pending");
  });

  it("tasks_done clears a fully completed list in one call", async () => {
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });
    await mock.executeTool("task_update", { taskId: "1", status: "completed" });
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });

    const done = await mock.executeTool("tasks_done", {});
    expect(done.content[0].text).toContain("Cleared 2 completed tasks");

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toBe("No tasks found");
  });

  it("tasks_done refuses to clear unfinished tasks", async () => {
    await mock.executeTool("task_create", { subject: "Finished", description: "desc" });
    await mock.executeTool("task_create", { subject: "Still open", description: "desc" });
    await mock.executeTool("task_update", { taskId: "1", status: "completed" });

    const done = await mock.executeTool("tasks_done", {});
    expect(done.content[0].text).toContain("unfinished tasks remain");
    expect(done.content[0].text).toContain("#2 [pending]");

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toContain("#1 [completed]");
    expect(list.content[0].text).toContain("#2 [pending]");
  });

  it("task_execute gracefully refuses without subagents", async () => {
    await mock.executeTool("task_create", {
      subject: "Agent task",
      description: "desc",
      agentType: "general-purpose",
    });
    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    const text = result.content[0].text;
    expect(text).toContain("Subagent execution is currently unavailable");
    // Offers the plain Agent tool as a fallback, with the tracking caveat.
    expect(text).toContain("Agent-tool spawns");
    expect(text).toContain("won't track them");
  });

  it("subagents lifecycle events are silently ignored without mapped agents", () => {
    // These should not throw even though no subagents extension is loaded
    mock.emitEvent("subagents:completed", { id: "ghost-agent", result: "done" });
    mock.emitEvent("subagents:failed", { id: "ghost-agent", error: "boom", status: "error" });
    // No crash = pass
  });

  it("task dependencies work without subagents", async () => {
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("task_get", { taskId: "2" });
    expect(result.content[0].text).toContain("Blocked by");
    expect(result.content[0].text).toContain("#1");
  });
});

describe("RPC protocol correctness", () => {
  it("ping uses scoped reply channel (not shared channel)", () => {
    const mock = mockPi();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const origEmit = mock.pi.events.emit.bind(mock.pi.events);
    mock.pi.events.emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
      origEmit(channel, data);
    };

    initExtension(mock.pi as any);

    // Find the ping emit
    const pingEmit = emitted.find(e => e.channel === "subagents:rpc:ping");
    expect(pingEmit).toBeDefined();
    const pingData = pingEmit!.data as { requestId: string };
    expect(pingData.requestId).toBeDefined();
    expect(typeof pingData.requestId).toBe("string");
  });

  it("spawn reply cleans up listener and timer on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("task_create", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });

    await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });

    // Second spawn should get a fresh requestId (not conflict with first)
    await mock.executeTool("task_create", {
      subject: "Test 2",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["2"] });
    expect(rpc.spawned).toHaveLength(2);
    expect(rpc.spawned[0].id).not.toBe(rpc.spawned[1].id);

    rpc.unsub();
  });

  it("spawn RPC rejects on timeout when no responder exists", async () => {
    const mock = mockPi();
    // Install ping handler (for version check) but no spawn handler
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    await mock.executeTool("task_create", {
      subject: "Timeout test",
      description: "desc",
      agentType: "general-purpose",
    });

    // spawnSubagent has a 30s timeout — we'll advance timers
    vi.useFakeTimers();
    const execPromise = mock.executeTool("task_execute", { task_ids: ["1"] });
    await vi.advanceTimersByTimeAsync(31000);

    const result = await execPromise;
    expect(result.content[0].text).toContain("timeout");

    vi.useRealTimers();
  });

  it("ready broadcast sets subagentsAvailable even after init", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Initially no subagents
    await mock.executeTool("task_create", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });
    let result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");

    // Reset task status
    await mock.executeTool("task_update", { taskId: "1", status: "pending" });

    // Late subagents extension broadcasts ready
    const rpc = installSubagentsMock(mock.pi);

    result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");

    rpc.unsub();
  });

  it("spawn RPC rejects with error message from server", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi, { spawnError: "No active session" });
    initExtension(mock.pi as any);

    await mock.executeTool("task_create", {
      subject: "Err test",
      description: "desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("No active session");
  });

  it("stop RPC resolves on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Spawn a task so we have an agent to stop
    await mock.executeTool("task_create", {
      subject: "Stoppable",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    const result = await mock.executeTool("task_stop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully and returned to pending");
    expect(rpc.stopped).toContain("agent-1");
    const task = await mock.executeTool("task_get", { taskId: "1" });
    expect(task.content[0].text).toContain("Status: pending");

    rpc.unsub();
  });

  it("stop RPC returns false on error (agent not found) without throwing", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Create and execute a task, then simulate agent already gone
    await mock.executeTool("task_create", {
      subject: "Ghost",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_execute", { task_ids: ["1"] });

    // Clear spawned list so the mock's stop handler won't find the agent
    rpc.spawned.length = 0;

    // task_stop should still succeed (stopSubagent catches the error)
    const result = await mock.executeTool("task_stop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");

    rpc.unsub();
  });

  it("stop RPC returns false on timeout without throwing", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Mark subagents as available via ready broadcast, but no stop handler installed
    mock.pi.events.emit("subagents:ready", {});

    await mock.executeTool("task_create", {
      subject: "Timeout stop",
      description: "desc",
      agentType: "general-purpose",
    });
    // Manually set task as in_progress with an agentId (no spawn handler)
    await mock.executeTool("task_update", {
      taskId: "1",
      status: "in_progress",
      metadata: { agentType: "general-purpose", agentId: "ghost-agent" },
    });

    vi.useFakeTimers();
    const stopPromise = mock.executeTool("task_stop", { task_id: "1" });
    await vi.advanceTimersByTimeAsync(11000);

    // Should resolve (not throw) — stopSubagent catches timeout
    const result = await stopPromise;
    expect(result.content[0].text).toContain("stopped successfully");

    vi.useRealTimers();
  });
});

/** Install a ping-only mock with a specific protocol version (or no version for v1). */
function installVersionedMock(pi: { events: MockEventBus }, version?: number) {
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    if (version !== undefined) {
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version } });
    } else {
      // v1 handler — no envelope, no version
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {});
    }
  });
  pi.events.emit("subagents:ready", {});
  return { unsub() { unsubPing(); } };
}

describe("Protocol version mismatch", () => {
  it("matching version — no warning", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    // No warning on before_agent_start
    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("old handler (no version) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // no version = v1
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("handler ahead (v3) — warns about pi-tasks", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 3);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-tasks is outdated"),
      "warning",
    );
  });

  it("handler behind (v1) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 1);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("warning shown only once", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // v1 — triggers warning
    initExtension(mock.pi as any);

    const ctx1 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx1);
    expect(ctx1.ui.notify).toHaveBeenCalledOnce();

    const ctx2 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx2);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

describe("Widget agent ID display", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  function mockUICtx() {
    const state = {
      widgets: new Map<string, any>(),
      statuses: new Map<string, string | undefined>(),
    };
    const ctx: UICtx = {
      setWidget(key, content, options) { state.widgets.set(key, { content, options }); },
      setStatus(key, text) { state.statuses.set(key, text); },
    };
    return { ctx, state };
  }

  function mockTheme(): Theme {
    return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    };
  }

  function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
    const entry = state.widgets.get("tasks");
    if (!entry?.content) return [];
    const theme = mockTheme();
    const tui = { terminal: { columns: 200 } };
    return entry.content(tui, theme).render();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows agent ID for active agent-backed tasks", () => {
    store.create("Agent task", "Desc", "Running tests", { agentType: "general-purpose", agentId: "abc1234567890" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent abc12");
    expect(lines[1]).toContain("Running tests");
  });

  it("shows agent ID for non-active in_progress agent-backed tasks", () => {
    store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "xyz9876543210" });
    store.update("1", { status: "in_progress" });
    // NOT calling setActiveTask — simulates external agent management
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent xyz98");
    expect(lines[1]).toContain("Agent task");
  });

  it("does not show agent ID for tasks without agentId", () => {
    store.create("Manual task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent");
    expect(lines[1]).toContain("Manual task");
  });

  it("does not show agent ID for pending tasks", () => {
    store.create("Pending agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });

  it("does not show agent ID for completed tasks", () => {
    store.create("Done", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });
});

describe("Cascade data injection (buildTaskPrompt)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;
  let configDir: string;

  beforeEach(async () => {
    // Enable autoCascade via isolated config file without creating project-local .pi state.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-config-"));
    const configPath = path.join(configDir, "tasks-config.json");
    process.env.PI_TASKS_CONFIG = configPath;
    fs.writeFileSync(configPath, JSON.stringify({ autoCascade: true }));

    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Set latestCtx via turn_start lifecycle event
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(async () => {
    rpc.unsub();
    delete process.env.PI_TASKS_CONFIG;
    const fs = await import("node:fs");
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("injects prerequisite result into cascaded agent prompt", async () => {
    await mock.executeTool("task_create", {
      subject: "Task A",
      description: "Produce a result",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Task B",
      description: "Use Task A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("task_execute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "The answer is 42" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("Prerequisite task results");
    expect(bPrompt).toContain("Task #1");
    expect(bPrompt).toContain("The answer is 42");
  });

  it("keeps full dependency context while truncating the prominent result summary", async () => {
    await mock.executeTool("task_create", {
      subject: "Task A",
      description: "Produce a long result",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Task B",
      description: "Use truncated result",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("task_execute", { task_ids: ["1"] });

    const longResult = "x".repeat(5000);
    mock.emitEvent("subagents:completed", { id: "agent-1", result: longResult });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("truncated in this summary");
    expect(bPrompt).toContain(`"result": "${longResult}"`);
    expect(bPrompt).toContain('"status": "completed"');
  });

  it("handles dependencies with no stored result gracefully", async () => {
    await mock.executeTool("task_create", {
      subject: "Task A",
      description: "No result stored",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_create", {
      subject: "Task B",
      description: "Works without A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("task_execute", { task_ids: ["1"] });

    mock.emitEvent("subagents:completed", { id: "agent-1" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).not.toContain("Prerequisite task results");
  });
});
