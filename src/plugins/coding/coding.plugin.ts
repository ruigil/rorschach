import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { dirname } from 'node:path'
import { AgentRegistrationTopic } from '../../types/agents.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolMsg } from '../../types/tools.ts'
import { ArtifactTools, deleteDocTool, writeDocPageTool } from './artifact-tools.ts'
import { CodingAgentFactory } from './coding-agent.ts'
import { DocsAgent, showDocsTool, updateDocsTool } from './docs-agent.ts'
import { ProjectShell, codingBashTool, codingReadTool } from './project-shell.ts'
import { buildCodingRoutes, codingSchemas } from './routes.ts'
import type { ArtifactToolsMsg, CodingConfig, DocsAgentMsg, ProjectShellMsg } from './types.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'

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

const codeSurfaceRegistration: UiSurfaceRegistration = {
  id: 'code',
  version: '1.0.0',
  view: {
    title: 'Code',
    icon: 'code',
    contentTag: 'r-code-workspace',
    modes: ['coding'],
  },
  moduleUrl: '/js/plugins/coding.js',
  frameTypes: ['codeWorkspace', 'coding.bash.response', 'coding.bash.autocomplete.response'],
}

export default createPluginFactory<CodingConfig>({
  id: 'coding',
  version: '1.0.0',
  description: 'Coding agent for read-only project inspection and app-styled documentation generation',
  configDescriptor: config,
  slots: {
    shell: {
      factory: (cfg) => {
        const merged = mergeConfig(cfg)
        return ProjectShell({
          projectRoot: merged.projectRoot,
          projectMount: merged.projectMount,
          workspaceDir: merged.workspaceDir ?? dirname(merged.artifactsDir),
          artifactsDir: merged.artifactsDir,
        })
      },
    },
    artifactTools: {
      factory: (cfg) => {
        const merged = mergeConfig(cfg)
        return ArtifactTools(merged.artifactsDir)
      },
    },
    docsAgent: {
      factory: (cfg, deps) => {
        const merged = mergeConfig(cfg)
        return DocsAgent({
          model: merged.docs.model,
          maxToolLoops: merged.docs.maxToolLoops ?? 30,
          projectMount: merged.projectMount,
          artifactsDir: merged.artifactsDir,
          tools: buildDocsTools(
            deps.shell as ActorRef<ProjectShellMsg>,
            deps.artifactTools as ActorRef<ArtifactToolsMsg>
          ),
        })
      },
      dependsOn: ['shell', 'artifactTools'],
    },
  },
  tools: {
    updateDocs: {
      schema: updateDocsTool.schema,
      slot: 'docsAgent',
      mayBeLongRunning: true,
    },
  },
  agents: {
    coding: {
      factory: CodingAgentFactory,
      options: (cfg, deps) => {
        const merged = mergeConfig(cfg)
        return {
          model: merged.coding.model,
          maxToolLoops: merged.coding.maxToolLoops,
          projectMount: merged.projectMount,
          tools: buildCodingTools(
            deps.shell as ActorRef<ProjectShellMsg>,
            deps.docsAgent as ActorRef<DocsAgentMsg>
          ),
          toolFilter: merged.coding.toolFilter,
        }
      },
      dependsOn: ['shell', 'docsAgent'],
    },
  },
  routes: (cfg) => {
    const merged = mergeConfig(cfg)
    return buildCodingRoutes(merged.artifactsDir)
  },
  uiSurface: codeSurfaceRegistration,
})
