# Implementation Plan: Recursive Capability Composition (SCR)

## Overview
This project transitions the entire Rorschach codebase to a single, unified recursive execution primitive: the **Single Capability Resource (SCR)**. Every task is designed to be completed in a single focused session, including explicit acceptance criteria, files likely touched, verification steps, and dependencies.

## Architecture Decisions
- **URN Scheme**: All capabilities are addressable via a unique URN of the format `scr:<kind>:<namespace>.<name>`.
- **User Budget Actor Persistence**: Keep `UserBudgetActor` instances in memory for the duration of the system lifecycle (no passivation).
- **Concurrency Throttling**: No hard limit on concurrent runners per node; we will rely purely on recursion depth and budget limits.
- **Default Recursion Limit**: Default `maxDepth` is set to 10.
- **Default Budget**: No safety default limits; run with unlimited budget unless specified by the request context.
- **Legacy Deprecation**: Purge legacy agents/tools/topics/executors completely in Phase 5 for a clean zero-backward-compatibility codebase.

---

## Task List

### Phase 0: Types & Foundation

#### Task 0.1: Define Unified SCR Type Specifications
* **Description:** Create the core TypeScript file containing the SCR schemas, URN structure, descriptors, definitions, and message payloads.
* **Acceptance criteria:**
  - [x] TypeScript types `SCRKind` (`'leaf' | 'reasoner' | 'graph' | 'operator'`), `SCRSchema`, `SCRDescriptor` (carrying URN, kind, schemas, target `ActorRef`), `SCRInvokeMsg`, and `SCRReply` compile.
  - [x] Topics `SCRRegistrationTopic` ('scr.registration'), `UsageUpdateTopic` ('scr.usage_update'), and `UserBudgetTopic` ('scr.user_budget') are defined.
* **Verification:**
  - [x] Run typescript compiler check: `bun run typecheck` and verify success.
* **Dependencies:** None
* **Files likely touched:**
  - `src/types/scr.ts` (New file)
* **Estimated scope:** S

#### Task 0.2: Extend Request Context for SCR Capabilities
* **Description:** Modify `MessageRequest` in `request.ts` to support execution metadata, budget parameters, and the channel-agnostic `streamTo` target. Define the structured streaming envelope `StreamChunk`.
* **Acceptance criteria:**
  - [x] `MessageRequest` supports `depth` (number), `maxDepth` (number), `maxTokens` (number), `maxCostUsd` (number), `supportsPending` (boolean), and `streamTo` (string).
  - [x] `createMessageRequest` sets default recursion limit configuration (`depth: 0`, `maxDepth: 10`).
  - [x] `StreamChunk` envelope is fully typed in `src/types/scr.ts`.
* **Verification:**
  - [x] Run typescript compiler check: `bun run typecheck`.
  - [x] Verify context serialization functions round-trip without loss of metadata.
* **Dependencies:** Task 0.1
* **Files likely touched:**
  - `src/system/context/request.ts`
  - `src/types/scr.ts`
* **Estimated scope:** XS

#### Task 0.3: Implement JSON Schema Validator
* **Description:** Create the self-contained validator function `validateSchema` to support input/output schema validation.
* **Acceptance criteria:**
  - [x] `validateSchema` successfully validates dynamic JSON shapes (primitives, nested objects, required arrays, fields checks) and outputs detailed validation error arrays.
  - [x] The validator is exported from the system index.
* **Verification:**
  - [x] Create `src/tests/schema-validator.test.ts` checking validation of complex nested objects and path reporting. Run `bun test src/tests/schema-validator.test.ts`.
* **Dependencies:** None
* **Files likely touched:**
  - `src/system/schema-validator.ts` (New file)
  - `src/system/index.ts`
* **Estimated scope:** S

---

### Checkpoint: Foundation
- [x] All new types compile.
- [x] Context serialization functions round-trip without loss of metadata.
- [x] `validateSchema` compiles and passes all validator unit tests.

---

