// Local backend: feeds from an OPML import, fetched through the proxy, parsed in the
// browser and stored in IndexedDB. Implements the same interface as Feedly / DemoFeedly.
import { ApiError, cleanProxy, proxyFetchPage } from './api.js';
import { parseFeed } from './feedparse.js';
import { parseOPML, buildOPML } from './opml.js';
import { isHNApi, parseHNApi } from './hnapi.js';
import { remoteState } from './sync.js';
import * as store from './store.js';

const UID = 'local';
const DAY = 24 * 3600 * 1000;
const FIRST_FETCH_UNREAD_MS = 7 * DAY;
const KEEP_MS = 60 * DAY;
const MAX_PER_FEED = 300;
const CHUNK = 25;
const CONCURRENCY = 3;
const LAST_KEY = 'pwrss.local.lastRefresh';

function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Cross-device key of an article: feed + link + title (stable even if a feed changes its GUIDs). Used for sync only.
const lkOf = (feedId, link, title) => (link ? 'l' + hash('L' + feedId + '\n' + link + '\n' + (title || '')) : undefined);

const abs = (u, base) => { try { return new URL(u, base || undefined).href; } catch { return u || ''; } };

export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

export class LocalFeeds {
  constructor({ proxy, proxyKey } = {}) {
    this.local = true;
    this.userId = UID;
    this.proxy = cleanProxy(proxy);
    this.proxyKey = proxyKey || '';
    this.catOrder = [];       // category labels in display order
    this.feeds = new Map();   // id -> feed record
    this.entries = new Map(); // id -> entry
    this.failed = [];
    this.syncOn = false;      // set by the app from Settings
    this.iid = Math.random().toString(36).slice(2);
    try {
      this.bc = new BroadcastChannel('pwrss-state'); // other tabs tell us when they change read/saved state
      this.bc.onmessage = (ev) => this.onOtherTab(ev.data);
    } catch { this.bc = null; }
    this.audit = { newUnread: 0, cloudUnread: 0, cloudRead: 0 }; // why articles changed state since the app started
    this.sync = { seq: 0, docRev: 0, docAt: 0, syncedDocAt: 0, dirty: {}, remote: {}, seeded: false, lastSync: 0 };
  }

  allId() { return `user/${UID}/category/global.all`; }
  savedId() { return `user/${UID}/tag/global.saved`; }
  catId(label) { return `user/${UID}/category/${label}`; }

  init() {
    this._init ??= (async () => {
      const [feeds, entries, meta] = await Promise.all([store.getAll('feeds'), store.getAll('entries'), store.getAll('meta')]);
      for (const f of feeds) this.feeds.set(f.id, f);
      for (const e of entries) this.entries.set(e.id, e);
      this.deriveKeys();
      this.catOrder = meta.find((m) => m.id === 'categories')?.labels || [];
      const sy = meta.find((m) => m.id === 'sync');
      if (sy) this.sync = { ...this.sync, ...sy.state };
      this.failed = feeds.filter((f) => f.error).map((f) => this.failure(f));
      await this.normalize();
    })();
    return this._init;
  }

  /** Give articles stored without a cross-device key one, when their feed + link + title is unique. */
  deriveKeys() {
    const count = new Map();
    const keyOf = (e) => (e.alternate?.[0]?.href ? lkOf(e.feedId, e.alternate[0].href, e.title) : undefined);
    for (const e of this.entries.values()) { const k = keyOf(e); if (k) count.set(k, (count.get(k) || 0) + 1); }
    for (const e of this.entries.values()) {
      if (e.lk) continue;
      const k = keyOf(e);
      if (k && count.get(k) === 1) e.lk = k;
    }
  }

  /** The key under which this article's read/saved state travels between devices. */
  fid(e) { return e.lk || e.id; }

  // Make sure every category is listed and every feed has an order (older data may lack both).
  async normalize() {
    const known = new Set(this.catOrder);
    const extra = [...new Set([...this.feeds.values()].map((f) => f.category).filter((c) => c && !known.has(c)))].sort((a, b) => a.localeCompare(b));
    const changedFeeds = [];
    if (extra.length) { this.catOrder.push(...extra); await this.saveMeta(); }
    for (const cat of [null, ...this.catOrder]) {
      const list = this.list(cat);
      list.forEach((f, i) => { if (f.order !== i) { f.order = i; changedFeeds.push(f); } });
    }
    await store.put('feeds', changedFeeds);
  }

