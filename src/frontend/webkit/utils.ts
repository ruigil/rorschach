
export const toolActionLabel = (tools: string[]) => {
  if (tools.length === 1) {
    const name = tools[0]
    if (name === 'web_search') return 'searching the web...'
    if (name === 'analyze_image') return 'analysing image...'
    return `running ${name}...`
  }
  return tools.length > 1 ? `invoking ${tools.length} tools...` : 'working...'
}
