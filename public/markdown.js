// Markdown rendering: marked (GitHub-flavoured Markdown incl. tables, task lists, nested lists)
// followed by DOMPurify, so no script or raw HTML from a message can ever run.
(function () {
  marked.use({ gfm: true, breaks: true });

  const ALLOWED_TAGS = [
    'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'input', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'sup', 'sub', 'kbd',
  ];
  const ALLOWED_ATTR = ['href', 'title', 'type', 'checked', 'disabled', 'align', 'start', 'class'];

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // Task-list checkboxes only, and read-only.
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    }
    // Only highlight.js-style language classes on code blocks.
    if (node.hasAttribute?.('class') && !(node.tagName === 'CODE' && /^language-[\w+-]+$/.test(node.getAttribute('class')))) {
      node.removeAttribute('class');
    }
  });

  const MENTION = /(^|[\s(])@([\p{L}\p{N}_-](?:[\p{L}\p{N}._-]{0,38}[\p{L}\p{N}_-])?)/gu;

  // Turn @Name in plain text (not inside code or links) into highlighted mentions.
  function highlightMentions(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement.closest('code, pre, a') && n.nodeValue.includes('@')) nodes.push(n);
    }
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = node.nodeValue;
      for (const m of text.matchAll(MENTION)) {
        const start = m.index + m[1].length;
        frag.append(text.slice(last, start));
        const span = document.createElement('span');
        span.className = 'mention';
        span.dataset.name = m[2];
        span.textContent = `@${m[2]}`;
        frag.append(span);
        last = start + 1 + m[2].length;
      }
      if (last === 0) continue;
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  function render(src) {
    const html = marked.parse(String(src ?? ''));
    const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, RETURN_DOM: true });
    highlightMentions(clean);
    // Wide tables scroll horizontally instead of breaking the layout.
    for (const table of clean.querySelectorAll('table')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    return clean.innerHTML;
  }

  window.renderMarkdown = render;
})();
