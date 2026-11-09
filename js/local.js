// Local backend: feeds from an OPML import, fetched through the proxy, parsed in the
// browser and stored in IndexedDB. Implements the same interface as Feedly / DemoFeedly.
import { ApiError, proxyFetchPage } from './api.js';
import { parseFeed } from './feedparse.js';
import { parseOPML, buildOPML } from './opml.js';
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
    this.proxy = (proxy || '').trim().replace(/\/+$/, '');
    this.proxyKey = proxyKey || '';
    this.feeds = new Map();   // id -> feed record
    this.entries = new Map(); // id -> entry
    this.failed = [];
  }

  allId() { return `user/${UID}/category/global.all`; }
  savedId() { return `user/${UID}/tag/global.saved`; }
  catId(label) { return `user/${UID}/category/${label}`; }

  init() {
    this._init ??= (async () => {
      const [feeds, entries] = await Promise.all([store.getAll('feeds'), store.getAll('entries')]);
      for (const f of feeds) this.feeds.set(f.id, f);
      for (const e of entries) this.entries.set(e.id, e);
      this.failed = feeds.filter((f) => f.error).map((f) => ({ title: f.title || f.url, error: f.error }));
    })();
    return this._init;
  }

  lastRefresh() { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } }
  stats() { return { feeds: this.feeds.size, failed: this.failed, lastRefresh: this.lastRefresh() }; }

  // ----- Feedly-shaped interface -----
  async profile() { await this.init(); return { id: UID }; }

  async categories() {
    await this.init();
    const labels = [...new Set([...this.feeds.values()].map((f) => f.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return labels.map((label) => ({ id: this.catId(label), label }));
  }

  async subscriptions() {
    await this.init();
    return [...this.feeds.values()].map((f) => ({
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
    return { ...e, origin: { streamId: e.feedId, title: f?.title || '', htmlUrl: f?.website || '' } };
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
    }
    await store.put('entries', changed);
  }

  async markStreamRead(streamId, asOf) {
    await this.init();
    const changed = [];
    for (const e of this.entries.values()) {
      if (e.unread && this.matches(streamId, e) && (e.crawled || e.published) <= asOf) { e.unread = false; changed.push(e); }
    }
    await store.put('entries', changed);
  }

  fetchPage(url) { return proxyFetchPage(this.proxy, this.proxyKey, url); }

  // ----- feed management -----
  async importOPML(xml) {
    await this.init();
    const items = parseOPML(xml);
    let added = 0, updated = 0;
    const touched = [];
    for (const it of items) {
      const id = 'feed/' + it.url;
      const cur = this.feeds.get(id);
      if (cur) {
        cur.title = it.title || cur.title;
        cur.category = it.category;
        cur.website = it.website || cur.website;
        updated++;
        touched.push(cur);
      } else {
        const f = { id, url: it.url, title: it.title, website: it.website, category: it.category, etag: null, modified: null, lastFetched: null, error: null };
        this.feeds.set(id, f);
        touched.push(f);
        added++;
      }
    }
    await store.put('feeds', touched);
    return { added, updated, total: items.length };
  }

  async exportOPML() {
    await this.init();
    return buildOPML([...this.feeds.values()].map((f) => ({ url: f.url, title: f.title, website: f.website, category: f.category })));
  }

  async addFeed(input) {
    await this.init();
    const url = normalizeUrl(input);
    if (!url) throw new ApiError('That doesn’t look like a web address.', 0);
    const id = 'feed/' + url;
    if (this.feeds.has(id)) throw new ApiError('You already follow this feed.', 0);
    const f = { id, url, title: '', website: '', category: null, etag: null, modified: null, lastFetched: null, error: null };
    this.feeds.set(id, f);
    const r = await this.refreshAll({ ids: [id] });
    if (f.error) {
      this.feeds.delete(id);
      await store.del('feeds', [id]);
      throw new ApiError(`Couldn’t add feed: ${f.error}`, 0);
    }
    return { feed: f, added: r.added };
  }

  async reset() {
    await this.init();
    await store.clear('feeds', 'entries');
    this.feeds.clear(); this.entries.clear(); this.failed = [];
    try { localStorage.removeItem(LAST_KEY); } catch {}
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
    if (res.status === 403) throw new ApiError('The proxy rejected this app (origin or proxy key). Check Settings.', 403);
    if (!res.ok) throw new ApiError(`Proxy error ${res.status}`, res.status);
    return res.json();
  }

  /** Fetch feeds (all, or only `ids`). Returns { added, fetched, failed, total }. */
  async refreshAll({ onProgress, ids } = {}) {
    await this.init();
    const feeds = (ids ? ids.map((i) => this.feeds.get(i)) : [...this.feeds.values()]).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < feeds.length; i += CHUNK) chunks.push(feeds.slice(i, i + CHUNK));
    const out = { added: 0, fetched: 0, failed: 0, total: feeds.length };
    let done = 0, next = 0, fatal = null;
    onProgress?.(0, feeds.length);

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
          await store.put('entries', changedEntries);
        } catch (e) {
          fatal = e;
        }
        done += chunk.length;
        onProgress?.(Math.min(done, feeds.length), feeds.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    if (fatal) throw fatal;

    await this.prune();
    this.failed = [...this.feeds.values()].filter((f) => f.error).map((f) => ({ title: f.title || f.url, error: f.error }));
    if (!ids) { try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch {} }
    return out;
  }

  applyResult(f, r, changedEntries) {
    const now = Date.now();
    if (r.status === 304) { f.lastFetched = now; f.error = null; return { ok: true, added: 0 }; }
    if (r.status !== 200) { f.error = r.error || `HTTP ${r.status}`; return { ok: false, added: 0 }; }
    let parsed;
    try {
      parsed = parseFeed(r.body, now);
    } catch (e) {
      f.error = e.message || 'Not a valid feed';
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

    let added = 0;
    for (const it of parsed.items) {
      if (!it.guid) continue;
      const id = 'e' + hash(f.id + '\n' + it.guid);
      const link = it.link ? abs(it.link, base) : '';
      const cur = this.entries.get(id);
      const published = it.published ?? cur?.published ?? now;
      const fields = {
        title: it.title || cur?.title || '(untitled)',
        author: it.author || '',
        published,
        alternate: link ? [{ href: link, type: 'text/html' }] : [],
        canonicalUrl: link || undefined,
        summary: { content: it.summary || '' },
        content: it.html ? { content: it.html } : undefined,
        visual: it.image ? { url: abs(it.image, base) } : undefined,
      };
      if (cur) {
        Object.assign(cur, fields);
        changedEntries.push(cur);
      } else {
        const e = {
          id, feedId: f.id, crawled: now, tags: [],
          unread: !(first && now - published > FIRST_FETCH_UNREAD_MS),
          ...fields,
        };
        this.entries.set(id, e);
        changedEntries.push(e);
        if (e.unread) added++;
      }
    }
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
      if (!this.feeds.has(feedId)) { drop.push(...list.filter((e) => !e.tags.length)); continue; }
      list.sort((a, b) => b.published - a.published);
      list.forEach((e, i) => {
        if (!e.unread && !e.tags.length && (now - e.published > KEEP_MS || i >= MAX_PER_FEED)) drop.push(e);
      });
    }
    for (const e of drop) this.entries.delete(e.id);
    await store.del('entries', drop.map((e) => e.id));
  }
}
