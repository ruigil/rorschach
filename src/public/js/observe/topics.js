const topicListEl = document.getElementById('topic-list')

export function updateTopics(topics) {
  topicListEl?.update(topics)
}
