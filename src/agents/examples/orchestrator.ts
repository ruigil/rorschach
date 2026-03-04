/**
 * OrchestratorAgent — receives submitted tasks, breaks them into sub-tasks,
 * assigns them to workers, and tracks completion.
 */

import { BaseAgent } from "../base-agent";
import type { TaskEvents } from "./events";
import type { EventBus } from "../../events";

export const OrchestratorAgent = 
  <TEvents extends TaskEvents = TaskEvents>
  (options: { id: string; name: string; bus: EventBus<TEvents> }) => {
  
  /** Track which sub-tasks belong to the current job */
  const pendingTasks = new Set<string>();

  /** All completed task IDs for the job summary */
  let completedTasks: string[] = [];

  // -------------------------------------------------------------------------
  // Task decomposition (simulated)
  // -------------------------------------------------------------------------

  const decompose = (description: string): Array<{
    taskId: string;
    assignee: string;
    description: string;
  }> => {
    // Simulate splitting into 2 sub-tasks
    return [
      {
        taskId: `task-${Date.now()}-1`,
        assignee: "worker-1",
        description: `[Part 1] Research: ${description}`,
      },
      {
        taskId: `task-${Date.now()}-2`,
        assignee: "worker-2",
        description: `[Part 2] Execute: ${description}`,
      },
    ];
  }

  return BaseAgent<TaskEvents>({
    ...options,
    setup: (agent) => {
      // -----------------------------------------------------------------------
      // Listen for new task submissions
      // -----------------------------------------------------------------------
      agent.on("task:submitted", async (event) => {
        const { description } = event.payload;
        console.log(
          `🎯 [Orchestrator] Received task: "${description}" — splitting into sub-tasks`,
        );

        // Simulate breaking a task into sub-tasks
        const subTasks = decompose(description);

        for (const sub of subTasks) {
          pendingTasks.add(sub.taskId);
          await agent.emit("task:assigned", {
            taskId: sub.taskId,
            assignee: sub.assignee,
            description: sub.description,
          });
        }
      });

      // -----------------------------------------------------------------------
      // Listen for task completions
      // -----------------------------------------------------------------------
      agent.on("task:completed", async (event) => {
        const { taskId, result } = event.payload;
        console.log(
          `✅ [Orchestrator] Task ${taskId} completed: ${result}`,
        );

        pendingTasks.delete(taskId);
        completedTasks.push(taskId);

        if (pendingTasks.size === 0) {
          await agent.emit("job:completed", {
            taskIds: [...completedTasks],
            summary: `All ${completedTasks.length} sub-tasks finished successfully.`,
          });
          completedTasks = [];
        }
      });

      // -----------------------------------------------------------------------
      // Listen for task failures
      // -----------------------------------------------------------------------
      agent.on("task:failed", (event) => {
        const { taskId, error } = event.payload;
        console.error(
          `❌ [Orchestrator] Task ${taskId} failed: ${error}`,
        );
        pendingTasks.delete(taskId);
        // In a real system: retry, reassign, or escalate
      });

      // -----------------------------------------------------------------------
      // Handle worker status requests (request/reply demo)
      // -----------------------------------------------------------------------
      agent.on("worker:status:request", async (event) => {
        // Forward — in a real system this would query worker state
        console.log(
          `🔍 [Orchestrator] Status requested for worker: ${event.payload.workerId}`,
        );
      });
    },
  });
}
