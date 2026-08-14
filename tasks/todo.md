# Task List: Recursive Capability Composition (SCR)

## Phase 0: Types & Foundation
- [x] **Task 0.1**: Define Unified SCR Type Specifications (`src/types/scr.ts`)
- [x] **Task 0.2**: Extend Request Context for SCR Capabilities (`src/system/context/request.ts`, `src/types/scr.ts`)
- [x] **Task 0.3**: Implement JSON Schema Validator (`src/system/schema-validator.ts`, `src/system/index.ts`)

### Checkpoint: Foundation
- [x] All new types compile.
- [x] Context serialization functions round-trip without loss of metadata.
- [x] `validateSchema` compiles and passes all validator unit tests.

---

## Phase 1: Central Registry & Dynamic Discovery
- [x] **Task 1.1**: Create Registry Configuration & Types (`src/plugins/registry/registry.config.ts`, `src/plugins/registry/types.ts`)
- [x] **Task 1.2**: Implement `SCRRegistry` Actor (`src/plugins/registry/registry-actor.ts`)
- [x] **Task 1.3**: Implement Node-Local `ResolutionCache` (`src/system/scr/cache.ts`)
- [x] **Task 1.4**: Implement Stateless `invokeSCR` Engine (`src/system/scr/invoker.ts`)
- [x] **Task 1.5**: Implement Discovery Meta-Tools (`src/plugins/registry/meta-tools.ts`)
- [x] **Task 1.6**: Build Registry Plugin Bootstrapper (`src/plugins/registry/registry.plugin.ts`)
- [x] **Task 1.7**: Refactor `createPluginFactory` for SCR registrations (`src/system/factory.ts`)
- [x] **Task 1.8**: Workflows Startup Scanning Hook (`src/plugins/workflows/workflows.plugin.ts`, `src/plugins/workflows/workflow-store.ts`)
- [x] **Task 1.9**: Implement `UserBudgetActor` (`src/plugins/observability/user-budget.ts`)
- [x] **Task 1.10**: Implement `UserBudgetSupervisor` (`src/plugins/observability/user-budget.ts`, `src/plugins/observability/observability.plugin.ts`)
- [x] **Task 1.11**: Implement `SCRGCSweeper` GC Task (`src/system/scr/gc-sweeper.ts`)

### Checkpoint: Registry & Discovery
- [x] Code builds without errors.
- [x] Registered tools/agents/workflows publish to `SCRRegistrationTopic` on start.
- [x] Local cache matches published registrations dynamically.
- [x] UserBudgetSupervisor and GC Sweeper initialize successfully.

---

## Phase 2: Leaf (Tool) Integration
- [x] **Task 2.1**: Implement Direct Leaf Tool Routing (`src/system/scr/invoker.ts`)
- [x] **Task 2.2**: Add Input Schema Validation Membrane (`src/system/scr/invoker.ts`, `src/system/agent/tool-utils.ts`)
- [x] **Task 2.3**: Add Output Schema Validation Membrane (`src/system/scr/invoker.ts`, `src/system/agent/tool-utils.ts`)

### Checkpoint: Leaf Integration
- [x] Invoking leaf URNs works successfully.
- [x] Incorrect input/output payloads are rejected at the membrane boundary.

---

## Phase 3: Reasoner (Agent) SCR Conversion
- [x] **Task 3.1**: Build `AgentSpawnerActor` Skeleton (`src/system/agent/spawner.ts`)
- [x] **Task 3.2**: Implement Ephemeral `SCRAgentRunner` Core Execution (`src/system/agent/agent-runner.ts`, `src/system/agent/agent-loop.ts`)
- [x] **Task 3.3**: Implement Channel-Agnostic Ambient Streaming (`src/system/agent/agent-runner.ts`)
- [x] **Task 3.4**: Implement Request Context Persistence & Restore (`src/system/agent/agent-runner.ts`)
- [x] **Task 3.5**: Implement Job Mapping & Resumption in `AgentSpawnerActor` (`src/system/agent/spawner.ts`)
- [x] **Task 3.6**: Integrate Usage Budget Accounting in `SCRAgentRunner` (`src/system/agent/agent-runner.ts`)
- [x] **Task 3.7**: Implement Dynamic Pull-Based Discovery (`src/system/agent/agent-loop.ts`)
- [x] **Task 3.8**: Refactor `SessionManager` for Ingress Execution (`src/plugins/cognitive/session-manager.ts`)

