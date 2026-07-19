import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { DocumentationTools, deleteDocTool, writeDocPageTool, writeTocTool } from './documentation.ts'
import { CodingAgentDescriptor } from './coding-agent.ts'
import { DocsAgent, showDocsTool, updateDocsTool } from './docs-agent.ts'
import { ProjectShell, codingBashTool, codingReadTool } from './project-shell.ts'
import { buildCodingRoutes, codingSchemas } from './routes.ts'
import type { DocumentationMsg, CodingConfig, DocsAgentMsg, ProjectShellMsg } from './types.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'

const defaultConfig: CodingConfig = {
  projectRoot: '/home/rigel/rorschach/src',
  projectMount: '/rorschach',
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
  documentationRef: ActorRef<DocumentationMsg>,
): ToolCollection => ({
  [codingBashTool.name]: { ...codingBashTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [codingReadTool.name]: { ...codingReadTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [deleteDocTool.name]: { ...deleteDocTool, ref: documentationRef as unknown as ActorRef<ToolMsg> },
  [writeDocPageTool.name]: { ...writeDocPageTool, ref: documentationRef as unknown as ActorRef<ToolMsg> },
  [writeTocTool.name]: { ...writeTocTool, ref: documentationRef as unknown as ActorRef<ToolMsg> },
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
  frameTypes: ['code.workspace', 'coding.bash.response', 'coding.bash.autocomplete.response'],
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
          workspaceDir: merged.workspaceDir ?? '/home/rigel/rorschach/workspace',
        })
      },
    },
    documentation: {
      factory: (_cfg) => {
        return DocumentationTools()
      },
    },
    docsAgent: {
      factory: (cfg, deps) => {
        const merged = mergeConfig(cfg)
        return DocsAgent({
          model: merged.docs.model,
          maxToolLoops: merged.docs.maxToolLoops ?? 30,
          projectMount: merged.projectMount,
          tools: buildDocsTools(
            deps.shell as ActorRef<ProjectShellMsg>,
            deps.documentation as ActorRef<DocumentationMsg>
          ),
        })
      },
      dependsOn: ['shell', 'documentation'],
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
      factory: CodingAgentDescriptor,
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
  routes: (cfg, deps) => {
    return buildCodingRoutes(deps.documentation as ActorRef<DocumentationMsg>)
  },
  uiSurface: codeSurfaceRegistration,
})
