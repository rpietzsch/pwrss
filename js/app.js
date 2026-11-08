import { Feedly, ApiError } from './api.js';
import { DemoFeedly } from './demo.js';
import { sanitize, readerView } from './reader.js';
import { swipeRows, edgeBack, flick, pullToRefresh } from './gestures.js';

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pwrss.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pwrss.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('pwrss.' + k); } catch {} },
};

const DEFAULTS = {
  token: '', proxy: '', proxyKey: '', demo: false, userId: null,
  markOnOpen: true, markOnScroll: false, readerDefault: false, thumbs: true,
  sort: 'newest', swipeRight: 'read', theme: 'auto', fontSize: 18, font: 'sans',
};

const S = {
  settings: { ...DEFAULTS, ...LS.get('settings', {}) },
  api: null,
  cats: [], subs: [], subById: new Map(), counts: new Map(),
  filter: LS.get('filter', 'unread'),
  collapsed: new Set(LS.get('collapsed', [])),
  streamId: LS.get('stream', null),
  entries: [], byId: new Map(), continuation: null, loading: false, gen: 0,
  currentId: null, reader: false,
  pending: LS.get('pending', {}),
};

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = {
  app: $('#app'), sourceList: $('#source-list'), entries: $('#entries'), listTitle: $('#list-title'),
  listSub: $('#list-sub'), content: $('#content'), articleScroll: $('#article-scroll'), toast: $('#toast'),
  settings: $('#settings'), form: $('#settings-form'), peek: $('#peek'), peekBody: $('#peek-body'),
  filterBtn: $('#filter-btn'), readBtn: $('#read-btn'), starBtn: $('#star-btn'), readerBtn: $('#reader-btn'),
  article: $('#article'), list: $('#list'), sources: $('#sources'), ptr: $('#ptr'),
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const setIcon = (btn, name) => { btn.querySelector('use').setAttribute('href', '#i-' + name); };

const tpl = document.createElement('template');
function textOf(html) {
  tpl.innerHTML = (html || '').replace(/<(\/(p|div|li|h\d|blockquote|figure|tr)|br\s*\/?)>/gi, ' $&');
  return tpl.content.textContent.replace(/\s+/g, ' ').trim();
}

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const fullDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function fail(e) {
  console.error(e);
  toast(e?.message || String(e), 4500);
  if (e instanceof ApiError && e.status === 401) openSettings();
}

const isWide = () => matchMedia('(min-width: 1100px)').matches;
const isNarrow = () => matchMedia('(max-width: 759px)').matches;

// ---------- entry helpers ----------
const entryUrl = (e) =>
  (typeof e.canonicalUrl === 'string' ? e.canonicalUrl : null) || e.canonical?.[0]?.href ||
  e.alternate?.find((a) => !a.type || a.type.includes('html'))?.href ||
  (e.originId?.startsWith('http') ? e.originId : null);
const entryHtml = (e) => e.fullContent || e.content?.content || e.summary?.content || '';
const isSaved = (e) => !!e.tags?.some((t) => t.id.endsWith('/tag/global.saved'));
function entryThumb(e) {
  const v = e.visual?.url;
  if (v && v !== 'none' && /^https?:/.test(v)) return v;
  const m = /<img[^>]+src=["'](https?:[^"']+)["']/i.exec(entryHtml(e));
  if (m && !/feedburner|pixel|tracking|\.gif(\?|$)/i.test(m[1])) return m[1];
  return null;
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
function favicon(feedId, title) {
  const sub = S.subById.get(feedId);
  const url = S.api?.demo ? '' : sub?.iconUrl || sub?.visualUrl ||
    (hostOf(sub?.website || feedId?.replace(/^feed\//, '')) ? `https://icons.duckduckgo.com/ip3/${hostOf(sub?.website || feedId.replace(/^feed\//, ''))}.ico` : '');
  const letter = esc((title || sub?.title || '?').trim().charAt(0).toUpperCase());
  return `<span class="fav" data-l="${letter}">${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`;
}
document.addEventListener('error', (ev) => {
  if (ev.target.tagName === 'IMG' && ev.target.parentElement?.classList.contains('fav')) ev.target.remove();
  if (ev.target.tagName === 'IMG' && ev.target.classList.contains('thumb')) ev.target.remove();
}, true);

// ---------- special streams ----------
const TODAY = 'pwrss:today';
const streamTitle = (id) => {
  if (!id || !S.api) return 'All';
  if (id === S.api.allId()) return 'All';
  if (id === TODAY) return 'Today';
  if (id === S.api.savedId()) return 'Saved';
  if (id.startsWith('feed/')) return S.subById.get(id)?.title || 'Feed';
  return S.cats.find((c) => c.id === id)?.label || id.split('/').pop();
};
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- theme ----------
function applyAppearance() {
  const st = S.settings;
  document.documentElement.dataset.theme = st.theme;
  document.documentElement.style.setProperty('--article-size', st.fontSize + 'px');
  document.documentElement.dataset.font = st.font;
  document.documentElement.classList.toggle('no-thumbs', !st.thumbs);
}

// ---------- views & history ----------
function setView(v) {
  el.app.dataset.view = v;
}
function go(v) {
  if (el.app.dataset.view === v) return;
  history.pushState({ view: v }, '');
  setView(v);
}
function back() {
  const v = el.app.dataset.view;
  if (history.state?.view && history.state.view !== 'list' && history.length > 1) history.back();
  else if (v === 'article') setView('list');
  else if (v === 'list' && !isWide()) go('sources');
}
addEventListener('popstate', (e) => setView(e.state?.view || 'list'));

// ---------- sources ----------
function countOf(id) { return S.counts.get(id) || 0; }

function renderSources() {
  const api = S.api;
  if (!api) { el.sourceList.innerHTML = ''; return; }
  const unreadOnly = S.filter === 'unread';
  const row = (id, label, lead, count, extra = '') => `
    <a class="src ${S.streamId === id ? 'active' : ''} ${extra}" data-stream="${esc(id)}" href="#">
      ${lead}<span class="src-label">${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}
    </a>`;

  let html = `<div class="src-group smart">
    ${row(api.allId(), 'All', `<span class="src-ico">${icon('inbox')}</span>`, countOf(api.allId()))}
    ${row(TODAY, 'Today', `<span class="src-ico">${icon('today')}</span>`, 0)}
    ${row(api.savedId(), 'Saved', `<span class="src-ico">${icon('star')}</span>`, 0)}
  </div>`;

  const byCat = new Map(S.cats.map((c) => [c.id, []]));
  const uncategorized = [];
  for (const s of S.subs) {
    if (!s.categories?.length) uncategorized.push(s);
    for (const c of s.categories || []) {
      if (!byCat.has(c.id)) { byCat.set(c.id, []); S.cats.push(c); }
      byCat.get(c.id).push(s);
    }
  }
  const feedRows = (subs) => subs
    .slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .filter((s) => !unreadOnly || countOf(s.id) > 0 || s.id === S.streamId)
    .map((s) => row(s.id, s.title || s.website || s.id, favicon(s.id, s.title), countOf(s.id), 'feed')).join('');

  for (const c of S.cats) {
    const subs = byCat.get(c.id) || [];
    if (!subs.length) continue;
    const n = countOf(c.id);
    if (unreadOnly && !n && S.streamId !== c.id && !subs.some((s) => s.id === S.streamId)) continue;
    const collapsed = S.collapsed.has(c.id);
    html += `<div class="src-group ${collapsed ? 'collapsed' : ''}" data-cat="${esc(c.id)}">
      <div class="cat-row">
        <button class="chev" data-collapse="${esc(c.id)}" aria-label="Toggle ${esc(c.label)}" aria-expanded="${!collapsed}">${icon('chevron')}</button>
        ${row(c.id, c.label, `<span class="src-ico">${icon('folder')}</span>`, n, 'cat')}
      </div>
      <div class="feeds">${feedRows(subs)}</div>
    </div>`;
  }
  if (uncategorized.length) {
    html += `<div class="src-group"><div class="cat-row plain"><span class="src-label muted">Uncategorized</span></div><div class="feeds">${feedRows(uncategorized)}</div></div>`;
  }
  if (S.api.demo) html += `<p class="demo-note">Demo mode · <a href="#" data-action="settings">connect Feedly</a></p>`;
  el.sourceList.innerHTML = html;
}

el.sourceList.addEventListener('click', (ev) => {
  const col = ev.target.closest('[data-collapse]');
  if (col) {
    ev.preventDefault();
    const id = col.dataset.collapse;
    S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id);
    LS.set('collapsed', [...S.collapsed]);
    col.closest('.src-group').classList.toggle('collapsed');
    col.setAttribute('aria-expanded', String(!S.collapsed.has(id)));
    return;
  }
  const a = ev.target.closest('[data-stream]');
  if (!a) return;
  ev.preventDefault();
  openStream(a.dataset.stream);
  if (!isWide()) {
    if (el.app.dataset.view === 'sources' && history.state?.view === 'sources') history.back();
    else setView('list');
  }
});

// ---------- list ----------
function entryRow(e) {
  const thumb = S.settings.thumbs ? entryThumb(e) : null;
  const snippet = textOf(entryHtml(e)).slice(0, 260);
  const right = S.settings.swipeRight;
  const leftAction = right === 'read' ? 'star' : 'read';
  const lbl = (a) => (a === 'read' ? (e.unread ? 'Read' : 'Unread') : (isSaved(e) ? 'Unsave' : 'Save'));
  return `<div class="entry row ${e.unread ? 'unread' : 'read'} ${isSaved(e) ? 'saved' : ''} ${S.currentId === e.id ? 'active' : ''}" data-id="${esc(e.id)}" role="button" tabindex="0">
    <div class="swipe-bg bg-right act-${right}"><span>${icon(right === 'read' ? 'dot-fill' : 'star-fill')}${lbl(right)}</span></div>
    <div class="swipe-bg bg-left act-${leftAction}"><span>${lbl(leftAction)}${icon(leftAction === 'read' ? 'dot-fill' : 'star-fill')}</span></div>
    <div class="row-inner">
      <div class="e-main">
        <div class="e-meta">${favicon(e.origin?.streamId, e.origin?.title)}<span class="e-src">${esc(e.origin?.title || '')}</span><span class="e-time">${ago(e.published || e.crawled)}</span><span class="e-star">${icon('star-fill')}</span></div>
        <div class="e-title">${esc(e.title || '(untitled)')}</div>
        ${snippet ? `<div class="e-snip">${esc(snippet)}</div>` : ''}
      </div>
      ${thumb ? `<img class="thumb" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    </div>
  </div>`;
}

function rowFor(id) { return el.entries.querySelector(`[data-id="${CSS.escape(id)}"]`); }
function refreshRow(e) {
  const r = rowFor(e.id);
  if (!r) return;
  r.outerHTML = entryRow(e);
  observeRow(rowFor(e.id));
}

function renderList({ append = false, from = 0 } = {}) {
  el.listTitle.textContent = streamTitle(S.streamId);
  updateListSub();
  setIcon(el.filterBtn, S.filter === 'unread' ? 'dot-fill' : 'dot');
  el.filterBtn.title = S.filter === 'unread' ? 'Showing unread — tap for all (U)' : 'Showing all — tap for unread only (U)';
  const items = S.entries.slice(from).map(entryRow).join('');
  const footer = S.loading ? '<div class="list-foot"><span class="spinner"></span></div>'
    : S.continuation ? '<div class="list-foot sentinel"></div>'
    : S.entries.length ? `<div class="list-foot muted">${S.filter === 'unread' ? 'You’re all caught up' : 'No more articles'}</div>` : '';
  if (append) {
    el.entries.querySelector('.list-foot')?.remove();
    el.entries.insertAdjacentHTML('beforeend', items + footer);
  } else if (!S.entries.length && !S.loading) {
    el.entries.innerHTML = `<div class="empty-state"><div class="big">${icon('check-all')}</div><p>${S.filter === 'unread' ? 'All caught up' : 'No articles'}</p>${S.filter === 'unread' ? '<button class="ghost" data-action="toggle-filter">Show all articles</button>' : ''}</div>`;
  } else {
    el.entries.innerHTML = items + footer;
  }
  $$('.entry', el.entries).slice(append ? -(S.entries.length - from) : 0).forEach(observeRow);
  const sentinel = el.entries.querySelector('.sentinel');
  if (sentinel) moreObserver.observe(sentinel);
}

function updateListSub() {
  const n = S.streamId === TODAY || S.streamId === S.api?.savedId()
    ? S.entries.filter((e) => e.unread).length : countOf(S.streamId);
  el.listSub.textContent = n ? `${n} unread` : (S.filter === 'unread' ? '' : 'All articles');
}

const moreObserver = new IntersectionObserver((ents) => {
  if (ents.some((x) => x.isIntersecting)) loadMore();
}, { root: el.entries, rootMargin: '600px' });

// mark-as-read when scrolled past the top
let userScrolled = false;
el.entries.addEventListener('scroll', () => { userScrolled = true; }, { passive: true });
const scrollObserver = new IntersectionObserver((ents) => {
  if (!S.settings.markOnScroll || !userScrolled) return;
  for (const x of ents) {
    if (x.isIntersecting || !x.rootBounds) continue;
    if (x.boundingClientRect.bottom <= x.rootBounds.top + 2) {
      const e = S.byId.get(x.target.dataset.id);
      if (e?.unread) setRead(e, true);
    }
  }
}, { root: el.entries, threshold: 0 });
function observeRow(r) { if (r) scrollObserver.observe(r); }

async function openStream(id, { keepScroll = false } = {}) {
  if (!S.api) return;
  S.streamId = id;
  LS.set('stream', id);
  S.entries = [];
  S.byId.clear();
  S.continuation = null;
  userScrolled = false;
  if (!keepScroll) el.entries.scrollTop = 0;
  renderSources();
  await loadMore(true);
}

async function loadMore(fresh = false) {
  if (S.loading || (!fresh && !S.continuation)) return;
  const gen = fresh ? ++S.gen : S.gen;
  S.loading = true;
  const from = S.entries.length;
  renderList({ append: !fresh, from });
  try {
    const isToday = S.streamId === TODAY;
    const r = await S.api.stream(isToday ? S.api.allId() : S.streamId, {
      count: 40,
      unreadOnly: S.filter === 'unread' && S.streamId !== S.api.savedId(),
      continuation: fresh ? undefined : S.continuation,
      ranked: S.settings.sort,
      newerThan: isToday ? startOfToday() : undefined,
    });
    if (gen !== S.gen) return;
    applyPending(r.items || []);
    for (const e of r.items || []) {
      if (S.byId.has(e.id)) continue;
      S.byId.set(e.id, e);
      S.entries.push(e);
    }
    S.continuation = r.continuation || null;
    if (fresh) cacheStream();
  } catch (e) {
    if (gen === S.gen) fail(e);
  } finally {
    if (gen === S.gen) {
      S.loading = false;
      renderList({ append: !fresh, from });
    }
  }
}

function cacheStream() {
  LS.set('cache.entries', { streamId: S.streamId, filter: S.filter, items: S.entries.slice(0, 80) });
}

// local actions not yet synced override server state
function applyPending(items) {
  for (const e of items) {
    const p = S.pending[e.id];
    if (!p) continue;
    if ('read' in p) e.unread = !p.read;
    if ('saved' in p) setSavedTag(e, p.saved);
  }
}

// ---------- marking ----------
function bumpCounts(e, delta) {
  const ids = new Set([S.api.allId(), e.origin?.streamId]);
  for (const c of S.subById.get(e.origin?.streamId)?.categories || []) ids.add(c.id);
  for (const id of ids) if (id) S.counts.set(id, Math.max(0, countOf(id) + delta));
}

function setRead(e, read) {
  if (!e || e.unread === !read) return;
  e.unread = !read;
  bumpCounts(e, read ? -1 : 1);
  queue(e.id, 'read', read);
  refreshRow(e);
  if (S.currentId === e.id) updateToolbar();
  updateListSub();
  renderSourcesSoon();
}

function setSavedTag(e, saved) {
  const tags = (e.tags || []).filter((t) => !t.id.endsWith('/tag/global.saved'));
  if (saved) tags.push({ id: S.api.savedId() });
  e.tags = tags;
}
function setSaved(e, saved) {
  if (!e || isSaved(e) === saved) return;
  setSavedTag(e, saved);
  queue(e.id, 'saved', saved);
  refreshRow(e);
  if (S.currentId === e.id) updateToolbar();
  toast(saved ? 'Saved for later' : 'Removed from saved', 1400);
}

let srcTimer;
function renderSourcesSoon() {
  clearTimeout(srcTimer);
  srcTimer = setTimeout(() => {
    const st = el.sourceList.scrollTop;
    renderSources();
    el.sourceList.scrollTop = st;
  }, 250);
}

// ---------- sync queue ----------
let flushTimer;
function queue(id, key, val) {
  (S.pending[id] ||= {})[key] = val;
  LS.set('pending', S.pending);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 900);
}
let flushing = false;
async function flush() {
  if (flushing || !S.api || !navigator.onLine) return;
  const snap = JSON.parse(JSON.stringify(S.pending));
  const groups = { markAsRead: [], keepUnread: [], markAsSaved: [], markAsUnsaved: [] };
  for (const [id, p] of Object.entries(snap)) {
    if ('read' in p) groups[p.read ? 'markAsRead' : 'keepUnread'].push(id);
    if ('saved' in p) groups[p.saved ? 'markAsSaved' : 'markAsUnsaved'].push(id);
  }
  if (!Object.values(groups).some((g) => g.length)) return;
  flushing = true;
  try {
    for (const [action, ids] of Object.entries(groups)) {
      for (let i = 0; i < ids.length; i += 500) await S.api.markers(action, ids.slice(i, i + 500));
    }
    for (const [id, p] of Object.entries(snap)) {
      const cur = S.pending[id];
      if (!cur) continue;
      for (const k of Object.keys(p)) if (cur[k] === p[k]) delete cur[k];
      if (!Object.keys(cur).length) delete S.pending[id];
    }
    LS.set('pending', S.pending);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 0)) fail(e);
  } finally {
    flushing = false;
  }
}
addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

// ---------- article ----------
function currentEntry() { return S.byId.get(S.currentId); }

function updateToolbar() {
  const e = currentEntry();
  el.article.classList.toggle('has-entry', !!e);
  if (!e) return;
  setIcon(el.readBtn, e.unread ? 'dot-fill' : 'dot');
  el.readBtn.title = e.unread ? 'Mark as read (M)' : 'Mark as unread (M)';
  setIcon(el.starBtn, isSaved(e) ? 'star-fill' : 'star');
  el.starBtn.classList.toggle('on', isSaved(e));
  el.readerBtn.classList.toggle('on', S.reader);
}

function readingTime(text) { return Math.max(1, Math.round(text.split(/\s+/).length / 230)); }

function articleHeader(e, extra = {}) {
  const url = entryUrl(e);
  const meta = [extra.byline || e.author, fullDate(e.published || e.crawled), extra.minutes ? `${extra.minutes} min read` : null]
    .filter(Boolean).map(esc).join(' · ');
  return `<header class="art-head">
    <div class="art-source">${favicon(e.origin?.streamId, e.origin?.title)}<span>${esc(e.origin?.title || '')}</span></div>
    <h1>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || '(untitled)')}</a>` : esc(e.title || '(untitled)')}</h1>
    <div class="art-meta">${meta}</div>
  </header>`;
}

async function renderArticle() {
  const e = currentEntry();
  updateToolbar();
  if (!e) { el.content.className = 'empty-state'; el.content.innerHTML = '<p>Select an article</p>'; return; }
  const url = entryUrl(e);
  const token = (renderArticle.token = {});
  el.content.className = 'art';
  if (!S.reader) {
    const html = entryHtml(e);
    const visual = entryThumb(e);
    const body = sanitize(html, url);
    const showHero = visual && !body.includes(visual);
    el.content.innerHTML = articleHeader(e, { minutes: readingTime(textOf(html)) }) +
      (showHero ? `<figure class="hero"><img src="${esc(visual)}" alt="" referrerpolicy="no-referrer"></figure>` : '') +
      `<div class="art-body">${body || '<p class="muted">No preview available.</p>'}</div>
       <footer class="art-foot">
         ${url ? `<button class="pill" data-action="toggle-reader">${icon('reader')} Load full article</button>
         <a class="pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('external')} Open website</a>` : ''}
       </footer>`;
    return;
  }
  el.content.innerHTML = articleHeader(e) + '<div class="art-body loading"><span class="spinner"></span><p class="muted">Loading full article…</p></div>';
  try {
    if (!url) throw new Error('This article has no link');
    const r = await readerView(S.api, url);
    if (token !== renderArticle.token) return;
    el.content.innerHTML = articleHeader(e, { byline: r.byline, minutes: readingTime(textOf(r.html)) }) +
      `<div class="art-body">${r.html}</div>
       <footer class="art-foot"><a class="pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('external')} Open website</a></footer>`;
  } catch (err) {
    if (token !== renderArticle.token) return;
    S.reader = false;
    toast(err.message || 'Reader mode failed', 4000);
    renderArticle();
  }
}

function openArticle(id, { scroll = true } = {}) {
  const e = S.byId.get(id);
  if (!e) return;
  const prev = S.currentId;
  S.currentId = id;
  S.reader = S.settings.readerDefault && !!entryUrl(e);
  if (prev) rowFor(prev)?.classList.remove('active');
  const r = rowFor(id);
  r?.classList.add('active');
  if (scroll) r?.scrollIntoView({ block: 'nearest' });
  el.articleScroll.scrollTop = 0;
  renderArticle();
  if (S.settings.markOnOpen && e.unread) setRead(e, true);
  if (el.app.dataset.view !== 'article') go('article');
}

async function step(dir) {
  const i = S.entries.findIndex((e) => e.id === S.currentId);
  let j = i + dir;
  if (i === -1) j = dir > 0 ? 0 : -1;
  if (j >= S.entries.length && S.continuation) { await loadMore(); }
  const e = S.entries[j];
  if (!e) { toast(dir > 0 ? 'No more articles' : 'This is the first article', 1200); return; }
  openArticle(e.id);
  if (isNarrow()) {
    el.article.classList.remove('flick-l', 'flick-r');
    void el.article.offsetWidth;
    el.article.classList.add(dir > 0 ? 'flick-l' : 'flick-r');
  }
}

// ---------- peek (long press) ----------
let peekId = null;
function openPeek(id) {
  const e = S.byId.get(id);
  if (!e) return;
  peekId = id;
  const thumb = entryThumb(e);
  el.peekBody.innerHTML = `
    <div class="e-meta">${favicon(e.origin?.streamId, e.origin?.title)}<span class="e-src">${esc(e.origin?.title || '')}</span><span class="e-time">${ago(e.published || e.crawled)}</span></div>
    <h3>${esc(e.title || '')}</h3>
    ${thumb ? `<img class="peek-img" src="${esc(thumb)}" alt="" referrerpolicy="no-referrer">` : ''}
    <p>${esc(textOf(entryHtml(e)).slice(0, 700)) || '<span class="muted">No preview.</span>'}</p>`;
  $('[data-peek="read"]').textContent = e.unread ? 'Mark read' : 'Mark unread';
  $('[data-peek="star"]').textContent = isSaved(e) ? 'Unsave' : 'Save';
  el.peek.hidden = false;
  requestAnimationFrame(() => el.peek.classList.add('open'));
}
function closePeek() {
  el.peek.classList.remove('open');
  peekId = null;
  setTimeout(() => { if (!peekId) el.peek.hidden = true; }, 200);
}
el.peek.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-peek]');
  if (!b) { if (!ev.target.closest('.sheet-card')) closePeek(); return; }
  const e = S.byId.get(peekId);
  const a = b.dataset.peek;
  closePeek();
  if (!e) return;
  if (a === 'read') setRead(e, e.unread);
  if (a === 'star') setSaved(e, !isSaved(e));
  if (a === 'open') openArticle(e.id);
});

