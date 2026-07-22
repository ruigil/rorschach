import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { PageTools, writeHTMLPageTool } from './page-tools.ts'
import { CodingAgentDescriptor } from './coding-agent.ts'
import { ProjectShell, codingBashTool, codingReadTool } from './project-shell.ts'
import { buildCodingRoutes, codingSchemas } from './routes.ts'
import type { PageToolsMsg, CodingConfig, ProjectShellMsg } from './types.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'

const defaultConfig: CodingConfig = {
  projectRoot: '/home/rigel/rorschach/src',
  projectMount: '/rorschach',
  workspaceDir: '/home/rigel/rorschach/workspace',
  coding: {
    model: 'google/gemini-3.5-flash',
    maxToolLoops: 25,
  },
}

const config = defineConfig<CodingConfig>('coding', defaultConfig, {
  schemas: codingSchemas,
})

const mergeConfig = (slice: CodingConfig | undefined): CodingConfig => ({
  ...defaultConfig,
  ...(slice ?? {}),
  coding: { ...defaultConfig.coding, ...(slice?.coding ?? {}) },
})

const buildCodingTools = (
  shellRef: ActorRef<ProjectShellMsg>,
  pageToolsRef: ActorRef<PageToolsMsg>,
): ToolCollection => ({
  [codingBashTool.name]: { ...codingBashTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [codingReadTool.name]: { ...codingReadTool, ref: shellRef as unknown as ActorRef<ToolMsg> },
  [writeHTMLPageTool.name]: { ...writeHTMLPageTool, ref: pageToolsRef as unknown as ActorRef<ToolMsg> },
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
  description: 'Coding agent for project inspection and HTML page generation',
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
        return PageTools()
      },
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
            deps.documentation as ActorRef<PageToolsMsg>,
          ),
          toolFilter: merged.coding.toolFilter,
        }
      },
      dependsOn: ['shell', 'documentation'],
    },
  },
  routes: (cfg, deps) => {
    return buildCodingRoutes(deps.documentation as ActorRef<PageToolsMsg>)
  },
  uiSurface: codeSurfaceRegistration,
})