### Checkpoint: Reasoners Unified
- [x] Agents can be invoked recursively (spawning ephemeral sub-runners).
- [x] Agents discover, bind, and call capabilities dynamically via discovery meta-tools.
- [x] `SessionManager` routes user messages directly to root agent via request-scoped execution.

---

## Phase 4: Graph (Workflow) & Operator Integration
- [x] **Task 4.1**: Build `WorkflowManager` Spawner Actor Skeleton (`src/plugins/workflows/workflow-manager.ts`)
- [x] **Task 4.2**: Implement `SCRWorkflowRunner` Core Execution (`src/plugins/workflows/workflow-run-executor.ts`)
- [x] **Task 4.3**: Adapt Task Execution to call URNs via `invokeSCR` (`src/plugins/workflows/workflow-task-executor.ts`)
- [x] **Task 4.4**: Implement Job Mapping & Resumption in `WorkflowManager` (`src/plugins/workflows/workflow-manager.ts`)
- [x] **Task 4.5**: Create `OperatorSpawnerActor` Skeleton (`src/plugins/workflows/operator-spawner.ts`)
- [x] **Task 4.6**: Implement Sequence & Parallel Operators (`src/plugins/workflows/operator-runner.ts`)
- [x] **Task 4.7**: Implement Map & Branch Operators (`src/plugins/workflows/operator-runner.ts`)
- [x] **Task 4.8**: Implement Retry & Fallback Operators (`src/plugins/workflows/operator-runner.ts`)
- [x] **Task 4.9**: Update Workflows Agent Prompt & Planning Schema (`src/plugins/workflows/workflows-agent.ts`)

### Checkpoint: Recursive Composition
- [x] Workflows can execute child workflows.
- [x] Operators (map, retry, branch) function correctly.
- [x] Workflows agent generates plan steps mapping to URNs.

---

## Phase 5: Zero Backward Compatibility (End State)

> Audit note (2026-08-13): gaps found beyond the original list — (a) the agent loop/`invokeTool`
> engine is still legacy (Task 5.11); (b) notebook/googleapis/coding/workflows tools have NO
> `scr:leaf:*` descriptors (part of Task 5.1); (c) `SessionManager` still runs per-user session
> actors (Task 5.12); (d) `_toolRegistered`/`_toolUnregistered` + registry meta-tools shim +
> dangling `cognitive.agents.*` protocol remain (Task 5.13); (e) `dynamic-agent.ts` and
> `agent-registry.ts` are already deleted, so Task 5.10 is re-scoped.

> Execution order (see plan "Phase 5 Execution Order & Dependency Lanes"): do **5.1+5.2 together**,
> then **5.11 → 5.13 → 5.8 → 5.10**; run 5.3 (after 5.1+5.2; loop tests after 5.11), 5.12 (after
> 5.11), and 5.9 (anywhere before 5.10) in parallel. Never delete a legacy type the agent loop still
> imports; never convert a tool actor without removing the adapter in the same pass.

- [x] **Task 5.1**: Migrate Tool Actors to Unified SCR Protocol (`src/plugins/tools/`, `src/plugins/notebook/tools/`, `src/plugins/googleapis/tools/`, `src/plugins/coding/`, `src/plugins/config/`, `src/plugins/memory/`, `src/plugins/workflows/workflow-tools.ts`)
  - [x] Convert `tools` plugin actors (web-search, vision, audio, video, cron, pdf, fetch-file, tool-status) to `SCRInvokeMsg`/`SCRReply` (`msg.input`, urn branching, `result`/`error`/`pending`).
  - [x] Convert `notebook/tools/*` (journal, search, todos, tracker) to SCR protocol.
  - [x] Convert `googleapis/tools/*` (calendar, drive, gmail, youtube) to SCR protocol (keep auth ask).
  - [x] Convert `coding` page-tools.ts + project-shell.ts (keep HTTP `http.request` path).
  - [x] Convert `config/manager.ts` and `memory/*` message unions off `ToolInvokeMsg`.
  - [x] Convert `workflows/workflow-tools.ts` handler to `msg.input` + SCR replies.
  - [x] **Add SCR leaf descriptor registration** (`blueprint.tools` or manual `SCRRegistrationTopic` publish, direct actor-ref target) for notebook/googleapis/coding/workflows tools — currently only agent `ToolCollection`s exist and no `scr:leaf:*` URNs resolve.