// ---------- actions ----------
function doSwipe(e, action) {
  if (action === 'read') { setRead(e, e.unread); }
  else setSaved(e, !isSaved(e));
}

const actions = {
  refresh: () => refresh(),
  settings: () => openSettings(),
  'show-sources': () => (isWide() ? null : go('sources')),
  'close-drawer': () => back(),
  back: () => back(),
  prev: () => step(-1),
  next: () => step(1),
  'toggle-read': () => { const e = currentEntry(); if (e) setRead(e, e.unread); },
  'toggle-star': () => { const e = currentEntry(); if (e) setSaved(e, !isSaved(e)); },
  'toggle-reader': () => {
    const e = currentEntry();
    if (!e) return;
    S.reader = !S.reader;
    el.articleScroll.scrollTop = 0;
    renderArticle();
  },
  open: () => { const u = currentEntry() && entryUrl(currentEntry()); if (u) window.open(u, '_blank', 'noopener'); },
  share: async () => {
    const e = currentEntry();
    const url = e && entryUrl(e);
    if (!url) return;
    try {
      if (navigator.share) await navigator.share({ title: e.title, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch {}
  },
  'toggle-filter': () => {
    S.filter = S.filter === 'unread' ? 'all' : 'unread';
    LS.set('filter', S.filter);
    toast(S.filter === 'unread' ? 'Unread only' : 'All articles', 1100);
    openStream(S.streamId);
  },
  'mark-all': () => markAll(),
  demo: () => { S.settings.demo = true; LS.set('settings', S.settings); el.settings.close(); start(); },
  logout: () => {
    if (!confirm('Sign out and remove your token from this device?')) return;
    S.settings = { ...S.settings, token: '', demo: false, userId: null };
    LS.set('settings', S.settings);
    LS.del('cache.entries'); LS.del('cache.meta'); LS.del('pending'); LS.del('stream');
    S.pending = {};
    location.reload();
  },
};

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-action]');
  if (!b) return;
  const fn = actions[b.dataset.action];
  if (!fn) return;
  ev.preventDefault();
  fn();
});

