/**
 * Demo: Cognitive Agent with OpenRouter Integration
 *
 * This script demonstrates the cognitive capabilities of Rorschach agents:
 *   1. Creates an OpenRouter provider
 *   2. Wires up a CognitiveAgent (ThinkerAgent) with event bus
 *   3. Shows think(), chat(), decide(), and summarize() in action
 *   4. Demonstrates LLM-powered task decomposition via events
 *
 * Prerequisites:
 *   Add your OpenRouter API key to .env:
 *     OPEN_ROUTER_API_KEY=sk-or-v1-...
 *
 * Run with:
 *   bun run src/cognitive-demo.ts
 */

import { EventBus, loggingMiddleware } from "./events";
import { WorkerAgent, LoggerAgent } from "./agents";
import {
  OpenRouterProvider,
  CognitiveAgent,
  ThinkerAgent,
} from "./cognitive";
import type { ThinkerEvents } from "./cognitive";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Bun auto-loads .env files, so OPEN_ROUTER_API_KEY is available via process.env
const API_KEY = process.env.OPEN_ROUTER_API_KEY;

if (!API_KEY) {
  console.error("❌ Missing OPEN_ROUTER_API_KEY.");
  console.error("   Add it to your .env file: OPEN_ROUTER_API_KEY=sk-or-v1-...");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Create the provider & bus
// ---------------------------------------------------------------------------

const provider = OpenRouterProvider({
  apiKey: API_KEY,
  defaultModel: "openai/gpt-4o-mini",
  appName: "Rorschach Cognitive Demo",
});

const bus = new EventBus<ThinkerEvents>();
bus.use(loggingMiddleware({ verbose: false }));

// ---------------------------------------------------------------------------
// 2. Create agents
// ---------------------------------------------------------------------------

// The LLM-powered thinker replaces the hardcoded orchestrator
const thinker = ThinkerAgent({
  id: "thinker-1",
  name: "Thinker",
  bus,
  provider,
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

const logger = LoggerAgent<ThinkerEvents>({
  id: "logger",
  name: "Logger",
  bus,
});

// A standalone cognitive agent for direct LLM interaction demos
const assistant = CognitiveAgent({
  id: "assistant",
  name: "Assistant",
  bus,
  provider,
  systemPrompt: "You are a concise, helpful assistant. Keep responses under 100 words.",
});

// ---------------------------------------------------------------------------
// 3. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  🧠 Rorschach — Cognitive Agent Demo (OpenRouter)");
  console.log("=".repeat(60));
  console.log();

  await Promise.all([
    thinker.start(),
    worker1.start(),
    worker2.start(),
    logger.start(),
    assistant.start(),
  ]);

  console.log("✓ All agents started\n");

  // =========================================================================
  // Demo 1: Single-turn reasoning (think)
  // =========================================================================

  console.log("─".repeat(60));
  console.log("  💭 Demo 1: think() — Single-turn reasoning");
  console.log("─".repeat(60));
  console.log();

  const thought = await assistant.think(
    "What are the 3 most important principles for designing a multi-agent system?"
  );
  console.log(`🤖 Response:\n${thought}\n`);

  // =========================================================================
  // Demo 2: Multi-turn conversation (chat)
  // =========================================================================

  console.log("─".repeat(60));
  console.log("  💬 Demo 2: chat() — Multi-turn conversation");
  console.log("─".repeat(60));
  console.log();

  const reply1 = await assistant.chat("What is an event-driven architecture?");
  console.log(`🤖 Turn 1: ${reply1}\n`);

  const reply2 = await assistant.chat("How does it compare to request/response?");
  console.log(`🤖 Turn 2: ${reply2}\n`);

  console.log(`📝 Conversation history: ${assistant.getHistory().length} messages\n`);

  // =========================================================================
  // Demo 3: Structured decision (decide)
  // =========================================================================

  console.log("─".repeat(60));
  console.log("  🎯 Demo 3: decide() — Structured decision making");
  console.log("─".repeat(60));
  console.log();

  const decision = await assistant.decide(
    "Which communication pattern should be used between microservices that need real-time updates?",
    [
      "REST API with polling",
      "WebSocket connections",
      "Event-driven pub/sub with message broker",
      "gRPC streaming",
    ],
  );

  console.log(`🎯 Choice: #${decision.choiceIndex + 1}`);
  console.log(`📋 Reason: ${decision.explanation}\n`);

  // =========================================================================
  // Demo 4: Summarize
  // =========================================================================

  console.log("─".repeat(60));
  console.log("  📄 Demo 4: summarize() — Text summarization");
  console.log("─".repeat(60));
  console.log();

  const textToSummarize = `
    Event-driven architecture (EDA) is a software design paradigm in which the 
    flow of the program is determined by events. Events are significant changes 
    in state, and they are the primary mechanism for communication between 
    decoupled services. In an event-driven system, event producers emit events 
    when something noteworthy happens, and event consumers subscribe to these 
    events and react accordingly. This pattern enables loose coupling between 
    components, as producers don't need to know about consumers, and vice versa. 
    EDA is particularly well-suited for systems that need to handle high 
    throughput, scale independently, and maintain resilience. Common 
    implementations include message queues like RabbitMQ, event streaming 
    platforms like Apache Kafka, and in-memory event buses for single-process 
    applications.
  `.trim();

  const summary = await assistant.summarize(textToSummarize, "in 2 sentences");
  console.log(`📄 Summary: ${summary}\n`);

  // =========================================================================
  // Demo 5: LLM-powered task decomposition via events
  // =========================================================================

  console.log("─".repeat(60));
  console.log("  🚀 Demo 5: Event-driven LLM task decomposition");
  console.log("─".repeat(60));
  console.log();

  console.log("📤 Submitting task to the event bus...\n");

  await bus.emit(
    "task:submitted",
    {
      description: "Build a REST API for a todo-list application with authentication",
      priority: 1,
    },
    { source: "external" },
  );

  // Give the async flow time to complete (LLM call + event propagation)
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  // =========================================================================
  // Shutdown
  // =========================================================================

  console.log();
  console.log("─".repeat(60));
  console.log("  🛑 Stopping agents...");
  console.log("─".repeat(60));

  await Promise.all([
    thinker.stop(),
    worker1.stop(),
    worker2.stop(),
    logger.stop(),
    assistant.stop(),
  ]);

  console.log("✓ All agents stopped\n");
}

main().catch(console.error);
