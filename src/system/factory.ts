import type { ActorDef, ActorRef, PluginDef } from './actor/types.ts';
import type { ConfigDescriptor } from './actor/config.ts';
import { onLifecycle, onMessage } from './actor/match.ts';
import { publishConfigSurface, deleteConfigSurface } from './actor/config.ts';
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts';
import { type UiSurfaceRegistration } from '../types/ui-surface.ts';
import { SCRRegistrationTopic, type SCRDescriptor, type SCRInvokeMsg } from '../types/scr.ts';
import type { AgentDescriptor } from '../types/agents.ts';
import type { ToolSchema } from '../types/tools.ts';
import { OutboundBroadcastTopic } from '../types/events.ts';
import type { ActorHealth, HealthStatus } from '../types/health.ts';

const SCRToolAdapterActor = (options: {
  target: ActorRef<any>;
  toolName: string;
}): ActorDef<any, null> => ({
  initialState: null,
  handler: (state, msg, ctx) => {
    if (msg.type === 'invoke') {
      if ('toolName' in msg || 'arguments' in msg) {
        ctx.send(options.target, msg);
      } else {
        const inputStr = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input);
        ctx.ask<any, any>(
          options.target,
          (replyTo) => ({
            type: 'invoke',
            toolName: options.toolName,
            arguments: inputStr,
            replyTo,
          }),
          { timeoutMs: 60_000 }
        ).then(
          (reply) => {
            if (reply.type === 'toolResult') {
              msg.replyTo.send({ type: 'result', output: reply.result });
            } else if (reply.type === 'toolError') {
              msg.replyTo.send({ type: 'error', error: reply.error });
            } else if (reply.type === 'toolPending') {
              msg.replyTo.send({
                type: 'pending',
                jobId: reply.jobId,
                placeholderText: reply.placeholderText,
              });
            } else {
              msg.replyTo.send({ type: 'error', error: `Unexpected tool response: ${reply.type}` });
            }
          },
          (err) => {
            msg.replyTo.send({ type: 'error', error: String(err) });
          }
        );
      }
    }
    return { state };
  },
});

/**
 * Declaration for a sub-actor slot managed by the factory.
 */
export type SlotDeclaration<C = unknown, SubConfig = any> = {
  factory: (config: SubConfig, dependencies: Record<string, ActorRef<unknown>>) => ActorDef<any, any> | null;
  configPath?: string;
  surviveConfigChange?: boolean;
  dependsOn?: string[];
};

/**
 * Declaration for a session-level agent registered by the factory.
 */
export type AgentDeclaration<C = unknown, S = Record<string, any>, Options = unknown> = {
  factory: (options: Options) => AgentDescriptor;
  options: (config: C, dependencies: Record<keyof S, ActorRef<unknown>>) => Options;
  dependsOn?: (keyof S)[];
  slot?: keyof S;
};

/**
 * Declaration for a tool registered by the factory.
 */
export type ToolDeclaration<S = Record<string, any>> = {
  schema: ToolSchema;
  slot: keyof S;
  mayBeLongRunning?: boolean;
};

/**
 * Input blueprint passed to createPluginFactory.
 */
export type PluginBlueprint<
  C = unknown,
  S extends Record<string, SlotDeclaration<C, any>> = Record<string, SlotDeclaration<C, any>>,
  A extends Record<string, AgentDeclaration<C, S, any>> = Record<string, AgentDeclaration<C, S, any>>,
  T extends Record<string, ToolDeclaration<S>> = Record<string, ToolDeclaration<S>>,
  M = unknown
> = {
  id: string;
  version: string;
  description?: string;
  configDescriptor: ConfigDescriptor<C>;
  maskKeys?: string[];
  slots?: S;
  agents?: A;
  tools?: T;
  routes?: (config: C, dependencies: Record<keyof S, ActorRef<unknown>>) => RouteRegistration[];
  uiSurface?: UiSurfaceRegistration | ((config: C) => UiSurfaceRegistration);
};

type ActorSlotState = {
  config: any;
  ref: ActorRef<any> | null;
  gen: number;
};

type PluginFactoryState = {
  config: any;
  generation: number;
  activeSlots: Record<string, ActorSlotState>;
  activeRoutes: RouteRegistration[];
  activeUiSurface: UiSurfaceRegistration | null;
  activeAgents: string[];
  activeTools: string[];
  /** Child alive health by full actor name; terminated children are removed. */
  childStatus: Record<string, ActorHealth>;
};

