import { escHtml, CHEVRON_DOWN, CHEVRON_RIGHT } from '../utils.js'

const topicListEl  = document.getElementById('topic-list')
const topicsEmpty  = document.getElementById('topics-empty')

let topicsData = []
const expandedTopics = new Set()

function renderTopicEntry(t, label) {
  const displayLabel = label ?? t.topic
  const isExpanded   = expandedTopics.has(t.topic)
  const subCount     = t.subscribers.length
  const chevron = subCount > 0
    ? `<span class="tree-chevron topic-chevron" data-topic="${escHtml(t.topic)}">${isExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>`
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

export function updateTopics(topics) {
  if (topicsEmpty?.parentNode) topicsEmpty.remove()
  topicsData = topics

  if (topics.length === 0) {
    topicListEl.innerHTML = `<div class="empty-panel"><span>no active topics</span></div>`
    return
  }

  const watchTopics = topics.filter(t => t.topic.startsWith('$watch:'))
  const otherTopics = topics.filter(t => !t.topic.startsWith('$watch:'))

  let watchHtml = ''
  if (watchTopics.length > 0) {
    const isGroupExpanded = expandedTopics.has('$watch')
    const childrenHtml = isGroupExpanded
      ? `<div class="topic-children">${watchTopics.map(t => renderTopicEntry(t, t.topic.slice('$watch:'.length))).join('')}</div>`
      : ''
    watchHtml = `
      <div class="topic-entry">
        <div class="topic-row topic-group" data-topic="$watch" data-has-subs="true">
          <span class="tree-chevron topic-chevron" data-topic="$watch">${isGroupExpanded ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>
          <span class="topic-name">$watch</span>
          <span class="topic-sub-count">${watchTopics.length}</span>
        </div>
        ${childrenHtml}
      </div>`
  }

  topicListEl.innerHTML = watchHtml + otherTopics.map(t => renderTopicEntry(t)).join('')
}

topicListEl.addEventListener('click', e => {
  const row = e.target.closest('.topic-row')
  if (!row || row.dataset.hasSubs !== 'true') return
  const topic = row.dataset.topic
  expandedTopics.has(topic) ? expandedTopics.delete(topic) : expandedTopics.add(topic)
  updateTopics(topicsData)
})
