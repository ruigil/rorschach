/** Barrel export for the interface module. */

export { InterfaceAgent } from "./interface-agent";
export type { InterfaceAgentOptions } from "./interface-agent";

export { HttpAdapter } from "./adapters/http-adapter";
export type { HttpAdapterOptions } from "./adapters/http-adapter";

export { WebSocketAdapter } from "./adapters/websocket-adapter";
export type { WebSocketAdapterOptions } from "./adapters/websocket-adapter";

export type {
  InterfaceAdapter,
  InterfaceMessage,
  InterfaceResponse,
  InterfaceEvents,
  MessageHandler,
} from "./types";
