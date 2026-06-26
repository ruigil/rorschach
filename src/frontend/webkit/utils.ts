export const escHtml = (str: string | number) => {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const tsStr = (timestamp: number | string | Date) => {
  return new Date(timestamp).toISOString().slice(11, 23);
}

export const modeLabel = (mode: string, displayName = '') => {
  if (displayName) return displayName
  if (!mode) return 'Mode'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

export const toolActionLabel = (tools: string[]) => {
  if (tools.length === 1) {
    const name = tools[0]
    if (name === 'web_search') return 'searching the web...'
    if (name === 'analyze_image') return 'analysing image...'
    return `running ${name}...`
  }
  return tools.length > 1 ? `invoking ${tools.length} tools...` : 'working...'
}
