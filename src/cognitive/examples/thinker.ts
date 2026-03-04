/**
 * ThinkerAgent — Example cognitive agent that uses LLM reasoning to
 * decompose submitted tasks into structured sub-tasks.
 *
 * Demonstrates how to build an event-driven agent with cognitive capabilities:
 *   1. Listens for "task:submitted" events on the bus
 *   2. Uses the LLM to reason about task decomposition
 *   3. Emits "task:assigned" events for each sub-task
 *   4. Full observability via cognitive events
 */

import { CognitiveAgent } from "../cognitive-agent";
import type { EventBus } from "../../events/event-bus";
import type { TaskEvents } from "../../agents/examples/events";
import type { CognitiveEvents, ModelProvider } from "../types";

// ---------------------------------------------------------------------------
// Combined event map
// ---------------------------------------------------------------------------

export type ThinkerEvents = TaskEvents & CognitiveEvents;

// ---------------------------------------------------------------------------
// ThinkerAgent Factory
// ---------------------------------------------------------------------------

export const ThinkerAgent = (options: {
  id: string;
  name: string;
  bus: EventBus<ThinkerEvents>;
  provider: ModelProvider;
}) => {
  const agent = CognitiveAgent<TaskEvents>({
    id: options.id,
    name: options.name,
    bus: options.bus,
    provider: options.provider,
    systemPrompt: [
      "You are a task decomposition expert for a multi-agent system.",
      "When given a task description, you break it into 2-3 concrete, actionable sub-tasks.",
      "Each sub-task should be independent and clearly scoped.",
      "",
      "Respond with ONLY a JSON array of objects, no markdown, no extra text:",
      '[{"assignee": "worker-1", "description": "..."}, ...]',
      "",
      "Assignees should be worker-1 or worker-2.",
    ].join("\n"),
    defaultOptions: {
      temperature: 0.3,
      maxTokens: 1024,
    },
  });

  // -------------------------------------------------------------------------
  // Parse LLM response into sub-tasks
  // -------------------------------------------------------------------------

  const parseSubTasks = (
    response: string,
  ): Array<{ assignee: string; description: string }> => {
    try {
      // Strip potential markdown code fences
      const cleaned = response
        .trim()
        .replace(/^```json?\s*/, "")
        .replace(/\s*```$/, "");

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (item: unknown): item is { assignee: string; description: string } =>
            typeof item === "object" &&
            item !== null &&
            "assignee" in item &&
            "description" in item &&
            typeof (item as Record<string, unknown>).assignee === "string" &&
            typeof (item as Record<string, unknown>).description === "string",
        )
        .map((item) => ({
          assignee: item.assignee,
          description: item.description,
        }));
    } catch {
      return [];
    }
  };

  // -------------------------------------------------------------------------
  // Setup: listen for task submissions
  // -------------------------------------------------------------------------

  const setup = (): void => {
    agent.on("task:submitted", async (event) => {
      const { description } = event.payload;
      console.log(
        `🧠 [Thinker] Received task: "${description}" — reasoning with LLM...`,
      );

      try {
        // Use the LLM to decompose the task
        const response = await agent.think(
          `Decompose this task into sub-tasks: "${description}"`,
        );

        // Parse the LLM's response
        const subTasks = parseSubTasks(response);

        if (subTasks.length === 0) {
          console.warn(
            `⚠️ [Thinker] LLM returned no parseable sub-tasks. Raw response:\n${response}`,
          );
          return;
        }

        console.log(
          `🧠 [Thinker] Decomposed into ${subTasks.length} sub-tasks`,
        );

        // Emit task:assigned for each sub-task
        for (const sub of subTasks) {
          await agent.emit("task:assigned", {
            taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            assignee: sub.assignee,
            description: sub.description,
          });
        }
      } catch (err) {
        console.error(
          `❌ [Thinker] Failed to decompose task:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  };

  return {
    ...agent,

    // Override start to wire setup before agent starts
    start: async (): Promise<void> => {
      setup();
      await agent.start();
    },

    // Expose cognitive capabilities for direct use
    think: agent.think,
    chat: agent.chat,
    decide: agent.decide,
    summarize: agent.summarize,
  };
};
