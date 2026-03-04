/**
 * WebSocketAdapter — A duplex interface adapter using Bun's native WebSocket support.
 *
 * Features:
 *   - Inbound: Receives messages from connected clients → routes to message handler
 *   - Outbound: Sends server-initiated push messages to specific sessions or broadcasts
 *   - Session management: Maps sessionId → WebSocket connections
 *   - Serves the chat.html page and handles WebSocket upgrades on the same port
 *
 * Protocol (JSON messages):
 *   Client → Server:
 *     { "type": "chat", "message": "...", "sessionId"?: "..." }
 *
 *   Server → Client:
 *     { "type": "response", "content": "...", "sessionId": "..." }
 *     { "type": "notification", "content": "...", "sessionId": "..." }
 *     { "type": "error", "content": "...", "sessionId": "..." }
 *     { "type": "session", "sessionId": "..." }  (sent on connect)
 *
 * Zero runtime dependencies — uses Bun's native WebSocket support.
 */

import type {
  MessageHandler,
  InterfaceAdapter,
  InterfaceResponse,
} from "../types";

// ---------------------------------------------------------------------------
// WebSocketAdapter Options
// ---------------------------------------------------------------------------

export type WebSocketAdapterOptions = {
  /** Port to listen on (default: 3001) */
  port?: number;

  /** Hostname to bind to (default: "0.0.0.0") */
  hostname?: string;

  /** Directory to serve static files from (optional) */
  staticDir?: string;

  /** Maximum message size in bytes (default: 64KB) */
  maxPayloadLength?: number;

  /** Idle timeout in seconds (default: 120) */
  idleTimeout?: number;
};

// ---------------------------------------------------------------------------
// Internal types for Bun WebSocket data
// ---------------------------------------------------------------------------

type WSData = {
  sessionId: string;
};

// ---------------------------------------------------------------------------
// WebSocketAdapter Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebSocket interface adapter using Bun's native WebSocket support.
 *
 * @example
 * ```ts
 * const ws = WebSocketAdapter({ port: 3001 });
 * // Used by InterfaceAgent — don't call start() directly
 * ```
 */
