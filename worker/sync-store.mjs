// Sync store: one Durable Object (SQLite storage) that holds a single person's reading state.
//
// Protocol (POST /sync through the Worker, which adds origin and proxy-key checks):
//   request  { since, flags: [...], docRev, docAt, doc?, limit? }
//   response { seq, flags: [...], more, docRev, docAt, doc?, accepted }
//
// - flags: per-article read/saved state, merged last-writer-wins per field (read, saved) by client timestamp.
//   { id, read?, readAt?, saved?, savedAt?, entry? }  (entry = small payload so saved articles can be shown on other devices)
// - doc: the feed list document (feeds, categories), last-writer-wins as a whole.
// - seq: server counter; a client asks for everything with seq > since.

const MAX_FLAGS = 5000;
const MAX_DOC_BYTES = 500_000;
const MAX_ENTRY_BYTES = 20_000;
const PAGE = 1000;
const RETENTION_MS = 90 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const clampTime = (t, now) => Math.min(Math.max(Number(t) || 0, 0), now + 60_000);

export class SyncStore {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS flags (
      id TEXT PRIMARY KEY, read INTEGER NOT NULL DEFAULT 0, read_at INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0, saved_at INTEGER NOT NULL DEFAULT 0, entry TEXT, seq INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS flags_seq ON flags (seq)');
  }

  get(k, fallback) {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v) : fallback;
  }

  set(k, v) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const now = Date.now();
    let seq = this.get('seq', 0);

    // ---- flags: last writer wins per field ----
    const flags = Array.isArray(body.flags) ? body.flags.slice(0, MAX_FLAGS) : [];
    for (const f of flags) {
      if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 100) continue;
      const cur = this.sql.exec('SELECT read, read_at, saved, saved_at, entry FROM flags WHERE id = ?', f.id).toArray()[0]
        || { read: 0, read_at: 0, saved: 0, saved_at: 0, entry: null };
      let { read, read_at, saved, saved_at, entry } = cur;
      let changed = false;
      const rt = clampTime(f.readAt, now);
      const st = clampTime(f.savedAt, now);
      if ('read' in f && rt > read_at) { read = f.read ? 1 : 0; read_at = rt; changed = true; }
      if ('saved' in f && st > saved_at) {
        saved = f.saved ? 1 : 0; saved_at = st; changed = true;
        if (!saved) entry = null;
        else if (f.entry) { const e = JSON.stringify(f.entry); if (e.length <= MAX_ENTRY_BYTES) entry = e; }
      }
      if (!changed) continue;
      seq += 1;
      this.sql.exec(
        `INSERT INTO flags (id, read, read_at, saved, saved_at, entry, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET read = excluded.read, read_at = excluded.read_at, saved = excluded.saved,
           saved_at = excluded.saved_at, entry = excluded.entry, seq = excluded.seq`,
        f.id, read, read_at, saved, saved_at, entry, seq);
    }
    this.set('seq', seq);

    // ---- feed list document: last writer wins as a whole ----
    let docRev = this.get('docRev', 0);
    let docAt = this.get('docAt', 0);
    const clientRev = Number(body.docRev) || 0;
    let doc;
    let accepted = false;
    if (body.doc && JSON.stringify(body.doc).length <= MAX_DOC_BYTES && clampTime(body.docAt, now) > docAt) {
      docAt = clampTime(body.docAt, now);
      docRev += 1;
      this.set('doc', body.doc); this.set('docAt', docAt); this.set('docRev', docRev);
      accepted = true;
    } else if (body.doc || docRev > clientRev) {
      doc = this.get('doc', undefined); // the client is behind (or its change was older): the server's copy wins
    }

    // ---- everything changed since the client's last sync ----
    const limit = Math.min(Math.max(Number(body.limit) || PAGE, 1), PAGE);
    const rows = this.sql.exec(
      'SELECT id, read, read_at, saved, saved_at, entry, seq FROM flags WHERE seq > ? ORDER BY seq LIMIT ?',
      Math.max(Number(body.since) || 0, 0), limit).toArray();
    const more = rows.length === limit;

    // ---- daily housekeeping: forget old read states (saved ones stay) ----
    if (this.get('prunedAt', 0) < now - DAY_MS) {
      const cutoff = now - RETENTION_MS;
      this.sql.exec('DELETE FROM flags WHERE saved = 0 AND read_at < ? AND saved_at < ?', cutoff, cutoff);
      this.set('prunedAt', now);
    }

    return json({
      seq: more ? rows[rows.length - 1].seq : seq,
      more,
      flags: rows.map((r) => ({
        id: r.id, read: !!r.read, readAt: r.read_at, saved: !!r.saved, savedAt: r.saved_at,
        ...(r.entry ? { entry: JSON.parse(r.entry) } : {}),
      })),
      docRev, docAt, accepted,
      ...(doc ? { doc } : {}),
    });
  }
}
