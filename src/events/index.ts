/** Barrel export for the events module. */
export { EventBus } from "./event-bus";
export {
  loggingMiddleware,
  deadLetterMiddleware,
  filterMiddleware,
} from "./middleware";

export type {
  BaseEventMap,
  EmitOptions,
  EventEnvelope,
  EventHandler,
  Middleware,
  Subscription,
  SubscriptionOptions,
} from "./types";

export type {
  LoggingOptions,
  DeadLetterHandler,
  EventPredicate,
} from "./middleware";
