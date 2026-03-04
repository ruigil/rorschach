/**
 * Demo: Async Event Bus with Agents
 *
 * This script wires up an EventBus with middleware, creates three agents
 * (Orchestrator, Worker×2, Logger), submits a task, and shows the full
 * async event flow — including the request/reply pattern.
 *
 * Run with: bun run src/demo.ts
 */

import { EventBus, loggingMiddleware } from "./events";
import {
  OrchestratorAgent,
  WorkerAgent,
  LoggerAgent,
} from "./agents";
import type { TaskEvents } from "./agents";

// ---------------------------------------------------------------------------
// 1. Create the bus
// ---------------------------------------------------------------------------

const bus = new EventBus<TaskEvents>();

// Register logging middleware (times every event, shows trace info)
bus.use(loggingMiddleware({ verbose: false }));

// ---------------------------------------------------------------------------
// 2. Create the agents
// ---------------------------------------------------------------------------

const orchestrator = OrchestratorAgent({
  id: "orchestrator",
  name: "Orchestrator",
  bus,
});

const worker1 = WorkerAgent({
  id: "worker-1",
  name: "Worker 1",
  bus,
});

const worker2 = WorkerAgent({
  id: "worker-2",
  name: "Worker 2",
  bus,
});

const logger = LoggerAgent<TaskEvents>({
  id: "logger",
  name: "Logger",
  bus,
});

// ---------------------------------------------------------------------------
// 3. Start all agents
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  🚀 Rorschach — Async Event Bus Demo");
  console.log("=".repeat(60));
  console.log();

  await Promise.all([
    orchestrator.start(),
    worker1.start(),
    worker2.start(),
    logger.start(),
  ]);

  console.log("✓ All agents started\n");

  // -------------------------------------------------------------------------
  // 4. Submit a task — this kicks off the entire async flow
  // -------------------------------------------------------------------------

  console.log("─".repeat(60));
  console.log("  📤 Submitting task...");
  console.log("─".repeat(60));
  console.log();

  const submitEvent = await bus.emit(
    "task:submitted",
    { description: "Build a modern agentic event system", priority: 1 },
    { source: "external" },
  );

  // Give the async event flow some time to complete
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // -------------------------------------------------------------------------
  // 5. Demo: Request/Reply pattern
  // -------------------------------------------------------------------------

  console.log();
  console.log("─".repeat(60));
  console.log("  🔄 Testing request/reply: querying worker-1 status...");
  console.log("─".repeat(60));
  console.log();

  try {
    const statusReply = await bus.request<"worker:status:request", TaskEvents["worker:status:reply"]>(
      "worker:status:request",
      { workerId: "worker-1" },
      { source: "external", timeoutMs: 5_000 },
    );

    console.log(`\n📊 Worker-1 status reply:`, statusReply.payload);
  } catch (err) {
    console.error("Status request failed:", err);
  }

  // -------------------------------------------------------------------------
  // 6. Show the trace
  // -------------------------------------------------------------------------

  console.log();
  console.log("─".repeat(60));
  console.log(`  🔍 Full trace for traceId=${submitEvent.traceId.slice(0, 8)}...`);
  console.log("─".repeat(60));

  const traceEvents = logger.getTrace(submitEvent.traceId);
  for (const e of traceEvents) {
    const parent = e.parentId ? ` ← ${e.parentId.slice(0, 8)}` : " (root)";
    console.log(
      `  ${e.id.slice(0, 8)} | ${e.type.padEnd(24)} | src=${e.source.padEnd(14)}${parent}`,
    );
  }

  console.log(`\n  Total events in trace: ${traceEvents.length}`);

  // -------------------------------------------------------------------------
  // 7. Shutdown
  // -------------------------------------------------------------------------

  console.log();
  console.log("─".repeat(60));
  console.log("  🛑 Stopping agents...");
  console.log("─".repeat(60));

  await Promise.all([
    orchestrator.stop(),
    worker1.stop(),
    worker2.stop(),
    logger.stop(),
  ]);

  console.log("✓ All agents stopped");
  console.log();
}

main().catch(console.error);
