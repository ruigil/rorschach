import type { ActorDef, ActorRef, PluginDef } from './actor/types.ts';
import type { ConfigDescriptor } from './actor/config.ts';
import { onLifecycle, onMessage } from './actor/match.ts';
import { publishConfigSurface, deleteConfigSurface } from './actor/config.ts';
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts';
import { type UiSurfaceRegistration } from '../types/ui-surface.ts';
import { AgentRegistrationTopic, type AgentDescriptor } from '../types/agents.ts';
import { ToolRegistrationTopic, type ToolSchema } from '../types/tools.ts';
import { OutboundBroadcastTopic } from '../types/events.ts';

/**
 * Declaration for a sub-actor slot managed by the factory.
 */
export type SlotDeclaration<C = unknown, SubConfig = any> = {
  factory: (config: SubConfig, dependencies: Record<string, ActorRef<unknown>>) => ActorDef<any, any> | null;
  configPath?: string;
  args?: SubConfig;
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
          if (slotDecl.args !== undefined) {
            slotConfig = slotDecl.args;
          } else if (slotDecl.configPath) {
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
              ctx.publishRetained(ToolRegistrationTopic, toolDecl.schema.function.name, {
                name: toolDecl.schema.function.name,
                schema: toolDecl.schema,
                ref: ref as ActorRef<any>,
                ...(toolDecl.mayBeLongRunning ? { mayBeLongRunning: true } : {}),
              });
              activeTools.push(toolDecl.schema.function.name);
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

            ctx.publishRetained(AgentRegistrationTopic, descriptor.mode, {
              type: 'register',
              descriptor,
            });
            activeAgents.push(descriptor.mode);
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

        return {
          state: {
            config: initialConfig,
            generation: 0,
            activeSlots,
            activeRoutes,
            activeUiSurface,
            activeAgents,
            activeTools,
          },
        };
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
        for (const mode of state.activeAgents) {
          ctx.deleteRetained(AgentRegistrationTopic, mode, {
            type: 'unregister',
            mode,
          });
        }

        // 4. Tombstone tools
        for (const toolName of state.activeTools) {
          ctx.deleteRetained(ToolRegistrationTopic, toolName, {
            name: toolName,
            ref: null,
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
      'http.request': (state, message, ctx) => {
        const { request, replyTo } = message;
        const url = new URL(request.url, 'http://localhost');
        const path = url.pathname;
        if (request.method === 'GET' && path === `/config/${blueprint.id}`) {
          replyTo.send({
            type: 'http.response',
            response: {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(state.config ?? {}),
            },
          });
        } else {
          replyTo.send({
            type: 'http.response',
            response: { status: 404, headers: {}, body: 'Not Found' }
          });
        }
        return { state };
      },

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
          if (slotDecl.args !== undefined) {
            slotConfig = slotDecl.args;
          } else if (slotDecl.configPath) {
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

        for (const toolName of state.activeTools) {
          ctx.deleteRetained(ToolRegistrationTopic, toolName, {
            name: toolName,
            ref: null,
          });
        }

        for (const mode of state.activeAgents) {
          ctx.deleteRetained(AgentRegistrationTopic, mode, {
            type: 'unregister',
            mode,
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
          if (slotDecl.args !== undefined) {
            slotConfig = slotDecl.args;
          } else if (slotDecl.configPath) {
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
              ctx.publishRetained(ToolRegistrationTopic, toolDecl.schema.function.name, {
                name: toolDecl.schema.function.name,
                schema: toolDecl.schema,
                ref: ref as ActorRef<any>,
                ...(toolDecl.mayBeLongRunning ? { mayBeLongRunning: true } : {}),
              });
              activeTools.push(toolDecl.schema.function.name);
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

            ctx.publishRetained(AgentRegistrationTopic, descriptor.mode, {
              type: 'register',
              descriptor,
            });
            activeAgents.push(descriptor.mode);
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

        return {
          state: {
            config: newConfig,
            generation: gen,
            activeSlots,
            activeRoutes,
            activeUiSurface: nextUiSurface,
            activeAgents,
            activeTools,
          },
        };
      },
    }),
  };
};
