import { store } from './store.js';
import { type RorschachState, type Message } from './types/state.js';
import { modeLabel, toolActionLabel } from './core/utils.js';

export function setMode(mode: string, displayName?: string) {
  store.set('currentMode', mode);
  store.set('currentModeDisplayName', displayName || modeLabel(mode));
  store.set('isWaiting', false);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.currentMode', mode);
  }
}

export function addLog(log: any) {
  const currentLogs = store.get('logs');
  store.set('logs', [log, ...currentLogs].slice(0, 500));
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

export async function bootstrapSession() {
  try {
    const res = await fetch(new URL('me', location.href));
    if (res.ok) {
      const { userId, roles } = await res.json();
      store.set('currentUserId', userId);
      store.set('currentUserRoles', roles ?? []);
    }
  } catch (e) {
    console.error('Failed to fetch user session', e);
  }
}

export function switchMode(mode: string) {
  const ws = store.get('ws');
  if (!mode || mode === store.get('currentMode') || ws?.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(JSON.stringify({ type: 'switchMode', mode }));
  return true;
}

export function submitChatMessage(text: string, attachments: any[]) {
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

  const logoMark = document.querySelector('.logo-mark');
  logoMark?.classList.add('noticing');
  setTimeout(() => logoMark?.classList.remove('noticing'), 700);
}

export async function logout() {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' });
  window.location.href = new URL('auth/login.html', location.href).href;
}