### Phase 1: Central Registry & Dynamic Discovery

#### Task 1.1: Create Registry Configuration & Types
* **Description:** Setup baseline configuration keys and types for the registry plugin.
* **Acceptance criteria:**
  - [x] Config schema and types defined in `src/plugins/registry/registry.config.ts` and `src/plugins/registry/types.ts` compile.
* **Verification:**
  - [x] Run `bun run typecheck` check.
* **Dependencies:** Task 0.2
* **Files likely touched:**
  - `src/plugins/registry/registry.config.ts` (New file)
  - `src/plugins/registry/types.ts` (New file)
* **Estimated scope:** XS

#### Task 1.2: Implement `SCRRegistry` Actor
* **Description:** Build the central `SCRRegistry` actor to receive registration events on `SCRRegistrationTopic` and maintain the master in-memory directory of URNs and target spawner/actor refs.
* **Acceptance criteria:**
  - [x] `SCRRegistry` processes registry messages and maintains URN descriptors.
* **Verification:**
  - [x] Run local mock test sending registrations and confirming actor directory state matches.
* **Dependencies:** Task 1.1
* **Files likely touched:**
  - `src/plugins/registry/registry-actor.ts` (New file)
* **Estimated scope:** S

#### Task 1.3: Implement Node-Local `ResolutionCache`
* **Description:** Implement `ResolutionCache` subscribing to the retained `SCRRegistrationTopic` and `UserBudgetTopic` to keep hot maps of active URN descriptors and user budget states in memory.
* **Acceptance criteria:**
  - [x] Exposes synchronous lookup for descriptors and budget records without mailbox overhead.
* **Verification:**
  - [x] Test local cache updates immediately when a registration message is published.
* **Dependencies:** Task 1.2
* **Files likely touched:**
  - `src/system/scr/cache.ts` (New file)
* **Estimated scope:** S

#### Task 1.4: Implement Stateless `invokeSCR` Engine
* **Description:** Create the `invokeSCR` library function which synchronously checks permissions, budget, recursion depth limits, and routes the invocation to the resolved `ActorRef`.
* **Acceptance criteria:**
  - [x] `invokeSCR` evaluates local cache data, validates budget/recursion, updates enqueued context, and forwards `SCRInvokeMsg`.
* **Verification:**
  - [x] Unit tests checking recursion detection (rejection at `depth > maxDepth`) and budget overflow rejection.
* **Dependencies:** Task 1.3
* **Files likely touched:**
  - `src/system/scr/invoker.ts` (New file)
* **Estimated scope:** S

#### Task 1.5: Implement Discovery Meta-Tools
* **Description:** Create standard lookup tools `scr:tool:registry.search` and `scr:tool:registry.get` to query registry data.
* **Acceptance criteria:**
  - [x] Both discovery tools are functional and return structured descriptors.
* **Verification:**
  - [x] Verify executing search/get tools returns expected capability descriptions.
* **Dependencies:** Task 1.4
* **Files likely touched:**
  - `src/plugins/registry/meta-tools.ts` (New file)
* **Estimated scope:** S

#### Task 1.6: Build Registry Plugin Bootstrapper
* **Description:** Build `registry.plugin.ts` to instantiate the registry actor and register the meta-tools on startup.
* **Acceptance criteria:**
  - [x] The registry plugin registers itself in the factory and starts during boot.
* **Verification:**
  - [x] System starts up, spawning `SCRRegistry`.
* **Dependencies:** Task 1.5
* **Files likely touched:**
  - `src/plugins/registry/registry.plugin.ts` (New file)
* **Estimated scope:** XS

#### Task 1.7: Refactor `createPluginFactory` for SCR registrations
* **Description:** Modify `factory.ts` to publish tools, agents, and workflows to the unified `SCRRegistrationTopic` pointing to spawner or direct actor references. Remove legacy registration publishing.
* **Acceptance criteria:**
  - [x] `factory.ts` has zero references to `ToolRegistrationTopic` or legacy `AgentRegistrationTopic`.
