// Tiny IndexedDB wrapper for local feeds and articles.
const NAME = 'pwrss';
let dbp;

export function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => {
      for (const n of ['feeds', 'entries', 'meta']) {
        if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function getAll(store) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function put(store, items) {
  if (!items.length) return;
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  for (const i of items) tx.objectStore(store).put(i);
  await done(tx);
}

export async function del(store, ids) {
  if (!ids.length) return;
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  for (const id of ids) tx.objectStore(store).delete(id);
  await done(tx);
}

export async function clear(...stores) {
  const d = await db();
  const tx = d.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  await done(tx);
}
