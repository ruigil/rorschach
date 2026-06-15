export interface WindowConfig {
  id: string;
  title: string;
  icon: string;
  contentTag: string;
  dockResizable?: boolean;
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
}

export const WINDOW_REGISTRY: Record<string, WindowConfig> = {
  chat: {
    id: 'chat',
    title: 'Chat',
    icon: 'message-square',
    contentTag: 'r-chat-panel',
    defaultWidth: 320,
    defaultHeight: 600,
    minWidth: 300,
    minHeight: 300,
  },
  docs: {
    id: 'docs',
    title: 'Documentation',
    icon: 'file-text',
    contentTag: 'r-doc-workspace',
    dockResizable: false,
    defaultWidth: 500,
    defaultHeight: 600,
    minWidth: 350,
    minHeight: 200,
  },
  workflows: {
    id: 'workflows',
    title: 'Workflows',
    icon: 'git-branch',
    contentTag: 'r-workflow-workspace',
    dockResizable: false,
    defaultWidth: 460,
    defaultHeight: 600,
    minWidth: 320,
    minHeight: 200,
  }
};
