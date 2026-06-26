declare const marked: any;
declare const katex: any;
declare const hljs: any;

marked.use({
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start(src: string) { return src.indexOf('$$') },
      tokenizer(src: string) {
        const match = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (match) return { type: 'blockMath', raw: match[0], math: match[1]?.trim() };
      },
      renderer(token: any) {
        return '<div class="math-block">' + katex.renderToString(token.math, { displayMode: true, throwOnError: false }) + '</div>';
      }
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(src: string) { return src.indexOf('$') },
      tokenizer(src: string) {
        const match = src.match(/^\$([^$\n]+?)\$/);
        if (match) return { type: 'inlineMath', raw: match[0], math: match[1]?.trim() };
      },
      renderer(token: any) {
        return '<span class="math-inline">' + katex.renderToString(token.math, { displayMode: false, throwOnError: false }) + '</span>';
      }
    }
  ]
});

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    link(href: string, title: string, text: string) {
      const ytMatch = href.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      if (ytMatch) {
        const videoId = ytMatch[1];
        const embed = `<div class="video-container"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`;
        const isBareLink = text === href || 
                           text === href.replace(/^https?:\/\//, '') || 
                           text === href.replace(/^https?:\/\/www\./, '');
        
        if (isBareLink) {
          return embed;
        } else {
          return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>${embed}`;
        }
      }
      return false;
    }
  }
});

const copyCode = (btn: HTMLElement) => {
  const codeBlock = btn.closest('.code-block');
  if (!codeBlock) return;
  const codeEl = codeBlock.querySelector('code');
  if (!codeEl) return;
  const code = codeEl.textContent || '';
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy'; }, 1800);
  });
}

// Exposed globally because it's called from onclick="copyCode(this)" in generated HTML
(window as any).copyCode = copyCode;

export const renderMarkdown = (text: string) => {
  const el = document.createElement('div');
  el.className = 'md';
  el.innerHTML = marked.parse(text);
  el.querySelectorAll('pre > code').forEach(block => {
    const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : 'code';
    hljs.highlightElement(block);
    const pre = block.parentElement;
    if (!pre) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `<span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">copy</button>`;
    pre.replaceWith(wrapper);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
  return el;
}