* **Verification:**
  - [x] Ensure system boot logs confirm registration events published on startup.
* **Dependencies:** Task 1.6
* **Files likely touched:**
  - `src/system/factory.ts`
* **Estimated scope:** S

#### Task 1.8: Workflows Startup Scanning Hook
* **Description:** Add startup scanning inside the workflows plugin to read stored files from database and register current workflow URN descriptors.
* **Acceptance criteria:**
  - [x] Scans files and publishes active workflow descriptors to `SCRRegistrationTopic`.
* **Verification:**
  - [x] Verify startup triggers registration updates for existing workflows.
* **Dependencies:** Task 1.7
* **Files likely touched:**
  - `src/plugins/workflows/workflows.plugin.ts`
  - `src/plugins/workflows/workflow-store.ts`
* **Estimated scope:** S

#### Task 1.9: Implement `UserBudgetActor`
* **Description:** Build the persistent `UserBudgetActor` to load/save user budget totals and broadcast them to the retained topic `UserBudgetTopic`. No passivation of idle budget actors is required.
* **Acceptance criteria:**
  - [x] Accumulates usage updates, uses `persistencePluginAdapter`, and updates retained records.
* **Verification:**
  - [x] Verify state is saved to the database and re-loaded upon actor boot.
* **Dependencies:** Task 1.3
* **Files likely touched:**
  - `src/plugins/observability/user-budget.ts` (New file)
* **Estimated scope:** S

#### Task 1.10: Implement `UserBudgetSupervisor`
* **Description:** Create the budget supervisor actor inside the observability plugin to subscribe to `UsageUpdateTopic` deltas and spawn `UserBudgetActor` child actors on-demand.
* **Acceptance criteria:**
  - [x] Supervisor instantiates on startup and manages child lifecycles.
* **Verification:**
  - [x] Sending usage updates dynamically spawns the corresponding user budget actor.
* **Dependencies:** Task 1.9
* **Files likely touched:**
  - `src/plugins/observability/user-budget.ts`
  - `src/plugins/observability/observability.plugin.ts`
* **Estimated scope:** S

#### Task 1.11: Implement `SCRGCSweeper` GC Task
* **Description:** Create a sweep task to run hourly and clean up orphaned dynamic keys `scr.run.*` of finished/dead runners.
* **Acceptance criteria:**
  - [x] Scanning sweeps database and deletes matching stale KV keys.
* **Verification:**
  - [x] Trigger GC sweep manually and confirm dead runner keys are deleted.
* **Dependencies:** Task 1.4
* **Files likely touched:**
  - `src/system/scr/gc-sweeper.ts` (New file)
* **Estimated scope:** S

---

### Checkpoint: Registry & Discovery
- [x] Code builds without errors.
- [x] Registered tools/agents/workflows publish to `SCRRegistrationTopic` on start.
- [x] Local cache matches published registrations dynamically.
- [x] UserBudgetSupervisor and GC Sweeper initialize successfully.

---

### Phase 2: Leaf (Tool) Integration

#### Task 2.1: Implement Direct Leaf Tool Routing
* **Description:** Update the `invokeSCR` function to direct leaf kind requests to the tool's registered direct `ActorRef`.
* **Acceptance criteria:**
  - [ ] Leaf tool execution is correctly triggered via `invokeSCR`.
* **Verification:**
  - [ ] Integration tests verify invoking tool URNs returns terminal results.
* **Dependencies:** Task 1.7
* **Files likely touched:**
  - `src/system/scr/invoker.ts`
* **Estimated scope:** S

#### Task 2.2: Add Input Schema Validation Membrane
* **Description:** Add input validation to the tool delegate wrapper using the `validateSchema` utility.
* **Acceptance criteria:**
  - [ ] Invoking a tool with incorrect types returns an immediate `SCRReply.error`.
* **Verification:**
  - [ ] Unit tests verify validation rejection.