async function markAll() {
  const id = S.streamId;
  if (!id) return;
  const loadedUnread = S.entries.filter((e) => e.unread);
  const total = Math.max(countOf(id), loadedUnread.length);
  if (!total) { toast('Nothing to mark'); return; }
  if (!confirm(`Mark ${total} article${total === 1 ? '' : 's'} in “${streamTitle(id)}” as read?`)) return;
  // Don't mark articles that arrived after this list was loaded.
  const asOf = S.settings.sort === 'newest' && S.entries.length
    ? Math.max(...S.entries.map((e) => e.crawled || e.published || 0)) + 1 : Date.now();
  try {
    const r = id === TODAY || id === S.api.savedId() ? null : S.api.markStreamRead(id, asOf);
    if (r) await r;
    else await S.api.markers('markAsRead', loadedUnread.map((e) => e.id));
    for (const e of loadedUnread) e.unread = false;
    renderList();
    if (S.currentId) updateToolbar();
    toast('Marked as read');
    await loadCounts();
  } catch (e) { fail(e); }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea, select, dialog[open]') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  const e = currentEntry();
  const map = {
    j: () => step(1), ArrowDown: () => (isNarrow() && el.app.dataset.view === 'article' ? null : step(1)),
    k: () => step(-1), ArrowUp: () => (isNarrow() && el.app.dataset.view === 'article' ? null : step(-1)),
    n: () => step(1), p: () => step(-1),
    m: () => e && setRead(e, e.unread),
    s: () => e && setSaved(e, !isSaved(e)),
    r: () => actions['toggle-reader'](),
    v: () => actions.open(), o: () => actions.open(),
    u: () => actions['toggle-filter'](),
    A: () => markAll(),
    R: () => refresh(),
    Escape: () => (peekId ? closePeek() : back()),
    ' ': () => {
      const sc = el.articleScroll;
      if (!e) return false;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) { step(1); return; }
      sc.scrollBy({ top: (sc.clientHeight - 60) * (ev.shiftKey ? -1 : 1), behavior: 'smooth' });
    },
    Enter: () => { const r = ev.target.closest?.('.entry'); if (r) openArticle(r.dataset.id); else return false; },
  };
  const fn = map[k];
  if (!fn) return;
  if (fn() !== false) ev.preventDefault();
});

