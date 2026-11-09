// Unit tests for the sync Durable Object logic, run against real SQLite (node:sqlite) and through the Worker route.
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) { failures++; if (extra !== undefined) console.log('   ', JSON.stringify(extra)); } };

// Minimal stand-in for a Durable Object's `state.storage.sql`.
function makeState() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return {
    storage: {
      sql: {
        exec(query, ...bindings) {
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows, one: () => rows[0] };
        },
      },
    },
  };
}

(async () => {
  const origWarn = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite prints an experimental warning
  const { SyncStore } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'sync-store.mjs')).href);
  const { default: w } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'feedly-proxy.mjs')).href);
  process.emitWarning = origWarn;

  const store = new SyncStore(makeState());
  const call = async (body) => {
    const res = await store.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, ...(await res.json()) };
  };
  const T = Date.now();

  // ---- flags: last writer wins per field ----
  let r = await call({ since: 0, flags: [{ id: 'a', read: true, readAt: T - 1000 }, { id: 'b', saved: true, savedAt: T - 900, entry: { id: 'b', title: 'Saved one' } }] });
  check('push stores flags and returns them with a sequence', r.status === 200 && r.flags.length === 2 && r.seq === 2, r);
  check('saved entry payload round-trips', r.flags.find((f) => f.id === 'b').entry.title === 'Saved one');

  r = await call({ since: 0, flags: [{ id: 'a', read: false, readAt: T - 2000 }] });
  check('an older change loses', r.flags.find((f) => f.id === 'a').read === true && r.seq === 2, r);
  r = await call({ since: 0, flags: [{ id: 'a', read: false, readAt: T - 500 }] });
  check('a newer change wins', r.flags.find((f) => f.id === 'a').read === false && r.seq === 3, r);
  r = await call({ since: 0, flags: [{ id: 'a', saved: true, savedAt: T - 400 }] });
  const a = r.flags.find((f) => f.id === 'a');
  check('read and saved are independent fields', a.read === false && a.saved === true, a);

  r = await call({ since: 3, flags: [] });
  check('pull returns only what changed since', r.flags.length === 1 && r.flags[0].id === 'a' && r.seq === 4, r);
  r = await call({ since: 4, flags: [] });
  check('nothing new after the latest sequence', r.flags.length === 0 && r.seq === 4 && !r.more);

  r = await call({ since: 0, flags: [{ id: 'b', saved: false, savedAt: T - 100 }] });
  check('unsaving drops the stored payload', r.flags.find((f) => f.id === 'b').entry === undefined && r.flags.find((f) => f.id === 'b').saved === false);

  r = await call({ since: 0, flags: [{ id: 'future', read: true, readAt: T + 10 * 24 * 3600 * 1000 }] });
  const fut = r.flags.find((f) => f.id === 'future');
  check('timestamps from the far future are clamped', fut.readAt <= Date.now() + 61_000, fut);

  r = await call({ since: 0, flags: [{ id: 'x'.repeat(200), read: true, readAt: T }, { id: '', read: true, readAt: T }, null, { read: true }] });
  check('malformed flags are ignored', !r.flags.some((f) => f.id.length > 100 || f.id === ''));

  // ---- paging ----
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, read: true, readAt: T + 1 + i }));
  await call({ since: 0, flags: many.slice(0, 2500) });
  let since = 0, got = 0, pages = 0, more = true;
  while (more) { r = await call({ since, flags: [], limit: 1000 }); got += r.flags.length; since = r.seq; more = r.more; pages++; }
  check('large state is delivered in pages', got >= 2500 && pages >= 3, [got, pages]);

  // ---- feed list document ----
  r = await call({ since: since, flags: [], docRev: 0, docAt: T, doc: { feeds: [{ id: 'f1' }], categories: ['news'] } });
  check('first document is accepted', r.accepted === true && r.docRev === 1 && !r.doc, r);
  r = await call({ since, flags: [], docRev: 1, docAt: T + 10, doc: { feeds: [{ id: 'f1' }, { id: 'f2' }], categories: ['news'] } });
  check('a newer document replaces it', r.accepted && r.docRev === 2, r);
  r = await call({ since, flags: [], docRev: 2, docAt: T + 5, doc: { feeds: [], categories: [] } });
  check('an older document is refused and the server copy comes back', !r.accepted && r.doc.feeds.length === 2 && r.docRev === 2, r);
  r = await call({ since, flags: [], docRev: 1, docAt: T });
  check('a client that is behind receives the document', r.doc?.feeds.length === 2 && r.docAt === T + 10, r);
  r = await call({ since, flags: [], docRev: 2, docAt: T + 10 });
  check('an up-to-date client gets no document', !r.doc && !r.accepted);
  r = await call({ since, flags: [], docRev: 2, docAt: T + 99999, doc: { feeds: [{ id: 'big', pad: 'x'.repeat(600_000) }] } });
  check('an oversized document is refused', !r.accepted && r.doc.feeds.length === 2);

  r = await store.fetch(new Request('https://x/', { method: 'POST', body: 'not json' }));
  check('bad JSON is a 400', r.status === 400);

  // ---- retention ----
  const state2 = makeState();
  const s2 = new SyncStore(state2);
  const old = Date.now() - 100 * 24 * 3600 * 1000;
  await s2.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify({ since: 0, flags: [{ id: 'old-read', read: true, readAt: old }, { id: 'old-saved', saved: true, savedAt: old, entry: { id: 'old-saved' } }, { id: 'new-read', read: true, readAt: Date.now() - 1000 }] }) }));
  state2.storage.sql.exec("DELETE FROM meta WHERE k = 'prunedAt'");
  const after = await (await s2.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify({ since: 0, flags: [] }) }))).json();
  const ids = after.flags.map((f) => f.id).sort();
  check('old read states are pruned, saved and recent ones stay', JSON.stringify(ids) === JSON.stringify(['new-read', 'old-saved']), ids);

  // ---- through the Worker route ----
  const ORIGIN = 'https://rpietzsch.github.io';
  const stub = { get: () => ({ fetch: (req) => new SyncStore(makeState()).fetch(req) }), idFromName: (n) => n };
  const hit = (env, extra = {}) => w.fetch(new Request('https://w/sync', {
    method: 'POST', headers: { Origin: ORIGIN, 'X-Proxy-Key': 'k', ...extra.headers }, body: JSON.stringify({ since: 0, flags: [{ id: 'z', read: true, readAt: Date.now() }] }),
  }), env);
  const base = { ALLOWED_ORIGINS: ORIGIN, PROXY_KEY: 'k', SYNC: stub };
  let res = await hit(base);
  check('route: sync works with origin, key and the binding', res.status === 200 && (await res.json()).flags.length === 1);
  const health = await w.fetch(new Request('https://w/health'), base);
  const healthNo = await w.fetch(new Request('https://w/health'), { ...base, SYNC: undefined });
  check('health reports whether sync is set up', (await health.text()).includes('sync: ready') && (await healthNo.text()).includes('sync: not set up'));
  res = await hit({ ...base, PROXY_KEY: undefined });
  check('route: refuses to run without a proxy key set', res.status === 403 && (await res.json()).error === 'sync_requires_proxy_key');
  res = await hit({ ...base, SYNC: undefined });
  check('route: 501 when the Durable Object binding is missing', res.status === 501);
  res = await hit(base, { headers: { 'X-Proxy-Key': 'wrong' } });
  check('route: wrong proxy key is rejected', res.status === 403);
  res = await w.fetch(new Request('https://w/sync', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Proxy-Key': 'k' }, body: '{}' }), base);
  check('route: other origins are rejected', res.status === 403);
  res = await w.fetch(new Request('https://w/sync', { method: 'POST', headers: { Origin: ORIGIN, 'X-Proxy-Key': 'k' }, body: 'x'.repeat(1_600_000) }), base);
  check('route: oversized body is refused', res.status === 413);

  process.exit(failures ? 1 : 0);
})();