* **Dependencies:** Task 0.3, Task 2.1
* **Files likely touched:**
  - `src/system/scr/invoker.ts`
  - `src/system/agent/tool-utils.ts`
* **Estimated scope:** S

#### Task 2.3: Add Output Schema Validation Membrane
* **Description:** Add output validation to ensure tool execution returns expected data formats.
* **Acceptance criteria:**
  - [ ] Incorrect return structures from tool execution trigger an immediate `SCRReply.error`.
* **Verification:**
  - [ ] Verify validation errors are generated if output data doesn't match schema.
* **Dependencies:** Task 2.2
* **Files likely touched:**
  - `src/system/scr/invoker.ts`
  - `src/system/agent/tool-utils.ts`
* **Estimated scope:** S

---

### Checkpoint: Leaf Integration
- [ ] Invoking leaf URNs works successfully.
- [ ] Incorrect input/output payloads are rejected at the membrane boundary.

---

### Phase 3: Reasoner (Agent) SCR Conversion

#### Task 3.1: Build `AgentSpawnerActor` Skeleton
* **Description:** Implement `AgentSpawnerActor` to handle agent URN execution requests.
* **Acceptance criteria:**
  - [ ] Spawner instantiates, registers with the registry, and accepts message execution requests.
* **Verification:**
  - [ ] System boots and registers `AgentSpawner` to `SCRRegistrationTopic`.
* **Dependencies:** Task 1.7
* **Files likely touched:**
  - `src/system/agent/spawner.ts` (New file)
* **Estimated scope:** S

#### Task 3.2: Implement Ephemeral `SCRAgentRunner` Core Execution
* **Description:** Create the `SCRAgentRunner` actor spawned per agent request to manage inputs, run `agentLoop`, and execute turns. Injects the `scr_complete` tool.
* **Acceptance criteria:**
  - [ ] Runner spawns and executes a single ReAct loop successfully.
* **Verification:**
  - [ ] Verify basic runner test returns terminal responses.
* **Dependencies:** Task 3.1
* **Files likely touched:**
  - `src/system/agent/agent-runner.ts` (New file)
  - `src/system/agent/agent-loop.ts`
* **Estimated scope:** M

#### Task 3.3: Implement Channel-Agnostic Ambient Streaming
* **Description:** Update `SCRAgentRunner` to intercept internal agent tokens and publish them as `StreamChunk` envelopes out-of-band to the context's `streamTo` target.
* **Acceptance criteria:**
  - [ ] Intermediate tokens bypass core mailbox channels and stream to target topics.
* **Verification:**
  - [ ] Subscribe to stream topic and verify tokens arrive wrapped in structured envelopes with matching span IDs.
* **Dependencies:** Task 3.2
* **Files likely touched:**
  - `src/system/agent/agent-runner.ts`
* **Estimated scope:** S

#### Task 3.4: Implement Request Context Persistence & Restore
* **Description:** Add persistent state capabilities to `SCRAgentRunner` using `persistencePluginAdapter('scr.run.' + runId)`. Store requests and restore them via `requestStorage.run` on resume. Clean up KV on completion.
* **Acceptance criteria:**
  - [ ] Runner serializes state, restores context when re-spawned, and deletes database key on completion.
* **Verification:**
  - [ ] Verify database contains runner states during execution, and deletes them upon completion.
* **Dependencies:** Task 3.3
* **Files likely touched:**
  - `src/system/agent/agent-runner.ts`
* **Estimated scope:** S

#### Task 3.5: Implement Job Mapping & Resumption in `AgentSpawnerActor`
* **Description:** Implement `RegisterJobMsg` handling in `AgentSpawnerActor` to save pending job mappings in KV and listen to `JobRegistryTopic` to resume suspended runners.
* **Acceptance criteria:**
  - [ ] Spawner maps job IDs, registers mappings in KV database, and resumes runner upon completion events.
* **Verification:**
  - [ ] Publish completion event and confirm runner executes subsequent steps.
