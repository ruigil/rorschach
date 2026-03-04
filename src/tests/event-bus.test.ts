/**
 * Tests for the EventBus core functionality.
 *
 * Run with: bun test
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { EventBus } from "../events/event-bus";
import type { EventEnvelope, Middleware } from "../events/types";

// ---------------------------------------------------------------------------
// Test event map
// ---------------------------------------------------------------------------

type TestEvents = {
  "user:created": { name: string; email: string };
  "user:deleted": { userId: string };
  "order:placed": { orderId: string; amount: number };
  ping: { message: string };
  pong: { reply: string };
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("EventBus", () => {
  let bus: EventBus<TestEvents>;

  beforeEach(() => {
    bus = new EventBus<TestEvents>();
  });

  // =========================================================================
  // Basic pub/sub
  // =========================================================================

  describe("basic pub/sub", () => {
    test("handler receives emitted event with correct payload", async () => {
      let received: EventEnvelope<TestEvents["user:created"]> | null = null;

      bus.on("user:created", (event) => {
        received = event;
      });

      await bus.emit("user:created", { name: "Alice", email: "alice@example.com" });

      expect(received).not.toBeNull();
      expect(received!.payload.name).toBe("Alice");
      expect(received!.payload.email).toBe("alice@example.com");
      expect(received!.type).toBe("user:created");
      expect(received!.source).toBe("unknown");
    });

    test("event envelope has id, timestamp, traceId", async () => {
      let received: EventEnvelope | null = null;

      bus.on("user:created", (event) => {
        received = event;
      });

      await bus.emit("user:created", { name: "Bob", email: "bob@example.com" });

      expect(received).not.toBeNull();
      expect(received!.id).toBeDefined();
      expect(received!.timestamp).toBeGreaterThan(0);
      expect(received!.traceId).toBeDefined();
    });

    test("multiple handlers for the same event all fire", async () => {
      const calls: string[] = [];

      bus.on("user:created", () => { calls.push("a"); });
      bus.on("user:created", () => { calls.push("b"); });
      bus.on("user:created", () => { calls.push("c"); });

      await bus.emit("user:created", { name: "X", email: "x@x.com" });

      expect(calls).toHaveLength(3);
      expect(calls).toContain("a");
      expect(calls).toContain("b");
      expect(calls).toContain("c");
    });

    test("handlers for different event types don't interfere", async () => {
      let userCount = 0;
      let orderCount = 0;

      bus.on("user:created", () => { userCount++; });
      bus.on("order:placed", () => { orderCount++; });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      expect(userCount).toBe(1);
      expect(orderCount).toBe(0);
    });

    test("emit returns the event envelope", async () => {
      const envelope = await bus.emit("user:created", { name: "A", email: "a@a.com" }, { source: "test" });

      expect(envelope.type).toBe("user:created");
      expect(envelope.payload.name).toBe("A");
      expect(envelope.source).toBe("test");
    });
  });

  // =========================================================================
  // Unsubscribe
  // =========================================================================

  describe("unsubscribe", () => {
    test("unsubscribed handler is no longer called", async () => {
      let count = 0;

      const sub = bus.on("user:created", () => { count++; });
      await bus.emit("user:created", { name: "A", email: "a@a.com" });
      expect(count).toBe(1);

      sub.unsubscribe();
      await bus.emit("user:created", { name: "B", email: "b@b.com" });
      expect(count).toBe(1); // still 1
    });
  });

  // =========================================================================
  // Wildcard
  // =========================================================================

  describe("wildcard subscriptions", () => {
    test("wildcard handler receives all events", async () => {
      const types: string[] = [];

      bus.on("*", (event) => {
        types.push(event.type);
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });
      await bus.emit("order:placed", { orderId: "123", amount: 42 });
      await bus.emit("user:deleted", { userId: "u1" });

      expect(types).toEqual(["user:created", "order:placed", "user:deleted"]);
    });

    test("wildcard unsubscribe works", async () => {
      let count = 0;
      const sub = bus.on("*", () => { count++; });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });
      expect(count).toBe(1);

      sub.unsubscribe();
      await bus.emit("user:created", { name: "B", email: "b@b.com" });
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // Priority
  // =========================================================================

  describe("handler priority", () => {
    test("higher priority handlers execute first", async () => {
      const order: string[] = [];

      bus.on("user:created", async () => {
        order.push("low");
      }, { priority: 1 });

      bus.on("user:created", async () => {
        order.push("high");
      }, { priority: 10 });

      bus.on("user:created", async () => {
        order.push("medium");
      }, { priority: 5 });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      // All fire concurrently via allSettled, but they're ordered by priority
      // in the array. Since they're all sync-ish, order should reflect priority.
      expect(order[0]).toBe("high");
      expect(order[1]).toBe("medium");
      expect(order[2]).toBe("low");
    });
  });

  // =========================================================================
  // Error isolation
  // =========================================================================

  describe("error isolation", () => {
    test("a failing handler does not prevent other handlers from running", async () => {
      const results: string[] = [];

      bus.on("user:created", () => {
        results.push("before-error");
      }, { priority: 10 });

      bus.on("user:created", () => {
        throw new Error("boom");
      }, { priority: 5 });

      bus.on("user:created", () => {
        results.push("after-error");
      }, { priority: 1 });

      // Suppress console.error for this test
      const origError = console.error;
      console.error = () => {};

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      console.error = origError;

      expect(results).toContain("before-error");
      expect(results).toContain("after-error");
    });
  });

  // =========================================================================
  // Middleware
  // =========================================================================

  describe("middleware", () => {
    test("middleware runs around handler invocation", async () => {
      const order: string[] = [];

      bus.use(async (_event, next) => {
        order.push("mw-before");
        await next();
        order.push("mw-after");
      });

      bus.on("user:created", () => {
        order.push("handler");
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      expect(order).toEqual(["mw-before", "handler", "mw-after"]);
    });

    test("middleware can short-circuit (not call next)", async () => {
      let handlerCalled = false;

      bus.use(async (_event, _next) => {
        // intentionally not calling next()
      });

      bus.on("user:created", () => {
        handlerCalled = true;
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      expect(handlerCalled).toBe(false);
    });

    test("multiple middlewares compose in order", async () => {
      const order: string[] = [];

      bus.use(async (_event, next) => {
        order.push("mw1-before");
        await next();
        order.push("mw1-after");
      });

      bus.use(async (_event, next) => {
        order.push("mw2-before");
        await next();
        order.push("mw2-after");
      });

      bus.on("user:created", () => {
        order.push("handler");
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      expect(order).toEqual([
        "mw1-before",
        "mw2-before",
        "handler",
        "mw2-after",
        "mw1-after",
      ]);
    });
  });

  // =========================================================================
  // Request / Reply
  // =========================================================================

  describe("request / reply", () => {
    test("request resolves with the reply payload", async () => {
      bus.on("ping", async (event) => {
        await bus.reply(event, { reply: `pong: ${event.payload.message}` }, "responder");
      });

      const reply = await bus.request<"ping", { reply: string }>(
        "ping",
        { message: "hello" },
        { source: "requester", timeoutMs: 2_000 },
      );

      expect(reply.payload.reply).toBe("pong: hello");
      expect(reply.correlationId).toBeDefined();
      expect(reply.source).toBe("responder");
    });

    test("request times out if no reply", async () => {
      // No handler registered for "ping"

      const promise = bus.request<"ping", { reply: string }>(
        "ping",
        { message: "hello" },
        { source: "requester", timeoutMs: 100 },
      );

      await expect(promise).rejects.toThrow(/timed out/);
    });

    test("reply preserves traceId from the original request", async () => {
      bus.on("ping", async (event) => {
        await bus.reply(event, { reply: "ok" }, "responder");
      });

      const reply = await bus.request<"ping", { reply: string }>(
        "ping",
        { message: "hi" },
        { source: "requester", traceId: "custom-trace-123", timeoutMs: 2_000 },
      );

      expect(reply.payload.reply).toBe("ok");
      expect(reply.traceId).toBe("custom-trace-123");
    });
  });

  // =========================================================================
  // Tracing
  // =========================================================================

  describe("tracing", () => {
    test("emitted events carry the provided traceId and parentId", async () => {
      let received: EventEnvelope | null = null;

      bus.on("user:created", (event) => {
        received = event;
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" }, {
        source: "agent-1",
        traceId: "trace-abc",
        parentId: "parent-xyz",
      });

      expect(received).not.toBeNull();
      expect(received!.traceId).toBe("trace-abc");
      expect(received!.parentId).toBe("parent-xyz");
      expect(received!.source).toBe("agent-1");
    });

    test("traceId is auto-generated when not provided", async () => {
      let received: EventEnvelope | null = null;

      bus.on("user:created", (event) => {
        received = event;
      });

      await bus.emit("user:created", { name: "A", email: "a@a.com" });

      expect(received).not.toBeNull();
      expect(received!.traceId).toBeDefined();
      expect(received!.traceId.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Introspection
  // =========================================================================

  describe("introspection", () => {
    test("listenerCount returns correct count", () => {
      bus.on("user:created", () => {});
      bus.on("user:created", () => {});
      bus.on("order:placed", () => {});

      expect(bus.listenerCount("user:created")).toBe(2);
      expect(bus.listenerCount("order:placed")).toBe(1);
      expect(bus.listenerCount("user:deleted")).toBe(0);
    });

    test("listenerCount includes wildcard handlers", () => {
      bus.on("user:created", () => {});
      bus.on("*", () => {});

      expect(bus.listenerCount("user:created")).toBe(2); // 1 specific + 1 wildcard
    });

    test("eventTypes returns registered types", () => {
      bus.on("user:created", () => {});
      bus.on("order:placed", () => {});

      const types = bus.eventTypes();
      expect(types).toContain("user:created");
      expect(types).toContain("order:placed");
    });

    test("clear removes all handlers and middleware", async () => {
      let called = false;
      bus.on("user:created", () => { called = true; });
      bus.use(async (_, next) => { await next(); });

      bus.clear();

      await bus.emit("user:created", { name: "A", email: "a@a.com" });
      expect(called).toBe(false);
      expect(bus.eventTypes()).toHaveLength(0);
    });
  });
});
