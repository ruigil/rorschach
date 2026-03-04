# Project Brief: Rorschach

## Overview
Rorschach is a modern agentic system framework built on an async event bus. Agents communicate asynchronously through typed events, enabling decoupled, scalable multi-agent architectures.

## Core Requirements
1. **Async Event Bus** — In-memory, type-safe pub/sub with support for wildcards, priority, and middleware
2. **Agent Abstraction** — BaseAgent class with lifecycle management, auto trace propagation, and convenient pub/sub helpers
3. **Request/Reply Pattern** — Built-in support for agents to ask questions and receive typed responses
4. **Distributed Tracing** — traceId + parentId for reconstructing causal event chains across agents
5. **Middleware Pipeline** — Koa-style composable middleware for logging, filtering, dead letter handling

## Tech Stack
- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Dependencies:** Zero runtime dependencies for the core event bus
- **Testing:** bun:test

## Goals
- Type-safe event contracts between agents
- Error isolation (one handler failure doesn't break others)
- Full observability into agent communication via traces
- Easy to extend with new agents, middleware, and event types