* **Dependencies:** Task 3.4
* **Files likely touched:**
  - `src/system/agent/spawner.ts`
* **Estimated scope:** M

#### Task 3.6: Integrate Usage Budget Accounting in `SCRAgentRunner`
* **Description:** Update the runner to publish LLM usage updates to `UsageUpdateTopic` to track spending budgets.
* **Acceptance criteria:**
  - [ ] Token and cost deltas publish after turns.
* **Verification:**
  - [ ] Verify that budget coordinator updates the UserBudget record.
* **Dependencies:** Task 1.10, Task 3.2
* **Files likely touched:**
  - `src/system/agent/agent-runner.ts`
* **Estimated scope:** S

#### Task 3.7: Implement Dynamic Pull-Based Discovery
* **Description:** Update `agentLoop` to search capabilities dynamically via `scr:tool:registry.search` rather than using pre-loaded tools.
* **Acceptance criteria:**
  - [ ] Agent binds discovered tool schemas mid-flight.
* **Verification:**
  - [ ] Verify agent can successfully find, bind, and execute a notebook tool dynamically.
* **Dependencies:** Task 1.5, Task 3.2
* **Files likely touched:**
  - `src/system/agent/agent-loop.ts`
* **Estimated scope:** M

#### Task 3.8: Refactor `SessionManager` for Ingress Execution
* **Description:** Refactor `SessionManager` to start request-scoped chatbot agent runs via `invokeSCR` directly, propagating user presence context.
* **Acceptance criteria:**
  - [ ] Chat ingress maps incoming WS inputs to chatbot agent SCR invocations.
* **Verification:**
  - [ ] Send user message and verify it triggers chatbot execution.
* **Dependencies:** Task 3.7
* **Files likely touched:**
  - `src/plugins/cognitive/session-manager.ts`
* **Estimated scope:** S

---

### Checkpoint: Reasoners Unified
- [ ] Agents can be invoked recursively (spawning ephemeral sub-runners).
- [ ] Agents discover, bind, and call capabilities dynamically via discovery meta-tools.
- [ ] `SessionManager` routes user messages directly to root agent via request-scoped execution.

---

### Phase 4: Graph (Workflow) & Operator Integration

#### Task 4.1: Build `WorkflowManager` Spawner Actor Skeleton
* **Description:** Create the long-lived spawner actor `WorkflowManager` to handle graph SCR URN invocations.
* **Acceptance criteria:**
  - [ ] Manager registers with registry and spawns workflow runner actors.
* **Verification:**
  - [ ] Verify system boots and registers the workflow spawner.
* **Dependencies:** Task 1.7
* **Files likely touched:**
  - `src/plugins/workflows/workflow-manager.ts` (New file)
* **Estimated scope:** S

#### Task 4.2: Implement `SCRWorkflowRunner` Core Execution (DAG & Bindings)
* **Description:** Create the ephemeral `SCRWorkflowRunner` to load the task DAG from DB and execute nodes in topological order, mapping parameter bindings.
* **Acceptance criteria:**
  - [ ] Runner parses bindings and runs tasks in correct topological order.
* **Verification:**
  - [ ] Verify execution runs simple DAG task steps.
* **Dependencies:** Task 4.1
* **Files likely touched:**
  - `src/plugins/workflows/workflow-run-executor.ts` (New file/refactor)
* **Estimated scope:** M

#### Task 4.3: Adapt Task Execution to call URNs via `invokeSCR`
* **Description:** Update tasks in the runner to target SCR URNs instead of old agent modes, propagating context.
* **Acceptance criteria:**
  - [ ] Task execution recursively triggers child SCR URNs.
* **Verification:**
  - [ ] Verify child tool and agent URNs are triggered.
* **Dependencies:** Task 4.2
* **Files likely touched:**
  - `src/plugins/workflows/workflow-task-executor.ts` (New file/refactor)
* **Estimated scope:** S

