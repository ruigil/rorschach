/**
 * Demo: Interface Module — Web Chat with HTTP + WebSocket
 *
 * Demonstrates the full interface pipeline:
 *   1. Creates an OpenRouter provider for LLM capabilities
 *   2. Wires a CognitiveAgent (session-based chat) + InterfaceAgent (HTTP + WS)
 *   3. Users can chat via HTTP API or WebSocket (chat.html UI)
 *   4. Session history is centralized in the CognitiveAgent
 *   5. Full observability via bus events
 *
 * Architecture:
 *   Browser (chat.html) ──WebSocket──► InterfaceAgent ──bus──► CognitiveAgent ──► LLM
 *   curl POST /chat     ──HTTP──────►                                            ▲
 *                                                                                │
 *   Same sessionId = same conversation across any channel                        │
 *
 * Prerequisites:
 *   Add your OpenRouter API key to .env:
 *     OPEN_ROUTER_API_KEY=sk-or-v1-...
 *
 * Run with:
 *   bun run src/interface-demo.ts
 *
 * Then:
 *   - Open http://localhost:3001 for the WebSocket chat UI
 *   - Or use curl:
 *     curl -X POST http://localhost:3000/chat \
 *       -H "Content-Type: application/json" \
 *       -d '{"message": "Hello!", "sessionId": "my-session"}'
 */

import { EventBus } from "./events";
import { loggingMiddleware } from "./events";
import { OpenRouterProvider, type CognitiveEvents } from "./cognitive";
import { LoggerAgent } from "./agents";
import type { InterfaceEvents } from "./interface/types";
import { HttpAdapter } from "./interface/adapters/http-adapter";
import { WebSocketAdapter } from "./interface/adapters/websocket-adapter";
import { InterfaceAgent } from "./interface/interface-agent";
import { WebChatAgent } from "./interface/examples/web-chat-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const systemPrompt = "You are a helpful, concise assistant."
const httpPort = 3000
const wsPort = 3001
const staticDir = "./public"

const API_KEY = process.env.OPEN_ROUTER_API_KEY;

if (!API_KEY) {
  console.error("❌ Missing OPEN_ROUTER_API_KEY.");
  console.error("   Add it to your .env file: OPEN_ROUTER_API_KEY=sk-or-v1-...");
  process.exit(1);
}

export type WebChatEvents = InterfaceEvents & CognitiveEvents;

// ---------------------------------------------------------------------------
// 1. Create the event bus
// ---------------------------------------------------------------------------

const bus = new EventBus<WebChatEvents>();
bus.use(loggingMiddleware({ verbose: false }));

// ---------------------------------------------------------------------------
// 2. Create the provider
// ---------------------------------------------------------------------------

const provider = OpenRouterProvider({
  apiKey: API_KEY,
  defaultModel: "openai/gpt-4o-mini",
  appName: "Rorschach Interface Demo",
});

// -------------------------------------------------------------------------
// 3. Create the CognitiveAgent
// -------------------------------------------------------------------------

const chatAgent = WebChatAgent({
  bus,
  provider,
  systemPrompt,
  httpPort,
  wsPort,
  staticDir,
});


// -------------------------------------------------------------------------
// 4. Create adapters
// -------------------------------------------------------------------------

const httpAdapter = HttpAdapter({
  port: httpPort,
  staticDir,
});

const wsAdapter = WebSocketAdapter({
  port: wsPort,
  staticDir,
});

// -------------------------------------------------------------------------
// 5. Create the InterfaceAgent
// -------------------------------------------------------------------------

const interfaceAgent = InterfaceAgent({
  id: "interface-1",
  name: "Interface Gateway",
  bus,
  adapters: [httpAdapter, wsAdapter],
  replyTimeoutMs: 60_000, // LLM calls can be slow
});


// ---------------------------------------------------------------------------
// 4. Optional: Add a logger agent for observability
// ---------------------------------------------------------------------------

const logger = LoggerAgent<WebChatEvents>({
  id: "logger",
  name: "Logger",
  bus,
});

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  🧠 Rorschach — Interface Demo (HTTP + WebSocket)");
  console.log("=".repeat(60));
  console.log();

  await logger.start();
  await interfaceAgent.start();
  await chatAgent.start();

  console.log();
  console.log("─".repeat(60));
  console.log("  🌐 Servers running:");
  console.log(`     HTTP API:     http://localhost:${httpPort}/chat`);
  console.log(`     Health:       http://localhost:${httpPort}/health`);
  console.log(`     WebSocket:    ws://localhost:${wsPort}/ws`);
  console.log(`     Chat UI:      http://localhost:${wsPort}/`);
  console.log("─".repeat(60));
  console.log();
  console.log("  Try it:");
  console.log(`     1. Open http://localhost:${wsPort} in your browser`);
  console.log(`     2. Or use curl:`);
  console.log(`        curl -X POST http://localhost:${httpPort}/chat \\`);
  console.log(`          -H "Content-Type: application/json" \\`);
  console.log(`          -d '{"message": "Hello!", "sessionId": "demo"}'`);
  console.log();
  console.log("  Press Ctrl+C to stop.");
  console.log();

  // Keep the process running
  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down...");
    await chatAgent.stop();
    await interfaceAgent.stop();
    await logger.stop();
    console.log("✓ All agents stopped");
    process.exit(0);
  });
}

main().catch(console.error);
