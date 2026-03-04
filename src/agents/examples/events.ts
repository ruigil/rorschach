/**
 * Shared event map for the example agent system.
 *
 * Defines the contract between Orchestrator, Worker, and any other agents.
 */

export type TaskEvents = {
  /** A user/external system submits a new task */
  "task:submitted": {
    description: string;
    priority?: number;
  };

  /** Orchestrator breaks a task into sub-tasks and assigns them */
  "task:assigned": {
    taskId: string;
    assignee: string;
    description: string;
  };

  /** Worker reports progress on an assigned task */
  "task:progress": {
    taskId: string;
    percent: number;
    message: string;
  };

  /** Worker has completed the task */
  "task:completed": {
    taskId: string;
    result: string;
  };

  /** Worker failed to complete the task */
  "task:failed": {
    taskId: string;
    error: string;
  };

  /** Orchestrator signals that the overall job is done */
  "job:completed": {
    taskIds: string[];
    summary: string;
  };

  /** Request/reply: Orchestrator asks a worker about its status */
  "worker:status:request": {
    workerId: string;
  };

  /** Worker replies with its status */
  "worker:status:reply": {
    workerId: string;
    activeTasks: number;
    state: "idle" | "busy";
  };
}