#### Task 4.4: Implement Job Mapping & Resumption in `WorkflowManager`
* **Description:** Integrate job mapping persistence and `JobRegistryTopic` listening to resume workflow execution on completion events.
* **Acceptance criteria:**
  - [ ] Suspended workflow runners resume correctly on completed events.
* **Verification:**
  - [ ] Send completed job event and verify runner resumes execution.
  - [ ] Deletes persisted state from database when workflow runs complete.
* **Dependencies:** Task 4.3
* **Files likely touched:**
  - `src/plugins/workflows/workflow-manager.ts`
* **Estimated scope:** M

#### Task 4.5: Create `OperatorSpawnerActor` Skeleton
* **Description:** Implement `OperatorSpawnerActor` to coordinate composite operations (sequence, parallel, map, retry, fallback, branch).
* **Acceptance criteria:**
  - [ ] Spawner actor starts up and registers with the registry.
* **Verification:**
  - [ ] System registers operator URNs during boot.
* **Dependencies:** Task 1.7
* **Files likely touched:**
  - `src/plugins/workflows/operator-spawner.ts` (New file)
* **Estimated scope:** S

#### Task 4.6: Implement Sequence & Parallel Operators
* **Description:** Implement sequential and parallel execution in the ephemeral `SCROperatorRunner`.
* **Acceptance criteria:**
  - [ ] Executes child operands sequentially or concurrently.
* **Verification:**
  - [ ] Unit tests verifying execution order.
* **Dependencies:** Task 4.5
* **Files likely touched:**
  - `src/plugins/workflows/operator-runner.ts` (New file)
* **Estimated scope:** S

#### Task 4.7: Implement Map & Branch Operators
* **Description:** Implement collection mapping and conditional routing operators.
* **Acceptance criteria:**
  - [ ] Executes operations on lists or takes specific paths based on conditions.
* **Verification:**
  - [ ] Verify map and branch execution pathways.
* **Dependencies:** Task 4.6
* **Files likely touched:**
  - `src/plugins/workflows/operator-runner.ts`
* **Estimated scope:** S

#### Task 4.8: Implement Retry & Fallback Operators
* **Description:** Implement error recovery and alternative path execution.
* **Acceptance criteria:**
  - [ ] Retries failing operations and falls back to alternate URNs if failures persist.
* **Verification:**
  - [ ] Verify error retries and fallback results.
* **Dependencies:** Task 4.7
* **Files likely touched:**
  - `src/plugins/workflows/operator-runner.ts`
* **Estimated scope:** S

#### Task 4.9: Update Workflows Agent Prompt & Planning Schema
* **Description:** Update `workflows-agent.ts` to query registries and output steps targeting SCR URNs instead of legacy modes.
* **Acceptance criteria:**
  - [ ] Agent utilizes discovery tools and plans workflows with correct URN mappings.
* **Verification:**
  - [ ] Generate workflow and verify output URN task structure.
* **Dependencies:** Task 1.5, Task 4.8
* **Files likely touched:**
  - `src/plugins/workflows/workflows-agent.ts`
* **Estimated scope:** S

---

### Checkpoint: Recursive Composition
- [ ] Workflows can execute child workflows.
- [ ] Operators (map, retry, branch) function correctly.
- [ ] Workflows agent generates plan steps mapping to URNs.

---

### Phase 5: Zero Backward Compatibility (End State)

#### Task 5.1: WebSocket Frame Ingress Routing in `WorkflowManager`
* **Description:** Update the WebSocket frame dispatcher in `WorkflowManager` to route requests using the SCR execution model.
* **Acceptance criteria:**
  - [ ] Intercepts and routes workspace requests using URN-based calls.
* **Verification:**
  - [ ] Verify mock WS frames trigger SCR invocations.
* **Dependencies:** Task 4.4
* **Files likely touched:**
  - `src/plugins/workflows/workflow-manager.ts`
  - `src/plugins/workflows/workflows.plugin.ts`
* **Estimated scope:** S