  destroy() { try { this.bc?.close(); } catch {} }

  /** Store the read/saved state of articles (only those fields) and tell the other tabs. */
  async persistState(entries) {
    if (!entries.length) return;
    await store.patch('entries', entries.map((e) => ({ id: e.id, set: { unread: e.unread, tags: e.tags }, create: e })));
    try { this.bc?.postMessage({ from: this.iid, items: entries.map((e) => ({ id: e.id, unread: e.unread, tags: e.tags })) }); } catch {}
  }

  /** Store the content of articles (everything except read/saved state); a new article is stored whole. */
  persistContent(entries) {
    return store.patch('entries', entries.map((e) => {
      const { unread, tags, ...content } = e;
      return { id: e.id, set: content, create: e };
    }));
  }

  /** Another tab changed read/saved state: follow it in memory. */
  onOtherTab(msg) {
    if (!msg || msg.from === this.iid) return;
    const changed = [];
    for (const it of msg.items || []) {
      const e = this.entries.get(it.id);
      if (!e || this.getPending?.()?.[e.id]) continue;
      if (e.unread !== it.unread || (e.tags.length > 0) !== (it.tags.length > 0)) { e.unread = it.unread; e.tags = it.tags; changed.push(e.id); }
    }
    if (changed.length) this.onExternalChange?.(changed);
  }

  failure(f) { return { id: f.id, title: f.title || f.url, url: f.url, error: f.error, detail: f.errorDetail || '' }; }

  saveMeta() { return store.put('meta', [{ id: 'categories', labels: this.catOrder }]); }

  // Feeds of one category (null = uncategorized) in display order.
  byUrl(url) { return [...this.feeds.values()].find((f) => f.url === url); }

