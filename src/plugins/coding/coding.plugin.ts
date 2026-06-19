import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { dirname } from 'node:path'
import { defineConfig, deleteConfigSurface, onLifecycle, onMessage, publishConfigSurface } from '../../system/index.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolMsg } from '../../types/tools.ts'
import { ArtifactTools, deleteDocTool, writeDocPageTool } from './artifact-tools.ts'
import { CodingAgentFactory } from './coding-agent.ts'
import { DocsAgent, showDocsTool, updateDocsTool } from './docs-agent.ts'
import { ProjectShell, codingBashTool, codingReadTool } from './project-shell.ts'
import { buildCodingRoutes, codingSchemas } from './routes.ts'
import type { ArtifactToolsMsg, CodingConfig, DocsAgentMsg, ProjectShellMsg } from './types.ts'

type PluginMsg =
  | { type: 'config'; slice: CodingConfig | undefined }

type PluginState = {
  initialized: boolean
  gen: number
  cfg: CodingConfig
  shellRef: ActorRef<ProjectShellMsg> | null
  artifactToolsRef: ActorRef<ArtifactToolsMsg> | null
  docsAgentRef: ActorRef<DocsAgentMsg> | null
}

const defaultConfig: CodingConfig = {
  projectRoot: '/home/rigel/rorschach/src',
  projectMount: '/rorschach',
  artifactsDir: '/home/rigel/rorschach/workspace/artifacts',
  workspaceDir: '/home/rigel/rorschach/workspace',
  coding: {
    model: 'google/gemini-3.5-flash',
    maxToolLoops: 25,
  },
  docs: {
    model: 'google/gemini-3.5-flash',
    maxToolLoops: 30,
  },
}

const config = defineConfig<CodingConfig>('coding', defaultConfig, {
  schemas: codingSchemas,
})

const mergeConfig = (slice: CodingConfig | undefined): CodingConfig => ({
  ...defaultConfig,
  ...(slice ?? {}),
  coding: { ...defaultConfig.coding, ...(slice?.coding ?? {}) },
  docs: { ...defaultConfig.docs, ...(slice?.docs ?? {}) },
})

