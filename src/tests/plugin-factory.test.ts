import { describe, test, expect } from 'bun:test';
import { MockPersistenceActor } from './mock-persistence.ts'
import { AgentSystem, MetricsTopic } from '../system/index.ts';
import type { ActorDef, MetricsEvent } from '../system/index.ts';
import observabilityPlugin from '../plugins/observability/observability.plugin.ts';
import {
  computeSpawnOrder,
  createPluginFactory,
} from '../system/factory.ts';
import { onMessage } from '../system/index.ts';
import { RouteRegistrationTopic } from '../types/routes.ts';
import { OutboundBroadcastTopic } from '../types/events.ts';
import { AgentRegistrationTopic } from '../types/agents.ts';
import { ToolRegistrationTopic } from '../types/tools.ts';

const tick = (ms = 50) => Bun.sleep(ms);

const getSnap = (events: MetricsEvent[], name: string) =>
  events[events.length - 1]?.actors.find(a => a.name === name);

describe('Topological Sorter (computeSpawnOrder)', () => {
  test('resolves a simple linear dependency path', () => {
    const slots = {
      identityProvider: { dependsOn: ['authenticator'] },
      authenticator: { dependsOn: ['userStore'] },
      userStore: {},
    };
    const order = computeSpawnOrder(slots);
    expect(order).toEqual(['userStore', 'authenticator', 'identityProvider']);
  });

  test('resolves a branching DAG structure', () => {
    const slots = {
      C: { dependsOn: ['A', 'B'] },
      B: { dependsOn: ['A'] },
      A: {},
    };
    const order = computeSpawnOrder(slots);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('throws an error on circular dependencies', () => {
    const slots = {
      A: { dependsOn: ['B'] },
      B: { dependsOn: ['C'] },
      C: { dependsOn: ['A'] },
    };
    expect(() => computeSpawnOrder(slots)).toThrow('Circular dependency detected: A -> B -> C -> A');
  });

  test('throws an error on missing/unknown dependency', () => {
    const slots = {
      A: { dependsOn: ['missingSlot'] },
    };
    expect(() => computeSpawnOrder(slots)).toThrow("Slot 'A' depends on unknown sibling slot 'missingSlot'");
  });
});

describe('Plugin Factory (createPluginFactory)', () => {
  // Define mock sub-actor factory functions
  const createMockActor = (name: string): ActorDef<any, any> => ({
    initialState: () => ({ name, msgs: [] as string[] }),
    handler: onMessage<any, any>({
      noop: (state) => ({ state }),
      record: (state, msg) => ({ state: { ...state, msgs: [...state.msgs, msg.val] } }),
    }),
  });

  test('initializes slots in topological order and registers routes/UI/tools/agents', async () => {
    const events: MetricsEvent[] = [];
    const system = await AgentSystem({
      config: { observability: { metrics: { intervalMs: 50 } } },
      plugins: [MockPersistenceActor(), observabilityPlugin],
    });
    system.subscribe(MetricsTopic, (e) => events.push(e));

    const registeredAgents: any[] = [];
    const registeredTools: any[] = [];
    const registeredRoutes: any[] = [];
    const registeredUi: any[] = [];

    system.subscribe(AgentRegistrationTopic, (e) => registeredAgents.push(e));
    system.subscribe(ToolRegistrationTopic, (e) => registeredTools.push(e));
    system.subscribe(RouteRegistrationTopic, (e) => registeredRoutes.push(e));
    system.subscribe(OutboundBroadcastTopic, (e) => {
      if (e.type === 'ui.surface') {
        const parsed = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
        registeredUi.push(parsed.reg);
      }
    });

    // Setup mock schemas
    const toolSchema = {
      type: 'function' as const,
      function: {
        name: 'mock_search',
        description: 'Mock search tool',
        parameters: { type: 'object', properties: {} },
      },
    };

    const blueprint = createPluginFactory({
      id: 'mock-plugin',
      version: '1.0.0',
      configDescriptor: {
        key: 'mock-plugin',
        defaults: { apiKey: 'secret-key', nested: { val: 'test' } },
        onConfigChange: (c: any) => ({ type: 'config', slice: c }),
      },
      maskKeys: ['apiKey'],
      slots: {
        dbStore: {
          factory: () => createMockActor('dbStore'),
          surviveConfigChange: true,
        },
        worker: {
          factory: () => createMockActor('worker'),
          dependsOn: ['dbStore'],
        },
      },
      tools: {
        search: {
          schema: toolSchema,
          slot: 'worker',
        },
      },
      agents: {
        mainAgent: {
          factory: (opts) => ({ mode: 'mock-agent', displayName: 'Mock Agent', options: opts } as any),
          options: (cfg: any, deps) => ({ key: cfg.apiKey, dbRef: deps.dbStore }),
          dependsOn: ['dbStore'],
        },
      },
      routes: (cfg, deps) => [
        {
          id: 'mock-route',
          method: 'GET',
          path: '/mock/action',
          handler: () => new Response('ok'),
        },
      ],
      uiSurface: (cfg: any) => ({
        id: 'mock-ui',
        version: '1.0.0',
        view: {
          title: 'Mock UI',
          icon: 'settings',
          contentTag: 'r-mock-workspace',
          modes: [],
        },
        moduleUrl: '/mock/index.js',
        frameTypes: [],
      }),
    });

    // 1. Load the factory-created plugin
    const loadResult = await system.use(blueprint);
    expect(loadResult.ok).toBe(true);
    await tick(150);

    // Verify actor creation and references
    const pluginStatus = system.getPluginStatus('mock-plugin');
    expect(pluginStatus).toBeDefined();
    expect(pluginStatus?.status).toBe('active');

    // Verify slot actors are spawned under parent via metrics snapshot
    const snap = getSnap(events, 'system/mock-plugin');
    expect(snap).toBeDefined();
    expect(snap!.children).toContain('system/mock-plugin/dbStore-0');
    expect(snap!.children).toContain('system/mock-plugin/worker-0');

    // Verify registrations
    expect(registeredTools.map((t) => t.name)).toContain('mock_search');
    expect(registeredAgents.map((a) => a.descriptor?.mode)).toContain('mock-agent');
    expect(registeredRoutes.map((r) => r.id)).toContain('mock-route');
    expect(registeredUi.map((u) => u.id)).toContain('mock-ui');

    // Verify state redaction via metrics snapshot
    expect(snap!.state).toBeDefined();
    const stateObj = snap!.state as any;
    expect(stateObj.config.apiKey).toBe('[redacted]');

    // 2. Unload the plugin and verify tombstones
    const unloadResult = await system.unloadPlugin('mock-plugin');
    expect(unloadResult.ok).toBe(true);
    await tick(150);

    // Verify tombstones published
    const toolTombstone = registeredTools.find((t) => t.name === 'mock_search' && t.ref === null);
    const agentTombstone = registeredAgents.find((a) => a.type === 'unregister' && a.mode === 'mock-agent');
    const routeTombstone = registeredRoutes.find((r) => r.id === 'mock-route' && r.handler === null);
    const uiTombstone = registeredUi.find((u) => u.id === 'mock-ui' && u.view === null);

    expect(toolTombstone).toBeDefined();
    expect(agentTombstone).toBeDefined();
    expect(routeTombstone).toBeDefined();
    expect(uiTombstone).toBeDefined();

    await system.shutdown();
  });

  test('handles differential reconfigurations and survives stateful slots', async () => {
    const events: MetricsEvent[] = [];
    const system = await AgentSystem({
      config: { observability: { metrics: { intervalMs: 50 } } },
      plugins: [MockPersistenceActor(), observabilityPlugin],
    });
    system.subscribe(MetricsTopic, (e) => events.push(e));

    const blueprint = createPluginFactory({
      id: 'stateful-plugin',
      version: '1.0.0',
      configDescriptor: {
        key: 'stateful-plugin',
        defaults: {
          storePath: 'workspace/db.json',
          workerThreads: 4,
        },
        onConfigChange: (c: any) => ({ type: 'config', slice: c }),
      },
      slots: {
        store: {
          factory: () => createMockActor('store'),
          configPath: 'storePath',
          surviveConfigChange: true,
        },
        transientWorker: {
          factory: () => createMockActor('transientWorker'),
          configPath: 'workerThreads',
          dependsOn: ['store'],
        },
      },
    });

    const loadResult = await system.use(blueprint);
    expect(loadResult.ok).toBe(true);
    await tick(150);

    const snap1 = getSnap(events, 'system/stateful-plugin');
    expect(snap1).toBeDefined();
    expect(snap1!.children).toContain('system/stateful-plugin/store-0');
    expect(snap1!.children).toContain('system/stateful-plugin/transientWorker-0');

    // Update config: only workerThreads changes, storePath remains identical!
    system.updateConfig({
      'stateful-plugin': {
        storePath: 'workspace/db.json',
        workerThreads: 8,
      },
    });
    await tick(150);

    // After reconfig:
    // - store slot should survive (retaining stateful-plugin-store-0)
    // - transientWorker slot should stop and recreate as stateful-plugin-transientWorker-1
    const snap2 = getSnap(events, 'system/stateful-plugin');
    expect(snap2).toBeDefined();
    expect(snap2!.children).toContain('system/stateful-plugin/store-0');
    expect(snap2!.children).toContain('system/stateful-plugin/transientWorker-1');
    expect(snap2!.children).not.toContain('system/stateful-plugin/transientWorker-0');

    // Update config: storePath changes! (surviveConfigChange: true but its sliceConfig changed, so it must restart)
    system.updateConfig({
      'stateful-plugin': {
        storePath: 'workspace/new-db.json',
        workerThreads: 8,
      },
    });
    await tick(150);

    // Both should restart: store-1 and transientWorker-2
    const snap3 = getSnap(events, 'system/stateful-plugin');
    expect(snap3).toBeDefined();
    expect(snap3!.children).toContain('system/stateful-plugin/store-1');
    expect(snap3!.children).toContain('system/stateful-plugin/transientWorker-2');

    await system.shutdown();
  });
});
