marked.use({
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start(src) { return src.indexOf('$$') },
      tokenizer(src) {
        const match = src.match(/^\$\$([\s\S]+?)\$\$/)
        if (match) return { type: 'blockMath', raw: match[0], math: match[1].trim() }
      },
      renderer(token) {
        return '<div class="math-block">' + katex.renderToString(token.math, { displayMode: true, throwOnError: false }) + '</div>'
      }
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) { return src.indexOf('$') },
      tokenizer(src) {
        const match = src.match(/^\$([^$\n]+?)\$/)
        if (match) return { type: 'inlineMath', raw: match[0], math: match[1].trim() }
      },
      renderer(token) {
        return '<span class="math-inline">' + katex.renderToString(token.math, { displayMode: false, throwOnError: false }) + '</span>'
      }
    }
  ]
})

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    image(href) {
      if (/\.(wav|mp3|ogg|m4a|flac)(\?.*)?$/i.test(href)) {
        return `<audio controls autoplay class="message-audio" src="${href}"></audio>`
      }
      return false
    }
  }
})

function copyCode(btn) {
  const code = btn.closest('.code-block').querySelector('code').textContent
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'copied'
    setTimeout(() => { btn.textContent = 'copy' }, 1800)
  })
}

// Exposed globally because it's called from onclick="copyCode(this)" in generated HTML
window.copyCode = copyCode

export function renderMarkdown(text) {
  const el = document.createElement('div')
  el.className = 'md'
  el.innerHTML = marked.parse(text)
  el.querySelectorAll('pre > code').forEach(block => {
    const langClass = Array.from(block.classList).find(c => c.startsWith('language-'))
    const lang = langClass ? langClass.replace('language-', '') : 'code'
    hljs.highlightElement(block)
    const pre = block.parentElement
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block'
    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">copy</button>`
    pre.replaceWith(wrapper)
    wrapper.appendChild(header)
    wrapper.appendChild(pre)
  })
  return el
}
