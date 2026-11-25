// Tiny IndexedDB wrapper for local feeds and articles.
//
// Browsers can lose their database connection (WebKit does after the app was in the background, or when the
// storage is under pressure). A dead connection must not poison everything until the next reload, so every
// operation reopens the database and retries once when it hits a connection error.
const NAME = 'pwrss';
let dbp = null;
let logger = null;
export function setDbLogger(fn) { logger = fn; } // the app records reconnects in its diagnostics log

function open() {
  const p = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => {
      for (const n of ['feeds', 'entries', 'meta']) {
        if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = () => { if (dbp === p) dbp = null; };           // the browser dropped the connection
      d.onversionchange = () => { d.close(); if (dbp === p) dbp = null; };
      resolve(d);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('The database is blocked by another tab'));
  });
  p.catch(() => { if (dbp === p) dbp = null; });
  return p;
}

export function db() {
  dbp ??= open();
  return dbp;
}

const CONNECTION_ERRORS = new Set(['InvalidStateError', 'UnknownError', 'AbortError', 'TransactionInactiveError']);

async function run(fn) {
  try {
    return await fn(await db());
  } catch (e) {
    if (!CONNECTION_ERRORS.has(e?.name)) throw e;
    dbp = null; // drop the dead connection, try once more on a fresh one
    logger?.('db-reconnect', `${e.name}: ${e.message}`);
    return fn(await db());
  }
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error || new DOMException('The transaction was aborted', 'AbortError'));
});

export function getAll(store) {
  return run((d) => new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export function put(store, items) {
  if (!items.length) return Promise.resolve();
  return run(async (d) => {
    const tx = d.transaction(store, 'readwrite');
    for (const i of items) tx.objectStore(store).put(i);
    await done(tx);
  });
}

/**
 * Merge fields into stored records inside one transaction: `patches` is [{ id, set, create }]. The record is read at
 * that moment, `set` is merged into it, and `create` (a whole record) is stored only if none exists. Writers that own
 * different fields of the same record (state vs content) can never overwrite each other's work, even from two tabs.
 */
export function patch(store, patches) {
  if (!patches.length) return Promise.resolve();
  return run(async (d) => {
    const tx = d.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const p of patches) {
      const req = os.get(p.id);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) os.put({ ...cur, ...p.set });
        else if (p.create) os.put(p.create);
      };
    }
    await done(tx);
  });
}

export function del(store, ids) {
  if (!ids.length) return Promise.resolve();
  return run(async (d) => {
    const tx = d.transaction(store, 'readwrite');
    for (const id of ids) tx.objectStore(store).delete(id);
    await done(tx);
  });
}

export function clear(...stores) {
  return run(async (d) => {
    const tx = d.transaction(stores, 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    await done(tx);
  });
}
