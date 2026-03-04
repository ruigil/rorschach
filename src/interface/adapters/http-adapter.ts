/**
 * HttpAdapter — A simplex interface adapter using Bun.serve().
 *
 * Provides a REST API for receiving external messages:
 *   - POST /chat   — Send a message, receive a response
 *   - GET  /health — Health check
 *   - GET  /       — Serves static files (e.g. chat.html) if configured
 *
 * This adapter is simplex (request/response only). It does not support
 * server-initiated push. For duplex communication, use the WebSocket adapter.
 *
 * Zero runtime dependencies — uses Bun's native HTTP server.
 */

import type { MessageHandler, InterfaceAdapter } from "../types";

// ---------------------------------------------------------------------------
// HttpAdapter Options
// ---------------------------------------------------------------------------

export type HttpAdapterOptions = {
  /** Port to listen on (default: 3000) */
  port?: number;

  /** Hostname to bind to (default: "0.0.0.0") */
  hostname?: string;

  /** Allowed CORS origins (default: ["*"]) */
  corsOrigins?: string[];

  /** Path prefix for API routes (default: "") */
  pathPrefix?: string;

  /** Directory to serve static files from (optional) */
  staticDir?: string;
};

// ---------------------------------------------------------------------------
// HttpAdapter Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP interface adapter using Bun.serve().
 *
 * @example
 * ```ts
 * const http = HttpAdapter({ port: 3000 });
 * // Used by InterfaceAgent — don't call start() directly
 * ```
 */
export const HttpAdapter = (options: HttpAdapterOptions = {}): InterfaceAdapter => {
  const {
    port = 3000,
    hostname = "0.0.0.0",
    corsOrigins = ["*"],
    pathPrefix = "",
    staticDir,
  } = options;

  let server: ReturnType<typeof Bun.serve> | null = null;
  let messageHandler: MessageHandler | null = null;

  // -------------------------------------------------------------------------
  // CORS headers
  // -------------------------------------------------------------------------

  const corsHeaders = (origin?: string | null): Record<string, string> => {
    const allowedOrigin = corsOrigins.includes("*")
      ? "*"
      : (origin && corsOrigins.includes(origin) ? origin : "");

    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
  };

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  const handleChat = async (req: Request): Promise<Response> => {
    if (!messageHandler) {
      return new Response(
        JSON.stringify({ error: "Adapter not initialized" }),
        { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
      );
    }

    try {
      const body = await req.json() as { message?: string; sessionId?: string };

      if (!body.message || typeof body.message !== "string") {
        return new Response(
          JSON.stringify({ error: "Missing or invalid 'message' field" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
        );
      }

      const sessionId = body.sessionId ?? crypto.randomUUID();

      const response = await messageHandler({
        content: body.message,
        source: "http",
        sessionId,
        metadata: {
          ip: req.headers.get("x-forwarded-for") ?? "unknown",
          userAgent: req.headers.get("user-agent") ?? "unknown",
        },
      });

      return new Response(
        JSON.stringify({
          response: response.content,
          sessionId: response.sessionId,
          type: response.type,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
      );
    }
  };

  const handleHealth = (req: Request): Response => {
    return new Response(
      JSON.stringify({
        status: "ok",
        adapter: "http",
        uptime: process.uptime(),
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
    );
  };

  const handleStatic = async (pathname: string, req: Request): Promise<Response | null> => {
    if (!staticDir) return null;

    // Serve index file for root
    const filePath = pathname === "/" || pathname === ""
      ? staticDir + "/chat.html"
      : staticDir + pathname;

    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { ...corsHeaders(req.headers.get("origin")) },
        });
      }
    } catch {
      // File not found — fall through
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
      fetch: async (req) => {
        const url = new URL(req.url);
        const pathname = url.pathname.replace(pathPrefix, "") || "/";

        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: corsHeaders(req.headers.get("origin")),
          });
        }

        // API routes
        if (req.method === "POST" && pathname === "/chat") {
          return handleChat(req);
        }

        if (req.method === "GET" && pathname === "/health") {
          return handleHealth(req);
        }

        // Static file serving
        const staticResponse = await handleStatic(pathname, req);
        if (staticResponse) return staticResponse;

        // 404
        return new Response(
          JSON.stringify({ error: "Not Found" }),
          { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } },
        );
      },
    });

    console.log(`🌐 [HttpAdapter] Listening on http://${hostname}:${port}`);
  };

  const stop = async (): Promise<void> => {
    if (server) {
      server.stop(true);
      server = null;
      messageHandler = null;
      console.log(`🌐 [HttpAdapter] Stopped`);
    }
  };

  return {
    name: "http",
    duplex: false,
    start,
    stop,
  };
};