- [x] **Task 5.2**: Remove `SCRToolAdapterActor` Bridge (`src/system/factory.ts`)
  - [x] Delete `SCRToolAdapterActor` (factory.ts:13–57).
  - [x] Remove adapter spawn at factory.ts:357 and :712; set `descriptor.target` to the direct tool ref.
- [x] **Task 5.3**: Update Tool Unit and Integration Tests (`src/tests/`)
  - [x] Convert audio-actor, fetch-file, vision-actor, tools-plugin, tool-status, cron-jobs, googleapis-drive, memory-store-concurrent, project-shell tests to `ask<SCRInvokeMsg, SCRReply>`.
  - [x] Convert config-unified-integration, node-secrets-audit, plugins tests (legacy `{ type:'invoke' }` probes).
  - [x] Convert workflow-io-artifacts, workflows-store, workflow-run-executor, workflow-task-executor mocks to SCR (URN descriptors instead of `ToolCollection`).
  - [x] Fix `scr-phase3.test.ts` mock leaf actors: `ActorDef<ToolMsg>` → `ActorDef<SCRInvokeMsg>` replying `result`/`pending`; drop legacy `Tool` injection into `internalTools`.
  - [x] Rewrite `agent-loop.test.ts` for URN-based loop (see Task 5.11).
  - [x] Delete `src/tests/invoke-tool.test.ts` (tests the retired `invokeTool` primitive).
- [x] **Task 5.4**: WebSocket Frame Ingress Routing in `WorkflowManager` (`src/plugins/workflows/workflow-manager.ts`, `src/plugins/workflows/workflows.plugin.ts`)
- [x] **Task 5.5**: HTTP Ingress Routing in `WorkflowManager` (`src/plugins/workflows/workflows.routes.ts`)
- [x] **Task 5.6**: Align Frontend WebSocket Dispatcher (`src/frontend/`)
- [x] **Task 5.7**: Align Frontend UI Panels (`src/plugins/workflows/ui/`, `src/frontend/`)
- [x] **Task 5.8**: Deprecate Legacy Topics and Messages (`src/types/tools.ts`, `src/types/agents.ts`)
  - [x] Remove protocol types `ToolInvokeMsg`, `ToolMsg`, `ToolReply`, `ToolFinalReply`, `ToolCollection`, `Tool` (keep `ToolSchema`, `ToolFilter`, `ToolResultPayload`, `ToolSource`, `JobRegistryTopic`).
  - [x] `src/types/agents.ts`: remove `AgentDescriptor.internalTools?: Tool[]` (→ `agentSCRs` URN preload) and `AgentCatalogEvent`.
  - [x] Remove dead import `ToolMsg`/`ToolReply` in `src/system/scr/invoker.ts:9`.
  - [x] Remove `_toolRegistered`/`_toolUnregistered` from cognitive/notebook/coding/googleapis/workflows type unions.
  - [x] Remove `SwitchAgentTopic`/`SwitchAgentEvent` (`agent.switch`) from `cognitive/types.ts`.
  - [x] Fix stale `_toolReg` union in `src/plugins/observability/types.ts:73–74` (actor uses `_scrReg`).
  - [x] Purge followed by `rg` zero-match check + `bun run typecheck`.
- [x] **Task 5.9**: Clean Leftover Switch Mode Compatibility (`src/plugins/notebook/coach-agent.ts`, `src/system/permissions/system-tools.ts`, `src/tests/permissions-evaluator.test.ts`, `src/frontend/shell/actions.ts`, `src/frontend/webkit/runtime/connection-service.ts`)
  - [x] Remove `'cognitive_switch_mode'` from `INFRASTRUCTURE_CALLBACKS` (keep `workflows_task_complete`/`workflows_task_block`).
  - [x] Remove `permissions-evaluator.test.ts:9` assertion.
  - [x] Remove `switch_mode` prompt line in coach-agent.ts:30 (→ recursive `scr:agent:*` invocation guidance).
  - [x] Remove `cognitive.switchMode` send in shell/actions.ts `switchMode`, connection-service.ts:75, dispatcher `modeChanged`; decide tab behavior (see plan "Open decision for implementer").
  - [x] Rebuild bundles: `bun run build` (static/js are artifacts — never hand-edit).
