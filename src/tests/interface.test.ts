/**
 * Tests for the Interface module.
 *
 * Covers:
 *   - InterfaceAgent lifecycle and event flow
 *   - Request/reply delegation via the bus
 *   - Push routing to duplex adapters
 *   - Session-based CognitiveAgent chat
 *   - HttpAdapter request/response
 *   - WebSocketAdapter connection management
 *   - Observability events
 *   - Error handling
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../events/event-bus";
import { InterfaceAgent } from "../interface/interface-agent";
import { HttpAdapter } from "../interface/adapters/http-adapter";
import { WebSocketAdapter } from "../interface/adapters/websocket-adapter";
import type {
  InterfaceAdapter,
  InterfaceEvents,
  InterfaceMessage,
  InterfaceResponse,
  MessageHandler,
} from "../interface/types";

// ---------------------------------------------------------------------------
// Mock adapter — for testing InterfaceAgent without real servers
// ---------------------------------------------------------------------------

const MockAdapter = (opts: { name?: string; duplex?: boolean } = {}): InterfaceAdapter & {
  simulateMessage: (message: InterfaceMessage) => Promise<InterfaceResponse>;
  sentPushes: InterfaceResponse[];
  broadcasts: InterfaceResponse[];
} => {
  let handler: MessageHandler | null = null;
  const sentPushes: InterfaceResponse[] = [];
  const broadcasts: InterfaceResponse[] = [];

  return {
    name: opts.name ?? "mock",
    duplex: opts.duplex ?? false,
    start: async (h) => { handler = h; },
    stop: async () => { handler = null; },
    simulateMessage: async (message) => {
      if (!handler) throw new Error("Adapter not started");
      return handler(message);
    },
    sentPushes,
    broadcasts,
    ...(opts.duplex ? {
      send: async (_sessionId: string, response: InterfaceResponse) => {
        sentPushes.push(response);
        return true;
      },
      broadcast: async (response: InterfaceResponse) => {
        broadcasts.push(response);
        return 1;
      },
    } : {}),
  };
};

// ---------------------------------------------------------------------------
// Test Suite: InterfaceAgent Core
// ---------------------------------------------------------------------------

describe("InterfaceAgent", () => {
  let bus: EventBus<InterfaceEvents>;

  beforeEach(() => {
    bus = new EventBus<InterfaceEvents>();
  });

  test("should start and stop with adapters", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
    });

    await agent.start();
    expect(agent.isRunning()).toBe(true);

    await agent.stop();
    expect(agent.isRunning()).toBe(false);
  });

  test("should emit adapter:started events on start", async () => {
    const adapter = MockAdapter({ name: "test-adapter" });
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
    });

    const events: string[] = [];
    bus.on("interface:adapter:started", async (e) => {
      events.push(e.payload.adapter);
    });

    await agent.start();
    expect(events).toContain("test-adapter");

    await agent.stop();
  });

  test("should emit adapter:stopped events on stop", async () => {
    const adapter = MockAdapter({ name: "test-adapter" });
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
    });

    const events: string[] = [];
    bus.on("interface:adapter:stopped", async (e) => {
      events.push(e.payload.adapter);
    });

    await agent.start();
    await agent.stop();
    expect(events).toContain("test-adapter");
  });

  test("should delegate messages via bus request/reply", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
      replyTimeoutMs: 5000,
    });

    // Wire up a handler that replies to interface:chat
    bus.on("interface:chat", async (event) => {
      if (event.replyTo && event.correlationId) {
        await bus.reply(event, {
          content: `Echo: ${(event.payload as any).content}`,
          sessionId: (event.payload as any).sessionId,
        }, "test-handler");
      }
    });

    await agent.start();

    const response = await adapter.simulateMessage({
      content: "Hello",
      source: "mock",
      sessionId: "session-1",
    });

    expect(response.content).toBe("Echo: Hello");
    expect(response.sessionId).toBe("session-1");

    await agent.stop();
  });

  test("should emit message:received observability event", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
      replyTimeoutMs: 2000,
    });

    const received: Array<{ content: string; sessionId: string }> = [];
    bus.on("interface:message:received", async (e) => {
      received.push(e.payload);
    });

    // Wire up a responder
    bus.on("interface:chat", async (event) => {
      if (event.replyTo) {
        await bus.reply(event, { content: "ok", sessionId: "s1" }, "handler");
      }
    });

    await agent.start();

    await adapter.simulateMessage({
      content: "Test message",
      source: "mock",
      sessionId: "s1",
    });

    expect(received.length).toBe(1);
    expect(received[0]!.content).toBe("Test message");
    expect(received[0]!.sessionId).toBe("s1");

    await agent.stop();
  });

  test("should emit response:sent observability event", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
      replyTimeoutMs: 2000,
    });

    const sent: Array<{ content: string; sessionId: string }> = [];
    bus.on("interface:response:sent", async (e) => {
      sent.push(e.payload);
    });

    bus.on("interface:chat", async (event) => {
      if (event.replyTo) {
        await bus.reply(event, { content: "Reply!", sessionId: "s1" }, "handler");
      }
    });

    await agent.start();

    await adapter.simulateMessage({
      content: "Hello",
      source: "mock",
      sessionId: "s1",
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.content).toBe("Reply!");

    await agent.stop();
  });

  test("should return error response on timeout", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
      replyTimeoutMs: 100, // Very short timeout
    });

    // No handler registered — will timeout

    await agent.start();

    const response = await adapter.simulateMessage({
      content: "Hello",
      source: "mock",
      sessionId: "s1",
    });

    expect(response.type).toBe("error");
    expect(response.content).toContain("unable to process");

    await agent.stop();
  });

  test("should emit error event on failure", async () => {
    const adapter = MockAdapter();
    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter],
      replyTimeoutMs: 100,
    });

    const errors: Array<{ error: string }> = [];
    bus.on("interface:error", async (e) => {
      errors.push(e.payload);
    });

    await agent.start();

    await adapter.simulateMessage({
      content: "Hello",
      source: "mock",
      sessionId: "s1",
    });

    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("timed out");

    await agent.stop();
  });

  test("should route push events to duplex adapters", async () => {
    const duplexAdapter = MockAdapter({ name: "duplex", duplex: true });
    const simplexAdapter = MockAdapter({ name: "simplex", duplex: false });

    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [duplexAdapter, simplexAdapter],
    });

    await agent.start();

    // Emit a push event on the bus
    await bus.emit("interface:push", {
      content: "Notification!",
      sessionId: "s1",
      type: "notification",
    }, { source: "test" });

    // Give async handlers time to run
    await new Promise((r) => setTimeout(r, 50));

    // Only the duplex adapter should have received it
    expect(duplexAdapter.sentPushes.length).toBe(1);
    expect(duplexAdapter.sentPushes[0]!.content).toBe("Notification!");
    expect(simplexAdapter.sentPushes.length).toBe(0);

    await agent.stop();
  });

  test("should manage multiple adapters", async () => {
    const adapter1 = MockAdapter({ name: "a1" });
    const adapter2 = MockAdapter({ name: "a2" });

    const agent = InterfaceAgent({
      id: "test-interface",
      name: "Test Interface",
      bus,
      adapters: [adapter1, adapter2],
    });

    const started: string[] = [];
    bus.on("interface:adapter:started", async (e) => {
      started.push(e.payload.adapter);
    });

    await agent.start();

    expect(started).toContain("a1");
    expect(started).toContain("a2");
    expect(agent.adapters.length).toBe(2);

    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: CognitiveAgent Session Support
// ---------------------------------------------------------------------------

describe("CognitiveAgent Session Chat", () => {
  // Import here to avoid circular issues
  const { CognitiveAgent } = require("../cognitive/cognitive-agent");
  const { EventBus: EB } = require("../events/event-bus");

  // Mock provider
  const mockProvider = {
    name: "mock",
    complete: async (messages: any[]) => {
      const lastUser = messages.filter((m: any) => m.role === "user").pop();
      return {
        content: `Response to: ${lastUser?.content ?? "unknown"}`,
        model: "mock-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
        raw: {},
      };
    },
    completeText: async (prompt: string) => `Response to: ${prompt}`,
  };

  test("chatSession should maintain isolated session histories", async () => {
    const bus = new EB();
    const agent = CognitiveAgent({
      id: "cog-1",
      name: "Cog",
      bus,
      provider: mockProvider,
    });
    await agent.start();

    // Chat in session A
    await agent.chatSession("session-a", "Hello from A");
    await agent.chatSession("session-a", "Second from A");

    // Chat in session B
    await agent.chatSession("session-b", "Hello from B");

    // Verify isolated histories
    const historyA = agent.getSessionHistory("session-a");
    const historyB = agent.getSessionHistory("session-b");

    expect(historyA.length).toBe(4); // 2 user + 2 assistant
    expect(historyB.length).toBe(2); // 1 user + 1 assistant

    expect(historyA[0]!.content).toBe("Hello from A");
    expect(historyB[0]!.content).toBe("Hello from B");

    await agent.stop();
  });

  test("listSessions should return active session IDs", async () => {
    const bus = new EB();
    const agent = CognitiveAgent({
      id: "cog-1",
      name: "Cog",
      bus,
      provider: mockProvider,
    });
    await agent.start();

    await agent.chatSession("session-1", "hello");
    await agent.chatSession("session-2", "hello");
    await agent.chatSession("session-3", "hello");

    const sessions = agent.listSessions();
    expect(sessions).toContain("session-1");
    expect(sessions).toContain("session-2");
    expect(sessions).toContain("session-3");
    expect(sessions.length).toBe(3);

    await agent.stop();
  });

  test("clearSession should remove a specific session", async () => {
    const bus = new EB();
    const agent = CognitiveAgent({
      id: "cog-1",
      name: "Cog",
      bus,
      provider: mockProvider,
    });
    await agent.start();

    await agent.chatSession("session-1", "hello");
    await agent.chatSession("session-2", "hello");

    agent.clearSession("session-1");

    expect(agent.getSessionHistory("session-1").length).toBe(0);
    expect(agent.getSessionHistory("session-2").length).toBe(2);
    expect(agent.listSessions()).toEqual(["session-2"]);

    await agent.stop();
  });

  test("chatSessionRaw should return full CompletionResult", async () => {
    const bus = new EB();
    const agent = CognitiveAgent({
      id: "cog-1",
      name: "Cog",
      bus,
      provider: mockProvider,
    });
    await agent.start();

    const result = await agent.chatSessionRaw("session-1", "hello");

    expect(result.content).toBeDefined();
    expect(result.model).toBe("mock-model");
    expect(result.usage.totalTokens).toBe(30);

    await agent.stop();
  });

  test("session chat should not affect default chat history", async () => {
    const bus = new EB();
    const agent = CognitiveAgent({
      id: "cog-1",
      name: "Cog",
      bus,
      provider: mockProvider,
    });
    await agent.start();

    // Use session chat
    await agent.chatSession("session-1", "session message");

    // Use default chat
    await agent.chat("default message");

    // They should be independent
    const sessionHistory = agent.getSessionHistory("session-1");
    const defaultHistory = agent.getHistory();

    expect(sessionHistory.length).toBe(2);
    expect(defaultHistory.length).toBe(2);
    expect(sessionHistory[0]!.content).toBe("session message");
    expect(defaultHistory[0]!.content).toBe("default message");

    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: HttpAdapter
// ---------------------------------------------------------------------------

describe("HttpAdapter", () => {
  let adapter: ReturnType<typeof HttpAdapter>;
  const testPort = 19876; // Use unusual port to avoid conflicts

  afterEach(async () => {
    try {
      await adapter?.stop();
    } catch { /* ignore */ }
  });

  test("should respond to health check", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const response = await fetch(`http://localhost:${testPort}/health`);
    const data = await response.json() as { status: string };

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
  });

  test("should handle POST /chat", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: `Echo: ${msg.content}`,
      sessionId: msg.sessionId,
    }));

    const response = await fetch(`http://localhost:${testPort}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello!", sessionId: "s1" }),
    });

    const data = await response.json() as { response: string; sessionId: string };

    expect(response.status).toBe(200);
    expect(data.response).toBe("Echo: Hello!");
    expect(data.sessionId).toBe("s1");
  });

  test("should auto-generate sessionId when not provided", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: "ok",
      sessionId: msg.sessionId,
    }));

    const response = await fetch(`http://localhost:${testPort}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello!" }),
    });

    const data = await response.json() as { sessionId: string };
    expect(data.sessionId).toBeDefined();
    expect(data.sessionId.length).toBeGreaterThan(0);
  });

  test("should return 400 for missing message", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const response = await fetch(`http://localhost:${testPort}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  test("should return 404 for unknown routes", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const response = await fetch(`http://localhost:${testPort}/unknown`);
    expect(response.status).toBe(404);
  });

  test("should handle CORS preflight", async () => {
    adapter = HttpAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const response = await fetch(`http://localhost:${testPort}/chat`, {
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// Test Suite: WebSocketAdapter
// ---------------------------------------------------------------------------

describe("WebSocketAdapter", () => {
  let adapter: ReturnType<typeof WebSocketAdapter>;
  const testPort = 19877;

  afterEach(async () => {
    try {
      await adapter?.stop();
    } catch { /* ignore */ }
  });

  test("should accept WebSocket connections", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: `Echo: ${msg.content}`,
      sessionId: msg.sessionId,
    }));

    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);

    const messages: any[] = [];
    const connected = new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    await connected;

    // Wait for session message
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBe("session");
    expect(messages[0].sessionId).toBeDefined();

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test("should echo chat messages", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: `Echo: ${msg.content}`,
      sessionId: msg.sessionId,
    }));

    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    // Wait for session message
    await new Promise((r) => setTimeout(r, 100));

    // Send a chat message
    ws.send(JSON.stringify({ type: "chat", message: "Hello!" }));

    // Wait for response
    await new Promise((r) => setTimeout(r, 200));

    const responses = messages.filter((m) => m.type === "response");
    expect(responses.length).toBe(1);
    expect(responses[0].content).toBe("Echo: Hello!");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test("should support custom sessionId via query param", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: "ok",
      sessionId: msg.sessionId,
    }));

    const ws = new WebSocket(`ws://localhost:${testPort}/ws?sessionId=my-session`);
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    await new Promise((r) => setTimeout(r, 100));

    const sessionMsg = messages.find((m) => m.type === "session");
    expect(sessionMsg.sessionId).toBe("my-session");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test("should send push messages to connected sessions", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async (msg) => ({
      content: "ok",
      sessionId: msg.sessionId,
    }));

    const ws = new WebSocket(`ws://localhost:${testPort}/ws?sessionId=push-test`);
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    await new Promise((r) => setTimeout(r, 100));

    // Send a push message
    const delivered = await adapter.send!("push-test", {
      content: "Push notification!",
      sessionId: "push-test",
      type: "notification",
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(delivered).toBe(true);
    const notifications = messages.filter((m) => m.type === "notification");
    expect(notifications.length).toBe(1);
    expect(notifications[0].content).toBe("Push notification!");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test("should return false for push to non-existent session", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const delivered = await adapter.send!("nonexistent", {
      content: "Hello",
      sessionId: "nonexistent",
    });

    expect(delivered).toBe(false);
  });

  test("health check should return connection count", async () => {
    adapter = WebSocketAdapter({ port: testPort });
    await adapter.start(async () => ({
      content: "ok",
      sessionId: "test",
    }));

    const response = await fetch(`http://localhost:${testPort}/health`);
    const data = await response.json() as { connections: number };

    expect(response.status).toBe(200);
    expect(data.connections).toBe(0);
  });
});
