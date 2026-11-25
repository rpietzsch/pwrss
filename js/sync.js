// Client side of cross-device sync (server: worker/sync-store.mjs, spec: tasks/specs.md#sync-across-devices).
import { ApiError } from './api.js';

const PUSH_BATCH = 2000;
// Bump to make every device re-read all cloud states once (repairs read states damaged by an earlier bug).
const REPAIR_ID = 'read-state-2';

/**
 * What a server flag says about an article. A field counts only if it was ever set (timestamp > 0):
 * a flag created by saving an article has no read state yet and must not mark it unread.
 */
export function remoteState(f) {
  return { read: f.readAt > 0 ? !!f.read : undefined, saved: f.savedAt > 0 ? !!f.saved : undefined };
}

export class SyncClient {
  constructor(lf) {
    this.lf = lf;
    this.busy = null;
  }

  /** One sync: push local changes, then pull everything new. Resolves to { changed, docChanged, newFeeds, sent }. */
  run() {
    this.busy ??= this.sync().finally(() => { this.busy = null; });
    return this.busy;
  }

  async post(body) {
    try {
      return await this.lf.post('/sync', body);
    } catch (e) {
      if (e.status === 404) throw new ApiError('Your Worker has no sync endpoint yet. Redeploy the Worker from the latest version.', 404);
      if (e.status === 501) throw new ApiError('Sync is not set up on your Worker (the Durable Object is missing). Check its latest deployment.', 501);
      throw e;
    }
  }

  async sync() {
    const lf = this.lf;
    await lf.init();
    const st = lf.sync;
    lf.seedSync();
    if (st.repaired !== REPAIR_ID) { st.seq = 0; st.repaired = REPAIR_ID; } // full re-read, once
    const result = { changed: new Set(), docChanged: false, newFeeds: 0, sent: 0 };
    let first = true;
    let more = true;
    while (more || Object.keys(st.dirty).length) {
      const snap = lf.syncSnapshot(PUSH_BATCH);
      if (!first && !snap.flags.length && !more) break;
      const res = await this.post({ since: st.seq, flags: snap.flags, docRev: st.docRev, docAt: st.docAt, doc: first ? snap.doc : null, limit: 1000 });

      // Our own flags are on the server now (or lost to newer ones there): forget them before applying the server's state.
      lf.commitSync(snap);
      result.sent += snap.flags.length;
      for (const id of await lf.applyRemoteFlags(res.flags || [])) result.changed.add(id);

      if (res.doc) {
        const r = await lf.applyDoc(res.doc);
        st.docAt = res.docAt;
        st.syncedDocAt = res.docAt;
        result.docChanged = true;
        result.newFeeds += r.added;
      } else if (res.accepted) {
        st.syncedDocAt = snap.docAt;
      }
      st.docRev = res.docRev;
      st.seq = res.seq;
      more = !!res.more;
      first = false;
      await lf.saveSync();
    }
    st.lastSync = Date.now();
    await lf.saveSync();
    return result;
  }
}
