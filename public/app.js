(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    me: null,
    site: null,
    channels: [],
    current: null, // slug
    messages: [], // of current channel
    byId: new Map(),
    replyTo: null,
    events: null,
  };

  // ------------------------------------------------------------ helpers

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }

  function initials(name) {
    return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  }

  // Stable colour per name.
  function hue(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function attachmentsHtml(list = []) {
    if (!list.length) return '';
    const live = list.filter((a) => !a.expired);
    const images = live.filter((a) => a.kind === 'image');
    const files = live.filter((a) => a.kind !== 'image');
    const expired = list.filter((a) => a.expired);
    const until = (a) => `Available until ${new Date(a.expires_at).toLocaleString()}`;
    return `
      ${images.length ? `<div class="att-images${images.length === 1 ? ' single' : ''}">${images.map((a) => `
        <a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.filename)} · ${until(a)}"><img src="${esc(a.url)}" alt="${esc(a.filename)}" loading="lazy"></a>`).join('')}</div>` : ''}
      ${files.length || expired.length ? `<div class="att-files">${files.map((a) => `
        <a class="att-file" href="${esc(a.url)}?download" title="${until(a)}"><span>📄</span><span class="att-name">${esc(a.filename)}</span><span class="muted small">${fmtSize(a.size)}</span></a>`).join('')}${expired.map((a) => `
        <span class="att-file expired" title="Attachments are deleted after ${limits().retention_days} days"><span>⌛</span><span class="att-name">${esc(a.filename)}</span><span class="small">expired</span></span>`).join('')}</div>` : ''}`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  }

  function relTime(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 120) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  const baseUrl = () => state.site?.url || location.origin;

  // ------------------------------------------------------------ login

  async function start() {
    const params = new URLSearchParams(location.search);
    const urlKey = params.get('key');
    if (urlKey) {
      // Magic link: exchange the key for a cookie and remove it from the address bar.
      history.replaceState(null, '', location.pathname + location.hash);
      try { await api('/api/session', { method: 'POST', body: { key: urlKey } }); } catch (e) { showLogin(e.message); return; }
    }
    try {
      const { me, site } = await api('/api/me');
      state.me = me;
      state.site = site;
      await enterApp();
    } catch {
      showLogin();
    }
  }

  function showLogin(error) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').hidden = !error;
    $('#login-error').textContent = error || '';
    $('#login-key').focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/session', { method: 'POST', body: { key: $('#login-key').value.trim() } });
      $('#login-key').value = '';
      await start();
    } catch (err) {
      showLogin(err.message);
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/session', { method: 'DELETE', body: {} });
    state.events?.close();
    location.href = '/';
  });

  // ------------------------------------------------------------ app shell

  async function enterApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    document.title = state.site.name;
    $$('.site-name').forEach((el) => (el.textContent = state.site.name));
    $('#me-name').textContent = state.me.name;
    $('#me-kind').textContent = state.me.kind === 'ai' ? ' · AI' : state.me.is_admin ? ' · admin' : '';
    setAvatar($('#me-avatar'), state.me.name, state.me.kind);
    $('#open-admin').hidden = !state.me.is_admin;
    await loadChannels();
    connectStream();
    route();
  }

  function setAvatar(el, name, kind) {
    el.textContent = kind === 'ai' ? '◆' : initials(name);
    el.style.setProperty('--h', hue(name));
    el.classList.toggle('ai', kind === 'ai');
  }

  window.addEventListener('hashchange', route);

  function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash === 'admin' && state.me.is_admin) return openAdmin();
    $('#admin-view').hidden = true;
    $('#chat-view').hidden = false;
    const slug = state.channels.some((c) => c.slug === hash) ? hash : state.channels[0]?.slug;
    if (slug) openChannel(slug);
    else renderEmpty();
  }

  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#open-admin').addEventListener('click', () => (location.hash = 'admin'));
  $$('[data-close-admin]').forEach((b) => b.addEventListener('click', () => (location.hash = state.current || '')));

  // ------------------------------------------------------------ channels

  async function loadChannels() {
    state.channels = (await api('/api/channels')).channels;
    renderChannelList();
  }

  function unread(c) {
    const seen = store.get('aichat.seen', {})[c.slug] ?? 0;
    return c.slug !== state.current && c.last_message_id > seen;
  }

  function markSeen(slug, id) {
    const seen = store.get('aichat.seen', {});
    if ((seen[slug] ?? 0) < id) {
      seen[slug] = id;
      store.set('aichat.seen', seen);
    }
  }

  function renderChannelList() {
    $('#channel-list').innerHTML = state.channels.map((c) => `
      <li><a href="#${esc(c.slug)}" class="channel-link${c.slug === state.current ? ' active' : ''}${unread(c) ? ' unread' : ''}${c.archived ? ' archived' : ''}">
        <span class="hash">${c.is_open ? '#' : '🔒'}</span><span class="ch-name">${esc(c.slug)}</span>${c.access === 'read' ? '<span class="badge">read</span>' : ''}
      </a></li>`).join('') || '<li class="muted small pad">No channels you can access yet.</li>';
  }

  function renderEmpty() {
    $('#channel-title').textContent = 'No channels';
    $('#channel-topic').textContent = 'You have no access to any channel yet. Ask an admin.';
    $('#messages').innerHTML = '';
    $('#composer').hidden = true;
  }

  async function openChannel(slug) {
    $('#sidebar').classList.remove('open');
    const channel = state.channels.find((c) => c.slug === slug);
    const switching = state.current !== slug;
    state.current = slug;
    if (location.hash.slice(1) !== slug) history.replaceState(null, '', `#${slug}`);
    $('#channel-title').textContent = `${channel.is_open ? '#' : '🔒 '}${channel.slug}${channel.title && channel.title !== channel.slug ? ` · ${channel.title}` : ''}`;
    $('#channel-topic').textContent = channel.topic || '';
    $('#composer').hidden = false;
    $('#input').placeholder = `Message #${channel.slug}  (Shift+Enter: new line)`;
    const canWrite = channel.access === 'write';
    $('.composer-row').hidden = !canWrite;
    $('#readonly-note').hidden = canWrite;
    $('#readonly-note').textContent = channel.archived ? 'This channel is archived (read-only).' : 'You can read this channel but not write in it.';
    if (switching) {
      setReply(null);
      $('#participants').hidden = true;
    }
    renderChannelList();
    const { messages } = await api(`/api/channels/${encodeURIComponent(slug)}/messages?limit=100`);
    if (state.current !== slug) return;
    state.messages = messages;
    state.byId = new Map(messages.map((m) => [m.id, m]));
    renderMessages(true);
    loadParticipants();
    if (canWrite && matchMedia('(pointer: fine)').matches) $('#input').focus();
  }

  async function loadParticipants() {
    const slug = state.current;
    const { participants } = await api(`/api/channels/${encodeURIComponent(slug)}/participants`);
    if (slug !== state.current) return;
    state.participants = participants;
    const ais = participants.filter((p) => p.kind === 'ai').length;
    $('#participants-btn').textContent = `${participants.length - ais} 👤 · ${ais} ◆`;
    $('#participants').innerHTML = participants.map((p) => `
      <div class="participant">
        <span class="avatar sm${p.kind === 'ai' ? ' ai' : ''}" style="--h:${hue(p.name)}">${p.kind === 'ai' ? '◆' : esc(initials(p.name))}</span>
        <span><b>${esc(p.name)}</b> ${p.access === 'read' ? '<span class="badge">read</span>' : ''}<br><span class="muted small">${esc(p.description || (p.kind === 'ai' ? 'AI' : 'Human'))} · ${relTime(p.last_seen_at)}</span></span>
      </div>`).join('');
  }

  $('#participants-btn').addEventListener('click', () => ($('#participants').hidden = !$('#participants').hidden));

  // ------------------------------------------------------------ messages

  function messageHtml(m, prev) {
    const parent = m.reply_to ? state.byId.get(m.reply_to) : null;
    const grouped = prev && prev.author === m.author && !m.reply_to && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60_000;
    const mine = m.author === state.me.name;
    const mentionsMe = new RegExp(`(^|\\s)@${state.me.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.content);
    return `
      <article class="msg${grouped ? ' grouped' : ''}${mentionsMe ? ' mentioned' : ''}" id="m${m.id}" data-id="${m.id}">
        <span class="avatar${m.author_kind === 'ai' ? ' ai' : ''}" style="--h:${hue(m.author)}">${m.author_kind === 'ai' ? '◆' : esc(initials(m.author))}</span>
        <div class="msg-body">
          ${parent || m.reply_to ? `<a class="reply-ref" href="#m${m.reply_to}" data-jump="${m.reply_to}">↪ ${parent ? `<b>${esc(parent.author)}</b> ${esc(parent.content.replace(/[*_`#>~]/g, '').slice(0, 90))}` : `message #${m.reply_to}`}</a>` : ''}
          <header>
            <b class="author">${esc(m.author)}</b>
            ${m.author_kind === 'ai' ? '<span class="badge ai">AI</span>' : ''}
            <time datetime="${m.created_at}" title="${new Date(m.created_at).toLocaleString()}">${fmtTime(m.created_at)}</time>
            <span class="msg-id">#${m.id}</span>
          </header>
          ${m.content ? `<div class="content">${window.renderMarkdown(m.content)}</div>` : ''}
          ${attachmentsHtml(m.attachments)}
        </div>
        <div class="msg-actions">
          ${$('.composer-row').hidden ? '' : '<button class="icon-btn" data-reply title="Reply">↩</button>'}
          <button class="icon-btn" data-copy title="Copy text">⧉</button>
          ${mine || state.me.is_admin ? '<button class="icon-btn" data-delete title="Delete">🗑</button>' : ''}
        </div>
      </article>`;
  }

  // Keep the view pinned to the newest message while images finish loading.
  let stickToBottom = true;
  $('#messages').addEventListener('scroll', () => {
    const box = $('#messages');
    stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  });
  $('#messages').addEventListener('load', () => {
    if (stickToBottom) $('#messages').scrollTop = $('#messages').scrollHeight;
  }, true);

  function renderMessages(scrollToEnd) {
    const box = $('#messages');
    if (!state.messages.length) {
      box.innerHTML = '<div class="empty muted">No messages yet. Start the conversation.</div>';
      return;
    }
    box.innerHTML = state.messages.map((m, i) => messageHtml(m, state.messages[i - 1])).join('');
    if (scrollToEnd) box.scrollTop = box.scrollHeight;
    markSeen(state.current, state.messages.at(-1).id);
  }

  function appendMessage(m) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    state.messages.push(m);
    state.byId.set(m.id, m);
    if (state.messages.length === 1) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', messageHtml(m, state.messages.at(-2)));
    if (atBottom || m.author === state.me.name) box.scrollTop = box.scrollHeight;
    if (document.visibilityState === 'visible') markSeen(state.current, m.id);
  }

  $('#messages').addEventListener('click', async (e) => {
    const msgEl = e.target.closest('.msg');
    const m = msgEl && state.byId.get(Number(msgEl.dataset.id));
    if (e.target.closest('[data-jump]')) {
      e.preventDefault();
      const target = $(`#m${e.target.closest('[data-jump]').dataset.jump}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.classList.add('flash');
      setTimeout(() => target?.classList.remove('flash'), 1500);
    } else if (e.target.closest('[data-reply]')) {
      setReply(m);
    } else if (e.target.closest('[data-copy]')) {
      await navigator.clipboard.writeText(m.content);
      toast('Copied');
    } else if (e.target.closest('[data-delete]')) {
      if (!confirm('Delete this message?')) return;
      try { await api(`/api/messages/${m.id}`, { method: 'DELETE', body: {} }); } catch (err) { toast(err.message, true); }
    } else if (e.target.closest('.mention')) {
      insertText(`@${e.target.closest('.mention').dataset.name} `);
    }
  });

  function setReply(m) {
    state.replyTo = m;
    $('#reply-bar').hidden = !m;
    if (m) {
      $('#reply-name').textContent = `${m.author} (#${m.id})`;
      $('#input').focus();
    }
  }

  $('#reply-cancel').addEventListener('click', () => setReply(null));

  function insertText(t) {
    const input = $('#input');
    input.setRangeText(t, input.selectionStart, input.selectionEnd, 'end');
    input.focus();
    autosize();
  }

  // ------------------------------------------------------------ composer

  const autosize = () => {
    const input = $('#input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
    input.style.overflowY = input.scrollHeight > 260 ? 'auto' : 'hidden';
  };
  $('#input').addEventListener('input', autosize);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    } else if (e.key === 'Escape') {
      setReply(null);
    }
  });

  // @mention picker: typing "@" shows the channel's participants; arrows/Enter/Tab pick one.
  const mention = { open: false, start: 0, items: [], index: 0 };
  const menu = $('#mention-menu');

  function mentionQuery() {
    const input = $('#input');
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(?:^|[\s(])@([\p{L}\p{N}._-]{0,40})$/u);
    return m ? { query: m[1], start: input.selectionStart - m[1].length - 1 } : null;
  }

  function closeMention() {
    mention.open = false;
    menu.hidden = true;
  }

  function updateMention() {
    const q = mentionQuery();
    if (!q) return closeMention();
    const needle = q.query.toLowerCase();
    const all = (state.participants || []).filter((p) => p.name !== state.me.name);
    const starts = all.filter((p) => p.name.toLowerCase().startsWith(needle));
    const contains = all.filter((p) => !starts.includes(p) && p.name.toLowerCase().includes(needle));
    mention.items = [...starts, ...contains].slice(0, 8);
    if (!mention.items.length) return closeMention();
    mention.start = q.start;
    mention.index = Math.min(mention.index, mention.items.length - 1);
    mention.open = true;
    menu.hidden = false;
    menu.innerHTML = mention.items.map((p, i) => `
      <div class="mention-item${i === mention.index ? ' active' : ''}" role="option" data-i="${i}">
        <span class="avatar sm${p.kind === 'ai' ? ' ai' : ''}" style="--h:${hue(p.name)}">${p.kind === 'ai' ? '◆' : esc(initials(p.name))}</span>
        <b>${esc(p.name)}</b><span class="muted small">${p.kind === 'ai' ? 'AI' : 'Human'}${p.description ? ` · ${esc(p.description)}` : ''}</span>
      </div>`).join('');
  }

  function pickMention(i) {
    const p = mention.items[i];
    if (!p) return;
    const input = $('#input');
    input.setRangeText(`@${p.name} `, mention.start, input.selectionStart, 'end');
    closeMention();
    input.focus();
    autosize();
  }

  $('#input').addEventListener('input', () => {
    mention.index = 0;
    updateMention();
  });
  $('#input').addEventListener('click', updateMention);
  $('#input').addEventListener('blur', () => setTimeout(closeMention, 150));
  // Capture phase: runs before the Enter-to-send handler.
  $('#input').addEventListener('keydown', (e) => {
    if (!mention.open) return;
    const n = mention.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      updateMention();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pickMention(mention.index);
    } else if (e.key === 'Escape') {
      closeMention();
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  menu.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-i]');
    if (!item) return;
    e.preventDefault();
    pickMention(Number(item.dataset.i));
  });

  // Files chosen for the next message. Each is uploaded on send; the upload id is kept so a failed send can be retried.
  let pending = [];
  let sending = false;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const limits = () => state.site?.limits ?? { max_images: 10, max_files: 5, max_upload_mb: 10, retention_days: 3 };

  function addFiles(files) {
    const l = limits();
    for (const file of files) {
      const kind = IMAGE_TYPES.includes(file.type) ? 'image' : 'file';
      const count = pending.filter((p) => p.kind === kind).length;
      if (kind === 'image' && count >= l.max_images) { toast(`Max ${l.max_images} images per post.`, true); continue; }
      if (kind === 'file' && count >= l.max_files) { toast(`Max ${l.max_files} files per post.`, true); continue; }
      if (file.size > l.max_upload_mb * 1024 * 1024) { toast(`${file.name} is larger than ${l.max_upload_mb} MB.`, true); continue; }
      pending.push({ file, kind, preview: kind === 'image' ? URL.createObjectURL(file) : null, id: null });
    }
    renderPending();
  }

  function renderPending() {
    const box = $('#pending');
    box.hidden = !pending.length;
    box.innerHTML = pending.map((p, i) => `
      <div class="chip${p.kind === 'image' ? ' img' : ''}" title="${esc(p.file.name)}">
        ${p.preview ? `<img src="${p.preview}" alt="">` : `<span class="chip-icon">📄</span><span class="chip-name">${esc(p.file.name)}</span>`}
        <button type="button" class="chip-x" data-remove="${i}" title="Remove">✕</button>
      </div>`).join('') + `<span class="muted small pending-note">Deleted after ${limits().retention_days} days</span>`;
  }

  function clearPending() {
    pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    pending = [];
    renderPending();
  }

  $('#pending').addEventListener('click', (e) => {
    const i = e.target.closest('[data-remove]')?.dataset.remove;
    if (i === undefined) return;
    const [p] = pending.splice(Number(i), 1);
    if (p.preview) URL.revokeObjectURL(p.preview);
    renderPending();
  });

  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('#input').addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  });
  const chatView = $('#chat-view');
  chatView.addEventListener('dragover', (e) => {
    if (!$('.composer-row').hidden && e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      chatView.classList.add('dropping');
    }
  });
  chatView.addEventListener('dragleave', (e) => { if (!chatView.contains(e.relatedTarget)) chatView.classList.remove('dropping'); });
  chatView.addEventListener('drop', (e) => {
    chatView.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length || $('.composer-row').hidden) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  async function upload(file) {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${file.name}: ${data.error || res.statusText}`);
    return data.attachment.id;
  }

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#input');
    const content = input.value.trim();
    if ((!content && !pending.length) || sending) return;
    sending = true;
    $('#composer').classList.add('busy');
    try {
      for (const p of pending) p.id ??= await upload(p.file);
      await api(`/api/channels/${encodeURIComponent(state.current)}/messages`, {
        method: 'POST',
        body: { content, reply_to: state.replyTo?.id, attachments: pending.map((p) => p.id) },
      });
      input.value = '';
      autosize();
      setReply(null);
      clearPending();
    } catch (err) {
      toast(err.message, true);
    } finally {
      sending = false;
      $('#composer').classList.remove('busy');
    }
  });

  // ------------------------------------------------------------ live updates

  function connectStream() {
    state.events?.close();
    const es = new EventSource('/api/stream');
    state.events = es;
    es.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const ch = state.channels.find((c) => c.slug === m.channel);
      if (ch) {
        ch.last_message_id = m.id;
        ch.message_count++;
      }
      if (m.channel === state.current && !state.byId.has(m.id)) appendMessage(m);
      renderChannelList();
    });
    es.addEventListener('delete', (e) => {
      const { id, channel } = JSON.parse(e.data);
      if (channel !== state.current) return;
      state.messages = state.messages.filter((m) => m.id !== id);
      state.byId.delete(id);
      renderMessages(false);
    });
    // After a reconnect, catch up on anything we missed.
    es.addEventListener('open', async () => {
      if (!state.current || !state.messages.length) return;
      const slug = state.current;
      const { messages } = await api(`/api/channels/${encodeURIComponent(slug)}/messages?after=${state.messages.at(-1).id}&limit=200`);
      if (slug === state.current) messages.filter((m) => !state.byId.has(m.id)).forEach(appendMessage);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.messages.length) {
      markSeen(state.current, state.messages.at(-1).id);
      renderChannelList();
    }
  });

  // ------------------------------------------------------------ connect dialog

  function connectSnippets(token) {
    const k = token || '<YOUR_KEY>';
    const url = `${baseUrl()}/mcp`;
    return `
      <p class="muted small">Give each AI its own key (Admin → Keys). Then connect it in one of these ways:</p>
      <h4>Claude Code</h4>
      <pre class="copyable"><code>claude mcp add --transport http aichat ${esc(url)} --header "Authorization: Bearer ${esc(k)}"</code></pre>
      <h4>MCP config (Claude Desktop, Cursor, other clients)</h4>
      <pre class="copyable"><code>${esc(JSON.stringify({ mcpServers: { aichat: { type: 'http', url, headers: { Authorization: `Bearer ${k}` } } } }, null, 2))}</code></pre>
      <h4>Client without header support</h4>
      <pre class="copyable"><code>${esc(url)}?key=${esc(k)}</code></pre>
      <h4>Browser / login link</h4>
      <pre class="copyable"><code>${esc(baseUrl())}/?key=${esc(k)}</code></pre>
      <p class="muted small">Plain HTTP API and instructions for agents: <a href="/llms.txt" target="_blank">${esc(baseUrl())}/llms.txt</a></p>`;
  }

  $('#rotate-me').addEventListener('click', async () => {
    if (!confirm('Create a new key for yourself?\n\nYour current key stops working immediately — update it everywhere you use it (MCP config, other browsers).')) return;
    try {
      const { key, token } = await api('/api/me/rotate', { method: 'POST', body: {} });
      $('#connect-title').textContent = 'Your new key';
      $('#connect-body').innerHTML = `
        <p><b>Your new key — copy it now, it is shown only once.</b></p>
        <pre class="copyable big"><code>${esc(token)}</code></pre>
        ${key.kind === 'ai' ? connectSnippets(token) : `<h4>Login link</h4><pre class="copyable"><code>${esc(baseUrl())}/?key=${esc(token)}</code></pre>`}`;
      $('#connect-dialog').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#open-connect').addEventListener('click', () => {
    $('#connect-title').textContent = 'Connect an AI';
    $('#connect-body').innerHTML = connectSnippets();
    $('#connect-dialog').showModal();
  });

  document.addEventListener('click', async (e) => {
    const pre = e.target.closest('pre.copyable');
    if (!pre) return;
    await navigator.clipboard.writeText(pre.innerText);
    toast('Copied to clipboard');
  });

  // ------------------------------------------------------------ admin

  let adminTab = 'keys';
  let adminKeys = [];
  let adminChannels = [];

  async function openAdmin() {
    $('#sidebar').classList.remove('open');
    $('#chat-view').hidden = true;
    $('#admin-view').hidden = false;
    showTab(adminTab);
  }

  function showTab(tab) {
    adminTab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    return tab === 'keys' ? loadKeys() : loadAdminChannels();
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  async function loadKeys() {
    adminKeys = (await api('/api/admin/keys')).keys;
    $('#key-rows').innerHTML = adminKeys.map((k) => `
      <tr class="${k.revoked ? 'revoked' : ''}" data-key="${k.id}">
        <td><span class="avatar sm${k.kind === 'ai' ? ' ai' : ''}" style="--h:${hue(k.name)}">${k.kind === 'ai' ? '◆' : esc(initials(k.name))}</span>
            <b>${esc(k.name)}</b>${k.is_admin ? ' <span class="badge">admin</span>' : ''}${k.revoked ? ' <span class="badge danger">revoked</span>' : ''}
            ${k.description ? `<div class="muted small">${esc(k.description)}</div>` : ''}</td>
        <td>${k.kind === 'ai' ? 'AI' : 'Human'}</td>
        <td><code>${esc(k.token_hint)}</code></td>
        <td class="muted small">${relTime(k.last_seen_at)}</td>
        <td class="actions-cell"><div class="actions">
          <button class="btn ghost small-btn" data-act="rename">Rename</button>
          <button class="btn ghost small-btn" data-act="rotate" title="Issue a new secret; the old one stops working">New secret</button>
          <button class="btn ghost small-btn" data-act="admin">${k.is_admin ? 'Remove admin' : 'Make admin'}</button>
          <button class="btn ghost small-btn ${k.revoked ? '' : 'danger'}" data-act="revoke">${k.revoked ? 'Restore' : 'Revoke'}</button>
        </div></td>
      </tr>`).join('');
  }

  function showNewKey(key, token, title) {
    const box = $('#new-key');
    box.hidden = false;
    box.innerHTML = `
      <div class="new-key-head"><h3>${esc(title)}: ${esc(key.name)}</h3><button class="icon-btn" data-close-new>✕</button></div>
      <p><b>Copy this key now — it is shown only once.</b></p>
      <pre class="copyable big"><code>${esc(token)}</code></pre>
      ${key.kind === 'ai' ? connectSnippets(token) : `<h4>Login link for ${esc(key.name)}</h4><pre class="copyable"><code>${esc(baseUrl())}/?key=${esc(token)}</code></pre>`}`;
    box.querySelector('[data-close-new]').onclick = () => (box.hidden = true);
    box.scrollIntoView({ behavior: 'smooth' });
  }

  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { key, token } = await api('/api/admin/keys', {
        method: 'POST',
        body: { name: f.get('name'), kind: f.get('kind'), description: f.get('description'), is_admin: f.get('is_admin') === 'on' },
      });
      e.target.reset();
      showNewKey(key, token, 'New key');
      loadKeys();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#key-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const key = adminKeys.find((k) => k.id === Number(btn.closest('tr').dataset.key));
    try {
      switch (btn.dataset.act) {
        case 'rename': {
          const name = prompt('New name:', key.name);
          if (name && name !== key.name) await api(`/api/admin/keys/${key.id}`, { method: 'PATCH', body: { name } });
          break;
        }
        case 'rotate': {
          if (!confirm(`Issue a new secret for ${key.name}? The current one stops working immediately.`)) return;
          const { token } = await api(`/api/admin/keys/${key.id}/rotate`, { method: 'POST', body: {} });
          showNewKey(key, token, 'New secret');
          break;
        }
        case 'admin':
          await api(`/api/admin/keys/${key.id}`, { method: 'PATCH', body: { is_admin: !key.is_admin } });
          break;
        case 'revoke':
          if (!key.revoked && !confirm(`Revoke ${key.name}? It can no longer log in or connect.`)) return;
          await api(`/api/admin/keys/${key.id}`, { method: 'PATCH', body: { revoked: !key.revoked } });
          break;
      }
      await loadKeys();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function loadAdminChannels() {
    const [{ channels }, { keys }] = await Promise.all([api('/api/admin/channels'), api('/api/admin/keys')]);
    adminKeys = keys;
    adminChannels = channels;
    const active = keys.filter((k) => !k.revoked && !k.is_admin);
    $('#channel-cards').innerHTML = channels.map((c) => {
      const levels = new Map(c.access_list.map((a) => [a.key_id, a.level]));
      return `
      <div class="card channel-card" data-channel="${c.id}">
        <div class="channel-card-head">
          <h3>${c.is_open ? '#' : '🔒 '}${esc(c.slug)} ${c.archived ? '<span class="badge">archived</span>' : ''}</h3>
          <div class="actions">
            <button class="btn ghost small-btn" data-act="edit">Edit</button>
            <button class="btn ghost small-btn" data-act="archive">${c.archived ? 'Unarchive' : 'Archive'}</button>
            <button class="btn ghost small-btn danger" data-act="delete">Delete</button>
          </div>
        </div>
        <p class="muted small">${esc(c.title)}${c.topic ? ` — ${esc(c.topic)}` : ''} · ${c.message_count} messages</p>
        <label class="switch"><input type="checkbox" data-act="open" ${c.is_open ? 'checked' : ''}><span></span> Open to everyone (every key can read &amp; write)</label>
        ${c.is_open ? '' : `
          <div class="access-grid">
            ${active.length ? active.map((k) => {
              const lv = levels.get(k.id) || 'none';
              return `<div class="access-row" data-key="${k.id}">
                <span><span class="avatar sm${k.kind === 'ai' ? ' ai' : ''}" style="--h:${hue(k.name)}">${k.kind === 'ai' ? '◆' : esc(initials(k.name))}</span>${esc(k.name)}</span>
                <span class="seg">${['none', 'read', 'write'].map((l) => `<button class="${lv === l ? 'on' : ''}" data-level="${l}">${{ none: 'No access', read: 'Read', write: 'Read & write' }[l]}</button>`).join('')}</span>
              </div>`;
            }).join('') : '<p class="muted small">No non-admin keys yet. Admins can always access every channel.</p>'}
          </div>`}
      </div>`;
    }).join('');
  }

  $('#channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/admin/channels', {
        method: 'POST',
        body: { slug: f.get('slug'), title: f.get('title') || f.get('slug'), topic: f.get('topic'), is_open: f.get('is_open') === 'on' },
      });
      e.target.reset();
      await Promise.all([loadAdminChannels(), loadChannels()]);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#channel-cards').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-channel]');
    if (!card) return;
    const id = Number(card.dataset.channel);
    const channel = adminChannels.find((c) => c.id === id);
    const levelBtn = e.target.closest('[data-level]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (levelBtn) {
        const keyId = levelBtn.closest('[data-key]').dataset.key;
        const level = levelBtn.dataset.level;
        await api(`/api/admin/channels/${id}/access/${keyId}`, { method: 'PUT', body: { level: level === 'none' ? null : level } });
        $$('button', levelBtn.parentElement).forEach((b) => b.classList.toggle('on', b === levelBtn));
        return;
      }
      if (act === 'open') {
        await api(`/api/admin/channels/${id}`, { method: 'PATCH', body: { is_open: e.target.checked } });
      } else if (act === 'archive') {
        await api(`/api/admin/channels/${id}`, { method: 'PATCH', body: { archived: !channel.archived } });
      } else if (act === 'edit') {
        const title = prompt('Title:', channel.title);
        if (title === null) return;
        const topic = prompt('Topic:', channel.topic);
        if (topic === null) return;
        await api(`/api/admin/channels/${id}`, { method: 'PATCH', body: { title, topic } });
      } else if (act === 'delete') {
        if (prompt(`This deletes #${channel.slug} and ALL its messages. Type the channel name to confirm:`) !== channel.slug) return;
        await api(`/api/admin/channels/${id}`, { method: 'DELETE', body: {} });
      } else {
        return;
      }
      await Promise.all([loadAdminChannels(), loadChannels()]);
    } catch (err) {
      toast(err.message, true);
    }
  });

  start();
})();
