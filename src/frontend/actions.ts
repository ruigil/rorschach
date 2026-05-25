import { store } from './store.js';
import { type RorschachState, type Message, type LogEvent, type Attachment } from './types/state.js';
import { modeLabel, toolActionLabel } from './core/utils.js';

export function setMode(mode: string, displayName?: string) {
  store.set('currentMode', mode);
  store.set('currentModeDisplayName', displayName || modeLabel(mode));
  store.set('isWaiting', false);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.currentMode', mode);
  }
}

export function addLog(log: Partial<LogEvent> & { message: string }) {
  const currentLogs = store.get('logs');
  const entry: LogEvent = {
    timestamp: log.timestamp ?? Date.now(),
    level: log.level ?? 'info',
    source: log.source ?? '',
    message: log.message,
    data: log.data,
  };
  store.set('logs', [entry, ...currentLogs].slice(0, 500));
}

export function appendMessage(msg: Message) {
  const currentMessages = store.get('messages');
  const nextMessages = [...currentMessages, msg];
  store.set('messages', nextMessages);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.lastMessages', JSON.stringify(nextMessages.slice(-10)));
  }
}

export function updateActiveStream(patch: Partial<RorschachState['activeStream']>) {
  const active = store.get('activeStream');
  store.set('activeStream', { ...active, ...patch });
}

export function commitActiveStream(role: 'assistant' | 'error' = 'assistant', text?: string) {
  const active = store.get('activeStream');
  const message: Message = {
    id: crypto.randomUUID(),
    role,
    text: text ?? active.text,
    reasoning: active.reasoning,
    sources: [...active.sources],
    attachments: [...active.attachments],
    timestamp: Date.now(),
  };
  appendMessage(message);
  store.set('activeStream', {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  });
  store.set('isWaiting', false);
}

export function switchMode(mode: string) {
  const ws = store.get('ws');
  if (!mode || mode === store.get('currentMode') || ws?.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(JSON.stringify({ type: 'switchMode', mode }));
  return true;
}

export function submitChatMessage(text: string, attachments: Attachment[]) {
  const ws = store.get('ws');
  const isWaiting = store.get('isWaiting');
  if ((!text && attachments.length === 0) || ws?.readyState !== WebSocket.OPEN || isWaiting) {
    return;
  }

  appendMessage({
    id: crypto.randomUUID(),
    role: 'user',
    text,
    attachments,
    timestamp: Date.now(),
  });

  ws.send(JSON.stringify({ text, attachments }));
  store.set('isWaiting', true);
  updateActiveStream({ isActive: true });
}

export async function logout() {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' });
  window.location.href = new URL('auth/login.html', location.href).href;
}

export function openWindow(id: string, params: Record<string, any> = {}) {
  const windows = { ...store.get('windows') };
  const winState = windows[id];
  if (!winState) return;

  winState.isOpen = true;
  winState.isMinimized = false;
  winState.params = { ...winState.params, ...params };
  
  if (winState.isDocked && id !== 'chat') {
    store.set('activeWorkspaceTab', id);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.activeWorkspaceTab', id);
    }
  }

  store.set('windows', windows);
  focusWindow(id);

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`rorschach.window_state.${id}`, JSON.stringify(winState));
    if (id === 'docs') {
      localStorage.setItem('rorschach.docWorkspaceOpen', 'true');
      if (params.currentDocArtifact) {
        localStorage.setItem('rorschach.docWorkspaceArtifact', params.currentDocArtifact);
      }
    } else if (id === 'plans') {
      localStorage.setItem('rorschach.planWorkspaceOpen', 'true');
    }
  }
}

export function closeWindow(id: string) {
  const windows = { ...store.get('windows') };
  const winState = windows[id];
  if (!winState) return;

  winState.isOpen = false;
  store.set('windows', windows);

  const activeIds = [...store.get('activeWindowIds')];
  const idx = activeIds.indexOf(id);
  if (idx !== -1) {
    activeIds.splice(idx, 1);
    store.set('activeWindowIds', activeIds);
  }

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`rorschach.window_state.${id}`, JSON.stringify(winState));
    if (id === 'docs') {
      localStorage.setItem('rorschach.docWorkspaceOpen', 'false');
    } else if (id === 'plans') {
      localStorage.setItem('rorschach.planWorkspaceOpen', 'false');
    }
  }
}

export function focusWindow(id: string) {
  const activeIds = [...store.get('activeWindowIds')];
  const idx = activeIds.indexOf(id);
  if (idx !== -1) activeIds.splice(idx, 1);
  activeIds.push(id);
  store.set('activeWindowIds', activeIds);

  const windows = { ...store.get('windows') };
  activeIds.forEach((activeId, index) => {
    if (windows[activeId]) {
      windows[activeId].zIndex = 1000 + index;
    }
  });
  store.set('windows', windows);
}