  list(cat) {
    const c = cat || null;
    return [...this.feeds.values()]
      .filter((f) => (f.category || null) === c)
      .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (a.title || a.url).localeCompare(b.title || b.url));
  }
  orderedFeeds() { return [...this.catOrder.flatMap((c) => this.list(c)), ...this.list(null)]; }
  nextOrder(cat) { const l = this.list(cat); return l.length ? Math.max(...l.map((f) => f.order ?? 0)) + 1 : 0; }

  lastRefresh() { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } }
  stats() { return { feeds: this.feeds.size, failed: this.failed, lastRefresh: this.lastRefresh() }; }

  // ----- Feedly-shaped interface -----
  async profile() { await this.init(); return { id: UID }; }

  async categories() {
    await this.init();
    return this.catOrder.map((label) => ({ id: this.catId(label), label }));
  }

  async subscriptions() {
    await this.init();
    return this.orderedFeeds().map((f) => ({
      id: f.id, title: f.title || f.url, website: f.website || '',
      categories: f.category ? [{ id: this.catId(f.category), label: f.category }] : [],
    }));
  }

  async counts() {
    await this.init();
    const m = new Map();
    const add = (id) => m.set(id, (m.get(id) || 0) + 1);
    for (const e of this.entries.values()) {
      if (!e.unread) continue;
      const f = this.feeds.get(e.feedId);
      if (!f) continue;
      add(this.allId());
      add(f.id);
      if (f.category) add(this.catId(f.category));
    }
    return [...m].map(([id, count]) => ({ id, count }));
  }

  matches(streamId, e) {
    if (streamId === this.allId()) return true;
    if (streamId === this.savedId()) return e.tags.length > 0;
    if (streamId.startsWith('feed/')) return e.feedId === streamId;
    const f = this.feeds.get(e.feedId);
    return !!f?.category && this.catId(f.category) === streamId;
  }

  serve(e) {
    const f = this.feeds.get(e.feedId);
    return { ...e, origin: { streamId: e.feedId, title: f?.title || e.feedTitle || '', htmlUrl: f?.website || '' } };
  }

  async stream(streamId, { count = 40, unreadOnly = false, continuation, ranked = 'newest', newerThan } = {}) {
    await this.init();
    let list = [...this.entries.values()].filter((e) =>
      this.matches(streamId, e) && (!unreadOnly || e.unread) && (!newerThan || e.published >= newerThan));
    const dir = ranked === 'oldest' ? 1 : -1;
    list.sort((a, b) => dir * (a.published - b.published) || (a.id < b.id ? -dir : dir));
    const start = continuation ? Number(continuation) : 0;
    return {
      id: streamId,
      items: list.slice(start, start + count).map((e) => this.serve(e)),
      continuation: start + count < list.length ? String(start + count) : undefined,
    };
  }

  async markers(action, ids) {
    await this.init();
    const changed = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (action === 'markAsRead') e.unread = false;
      else if (action === 'keepUnread') e.unread = true;
      else if (action === 'markAsSaved') e.tags = [{ id: this.savedId() }];
      else if (action === 'markAsUnsaved') e.tags = [];
      else continue;
      changed.push(e);
      this.recordDirty(e, action);
    }
    await this.persistState(changed);
    if (this.syncOn && changed.length) await this.saveSync();
    return changed.map((e) => e.id); // the ids that exist and are now stored; the app keeps queued intents for all others
  }

  /** Ids of the unread articles of a stream that existed at `asOf` (what "mark all as read" covers). */
  unreadIds(streamId, asOf) {
    const out = [];
    for (const e of this.entries.values()) {
      if (e.unread && this.matches(streamId, e) && (e.crawled || e.published) <= asOf) out.push(e.id);
    }
    return out;
  }

  diag() {
    let unread = 0;
    for (const e of this.entries.values()) if (e.unread) unread++;
    const s = this.sync;
    return {
      feeds: this.feeds.size, articles: this.entries.size, unread,
      queued: Object.keys(this.getPending?.() || {}).length,
      sync: this.syncOn, dirty: Object.keys(s.dirty).length, remote: Object.keys(s.remote).length, seq: s.seq, docRev: s.docRev, repaired: s.repaired || '-',
      lastSync: s.lastSync, lastRefresh: this.lastRefresh(), audit: { ...this.audit },
    };
  }

  /** Apply queued intents (id -> { read, saved }) to the in-memory articles, so counts and lists are right at once. */
  applyIntents(pending) {
    for (const [id, p] of Object.entries(pending || {})) {
      const e = this.entries.get(id);
      if (!e) continue;
      if ('read' in p) e.unread = !p.read;
      if ('saved' in p) e.tags = p.saved ? [{ id: this.savedId() }] : [];
    }
  }

  async markStreamRead(streamId, asOf) {
    await this.init();
    const changed = [];
    for (const e of this.entries.values()) {
      if (e.unread && this.matches(streamId, e) && (e.crawled || e.published) <= asOf) { e.unread = false; changed.push(e); this.recordDirty(e, 'markAsRead'); }
    }
    await this.persistState(changed);
    if (this.syncOn && changed.length) await this.saveSync();
  }

  fetchPage(url) { return proxyFetchPage(this.proxy, this.proxyKey, url); }

  // ----- feed management -----
  async importOPML(xml) {
    await this.init();
    const items = parseOPML(xml);
    for (const label of [...items.folders, ...items.map((i) => i.category).filter(Boolean)]) {
      if (label && !this.catOrder.includes(label)) this.catOrder.push(label);
    }
    let added = 0, existing = 0;
    const touched = [];
    for (const it of items) {
      const id = 'feed/' + it.url;
      if (this.feeds.has(id) || this.byUrl(it.url)) { existing++; continue; } // never overwrite edits made in the app
      const f = { id, url: it.url, title: it.title, website: it.website, category: it.category, order: this.nextOrder(it.category), etag: null, modified: null, lastFetched: null, error: null };
      this.feeds.set(id, f);
      touched.push(f);
      added++;
    }
    await this.saveMeta();
    await store.put('feeds', touched);
    if (added) await this.touchDoc();
    return { added, existing, total: items.length };
  }

  async exportOPML() {
    await this.init();
    return buildOPML(this.orderedFeeds().map((f) => ({ url: f.url, title: f.title, website: f.website, category: f.category })), this.catOrder);
  }

  async addFeed(input, category = null) {
    await this.init();
    const url = normalizeUrl(input);
    if (!url) throw new ApiError('That doesn’t look like a web address.', 0);
    if (category && !this.catOrder.includes(category)) throw new ApiError('Unknown category.', 0);
    const id = 'feed/' + url;
    if (this.feeds.has(id) || this.byUrl(url)) throw new ApiError('You already follow this feed.', 0);
    const f = { id, url, title: '', website: '', category: category || null, order: this.nextOrder(category), etag: null, modified: null, lastFetched: null, error: null };
    this.feeds.set(id, f);
    let r;
    try { r = await this.refreshAll({ ids: [id] }); } catch (e) { this.feeds.delete(id); throw e; }
    if (f.error) {
      this.feeds.delete(id);
      await store.del('feeds', [id]);
      throw new ApiError(`Couldn’t add feed: ${f.error}`, 0);
    }
    await this.touchDoc();
    return { feed: f, added: r.added };
  }

  removeFeed(id) { return this.removeFeeds([id]); }

  /** Remove feeds and their unsaved articles (saved ones stay, keeping their feed name). */
  async removeFeeds(ids, { silent = false } = {}) {
    await this.init();
    const gone = new Set();
    const cats = new Set();
    for (const id of ids) {
      const f = this.feeds.get(id);
      if (!f) continue;
      gone.add(id);
      cats.add(f.category || null);
      this.feeds.delete(id);
    }
    if (!gone.size) return 0;
    const drop = [...this.entries.values()].filter((e) => gone.has(e.feedId) && !e.tags.length);
    for (const e of drop) this.entries.delete(e.id);
    await store.del('entries', drop.map((e) => e.id));
    await store.del('feeds', [...gone]);
    for (const c of cats) await this.renumber(c);
    this.failed = this.failed.filter((x) => !gone.has(x.id));
    if (!silent) await this.touchDoc();
    return gone.size;
  }

  /** Re-fetch only the feeds that failed last time. */
  retryFailed(opts = {}) {
    return this.refreshAll({ ...opts, ids: this.failed.map((f) => f.id) });
  }

  /** Point a feed at a new address; keeps its articles, read state and category. Fetches it right away. */
  async changeFeedUrl(id, input) {
    await this.init();
    const f = this.feeds.get(id);
    if (!f) return null;
    const url = normalizeUrl(input);
    if (!url) throw new ApiError('That doesn’t look like a web address.', 0);
    const dup = this.byUrl(url);
    if (dup && dup !== f) throw new ApiError('You already follow a feed with that address.', 0);
    f.url = url;
    f.etag = null; f.modified = null; f.error = null; f.errorDetail = null;
    await store.put('feeds', [f]);
    await this.touchDoc();
    const r = await this.refreshAll({ ids: [id] });
    return { ok: !f.error, error: f.error, added: r.added, feed: f };
  }

  async renameFeed(id, title) {
    await this.init();
    const f = this.feeds.get(id);
    title = (title || '').trim();
    if (!f || !title) return;
    f.title = title;
    for (const e of this.entries.values()) if (e.feedId === id) e.feedTitle = title;
    await store.put('feeds', [f]);
    await this.persistContent([...this.entries.values()].filter((e) => e.feedId === id));
    await this.touchDoc();
  }

  async renumber(cat) {
    const list = this.list(cat);
    list.forEach((f, i) => { f.order = i; });
    await store.put('feeds', list);
  }

  async moveFeed(id, category) {
    await this.init();
    const f = this.feeds.get(id);
    category = category || null;
    if (!f || (f.category || null) === category) return;
    if (category && !this.catOrder.includes(category)) throw new ApiError('Unknown category.', 0);
    const old = f.category;
    const order = this.nextOrder(category); // end of the target category
    f.category = category;
    f.order = order;
    await this.renumber(category);
    await this.renumber(old);
    await this.touchDoc();
  }

  /** dir = -1 (up) or +1 (down) within the feed's category. */
  async reorderFeed(id, dir) {
    await this.init();
    const f = this.feeds.get(id);
    if (!f) return;
    const list = this.list(f.category);
    const i = list.indexOf(f), j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => { x.order = k; });
    await store.put('feeds', list);
    await this.touchDoc();
  }

  async addCategory(label) {
    await this.init();
    label = (label || '').trim();
    if (!label) throw new ApiError('Enter a category name.', 0);
    if (this.catOrder.some((c) => c.toLowerCase() === label.toLowerCase())) throw new ApiError('That category already exists.', 0);
    this.catOrder.push(label);
    await this.saveMeta();
    await this.touchDoc();
  }

  async renameCategory(old, label) {
    await this.init();
    label = (label || '').trim();
    if (!label || label === old) return;
    if (this.catOrder.some((c) => c !== old && c.toLowerCase() === label.toLowerCase())) throw new ApiError('That category already exists.', 0);
    this.catOrder = this.catOrder.map((c) => (c === old ? label : c));
    const changed = [];
    for (const f of this.feeds.values()) if (f.category === old) { f.category = label; changed.push(f); }
    await this.saveMeta();
    await store.put('feeds', changed);
    await this.touchDoc();
  }

  async deleteCategory(label) {
    await this.init();
    this.catOrder = this.catOrder.filter((c) => c !== label);
    const moved = this.list(label);
    for (const f of moved) { f.order = this.nextOrder(null); f.category = null; }
    await store.put('feeds', moved);
    await this.saveMeta();
    await this.touchDoc();
  }

  async reorderCategory(label, dir) {
    await this.init();
    const i = this.catOrder.indexOf(label), j = i + dir;
    if (i < 0 || j < 0 || j >= this.catOrder.length) return;
    [this.catOrder[i], this.catOrder[j]] = [this.catOrder[j], this.catOrder[i]];
    await this.saveMeta();
    await this.touchDoc();
  }

  async reset() {
    await this.init();
    await store.clear('feeds', 'entries', 'meta');
    this.feeds.clear(); this.entries.clear(); this.failed = []; this.catOrder = [];
    this.sync = { seq: 0, docRev: 0, docAt: 0, syncedDocAt: 0, dirty: {}, remote: {}, seeded: false, lastSync: 0 };
    try { localStorage.removeItem(LAST_KEY); } catch {}
  }

  // ----- sync (see js/sync.js and tasks/specs.md#sync-across-devices) -----
  saveSync() { return store.put('meta', [{ id: 'sync', state: this.sync }]); }

  /** The feed list changed on this device: it becomes the newest version. */
  touchDoc() {
    this.sync.docAt = Date.now();
    this.onDocChange?.(); // the app schedules a sync, so no feed list change can be forgotten
    return this.saveSync();
  }

  savedPayload(e) {
    const cut = (t, n) => (t && t.length > n ? t.slice(0, n) : t);
    return {
      id: e.id, lk: e.lk, feedId: e.feedId, feedTitle: e.feedTitle || this.feeds.get(e.feedId)?.title || '', title: e.title, author: e.author,
      published: e.published, alternate: e.alternate, canonicalUrl: e.canonicalUrl,
      summary: { content: cut(e.summary?.content || e.content?.content || '', 4000) }, visual: e.visual,
    };
  }

  recordDirty(e, action) {
    if (!this.syncOn) return;
    const d = (this.sync.dirty[this.fid(e)] ||= {});
    const t = Date.now();
    if (action === 'markAsRead' || action === 'keepUnread') { d.read = action === 'markAsRead'; d.readAt = t; }
    else { d.saved = action === 'markAsSaved'; d.savedAt = t; if (d.saved) d.entry = this.savedPayload(e); else delete d.entry; }
  }

  /** First sync: upload what this device already knows (feed list, saved, recently read). */
  seedSync() {
    const s = this.sync;
    if (s.seeded) return;
    const recent = Date.now() - 30 * 24 * 3600 * 1000;
    for (const e of this.entries.values()) {
      const saved = e.tags.length > 0;
      const read = !e.unread && (e.published || e.crawled || 0) > recent;
      if (!saved && !read) continue;
      const d = (s.dirty[this.fid(e)] ||= {});
      if (read) { d.read = true; d.readAt ??= e.crawled || 1; }
      if (saved) { d.saved = true; d.savedAt ??= Date.now(); d.entry = this.savedPayload(e); }
    }
    if (!s.docAt && this.feeds.size) s.docAt = Date.now();
    s.seeded = true;
  }

  getDoc() {
    return {
      categories: [...this.catOrder],
      feeds: this.orderedFeeds().map((f) => ({ id: f.id, url: f.url, title: f.title, website: f.website, category: f.category, order: f.order })),
    };
  }

  /** The next batch of local changes to send. */
  syncSnapshot(max = 2000) {
    const s = this.sync;
    const ids = Object.keys(s.dirty).slice(0, max);
    return {
      flags: ids.map((id) => ({ id, ...s.dirty[id] })),
      doc: s.docAt > s.syncedDocAt && this.feeds.size ? this.getDoc() : null,
      docAt: s.docAt,
      remaining: Object.keys(s.dirty).length - ids.length,
    };
  }

  /** The server has the snapshot: forget it, except flags changed again in the meantime. */
  commitSync(snap) {
    for (const f of snap.flags) {
      const cur = this.sync.dirty[f.id];
      if (cur && cur.readAt === f.readAt && cur.savedAt === f.savedAt) delete this.sync.dirty[f.id];
    }
  }

  /** Apply read/saved state from the server. Returns the ids of articles that changed on screen. */
  async applyRemoteFlags(list) {
    const changedIds = new Set();
    const touched = [];
    const byKey = new Map();
    for (const e of this.entries.values()) if (e.lk) byKey.set(e.lk, e);
    for (const f of list) {
      const e = this.entries.get(f.id) || byKey.get(f.id); // the key is a local id (older flags) or a cross-device key
      if (this.sync.dirty[f.id] || (e && (this.sync.dirty[this.fid(e)] || this.getPending?.()?.[e.id]))) continue; // a local change is not sent or not stored yet
      const rs = remoteState(f);
      if (e) {
        if (rs.read !== undefined && e.unread === rs.read) { e.unread = !rs.read; this.audit[rs.read ? 'cloudRead' : 'cloudUnread']++; changedIds.add(e.id); touched.push(e); }
        if (rs.saved !== undefined && (e.tags.length > 0) !== rs.saved) { e.tags = rs.saved ? [{ id: this.savedId() }] : []; changedIds.add(e.id); touched.push(e); }
      } else if (rs.saved && f.entry) {
        const ne = { ...f.entry, crawled: Date.now(), tags: [{ id: this.savedId() }], unread: rs.read === undefined ? true : !rs.read };
        ne.id ||= f.id;
        this.entries.set(ne.id, ne);
        changedIds.add(ne.id); touched.push(ne);
      } else if (rs.read) {
        this.sync.remote[f.id] = { read: true, at: f.readAt };
      } else if (rs.read === false) {
        delete this.sync.remote[f.id];
      }
    }
    await this.persistState([...new Set(touched)]);
    return changedIds;
  }

  /** Make this device's feed list match the server's. Returns { added, removed }. */
  async applyDoc(doc) {
    if (!doc || !Array.isArray(doc.feeds)) return { added: 0, removed: 0 };
    if (!doc.feeds.length && this.feeds.size) return { added: 0, removed: 0 }; // an empty list never wipes a device
    const remote = new Map(doc.feeds.map((f) => [f.id, f]));
    const gone = [...this.feeds.keys()].filter((id) => !remote.has(id));
    const removed = await this.removeFeeds(gone, { silent: true });
    let added = 0;
    const touched = [];
    for (const rf of doc.feeds) {
      let f = this.feeds.get(rf.id);
      if (f) {
        Object.assign(f, { url: rf.url, title: rf.title, website: rf.website, category: rf.category || null, order: rf.order });
      } else {
        f = { id: rf.id, url: rf.url, title: rf.title, website: rf.website, category: rf.category || null, order: rf.order, etag: null, modified: null, lastFetched: null, error: null };
        this.feeds.set(f.id, f);
        added++;
      }
      touched.push(f);
    }
    this.catOrder = [...(doc.categories || [])];
    await this.saveMeta();
    await store.put('feeds', touched);
    await this.normalize();
    return { added, removed };
  }

  // ----- refresh -----
  async post(path, body) {
    if (!this.proxy) throw new ApiError('Set the proxy URL in Settings to fetch feeds.', 0);
    let res;
    try {
      res = await fetch(this.proxy + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.proxyKey ? { 'X-Proxy-Key': this.proxyKey } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(navigator.onLine ? 'Could not reach the proxy. Check the proxy URL in Settings.' : 'You are offline', 0);
    }
    if (res.status === 403) {
      let code = '';
      try { code = (await res.json()).error; } catch {}
      throw new ApiError(code === 'sync_requires_proxy_key'
        ? 'Sync needs a proxy key: set the PROXY_KEY secret on your Worker and enter the same key in Settings.'
        : 'The proxy rejected this app (origin or proxy key). Check Settings.', 403);
    }
    if (!res.ok) {
      let said = '';
      try { said = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 80); } catch {}
      const where = new URL(this.proxy + path).host + path;
      const hint = res.status === 404
        ? ` The proxy has no ${path} endpoint at this address. Check that the Proxy URL is just the Worker address (…workers.dev, no extra path) and that the Worker is up to date.`
        : '';
      throw new ApiError(`Proxy error ${res.status} at ${where}${said ? ` (“${said}”)` : ''}.${hint}`, res.status);
    }
    return res.json();
  }

  /** Fetch feeds (all, or only `ids`). Returns { added, fetched, failed, total }. */
  async refreshAll({ onProgress, ids } = {}) {
    await this.init();
    const feeds = (ids ? ids.map((i) => this.feeds.get(i)) : [...this.feeds.values()]).filter(Boolean);
    const direct = feeds.filter((f) => isHNApi(f.url));
    const proxied = feeds.filter((f) => !isHNApi(f.url));
    const chunks = [];
    for (let i = 0; i < proxied.length; i += CHUNK) chunks.push(proxied.slice(i, i + CHUNK));
    const out = { added: 0, fetched: 0, failed: 0, total: feeds.length };
    let done = 0, next = 0, fatal = null;
    onProgress?.(0, feeds.length);

    // Feeds the browser fetches itself (no proxy needed).
    if (direct.length) {
      const changedFeeds = [];
      const changedEntries = [];
      await Promise.all(direct.map(async (f) => {
        const res = this.applyResult(f, await this.fetchDirect(f), changedEntries);
        out.added += res.added;
        res.ok ? out.fetched++ : out.failed++;
        changedFeeds.push(f);
        done++;
        onProgress?.(Math.min(done, feeds.length), feeds.length);
      }));
      await store.put('feeds', changedFeeds);
      await this.persistContent(changedEntries);
    }

    const worker = async () => {
      while (next < chunks.length && !fatal) {
        const chunk = chunks[next++];
        try {
          const { results } = await this.post('/feeds', { feeds: chunk.map((f) => ({ url: f.url, etag: f.etag, modified: f.modified })) });
          const byUrl = new Map(results.map((r) => [r.url, r]));
          const changedFeeds = [];
          const changedEntries = [];
          for (const f of chunk) {
            const r = byUrl.get(f.url);
            if (!r) continue;
            const res = this.applyResult(f, r, changedEntries);
            out.added += res.added;
            res.ok ? out.fetched++ : out.failed++;
            changedFeeds.push(f);
          }
          await store.put('feeds', changedFeeds);
          await this.persistContent(changedEntries);
        } catch (e) {
          fatal = e;
        }
        done += chunk.length;
        onProgress?.(Math.min(done, feeds.length), feeds.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    if (fatal) {
      this.failed = [...this.feeds.values()].filter((f) => f.error).map((f) => this.failure(f));
      throw fatal;
    }

    await this.prune();
    this.failed = [...this.feeds.values()].filter((f) => f.error).map((f) => this.failure(f));
    if (!ids) { try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch {} }
    return out;
  }

  /** Fetch a feed in the browser itself (Hacker News Search API). Same result shape as the proxy's. */
  async fetchDirect(f) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { url: f.url, status: res.status, error: `HTTP ${res.status}` };
      return { url: f.url, status: 200, finalUrl: f.url, parsed: parseHNApi(await res.json(), f.url) };
    } catch (e) {
      return { url: f.url, status: 0, error: e?.name === 'TimeoutError' ? 'Timed out' : e?.message === 'Not a valid feed' ? 'Not a valid feed' : 'Could not reach the API' };
    }
  }

  applyResult(f, r, changedEntries) {
    const now = Date.now();
    if (r.status === 304) { f.lastFetched = now; f.error = null; f.errorDetail = null; return { ok: true, added: 0 }; }
    if (r.status !== 200) {
      f.error = r.error || `HTTP ${r.status}`;
      const moved = r.finalUrl && r.finalUrl !== f.url ? `after redirect to ${r.finalUrl}` : '';
      f.errorDetail = [r.detail, moved, r.server ? `server: ${r.server}` : ''].filter(Boolean).join(' — ') || null;
      return { ok: false, added: 0 };
    }
    let parsed;
    try {
      parsed = r.parsed || parseFeed(r.body, now);
    } catch (e) {
      f.error = e.message || 'Not a valid feed';
      const text = String(r.body || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      f.errorDetail = [(r.contentType || '').split(';')[0], text].filter(Boolean).join(' — ') || null;
      return { ok: false, added: 0 };
    }
    const first = f.lastFetched == null;
    const base = r.finalUrl || f.url;
    f.etag = r.etag || null;
    f.modified = r.modified || null;
    f.title = f.title || parsed.title || new URL(f.url).hostname;
    f.website = f.website || (parsed.website ? abs(parsed.website, base) : '');
    f.lastFetched = now;
    f.error = null;
    f.errorDetail = null;

    let added = 0;
    const batch = parsed.items.filter((it) => it.guid);
    const idOf = (it) => 'e' + hash(f.id + '\n' + it.guid);
    const linkOf = (it) => (it.link ? abs(it.link, base) : '');
    const titleOf = (it) => it.title || '';
    const keyOf = (it) => { const l = linkOf(it); return l ? l + '\n' + titleOf(it) : ''; };
    // A feed may change its GUIDs but keep link and title: match by those, but only when that is unambiguous.
    const batchIds = new Set(batch.map(idOf));
    const pairCount = new Map();
    for (const it of batch) { const k = keyOf(it); if (k) pairCount.set(k, (pairCount.get(k) || 0) + 1); }
    const byPair = new Map();
    for (const e of this.entries.values()) {
      if (e.feedId === f.id && e.alternate?.[0]?.href) byPair.set(e.alternate[0].href + '\n' + (e.title || ''), e);
    }

    const listed = [];
    for (const it of batch) {
      const guidId = idOf(it);
      const link = linkOf(it);
      const pair = keyOf(it);
      let cur = this.entries.get(guidId);
      if (!cur && pair && pairCount.get(pair) === 1) {
        const c = byPair.get(pair);
        if (c && !batchIds.has(c.id)) cur = c;
      }
      const id = cur ? cur.id : guidId;
      listed.push(id);
      const published = it.published ?? cur?.published ?? now;
      const title = it.title || cur?.title || '(untitled)';
      const fields = {
        title,
        author: it.author || '',
        published,
        alternate: link ? [{ href: link, type: 'text/html' }] : [],
        canonicalUrl: link || undefined,
        summary: { content: it.summary || '' },
        content: it.html ? { content: it.html } : undefined,
        visual: it.image ? { url: abs(it.image, base) } : undefined,
        feedTitle: f.title,
        lk: pair && pairCount.get(pair) === 1 ? lkOf(f.id, link, it.title || '') : undefined,
      };
      const sig = JSON.stringify(fields);
      if (cur) {
        if (cur.sig !== sig) { Object.assign(cur, fields); cur.sig = sig; changedEntries.push(cur); }
      } else {
        const remote = (fields.lk && this.sync.remote[fields.lk]) || this.sync.remote[id];
        const intent = this.getPending?.()?.[id]; // marked here before the article was stored (e.g. a write failed)
        const e = {
          id, feedId: f.id, crawled: now, tags: [], sig,
          unread: intent && 'read' in intent ? !intent.read : !(first && now - published > FIRST_FETCH_UNREAD_MS) && !remote?.read,
          ...fields,
        };
        if (intent && 'saved' in intent && intent.saved) e.tags = [{ id: this.savedId() }];
        if (remote) { delete this.sync.remote[fields.lk]; delete this.sync.remote[id]; }
        this.entries.set(id, e);
        changedEntries.push(e);
        if (e.unread) { added++; this.audit.newUnread++; }
      }
    }
    // What the feed lists right now. An empty answer is not trusted (it may be a glitch).
    if (listed.length) f.listed = listed;
    return { ok: true, added };
  }

  async prune() {
    const now = Date.now();
    const byFeed = new Map();
    for (const e of this.entries.values()) {
      if (!byFeed.has(e.feedId)) byFeed.set(e.feedId, []);
      byFeed.get(e.feedId).push(e);
    }
    const drop = [];
    for (const [feedId, list] of byFeed) {
      const f = this.feeds.get(feedId);
      if (!f) { drop.push(...list.filter((e) => !e.tags.length)); continue; }
      // Without a record of what the feed lists, keep everything. Articles it still lists are never dropped:
      // they would simply come back as new, unread articles on the next refresh.
      if (!f.listed) continue;
      const listed = new Set(f.listed);
      const gone = list.filter((e) => !listed.has(e.id)).sort((a, b) => b.published - a.published);
      gone.forEach((e, i) => {
        if (!e.unread && !e.tags.length && (now - e.published > KEEP_MS || i >= MAX_PER_FEED)) drop.push(e);
      });
    }
    for (const e of drop) this.entries.delete(e.id);
    await store.del('entries', drop.map((e) => e.id));
  }
}