export const WebSocketAdapter = (
  options: WebSocketAdapterOptions = {},
): InterfaceAdapter => {
  const {
    port = 3001,
    hostname = "0.0.0.0",
    staticDir,
    maxPayloadLength = 64 * 1024,
    idleTimeout = 120,
  } = options;

  let server: ReturnType<typeof Bun.serve> | null = null;
  let messageHandler: MessageHandler | null = null;

  /** Map sessionId → Set of active WebSocket connections */
  const connections = new Map<string, Set<any>>();

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  const addConnection = (sessionId: string, ws: any): void => {
    let sessionConns = connections.get(sessionId);
    if (!sessionConns) {
      sessionConns = new Set();
      connections.set(sessionId, sessionConns);
    }
    sessionConns.add(ws);
  };

  const removeConnection = (sessionId: string, ws: any): void => {
    const sessionConns = connections.get(sessionId);
    if (sessionConns) {
      sessionConns.delete(ws);
      if (sessionConns.size === 0) {
        connections.delete(sessionId);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Static file serving
  // -------------------------------------------------------------------------

  const handleStatic = async (pathname: string): Promise<Response | null> => {
    if (!staticDir) return null;

    const filePath = (pathname === "/" || pathname === "") ? staticDir + "/chat.html": staticDir + pathname;

    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    } catch {
      // File not found
    }

    return null;
  };

  // -------------------------------------------------------------------------
  // Adapter interface
  // -------------------------------------------------------------------------

  const start = async (handler: MessageHandler): Promise<void> => {
    messageHandler = handler;

    server = Bun.serve({
      port,
      hostname,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // Upgrade WebSocket connections
        if (url.pathname === "/ws") {
          const sessionId =
            url.searchParams.get("sessionId") ?? crypto.randomUUID();

          const upgraded = server.upgrade(req, {
            data: { sessionId } satisfies WSData,
          });

          if (upgraded) return undefined as unknown as Response;

          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Health check
        if (req.method === "GET" && url.pathname === "/health") {
          return new Response(
            JSON.stringify({
              status: "ok",
              adapter: "websocket",
              connections: connections.size,
              uptime: process.uptime(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Static files
        const staticResponse = await handleStatic(url.pathname);
        if (staticResponse) return staticResponse;

        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        maxPayloadLength,
        idleTimeout,

        open(ws) {
          const { sessionId } = ws.data as WSData;
          addConnection(sessionId, ws);

          // Send session confirmation to client
          ws.send(
            JSON.stringify({
              type: "session",
              sessionId,
            }),
          );

          console.log(
            `🔌 [WebSocketAdapter] Client connected (session: ${sessionId})`,
          );
        },

        async message(ws, rawMessage) {
          if (!messageHandler) return;

          const { sessionId } = ws.data as WSData;

          try {
            const text = typeof rawMessage === "string"
              ? rawMessage
              : new TextDecoder().decode(rawMessage as unknown as ArrayBuffer);

            const data = JSON.parse(text) as { type?: string; message?: string };

            // Only handle "chat" messages
            if (data.type !== "chat" || !data.message) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  content:
                    'Invalid message format. Expected: { "type": "chat", "message": "..." }',
                  sessionId,
                }),
              );
              return;
            }

            // Route through the message handler (interface agent)
            const response = await messageHandler({
              content: data.message,
              source: "websocket",
              sessionId,
            });

            // Send response back to the client
            ws.send(
              JSON.stringify({
                type: response.type ?? "response",
                content: response.content,
                sessionId: response.sessionId,
              }),
            );
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            ws.send(
              JSON.stringify({
                type: "error",
                content: errorMessage,
                sessionId,
              }),
            );
          }
        },

        close(ws) {
          const { sessionId } = ws.data as WSData;
          removeConnection(sessionId, ws);
          console.log(
            `🔌 [WebSocketAdapter] Client disconnected (session: ${sessionId})`,
          );
        },
      },
    });

    console.log(
      `🔌 [WebSocketAdapter] Listening on ws://${hostname}:${port}/ws`,
    );
  };

  const stop = async (): Promise<void> => {
    if (server) {
      server.stop(true);
      server = null;
      messageHandler = null;
      connections.clear();
      console.log(`🔌 [WebSocketAdapter] Stopped`);
    }
  };

  // -------------------------------------------------------------------------
  // Duplex: Send to specific session
  // -------------------------------------------------------------------------

  const send = async (
    sessionId: string,
    response: InterfaceResponse,
  ): Promise<boolean> => {
    const sessionConns = connections.get(sessionId);
    if (!sessionConns || sessionConns.size === 0) return false;

    const message = JSON.stringify({
      type: response.type ?? "notification",
      content: response.content,
      sessionId: response.sessionId,
    });

    for (const ws of sessionConns) {
      try {
        ws.send(message);
      } catch {
        // Connection might be stale — remove it
        removeConnection(sessionId, ws);
      }
    }

    return true;
  };

  // -------------------------------------------------------------------------
  // Duplex: Broadcast to all sessions
  // -------------------------------------------------------------------------

  const broadcast = async (response: InterfaceResponse): Promise<number> => {
    const message = JSON.stringify({
      type: response.type ?? "notification",
      content: response.content,
      sessionId: response.sessionId,
    });

    let delivered = 0;
    for (const [sessionId, sessionConns] of connections) {
      for (const ws of sessionConns) {
        try {
          ws.send(message);
          delivered++;
        } catch {
          removeConnection(sessionId, ws);
        }
      }
    }

    return delivered;
  };

  return {
    name: "websocket",
    duplex: true,
    start,
    stop,
    send,
    broadcast,
  };
};
