import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { PageTools, writeHTMLPageTool } from './page-tools.ts'
import { CodingAgentDescriptor } from './coding-agent.ts'
import {
  ProjectShell,
  codingBashTool,
  codingGlobTool,
  codingGrepTool,
  codingReadTool,
  codingStrReplaceTool,
  codingWriteTool,
} from './project-shell.ts'
import { buildCodingRoutes } from './coding.routes.ts'
import { config, defaultConfig, type CodingConfig } from './coding.config.ts'
import type { PageToolsMsg, ProjectShellMsg } from './types.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'

const mergeConfig = (slice: CodingConfig | undefined): CodingConfig => ({
  ...defaultConfig,
  ...(slice ?? {}),
  coding: { ...defaultConfig.coding, ...(slice?.coding ?? {}) },
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
  tools: {
    shellExec: { schema: codingBashTool.schema, slot: 'shell' },
    fileRead: { schema: codingReadTool.schema, slot: 'shell' },
    grep: { schema: codingGrepTool.schema, slot: 'shell' },
    glob: { schema: codingGlobTool.schema, slot: 'shell' },
    write: { schema: codingWriteTool.schema, slot: 'shell' },
    strReplace: { schema: codingStrReplaceTool.schema, slot: 'shell' },
    htmlWritePage: { schema: writeHTMLPageTool.schema, slot: 'documentation' },
  },
  agents: {
    coding: {
      factory: CodingAgentDescriptor,
      options: (cfg) => {
        const merged = mergeConfig(cfg)
        return {
          model: merged.coding.model,
          maxToolLoops: merged.coding.maxToolLoops,
          projectMount: merged.projectMount,
          agentSCRs: [
            'scr:leaf:coding.shell_exec',
            'scr:leaf:coding.file_read',
            'scr:leaf:coding.file_grep',
            'scr:leaf:coding.file_glob',
            'scr:leaf:coding.file_write',
            'scr:leaf:coding.file_replace_string',
            'scr:leaf:coding.html_write_page',
          ],
        }
      },
    },
  },
  routes: (cfg, deps) => {
    return buildCodingRoutes(deps.documentation as ActorRef<PageToolsMsg>)
  },
  uiSurface: codeSurfaceRegistration,
})
