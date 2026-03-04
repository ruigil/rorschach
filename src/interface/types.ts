/**
 * Core type definitions for the interface module.
 *
 * The interface layer bridges external inputs (HTTP, WebSocket, CLI, etc.)
 * to the internal agent system via the EventBus. Adapters handle transport
 * protocols; the InterfaceAgent coordinates the flow.
 *
 * Key concepts:
 *   - InterfaceAdapter — Transport-specific listener (HTTP, WS, etc.)
 *   - InterfaceMessage — Normalized inbound message from any source
 *   - InterfaceResponse — Normalized outbound response
 *   - InterfaceEvents — Events emitted on the bus for observability
 */

// ---------------------------------------------------------------------------
// Interface Message (inbound — external → internal)
// ---------------------------------------------------------------------------

export type InterfaceMessage = {
  /** The text content of the message */
  readonly content: string;

  /** Which adapter received this message (e.g. "http", "websocket", "cli") */
  readonly source: string;

  /** Session identifier — routes to the correct conversation in CognitiveAgent */
  readonly sessionId: string;

  /** Adapter-specific metadata (e.g. HTTP headers, IP address, etc.) */
  readonly metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Interface Response (outbound — internal → external)
// ---------------------------------------------------------------------------

export type InterfaceResponse = {
  /** The text content of the response */
  readonly content: string;

  /** The session this response belongs to */
  readonly sessionId: string;

  /** Optional type hint for the client (e.g. "chat", "notification", "error") */
  readonly type?: string;

  /** Additional metadata for the adapter */
  readonly metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Message Handler (adapter → interface agent)
// ---------------------------------------------------------------------------

/**
 * Function signature for handling inbound messages.
 * Called by adapters when they receive external input.
 * Returns a response to be sent back through the adapter.
 */
export type MessageHandler = (
  message: InterfaceMessage,
) => Promise<InterfaceResponse>;

// ---------------------------------------------------------------------------
// Interface Adapter — Transport layer interface
// ---------------------------------------------------------------------------

/**
 * A interface adapter handles a specific transport protocol.
 *
 * Simplex adapters (e.g. HTTP) only support request/response.
 * Duplex adapters (e.g. WebSocket) also support server-initiated push.
 */
export type InterfaceAdapter = {
  /** Human-readable adapter name (e.g. "http", "websocket") */
  readonly name: string;

  /** Whether this adapter supports server-initiated outbound messages */
  readonly duplex: boolean;

  /**
   * Start listening for external messages.
   * The adapter calls `handler` whenever it receives an inbound message.
   */
  start(handler: MessageHandler): Promise<void>;

  /** Stop listening and clean up resources */
  stop(): Promise<void>;

  /**
   * Send a message to a specific session (duplex adapters only).
   * Returns true if the message was delivered, false if the session
   * has no active connection.
   */
  send?(sessionId: string, response: InterfaceResponse): Promise<boolean>;

  /**
   * Broadcast a message to all connected sessions (duplex adapters only).
   * Returns the number of sessions the message was delivered to.
   */
  broadcast?(response: InterfaceResponse): Promise<number>;
};

// ---------------------------------------------------------------------------
// Interface Events — Bus events for observability
// ---------------------------------------------------------------------------

export type InterfaceEvents = {
  /** An external message was received by an adapter */
  "interface:message:received": {
    content: string;
    sessionId: string;
    source: string;
    adapter: string;
  };

  /** A response was sent back through an adapter */
  "interface:response:sent": {
    content: string;
    sessionId: string;
    adapter: string;
    durationMs: number;
  };

  /** A push message was sent to a connected client (duplex adapters) */
  "interface:push:sent": {
    content: string;
    sessionId: string;
    adapter: string;
    type?: string;
  };

  /**
   * Inbound chat event: interface agent emits this as a request,
   * and a cognitive agent (or any handler) replies with the response.
   */
  "interface:chat": {
    content: string;
    sessionId: string;
    source: string;
  };

  /** Reply event for interface:chat */
  "interface:chat:reply": {
    content: string;
    sessionId: string;
  };

  /**
   * Push event: any agent can emit this to send a message to a connected
   * client through duplex adapters. The interface agent routes it.
   */
  "interface:push": {
    content: string;
    sessionId: string;
    type?: string;
  };

  /** An adapter started listening */
  "interface:adapter:started": {
    adapter: string;
    duplex: boolean;
  };

  /** An adapter stopped listening */
  "interface:adapter:stopped": {
    adapter: string;
  };

  /** An error occurred in the interface layer */
  "interface:error": {
    error: string;
    sessionId?: string;
    adapter?: string;
  };
};