const severity: Record<HealthStatus, number> = {
  ok: 0,
  degraded: 1,
  unavailable: 2,
};

/**
 * Slot baseline from missing/inactive slots; children may only worsen severity.
 */
const deriveHealth = (
  activeSlots: Record<string, ActorSlotState>,
  childStatus: Record<string, ActorHealth>,
): ActorHealth => {
  const missingSlots = Object.keys(activeSlots).filter(k => !activeSlots[k]?.ref);
  const slotBaseline: ActorHealth = missingSlots.length > 0
    ? { status: 'degraded', detail: `${missingSlots.join(', ')} slot(s) inactive` }
    : { status: 'ok' };

  let status: HealthStatus = slotBaseline.status;
  const detailParts: string[] = [];
  if (slotBaseline.detail) detailParts.push(slotBaseline.detail);

  for (const [name, h] of Object.entries(childStatus)) {
    if (severity[h.status] > severity[status]) {
      status = h.status;
    }
    if (h.status !== 'ok' && h.detail) {
      const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
      detailParts.push(`${short}: ${h.detail}`);
    } else if (h.status !== 'ok') {
      const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
      detailParts.push(`${short}: ${h.status}`);
    }
  }

  // Children only worsen: never report better than slot baseline severity
  if (severity[status] < severity[slotBaseline.status]) {
    status = slotBaseline.status;
  }

  if (status === 'ok') return { status: 'ok' };
  return {
    status,
    detail: detailParts.length > 0 ? detailParts.join('; ') : undefined,
  };
};

/**
 * Helper to resolve nested configuration path lookups.
 */
const getByPath = (obj: any, path: string): any => {
  if (!obj) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
};

/**
 * Recursive security masking helper.
 */
const redactKeys = (obj: any, maskKeys: string[]): any => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactKeys(item, maskKeys));
  }
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (maskKeys.includes(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactKeys(val, maskKeys);
    }
  }
  return result;
};

/**
 * Topological dependency graph sorter.
 */
export const computeSpawnOrder = (slots: Record<string, { dependsOn?: string[] }>): string[] => {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const keys = Object.keys(slots);

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const path = Array.from(visiting);
      const startIdx = path.indexOf(node);
      const cycle = path.slice(startIdx).concat(node).join(' -> ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }
    if (!visited.has(node)) {
      visiting.add(node);
      const decl = slots[node];
      const deps = decl?.dependsOn ?? [];
      for (const dep of deps) {
        if (!slots[dep]) {
          throw new Error(`Slot '${node}' depends on unknown sibling slot '${dep}'`);
        }
        visit(dep);
      }
      visiting.delete(node);
      visited.add(node);
      result.push(node);
    }
  };

  for (const key of keys) {
    visit(key);
  }

  return result;
};

const buildUrn = (kind: string, namespace: string, name: string): string => {
  if (name.startsWith('scr:')) return name;
  let normNamespace = namespace;
  let normName = name;
  if (name.includes('_')) {
    const idx = name.indexOf('_');
    normNamespace = name.slice(0, idx);
    normName = name.slice(idx + 1);
  } else if (name.includes('.')) {
    const idx = name.indexOf('.');
    normNamespace = name.slice(0, idx);
    normName = name.slice(idx + 1);
  }
  return `scr:${kind}:${normNamespace}.${normName}`;
};

export const createPluginFactory = <
  C = unknown,
  S extends Record<string, SlotDeclaration<C, any>> = Record<string, SlotDeclaration<C, any>>,
  A extends Record<string, AgentDeclaration<C, S, any>> = Record<string, AgentDeclaration<C, S, any>>,
  T extends Record<string, ToolDeclaration<S>> = Record<string, ToolDeclaration<S>>,
  M = unknown