#### Task 5.2: HTTP Ingress Routing in `WorkflowManager`
* **Description:** Update REST routes (`workflows.routes.ts`) to query database records and delegate execution to the SCR engine.
* **Acceptance criteria:**
  - [ ] REST API endpoints route and execute jobs correctly.
* **Verification:**
  - [ ] HTTP tests confirm `/artifact` routes return logs successfully.
* **Dependencies:** Task 5.1
* **Files likely touched:**
  - `src/plugins/workflows/workflows.routes.ts`
* **Estimated scope:** S

#### Task 5.3: Align Frontend WebSocket Dispatcher
* **Description:** Update client WebSocket handlers to parse out-of-band `StreamChunk` chunks.
* **Acceptance criteria:**
  - [ ] Client correctly parses the structured stream chunks.
* **Verification:**
  - [ ] Verify streaming data is decoded by client parser tests.
* **Dependencies:** Task 5.2
* **Files likely touched:**
  - `src/frontend/`
* **Estimated scope:** S

#### Task 5.4: Align Frontend UI Panels
* **Description:** Refactor UI chat panels and graph visualizers to display URN information and render tree-based logs using span IDs.
* **Acceptance criteria:**
  - [ ] Chat UI displays output sorted by span context, and graph visualizer renders URN targets.
* **Verification:**
  - [ ] Verify the UI functions correctly by viewing in-browser test frames.
* **Dependencies:** Task 5.3
* **Files likely touched:**
  - `src/plugins/workflows/ui/`
  - `src/frontend/`
* **Estimated scope:** M

#### Task 5.5: Deprecate Legacy Topics and Messages
* **Description:** Delete `ToolRegistrationTopic`, `AgentRegistrationTopic`, and old types like `ToolInvokeMsg`.
* **Acceptance criteria:**
  - [ ] Legacy message types are deleted from the codebase.
* **Verification:**
  - [ ] Compiler check `bun run typecheck` verifies remaining files do not import legacy types.
* **Dependencies:** Task 5.4
* **Files likely touched:**
  - `src/types/tools.ts`
  - `src/types/agents.ts`
* **Estimated scope:** S

#### Task 5.6: Delete Legacy Actors and Verification
* **Description:** Delete `DynamicAgentActor`, legacy executors, and compile the final codebase.
* **Acceptance criteria:**
  - [ ] Deprecated files are deleted and system compilation succeeds.
* **Verification:**
  - [ ] Run full project compilation check (`bun run build` / `bun run typecheck`) and verify success.
* **Dependencies:** Task 5.5
* **Files likely touched:**
  - `src/system/agent/dynamic-agent.ts` (To be deleted)
  - `src/plugins/cognitive/agent-registry.ts`
  - `src/system/factory.ts`
* **Estimated scope:** M

---

### Checkpoint: Complete Transition
- [ ] No legacy agent/tool registration elements exist.
- [ ] Zero backward compatibility end-state achieved.
- [ ] System builds, tests pass, and app functions end-to-end.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
| :--- | :---: | :--- |
| **Privilege Escalation:** Child runners calling unauthorized URNs. | **High** | Permissions verified synchronously at cache lookup inside the `invokeSCR` entry membrane. |
| **Stack Overflow / Infinite Recursion:** Recursive URN loops. | **High** | Enforce strict depth checking inside `invokeSCR` context using the enqueued depth variable. |
| **Runaway Cost / Financial Bleed:** Infinite loops consuming LLM tokens. | **High** | Token/cost updates sent to `UsageUpdateTopic` update the user budget ledger managed by `UserBudgetSupervisor`. Local caches block calls instantly if thresholds are exceeded. |
| **System Resource Exhaustion:** Spawned ephemeral runners consume too much memory. | **Medium** | Depth limits block excessive nested spawning; child actors terminate immediately after execution. |
| **UI Integration Lag:** WebSocket frames changing mid-implementation. | **Medium** | Implement a temporary compatibility bridge translating SCR updates to legacy socket formats during phases 1–4, and decommission it in Phase 5. |