// ---------- settings ----------
function openSettings(welcome = false) {
  const f = el.form;
  for (const [k, v] of Object.entries(S.settings)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v ?? '';
  }
  el.settings.classList.toggle('welcome', welcome);
  if (!el.settings.open) el.settings.showModal();
}
el.form.addEventListener('submit', (ev) => {
  if (ev.submitter?.value !== 'save') return;
  const f = el.form;
  const prev = { ...S.settings };
  for (const k of Object.keys(DEFAULTS)) {
    const input = f.elements[k];
    if (!input) continue;
    S.settings[k] = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value.trim();
  }
  const accountChanged = prev.token !== S.settings.token || prev.proxy !== S.settings.proxy || prev.proxyKey !== S.settings.proxyKey;
  if (accountChanged && S.settings.token) { S.settings.demo = false; S.settings.userId = null; }
  LS.set('settings', S.settings);
  applyAppearance();
  if (accountChanged || (!S.api && S.settings.token)) { S.pending = {}; LS.del('pending'); LS.del('stream'); S.streamId = null; start(); }
  else if (prev.sort !== S.settings.sort) openStream(S.streamId);
  else { renderList(); renderArticle(); }
});
// live preview of appearance
el.form.addEventListener('input', (ev) => {
  const n = ev.target.name;
  if (n === 'fontSize') document.documentElement.style.setProperty('--article-size', ev.target.value + 'px');
  if (n === 'theme') document.documentElement.dataset.theme = ev.target.value;
  if (n === 'font') document.documentElement.dataset.font = ev.target.value;
});
el.settings.addEventListener('close', () => applyAppearance());

