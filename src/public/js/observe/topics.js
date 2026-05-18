const topicListEl = document.getElementById('topic-list')

topicListEl?.addEventListener('topics', (e) => {
  topicListEl.update(e.detail)
})
