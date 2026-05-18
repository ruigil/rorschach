import { LightElement, escHtml, ICONS } from './base.js'

export class RTopicList extends LightElement {
  constructor() {
    super()
    this._topicsData = []
    this._expandedTopics = new Set()
    this.addEventListener('click', (e) => this._onClick(e))
  }

  update(topics) {
    this._topicsData = topics

    if (topics.length === 0) {
      this.innerHTML = `<r-empty-state variant="panel" text="no active topics"></r-empty-state>`
      return
    }

    const watchTopics = topics.filter(t => t.topic.startsWith('$watch:'))
    const otherTopics = topics.filter(t => !t.topic.startsWith('$watch:'))

    let watchHtml = ''
    if (watchTopics.length > 0) {
      const isGroupExpanded = this._expandedTopics.has('$watch')
      const childrenHtml = isGroupExpanded
        ? `<div class="topic-children">${watchTopics.map(t => this._renderEntry(t, t.topic.slice('$watch:'.length))).join('')}</div>`
        : ''
      watchHtml = `
        <div class="topic-entry">
          <div class="topic-row topic-group" data-topic="$watch" data-has-subs="true">
            <span class="tree-chevron topic-chevron" data-topic="$watch">${isGroupExpanded ? ICONS['chevron-down'] : ICONS['chevron-right'] }</span>
            <span class="topic-name">$watch</span>
            <span class="topic-sub-count">${watchTopics.length}</span>
          </div>
          ${childrenHtml}
        </div>`
    }

    this.innerHTML = watchHtml + otherTopics.map(t => this._renderEntry(t)).join('')
  }

  _renderEntry(t, label) {
    const displayLabel = label ?? t.topic
    const isExpanded   = this._expandedTopics.has(t.topic)
    const subCount     = t.subscribers.length
    const chevron = subCount > 0
      ? `<span class="tree-chevron topic-chevron" data-topic="${escHtml(t.topic)}">${isExpanded ? ICONS['chevron-down'] : ICONS['chevron-right'] }</span>`
      : `<span class="tree-spacer"></span>`
    const subs = isExpanded && subCount > 0
      ? `<div class="topic-subscribers">${t.subscribers.map(s =>
          `<div class="topic-sub-row"><span class="topic-sub-name">${escHtml(s)}</span></div>`
        ).join('')}</div>`
      : ''
    return `
      <div class="topic-entry">
        <div class="topic-row" data-topic="${escHtml(t.topic)}" data-has-subs="${subCount > 0}">
          ${chevron}
          <span class="topic-name">${escHtml(displayLabel)}</span>
          <span class="topic-sub-count">${subCount}</span>
        </div>
        ${subs}
      </div>`
  }

  _onClick(e) {
    const row = e.target.closest('.topic-row')
    if (!row || row.dataset.hasSubs !== 'true') return
    const topic = row.dataset.topic
    this._expandedTopics.has(topic) ? this._expandedTopics.delete(topic) : this._expandedTopics.add(topic)
    this.update(this._topicsData)
  }
}

if (!customElements.get('r-topic-list')) {
  customElements.define('r-topic-list', RTopicList)
}
