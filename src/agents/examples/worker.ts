/**
 * WorkerAgent — listens for assigned tasks, simulates processing,
 * reports progress, and emits completion events.
 *
 * Also responds to status requests via the request/reply pattern.
 */

import { BaseAgent } from "../base-agent";
import type { TaskEvents } from "./events";
import type { EventBus } from "../../events";

export const WorkerAgent =
  <TEvents extends TaskEvents = TaskEvents>
  (options: { id: string; name: string; bus: EventBus<TEvents> }) => {

  let activeTasks = 0;

  const sleep = (ms: number): Promise<void> => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return BaseAgent<TaskEvents>({
    ...options,
    setup: (agent) => {
      // -----------------------------------------------------------------------
      // Process assigned tasks
      // -----------------------------------------------------------------------
      agent.on("task:assigned", async (event) => {
        const { taskId, assignee, description } = event.payload;

        // Only handle tasks assigned to this worker
        if (assignee !== options.id) return;

        activeTasks++;
        console.log(
          `⚙️  [${options.name}] Starting task ${taskId}: "${description}"`,
        );

        try {
          // Simulate work with progress updates
          for (let percent = 25; percent <= 75; percent += 25) {
            await sleep(100); // simulate async work
            await agent.emit("task:progress", {
              taskId,
              percent,
              message: `Processing step ${percent / 25}/3...`,
            });
          }

          await sleep(100);

          // Task completed
          await agent.emit("task:completed", {
            taskId,
            result: `Finished "${description}" successfully`,
          });

          console.log(`⚙️  [${options.name}] Completed task ${taskId}`);
        } catch (err) {
          await agent.emit("task:failed", {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeTasks--;
        }
      });

      // -----------------------------------------------------------------------
      // Respond to status requests (request/reply pattern)
      // -----------------------------------------------------------------------
      agent.on("worker:status:request", async (event) => {
        const { workerId } = event.payload;

        // Only respond if they're asking about us
        if (workerId !== options.id) return;

        await agent.reply(event, {
          workerId: options.id,
          activeTasks: activeTasks,
          state: activeTasks > 0 ? "busy" : "idle",
        } satisfies TaskEvents["worker:status:reply"]);
      });
    },
  });
}