- [x] **Task 5.10**: Delete Legacy Actors and Verification (`src/system/agent/tool-utils.ts`, `src/system/index.ts`, `src/system/agent/agent-runner.ts`) — NOTE: `dynamic-agent.ts`/`agent-registry.ts` already deleted
  - [x] Remove `invokeTool` primitive (+ `src/tests/invoke-tool.test.ts`); update `system/index.ts` exports.
  - [x] Drop or SCR-ify `scrCompleteHelperActor` (agent-runner.ts:43–63).
  - [x] Final: `bun run typecheck`, `bun test`, `bun run build` all green.
- [x] **Task 5.11**: Convert `agentLoop` & Tool Invocation to SCR-native `invokeSCR` (`src/system/agent/agent-loop.ts`)
  - [x] `agent-loop.ts`: replace `ToolCollection`/`invokeTool`/`ToolReply` with `invokeSCR(urn, input)`; `LoopToolResultMsg.reply` → `SCRReply`; drop legacy dynamic-binding block (:515–549) and `_toolRegistered` behavior.
  - [x] `agent-runner.ts`: build tools from registered SCR descriptors + `agentSCRs` (not `internalTools`); `scr_complete` becomes SCR-native; `_toolResult` branches on `SCRReply`.
  - [x] `spawner.ts` `_jobResumed`: reply `result`/`error` (SCRReply) instead of `toolResult`/`toolError`.
  - [x] Update workflow sub-agent tool injection (`workflow-task-executor.ts`, `workflow-run-executor.ts`).
- [x] **Task 5.12**: Refactor Context Store into Persistent User History & Pass Context to Agents (`src/plugins/cognitive/session-manager.ts`, `src/plugins/cognitive/context-store.ts`, `src/system/agent/agent-runner.ts`)
  - [x] Decouple `ContextStore` from live WebSocket presence / socket teardown in `SessionManager` (drop `activeInterfaces` tracking and `JobRegistryTopic` teardown subscription).
  - [x] Maintain durable user context in KV persistence keyed by `userId`.
  - [x] Pass conversation history as context parameters (`input.history` / `input.messages`) to `invokeSCR('scr:reasoner:cognitive.chatbot')`.
  - [x] Update `SCRAgentRunner` to accept conversation history and prepend past turns into LLM context.
  - [x] Append completed user/assistant turns to persistent user context on turn completion.
- [x] **Task 5.13**: Remove Runtime `_toolRegistered`/`_toolUnregistered`, Registry Meta-Tools Shim & Dangling Catalog Protocol
  - [x] Purge `_toolRegistered`/`_toolUnregistered` from all plugin type unions + `agent-loop` + `agent-loop.test.ts`.
  - [x] `registry/meta-tools.ts`: delete legacy `toolName`/`arguments` → `toolResult` shim (SCR-only replies).
  - [x] Remove `cognitive.agents.request` (r-agents-list.ts:122) / `cognitive.agents.updated` (dispatcher.ts:67) and `CognitiveFrameType` entries in `src/types/events.ts`.

### Checkpoint: Complete Transition
- [x] All tool actors and tests migrated to new SCR protocol (5.1, 5.3).
- [x] Agent loop invokes every capability via `invokeSCR`; `ToolCollection`/`ToolReply`/`invokeTool` gone (5.11).
- [x] Notebook/googleapis/coding/workflows tools are first-class `scr:leaf:*` capabilities (5.1).
- [x] Compatibility adapters and `SCRToolAdapterActor` bridge completely removed (5.2).
- [x] `SessionManager` is request-scoped only — no per-user session actors (5.12).
- [x] Leftover `cognitive_switch_mode` references and tests cleaned (5.9).
- [x] No legacy agent/tool registration elements exist (5.8, 5.13).
- [x] Zero backward compatibility end-state achieved.
- [x] System builds (`bun run build`), tests pass (`bun test`), typechecks pass (`bun run typecheck`), and app functions end-to-end.