// ---------- loading ----------
async function loadCounts() {
  const counts = await S.api.counts();
  S.counts = new Map(counts.map((c) => [c.id, c.count]));
  renderSources();
  updateListSub();
}

async function loadMeta() {
  const [cats, subs, counts] = await Promise.all([S.api.categories(), S.api.subscriptions(), S.api.counts()]);
  S.cats = cats || [];
  S.subs = subs || [];
  S.subById = new Map(S.subs.map((s) => [s.id, s]));
  S.counts = new Map(counts.map((c) => [c.id, c.count]));
  LS.set('cache.meta', { userId: S.api.userId, cats: S.cats, subs: S.subs, counts });
  renderSources();
}

let refreshing = false;
async function refresh() {
  if (!S.api || refreshing) return;
  refreshing = true;
  $('[data-action="refresh"]')?.classList.add('spin');
  try {
    await flush();
    await loadMeta();
    await openStream(S.streamId, { keepScroll: false });
  } catch (e) { fail(e); } finally {
    refreshing = false;
    $('[data-action="refresh"]')?.classList.remove('spin');
  }
}

async function start() {
  applyAppearance();
  const st = S.settings;
  if (!st.token && !st.demo) {
    S.api = null;
    el.entries.innerHTML = `<div class="empty-state welcome">
      <div class="logo"><img src="icons/icon.svg" alt=""></div>
      <h2>Welcome to Pwrss</h2>
      <p>A fast, gesture-friendly reader for your Feedly account.</p>
      <button class="primary" data-action="settings">Connect Feedly</button>
      <button class="ghost" data-action="demo">Try the demo</button>
    </div>`;
    el.listTitle.textContent = 'Pwrss';
    el.listSub.textContent = '';
    renderSources();
    return;
  }
  S.api = st.demo && !st.token ? new DemoFeedly() : new Feedly(st);
  if (S.api.demo) { S.pending = {}; }

  // instant paint from cache
  const meta = !S.api.demo && LS.get('cache.meta', null);
  if (meta && meta.userId) {
    S.api.userId = meta.userId;
    S.cats = meta.cats; S.subs = meta.subs;
    S.subById = new Map(S.subs.map((s) => [s.id, s]));
    S.counts = new Map(meta.counts.map((c) => [c.id, c.count]));
    if (!S.streamId) S.streamId = S.api.allId();
    renderSources();
    const cached = LS.get('cache.entries', null);
    if (cached && cached.streamId === S.streamId && cached.filter === S.filter) {
      S.entries = cached.items; S.byId = new Map(S.entries.map((e) => [e.id, e]));
      applyPending(S.entries);
      renderList();
    }
  }

  try {
    if (!S.api.userId || !meta) {
      await S.api.profile();
      if (!S.api.demo) { st.userId = S.api.userId; LS.set('settings', st); }
    }
    if (!S.streamId || !S.streamId.includes(S.api.userId) && !S.streamId.startsWith('feed/') && S.streamId !== TODAY) {
      S.streamId = S.api.allId();
    }
    await loadMeta();
    await openStream(S.streamId, { keepScroll: true });
    flush();
  } catch (e) {
    fail(e);
    if (!S.entries.length) {
      el.entries.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p><button class="primary" data-action="settings">Open Settings</button><button class="ghost" data-action="refresh">Retry</button></div>`;
    }
  }
}

// ---------- gestures wiring ----------
swipeRows(el.entries, {
  selector: '.entry',
  onSwipe: (row, dir) => {
    const e = S.byId.get(row.dataset.id);
    if (!e) return;
    const right = S.settings.swipeRight;
    doSwipe(e, dir === 'right' ? right : (right === 'read' ? 'star' : 'read'));
  },
  onLongPress: (row) => openPeek(row.dataset.id),
  onTap: (row) => openArticle(row.dataset.id, { scroll: false }),
});

edgeBack(el.app, {
  enabled: () => !isWide() && el.app.dataset.view !== 'sources' && !(el.app.dataset.view === 'list' && !isNarrow()),
  getPane: () => (el.app.dataset.view === 'article' && isNarrow() ? el.article : el.app.dataset.view === 'list' && isNarrow() ? el.list : null),
  onBack: () => back(),
});

flick(el.articleScroll, { onLeft: () => step(1), onRight: () => step(-1) });
pullToRefresh(el.entries, el.ptr, refresh);

// ---------- boot ----------
history.replaceState({ view: 'list' }, '');
setView('list');
start();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// refresh when coming back to the app after a while
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 15 * 60 * 1000) refresh();
});
