/**
 * Tests for the cognitive capabilities module.
 *
 * Uses a mock ModelProvider to test CognitiveAgent behavior
 * without making real API calls.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { EventBus } from "../events/event-bus";
import { CognitiveAgent } from "../cognitive/cognitive-agent";
import { OpenRouterProvider } from "../cognitive/openrouter";
import { ProviderError } from "../cognitive/types";
import type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  CognitiveEvents,
  ModelProvider,
} from "../cognitive/types";

// ---------------------------------------------------------------------------
// Mock Provider Factory
// ---------------------------------------------------------------------------

function createMockProvider(
  responseContent: string = "Mock response",
  overrides: Partial<CompletionResult> = {},
): ModelProvider {
  const completeFn = mock(
    async (
      messages: ChatMessage[],
      _options?: Partial<CompletionOptions>,
    ): Promise<CompletionResult> => ({
      content: responseContent,
      model: "mock/model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
      raw: {},
      ...overrides,
    }),
  );

  return {
    name: "mock",
    complete: completeFn,
    completeText: async (prompt: string, options?: Partial<CompletionOptions>) => {
      const result = await completeFn(
        [{ role: "user", content: prompt }],
        options,
      );
      return result.content;
    },
  };
}

// ---------------------------------------------------------------------------
// CognitiveAgent Tests
// ---------------------------------------------------------------------------

describe("CognitiveAgent", () => {
  let bus: EventBus<CognitiveEvents>;
  let provider: ModelProvider;
  let agent: ReturnType<typeof CognitiveAgent>;

  beforeEach(() => {
    bus = new EventBus<CognitiveEvents>();
    provider = createMockProvider("This is a mock LLM response.");
    agent = CognitiveAgent({
      id: "test-agent",
      name: "Test Agent",
      bus,
      provider,
      systemPrompt: "You are a test assistant.",
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    test("starts and stops correctly", async () => {
      expect(agent.isRunning()).toBe(false);
      await agent.start();
      expect(agent.isRunning()).toBe(true);
      await agent.stop();
      expect(agent.isRunning()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // think()
  // -----------------------------------------------------------------------

  describe("think()", () => {
    test("returns the LLM response content", async () => {
      await agent.start();
      const result = await agent.think("Hello!");
      expect(result).toBe("This is a mock LLM response.");
    });

    test("passes system prompt + user message to provider", async () => {
      await agent.start();
      await agent.think("What is 2+2?");

      const calls = (provider.complete as ReturnType<typeof mock>).mock.calls;
      expect(calls.length).toBe(1);

      const messages = calls[0]![0] as ChatMessage[];
      expect(messages.length).toBe(2);
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toBe("You are a test assistant.");
      expect(messages[1]!.role).toBe("user");
      expect(messages[1]!.content).toBe("What is 2+2?");
    });

    test("does NOT modify conversation history", async () => {
      await agent.start();
      await agent.think("Ephemeral question");
      expect(agent.getHistory().length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // chat()
  // -----------------------------------------------------------------------

  describe("chat()", () => {
    test("returns the LLM response content", async () => {
      await agent.start();
      const result = await agent.chat("Hello!");
      expect(result).toBe("This is a mock LLM response.");
    });

    test("builds up conversation history", async () => {
      await agent.start();
      await agent.chat("First message");
      await agent.chat("Second message");

      const history = agent.getHistory();
      expect(history.length).toBe(4); // 2 user + 2 assistant
      expect(history[0]!.role).toBe("user");
      expect(history[0]!.content).toBe("First message");
      expect(history[1]!.role).toBe("assistant");
      expect(history[2]!.role).toBe("user");
      expect(history[2]!.content).toBe("Second message");
      expect(history[3]!.role).toBe("assistant");
    });

    test("clearHistory() resets the conversation", async () => {
      await agent.start();
      await agent.chat("Message");
      expect(agent.getHistory().length).toBe(2);
      agent.clearHistory();
      expect(agent.getHistory().length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // decide()
  // -----------------------------------------------------------------------

  describe("decide()", () => {
    test("parses valid JSON response", async () => {
      const decideProvider = createMockProvider(
        '{"choice": 2, "explanation": "Option B is better because..."}',
      );
      const decideAgent = CognitiveAgent({
        id: "decide-agent",
        name: "Decide Agent",
        bus,
        provider: decideProvider,
      });
      await decideAgent.start();

      const result = await decideAgent.decide("Which option?", [
        "Option A",
        "Option B",
        "Option C",
      ]);

      expect(result.choiceIndex).toBe(1); // 0-based
      expect(result.explanation).toBe("Option B is better because...");
    });

    test("returns -1 for unparseable response", async () => {
      const badProvider = createMockProvider("I can't decide, sorry!");
      const badAgent = CognitiveAgent({
        id: "bad-agent",
        name: "Bad Agent",
        bus,
        provider: badProvider,
      });
      await badAgent.start();

      const result = await badAgent.decide("Which?", ["A", "B"]);
      expect(result.choiceIndex).toBe(-1);
    });

    test("handles JSON wrapped in code fences", async () => {
      const fencedProvider = createMockProvider(
        '```json\n{"choice": 1, "explanation": "First is best"}\n```',
      );
      const fencedAgent = CognitiveAgent({
        id: "fenced-agent",
        name: "Fenced Agent",
        bus,
        provider: fencedProvider,
      });
      await fencedAgent.start();

      const result = await fencedAgent.decide("Pick one", ["First", "Second"]);
      expect(result.choiceIndex).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // summarize()
  // -----------------------------------------------------------------------

  describe("summarize()", () => {
    test("calls think() with summarization prompt", async () => {
      await agent.start();
      const result = await agent.summarize("Long text here...", "in 1 sentence");
      expect(result).toBe("This is a mock LLM response.");

      const calls = (provider.complete as ReturnType<typeof mock>).mock.calls;
      const messages = calls[0]![0] as ChatMessage[];
      const userMsg = messages.find((m) => m.role === "user")!;
      expect(userMsg.content).toContain("Summarize");
      expect(userMsg.content).toContain("Long text here...");
      expect(userMsg.content).toContain("in 1 sentence");
    });
  });

  // -----------------------------------------------------------------------
  // System prompt management
  // -----------------------------------------------------------------------

  describe("system prompt", () => {
    test("getSystemPrompt returns the configured prompt", () => {
      expect(agent.getSystemPrompt()).toBe("You are a test assistant.");
    });

    test("setSystemPrompt updates the prompt", async () => {
      agent.setSystemPrompt("New prompt");
      expect(agent.getSystemPrompt()).toBe("New prompt");

      await agent.start();
      await agent.think("test");

      const calls = (provider.complete as ReturnType<typeof mock>).mock.calls;
      const messages = calls[0]![0] as ChatMessage[];
      expect(messages[0]!.content).toBe("New prompt");
    });

    test("no system prompt when not configured", async () => {
      const noSysAgent = CognitiveAgent({
        id: "no-sys",
        name: "No Sys",
        bus,
        provider,
      });
      await noSysAgent.start();
      await noSysAgent.think("test");

      const calls = (provider.complete as ReturnType<typeof mock>).mock.calls;
      const messages = calls[0]![0] as ChatMessage[];
      expect(messages.length).toBe(1);
      expect(messages[0]!.role).toBe("user");
    });
  });

  // -----------------------------------------------------------------------
  // Cognitive events on the bus
  // -----------------------------------------------------------------------

  describe("cognitive events", () => {
    test("emits cognitive:thinking before the call", async () => {
      const events: unknown[] = [];
      bus.on("cognitive:thinking", (event) => {
        events.push(event.payload);
      });

      await agent.start();
      await agent.think("Hello");

      expect(events.length).toBe(1);
      expect((events[0] as any).agentId).toBe("test-agent");
      expect((events[0] as any).prompt).toContain("Hello");
    });

    test("emits cognitive:complete after success", async () => {
      const events: unknown[] = [];
      bus.on("cognitive:complete", (event) => {
        events.push(event.payload);
      });

      await agent.start();
      await agent.think("Hello");

      expect(events.length).toBe(1);
      expect((events[0] as any).agentId).toBe("test-agent");
      expect((events[0] as any).model).toBe("mock/model");
      expect((events[0] as any).durationMs).toBeGreaterThanOrEqual(0);
    });

    test("emits cognitive:error on failure", async () => {
      const failProvider: ModelProvider = {
        name: "fail",
        complete: async () => {
          throw new Error("LLM is down!");
        },
        completeText: async () => {
          throw new Error("LLM is down!");
        },
      };

      const failAgent = CognitiveAgent({
        id: "fail-agent",
        name: "Fail Agent",
        bus,
        provider: failProvider,
      });

      const events: unknown[] = [];
      bus.on("cognitive:error", (event) => {
        events.push(event.payload);
      });

      await failAgent.start();

      try {
        await failAgent.think("This will fail");
      } catch {
        // Expected
      }

      expect(events.length).toBe(1);
      expect((events[0] as any).error).toContain("LLM is down!");
    });
  });

  // -----------------------------------------------------------------------
  // generate()
  // -----------------------------------------------------------------------

  describe("generate()", () => {
    test("passes custom messages and returns CompletionResult", async () => {
      await agent.start();
      const result = await agent.generate([
        { role: "user", content: "Custom message 1" },
        { role: "assistant", content: "Previous reply" },
        { role: "user", content: "Follow up" },
      ]);

      expect(result.content).toBe("This is a mock LLM response.");
      expect(result.model).toBe("mock/model");
      expect(result.usage.totalTokens).toBe(30);
    });
  });

  // -----------------------------------------------------------------------
  // History trimming
  // -----------------------------------------------------------------------

  describe("history trimming", () => {
    test("trims history when exceeding maxHistoryLength", async () => {
      const trimAgent = CognitiveAgent({
        id: "trim-agent",
        name: "Trim Agent",
        bus,
        provider,
        maxHistoryLength: 4, // max 4 messages (2 user + 2 assistant turns)
      });
      await trimAgent.start();

      await trimAgent.chat("First");
      await trimAgent.chat("Second");
      await trimAgent.chat("Third"); // This should push out "First" user+assistant

      const history = trimAgent.getHistory();
      expect(history.length).toBe(4);
      // The first messages should have been trimmed
      expect(history[0]!.content).toBe("Second");
    });
  });
});

// ---------------------------------------------------------------------------
// OpenRouterProvider Tests (unit — no network calls)
// ---------------------------------------------------------------------------

describe("OpenRouterProvider", () => {
  test("creates a provider with name 'openrouter'", () => {
    const provider = OpenRouterProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("openrouter");
  });

  test("complete() throws ProviderError on network failure", async () => {
    // Use an unreachable URL to simulate network failure
    const provider = OpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "http://localhost:1", // Will fail to connect
    });

    try {
      await provider.complete([{ role: "user", content: "test" }]);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).provider).toBe("openrouter");
    }
  });

  test("completeText() is a convenience wrapper", async () => {
    const provider = OpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "http://localhost:1",
    });

    try {
      await provider.completeText("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderError Tests
// ---------------------------------------------------------------------------

describe("ProviderError", () => {
  test("has correct properties", () => {
    const err = new ProviderError("test error", "openrouter", 401, {
      error: { message: "unauthorized" },
    });
    expect(err.message).toBe("test error");
    expect(err.provider).toBe("openrouter");
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe("ProviderError");
    expect(err instanceof Error).toBe(true);
  });
});
