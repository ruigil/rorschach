/**
 * LoggerAgent — subscribes to all events ("*") and logs them.
 *
 * Useful for observability and debugging the event flow between agents.
 */

import { BaseAgent } from "../base-agent";
import type { BaseEventMap, EventEnvelope } from "../../events/types";
import type { EventBus } from "../../events";

export const LoggerAgent = 
  <TEvents extends BaseEventMap = BaseEventMap>
  (options: { id: string; name: string; bus: EventBus<TEvents> }) => {
  
  let eventLog: EventEnvelope[] = [];

  const agent = BaseAgent<TEvents>({
    ...options,
    setup: (base) => {
      base.on("*" as any, (event: EventEnvelope) => {
        // Skip internal reply channels to reduce noise
        if (event.type.startsWith("__reply__:")) return;

        eventLog.push(event);

        const indent = event.parentId ? "  ↳ " : "";
        const trace = event.traceId.slice(0, 8);
        const corr = event.correlationId
          ? ` corr=${event.correlationId.slice(0, 8)}`
          : "";

        console.log(
          `📋 ${indent}[${event.source}] ${event.type} ` +
            `(trace=${trace}${corr})`,
        );
      });
    },
  });

  /** Get the full event log (useful for testing / inspection). */
  const getLog = (): ReadonlyArray<EventEnvelope> => {
    return eventLog;
  }

  /** Get events belonging to a specific trace. */
  const getTrace = (traceId: string): EventEnvelope[] => {
    return eventLog.filter((e) => e.traceId === traceId);
  }

  /** Clear the internal log. */
  const clearLog = (): void => {
    eventLog = [];
  }

  return {
    ...agent,
    getLog,
    getTrace,
    clearLog,
  }
}
