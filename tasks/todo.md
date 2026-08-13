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
- [ ] **Task 5.1**: WebSocket Frame Ingress Routing in `WorkflowManager` (`src/plugins/workflows/workflow-manager.ts`, `src/plugins/workflows/workflows.plugin.ts`)
- [ ] **Task 5.2**: HTTP Ingress Routing in `WorkflowManager` (`src/plugins/workflows/workflows.routes.ts`)
- [ ] **Task 5.3**: Align Frontend WebSocket Dispatcher (`src/frontend/`)
- [ ] **Task 5.4**: Align Frontend UI Panels (`src/plugins/workflows/ui/`, `src/frontend/`)
- [ ] **Task 5.5**: Deprecate Legacy Topics and Messages (`src/types/tools.ts`, `src/types/agents.ts`)
- [ ] **Task 5.6**: Delete Legacy Actors and Verification (`src/system/agent/dynamic-agent.ts`, `src/plugins/cognitive/agent-registry.ts`, `src/system/factory.ts`)

### Checkpoint: Complete Transition
- [ ] No legacy agent/tool registration elements exist.
- [ ] Zero backward compatibility end-state achieved.
- [ ] System builds, tests pass, and app functions end-to-end.