const buildCodingTools = (
  shellRef: ActorRef<ProjectShellMsg>,
  docsAgentRef: ActorRef<DocsAgentMsg>,
): ToolCollection => ({
  [codingBashTool.name]: { ...codingBashTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [codingReadTool.name]: { ...codingReadTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [updateDocsTool.name]: {
    ...updateDocsTool,
    ref: docsAgentRef as unknown as ActorRef<ToolMsg>,
    mayBeLongRunning: true,
  },
  [showDocsTool.name]: { ...showDocsTool, ref: docsAgentRef as unknown as ActorRef<ToolMsg> },
})

const buildDocsTools = (
  shellRef: ActorRef<ProjectShellMsg>,
  artifactToolsRef: ActorRef<ArtifactToolsMsg>,
): ToolCollection => ({
  [codingBashTool.name]: { ...codingBashTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [codingReadTool.name]: { ...codingReadTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [deleteDocTool.name]: { ...deleteDocTool, ref: artifactToolsRef as unknown as ActorRef<ToolMsg> },
  [writeDocPageTool.name]: { ...writeDocPageTool, ref: artifactToolsRef as unknown as ActorRef<ToolMsg> },
})

const buildDescriptor = (
  cfg: CodingConfig,
  shellRef: ActorRef<ProjectShellMsg>,
  docsAgentRef: ActorRef<DocsAgentMsg>,
): AgentDescriptor => ({
  mode: 'coding',
  displayName: 'Coding',
  shortDesc: 'Inspect a read-only project and generate app-styled documentation',
  factory: CodingAgentFactory({
    model: cfg.coding.model,
    maxToolLoops: cfg.coding.maxToolLoops,
    projectMount: cfg.projectMount,
    tools: buildCodingTools(shellRef, docsAgentRef),
  }),
  capabilities: { userVisible: true },
})

const publishRoutes = (ctx: ActorContext<PluginMsg>, cfg: CodingConfig): void => {
  for (const reg of buildCodingRoutes(cfg.artifactsDir)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (ctx: ActorContext<PluginMsg>, cfg: CodingConfig): void => {
  for (const reg of buildCodingRoutes(cfg.artifactsDir)) {
    ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
      id: reg.id,
      method: reg.method,
      path: reg.path,
      match: reg.match,
      handler: null,
    })
  }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.docsAgentRef) ctx.stop(state.docsAgentRef)
  if (state.artifactToolsRef) ctx.stop(state.artifactToolsRef)
  if (state.shellRef) ctx.stop(state.shellRef)
}

const spawnChildren = (
  ctx: ActorContext<PluginMsg>,
  cfg: CodingConfig,
  gen: number,
): Pick<PluginState, 'shellRef' | 'artifactToolsRef' | 'docsAgentRef'> => {
  const shellRef = ctx.spawn(`coding-shell-${gen}`, ProjectShell({
    projectRoot: cfg.projectRoot,
    projectMount: cfg.projectMount,
    workspaceDir: cfg.workspaceDir ?? dirname(cfg.artifactsDir),
    artifactsDir: cfg.artifactsDir,
  })) as ActorRef<ProjectShellMsg>

  const artifactToolsRef = ctx.spawn(`coding-artifacts-${gen}`, ArtifactTools(cfg.artifactsDir)) as ActorRef<ArtifactToolsMsg>
  const docsAgentRef = ctx.spawn(`coding-docs-agent-${gen}`, DocsAgent({
    model: cfg.docs.model,
    maxToolLoops: cfg.docs.maxToolLoops,
    projectMount: cfg.projectMount,
    artifactsDir: cfg.artifactsDir,
    tools: buildDocsTools(shellRef, artifactToolsRef),
  })) as ActorRef<DocsAgentMsg>

  ctx.publishRetained(ToolRegistrationTopic, updateDocsTool.name, {
    ...updateDocsTool,
    ref: docsAgentRef as unknown as ActorRef<ToolMsg>,
    mayBeLongRunning: true,
  })

  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: buildDescriptor(cfg, shellRef, docsAgentRef),
  })

  return { shellRef, artifactToolsRef, docsAgentRef }
}

const codingPlugin: PluginDef<PluginMsg, PluginState, CodingConfig> = {
  id: 'coding',
  version: '1.0.0',
  description: 'Coding agent for read-only project inspection and app-styled documentation generation',

  configDescriptor: config,

  initialState: {
    initialized: false,
    gen: 0,
    cfg: defaultConfig,
    shellRef: null,
    artifactToolsRef: null,
    docsAgentRef: null,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const cfg = mergeConfig(ctx.initialConfig() as CodingConfig | undefined)
      publishConfigSurface(ctx, config, () => cfg)
      publishRoutes(ctx, cfg)
      const children = spawnChildren(ctx, cfg, 0)
      ctx.log.info('coding plugin activated', { projectRoot: cfg.projectRoot, artifactsDir: cfg.artifactsDir })
      return { state: { initialized: true, gen: 0, cfg, ...children } }
    },

    stopped: (state, ctx) => {
      ctx.deleteRetained(ToolRegistrationTopic, updateDocsTool.name, { name: updateDocsTool.name, ref: null })
      deleteRoutes(ctx, state.cfg)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'coding' })
      deleteConfigSurface(ctx, config)
      ctx.log.info('coding plugin deactivated')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      ctx.deleteRetained(ToolRegistrationTopic, updateDocsTool.name, { name: updateDocsTool.name, ref: null })
      deleteRoutes(ctx, state.cfg)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'coding' })

      const cfg = mergeConfig(msg.slice)
      const gen = state.gen + 1
      publishRoutes(ctx, cfg)
      const children = spawnChildren(ctx, cfg, gen)
      return { state: { initialized: true, gen, cfg, ...children } }
    },
  }),
}

export default codingPlugin