>(
  blueprint: PluginBlueprint<C, S, A, T, M>
): PluginDef<any, PluginFactoryState, C> => {
  return {
    id: blueprint.id,
    version: blueprint.version,
    description: blueprint.description,
    configDescriptor: blueprint.configDescriptor,

    initialState: () => ({
      config: blueprint.configDescriptor.defaults,
      generation: 0,
      activeSlots: {},
      activeRoutes: [],
      activeUiSurface: null,
      activeAgents: [],
      activeTools: [],
      childStatus: {},
    }),

    maskState: (state: PluginFactoryState) => {
      if (!blueprint.maskKeys || blueprint.maskKeys.length === 0) {
        return state;
      }
      return redactKeys(state, blueprint.maskKeys);
    },

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        const initialConfig = (ctx.initialConfig() ?? blueprint.configDescriptor.defaults) as C;

        // 1. Publish configuration surface
        publishConfigSurface(ctx, blueprint.configDescriptor);

        // 2. Compute topological spawn order
        const spawnOrder = computeSpawnOrder(blueprint.slots ?? {});

        // 3. Spawning sub-actors
        const activeSlots: Record<string, ActorSlotState> = {};
        const activeRefs: Record<string, ActorRef<any>> = {};

        for (const slotKey of spawnOrder) {
          const slots = (blueprint.slots ?? {}) as any;
          const slotDecl = slots[slotKey];
          if (!slotDecl) continue;

          // Resolve slot configuration
          let slotConfig: any;
          if (slotDecl.configPath) {
            slotConfig = getByPath(initialConfig, slotDecl.configPath);
          } else {
            slotConfig = initialConfig;
          }

          // Build dependencies mapping
          const resolvedDeps: Record<string, ActorRef<any>> = {};
          for (const depKey of slotDecl.dependsOn ?? []) {
            if (activeRefs[depKey]) {
              resolvedDeps[depKey] = activeRefs[depKey];
            }
          }

          // Spawn slot actor with gen 0
          const name = `${slotKey}-0`;
          const actorDef = slotDecl.factory(slotConfig, resolvedDeps);
          const ref = actorDef ? ctx.spawn(name, actorDef) : null;

          activeSlots[slotKey] = { config: slotConfig, ref, gen: 0 };
          if (ref) {
            activeRefs[slotKey] = ref;
          } else {
            delete activeRefs[slotKey];
          }
        }

        // 4. Publish tools
        const activeTools: string[] = [];
        if (blueprint.tools) {
          for (const toolDecl of Object.values(blueprint.tools)) {
            const ref = activeRefs[toolDecl.slot as string];
            if (ref) {
              const urn = buildUrn('leaf', blueprint.id, toolDecl.schema.function.name);
              const slotGen = activeSlots[toolDecl.slot as string]?.gen ?? 0;
              const adapterName = `${blueprint.id}-tool-adapter-${toolDecl.schema.function.name}-${slotGen}`;
              const adapterRef = ctx.spawn(adapterName, SCRToolAdapterActor({
                target: ref,
                toolName: toolDecl.schema.function.name,
              }));
              const descriptor: SCRDescriptor = {
                urn,
                kind: 'leaf',
                description: toolDecl.schema.function.description || '',
                schema: {
                  inputSchema: toolDecl.schema.function.parameters as Record<string, any>,
                },
                yieldsPending: toolDecl.mayBeLongRunning || false,
                target: adapterRef,
                meta: { schema: toolDecl.schema, mayBeLongRunning: toolDecl.mayBeLongRunning },
              };
              ctx.publishRetained(SCRRegistrationTopic, urn, {
                type: 'register',
                descriptor,
              });
              activeTools.push(urn);
            }
          }
        }

        // 5. Publish agents
        const activeAgents: string[] = [];
        if (blueprint.agents) {
          for (const agentDecl of Object.values(blueprint.agents)) {
            const resolvedDeps: Record<string, ActorRef<any>> = {};
            for (const depKey of agentDecl.dependsOn ?? []) {
              const ref = activeRefs[depKey as string];
              if (ref) {
                resolvedDeps[depKey as string] = ref;
              }
            }
            const agentOpts = agentDecl.options(initialConfig, resolvedDeps as any);
            const descriptor = agentDecl.factory(agentOpts);

            const spawnerRef = agentDecl.slot ? activeRefs[agentDecl.slot as string] : undefined;
            const urn = buildUrn('reasoner', blueprint.id, descriptor.mode);
            const scrDescriptor: SCRDescriptor = {
              urn,
              kind: 'reasoner',
              description: descriptor.shortDesc || descriptor.displayName || '',
              schema: {
                inputSchema: {
                  type: 'object',
                  properties: {
                    prompt: { type: 'string' },
                  },
                  required: ['prompt'],
                },
                outputSchema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                  },
                },
              },
              target: spawnerRef || activeRefs['sessionManager'] || ctx.self,
              meta: { agentDescriptor: descriptor },
            };

            ctx.publishRetained(SCRRegistrationTopic, urn, {
              type: 'register',
              descriptor: scrDescriptor,
            });
            activeAgents.push(urn);
          }
        }

        // 6. Publish REST routes
        const activeRoutes: RouteRegistration[] = [];
        if (blueprint.routes) {
          const routesList = blueprint.routes(initialConfig, activeRefs as any);
          for (const reg of routesList) {
            ctx.publishRetained(RouteRegistrationTopic, reg.id, reg);
            activeRoutes.push(reg);
          }
        }

        // 7. Publish UI Surface
        let activeUiSurface: UiSurfaceRegistration | null = null;
        if (blueprint.uiSurface) {
          const uiReg = typeof blueprint.uiSurface === 'function'
            ? blueprint.uiSurface(initialConfig)
            : blueprint.uiSurface;
          ctx.publishRetained(OutboundBroadcastTopic, uiReg.id, {
            type: 'ui.surface',
            key: uiReg.id,
            payload: { reg: uiReg },
          });
          activeUiSurface = uiReg;
        }

        ctx.log.info(`${blueprint.id} plugin activated via factory`);

        const childStatus: Record<string, ActorHealth> = {};
        ctx.reportStatus(deriveHealth(activeSlots, childStatus));

        return {
          state: {
            config: initialConfig,
            generation: 0,
            activeSlots,
            activeRoutes,
            activeUiSurface,
            activeAgents,
            activeTools,
            childStatus,
          },
        };
      },

      watchStatus: (state, event, ctx) => {
        const childStatus = { ...state.childStatus };
        if (event.status === 'terminated') {
          delete childStatus[event.ref.name];
        } else {
          childStatus[event.ref.name] = {
            status: event.status,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          };
        }
        ctx.reportStatus(deriveHealth(state.activeSlots, childStatus));
        return { state: { ...state, childStatus } };
      },

      stopped: (state, ctx) => {
        // 1. Tombstone routes
        for (const reg of state.activeRoutes) {
          ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
            id: reg.id,
            method: reg.method,
            path: reg.path,
            target: null,
          });
        }

        // 2. Tombstone UI Surface
        if (state.activeUiSurface) {
          ctx.deleteRetained(OutboundBroadcastTopic, state.activeUiSurface.id, {
            type: 'ui.surface',
            key: state.activeUiSurface.id,
            payload: {
              reg: {
                id: state.activeUiSurface.id,
                view: null,
                moduleUrl: null,
                frameTypes: null,
              },
            },
            isTombstone: true,
          });
        }

        // 3. Unregister agents (delete retained entry so late joiners do not revive the mode)
        for (const urn of state.activeAgents) {
          ctx.deleteRetained(SCRRegistrationTopic, urn, {
            type: 'deregister',
            urn,
          });
        }

        // 4. Tombstone tools
        for (const urn of state.activeTools) {
          ctx.deleteRetained(SCRRegistrationTopic, urn, {
            type: 'deregister',
            urn,
          });
        }

        // 5. Delete config surface
        deleteConfigSurface(ctx, blueprint.configDescriptor);

        // 6. Stop child slots
        for (const slot of Object.values(state.activeSlots)) {
          if (slot.ref) {
            ctx.stop(slot.ref);
          }
        }

        ctx.log.info(`${blueprint.id} plugin deactivated via factory`);

        return { state };
      },
    }),

    handler: onMessage<any, PluginFactoryState>({
      config: (state, msg, ctx) => {
        const newConfig = msg.slice;
        const gen = state.generation + 1;

        // 1. Update config surface
        publishConfigSurface(ctx, blueprint.configDescriptor);

        // 2. Compute sorting spawn order
        const spawnOrder = computeSpawnOrder(blueprint.slots ?? {});
        const reverseSpawnOrder = [...spawnOrder].reverse();

        // 3. Selective Stop Planning
        const slotsToStop = new Set<string>();
        const activeSlots = { ...state.activeSlots };
        const activeRefs: Record<string, ActorRef<any>> = {};
        for (const [k, v] of Object.entries(activeSlots)) {
          if (v.ref) activeRefs[k] = v.ref;
        }

        for (const slotKey of reverseSpawnOrder) {
          const slots = (blueprint.slots ?? {}) as any;
          const slotDecl = slots[slotKey];
          if (!slotDecl) continue;
          const currentSlot = activeSlots[slotKey];
          if (!currentSlot) continue;

          // Resolve new config
          let slotConfig: any;
          if (slotDecl.configPath) {
            slotConfig = getByPath(newConfig, slotDecl.configPath);
          } else {
            slotConfig = newConfig;
          }

          const configChanged = JSON.stringify(currentSlot.config) !== JSON.stringify(slotConfig);
          const shouldSurvive = slotDecl.surviveConfigChange && !configChanged;

          let depChanged = false;
          for (const depKey of slotDecl.dependsOn ?? []) {
            if (slotsToStop.has(depKey)) {
              depChanged = true;
              break;
            }
          }

          if (!shouldSurvive || depChanged) {
            slotsToStop.add(slotKey);
          }
        }

        // Phase 1: Selective shutdown (reverse topological order)
        for (const slotKey of reverseSpawnOrder) {
          if (slotsToStop.has(slotKey)) {
            const slot = activeSlots[slotKey];
            if (slot && slot.ref) {
              ctx.stop(slot.ref);
              activeSlots[slotKey] = { config: null, ref: null, gen: slot.gen };
              delete activeRefs[slotKey];
            }
          }
        }

        // Phase 2: Route, UI, Tool and Agent Tombstoning
        for (const reg of state.activeRoutes) {
          ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
            id: reg.id,
            method: reg.method,
            path: reg.path,
            target: null,
          });
        }

        for (const urn of state.activeTools) {
          ctx.deleteRetained(SCRRegistrationTopic, urn, {
            type: 'deregister',
            urn,
          });
        }

        for (const urn of state.activeAgents) {
          ctx.deleteRetained(SCRRegistrationTopic, urn, {
            type: 'deregister',
            urn,
          });
        }

        let dynamicUiChanged = false;
        let nextUiSurface = state.activeUiSurface;
        if (blueprint.uiSurface) {
          const nextUiReg = typeof blueprint.uiSurface === 'function'
            ? blueprint.uiSurface(newConfig)
            : blueprint.uiSurface;
          
          if (JSON.stringify(state.activeUiSurface) !== JSON.stringify(nextUiReg)) {
            dynamicUiChanged = true;
            nextUiSurface = nextUiReg;
            if (state.activeUiSurface) {
              ctx.deleteRetained(OutboundBroadcastTopic, state.activeUiSurface.id, {
                type: 'ui.surface',
                key: state.activeUiSurface.id,
                payload: {
                  reg: {
                    id: state.activeUiSurface.id,
                    view: null,
                    moduleUrl: null,
                    frameTypes: null,
                  },
                },
                isTombstone: true,
              });
            }
          }
        }

        // Phase 3: Sequential respawn (topological order)
        for (const slotKey of spawnOrder) {
          const slots = (blueprint.slots ?? {}) as any;
          const slotDecl = slots[slotKey];
          if (!slotDecl) continue;
          const currentSlot = activeSlots[slotKey];

          // Resolve slot config
          let slotConfig: any;
          if (slotDecl.configPath) {
            slotConfig = getByPath(newConfig, slotDecl.configPath);
          } else {
            slotConfig = newConfig;
          }

          if (currentSlot && currentSlot.ref) {
            // Survived config change: carry ref forward
            activeRefs[slotKey] = currentSlot.ref;
          } else {
            // Recreated slot: increment gen and spawn
            const slotGen = (currentSlot?.gen ?? 0) + 1;

            const resolvedDeps: Record<string, ActorRef<any>> = {};
            for (const depKey of slotDecl.dependsOn ?? []) {
              if (activeRefs[depKey]) {
                resolvedDeps[depKey] = activeRefs[depKey];
              }
            }

            const name = `${slotKey}-${slotGen}`;
            const actorDef = slotDecl.factory(slotConfig, resolvedDeps);
            const ref = actorDef ? ctx.spawn(name, actorDef) : null;

            activeSlots[slotKey] = { config: slotConfig, ref, gen: slotGen };
            if (ref) {
              activeRefs[slotKey] = ref;
            } else {
              delete activeRefs[slotKey];
            }
          }
        }

        // Phase 4: Publish new tools, agents, routes, UI surfaces
        // Tools
        const activeTools: string[] = [];
        if (blueprint.tools) {
          for (const toolDecl of Object.values(blueprint.tools)) {
            const ref = activeRefs[toolDecl.slot as string];
            if (ref) {
              const urn = buildUrn('leaf', blueprint.id, toolDecl.schema.function.name);
              const slotGen = activeSlots[toolDecl.slot as string]?.gen ?? 0;
              const adapterName = `${blueprint.id}-tool-adapter-${toolDecl.schema.function.name}-${slotGen}`;
              const adapterRef = ctx.spawn(adapterName, SCRToolAdapterActor({
                target: ref,
                toolName: toolDecl.schema.function.name,
              }));
              const descriptor: SCRDescriptor = {
                urn,
                kind: 'leaf',
                description: toolDecl.schema.function.description || '',
                schema: {
                  inputSchema: toolDecl.schema.function.parameters as Record<string, any>,
                },
                yieldsPending: toolDecl.mayBeLongRunning || false,
                target: adapterRef,
                meta: { schema: toolDecl.schema, mayBeLongRunning: toolDecl.mayBeLongRunning },
              };
              ctx.publishRetained(SCRRegistrationTopic, urn, {
                type: 'register',
                descriptor,
              });
              activeTools.push(urn);
            }
          }
        }

        // Agents
        const activeAgents: string[] = [];
        if (blueprint.agents) {
          for (const agentDecl of Object.values(blueprint.agents)) {
            const resolvedDeps: Record<string, ActorRef<any>> = {};
            for (const depKey of agentDecl.dependsOn ?? []) {
              const ref = activeRefs[depKey as string];
              if (ref) {
                resolvedDeps[depKey as string] = ref;
              }
            }
            const agentOpts = agentDecl.options(newConfig, resolvedDeps as any);
            const descriptor = agentDecl.factory(agentOpts);

            const spawnerRef = agentDecl.slot ? activeRefs[agentDecl.slot as string] : undefined;
            const urn = buildUrn('reasoner', blueprint.id, descriptor.mode);
            const scrDescriptor: SCRDescriptor = {
              urn,
              kind: 'reasoner',
              description: descriptor.shortDesc || descriptor.displayName || '',
              schema: {
                inputSchema: {
                  type: 'object',
                  properties: {
                    prompt: { type: 'string' },
                  },
                  required: ['prompt'],
                },
                outputSchema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                  },
                },
              },
              target: spawnerRef || activeRefs['sessionManager'] || ctx.self,
              meta: { agentDescriptor: descriptor },
            };

            ctx.publishRetained(SCRRegistrationTopic, urn, {
              type: 'register',
              descriptor: scrDescriptor,
            });
            activeAgents.push(urn);
          }
        }

        // Routes
        const activeRoutes: RouteRegistration[] = [];
        if (blueprint.routes) {
          const routesList = blueprint.routes(newConfig, activeRefs as any);
          for (const reg of routesList) {
            ctx.publishRetained(RouteRegistrationTopic, reg.id, reg);
            activeRoutes.push(reg);
          }
        }

        // UI Surface
        if (blueprint.uiSurface && (dynamicUiChanged || !state.activeUiSurface)) {
          ctx.publishRetained(OutboundBroadcastTopic, nextUiSurface!.id, {
            type: 'ui.surface',
            key: nextUiSurface!.id,
            payload: { reg: nextUiSurface! },
          });
        }

        // Drop childStatus entries for slots that no longer have refs
        const childStatus = { ...state.childStatus };
        for (const name of Object.keys(childStatus)) {
          const stillActive = Object.values(activeSlots).some(s => s.ref?.name === name);
          if (!stillActive) delete childStatus[name];
        }

        ctx.reportStatus(deriveHealth(activeSlots, childStatus));

        return {
          state: {
            config: newConfig,
            generation: gen,
            activeSlots,
            activeRoutes,
            activeUiSurface: nextUiSurface,
            activeAgents,
            activeTools,
            childStatus,
          },
        };
      },
    }),
  };
};
