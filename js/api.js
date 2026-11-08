// Feedly Cloud API client.
// Docs: https://developer.feedly.com/
// Feedly does not send CORS headers, so in a browser every call goes through a
// proxy (see /worker). The proxy mirrors /v3/* to api.feedly.com and exposes
// /fetch?url=… for Reader mode.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Feedly {
  constructor({ token, proxy, proxyKey }) {
    this.token = token;
    this.proxy = (proxy || '').trim().replace(/\/+$/, '');
    this.proxyKey = proxyKey || '';
    this.userId = null;
  }

  get base() {
    return this.proxy || 'https://api.feedly.com';
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.proxyKey) h['X-Proxy-Key'] = this.proxyKey;
    return h;
  }

  async req(path, { method = 'GET', params, body } = {}) {
    const url = new URL(this.base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (!navigator.onLine) throw new ApiError('You are offline', 0);
      throw new ApiError(
        this.proxy
          ? 'Could not reach the proxy. Check the proxy URL in Settings.'
          : 'Feedly blocks direct browser access (CORS). Set up the proxy in Settings.',
        0,
      );
    }
    if (res.status === 401) throw new ApiError('Feedly rejected the token (expired?). Update it in Settings.', 401);
    if (res.status === 429) throw new ApiError('Feedly rate limit reached. Try again later.', 429);
    if (!res.ok) {
      let msg = `Feedly error ${res.status}`;
      try {
        const j = await res.json();
        if (j.errorMessage) msg += `: ${j.errorMessage}`;
      } catch {}
      throw new ApiError(msg, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async profile() {
    const p = await this.req('/v3/profile');
    this.userId = p.id;
    return p;
  }

  allId() { return `user/${this.userId}/category/global.all`; }
  savedId() { return `user/${this.userId}/tag/global.saved`; }

  categories() { return this.req('/v3/categories'); }
  subscriptions() { return this.req('/v3/subscriptions'); }

  async counts() {
    const r = await this.req('/v3/markers/counts');
    return r.unreadcounts || [];
  }

  stream(streamId, { count = 40, unreadOnly = false, continuation, ranked = 'newest', newerThan } = {}) {
    return this.req('/v3/streams/contents', {
      params: { streamId, count, unreadOnly, continuation, ranked, newerThan },
    });
  }

  markers(action, entryIds) {
    if (!entryIds.length) return Promise.resolve();
    return this.req('/v3/markers', { method: 'POST', body: { action, type: 'entries', entryIds } });
  }

  // Mark a whole feed / category as read up to `asOf` (ms timestamp).
  markStreamRead(streamId, asOf) {
    if (streamId.startsWith('feed/')) {
      return this.req('/v3/markers', { method: 'POST', body: { action: 'markAsRead', type: 'feeds', feedIds: [streamId], asOf } });
    }
    if (streamId.includes('/category/')) {
      return this.req('/v3/markers', { method: 'POST', body: { action: 'markAsRead', type: 'categories', categoryIds: [streamId], asOf } });
    }
    return null; // tags etc: caller marks loaded entries individually
  }

  async fetchPage(url) {
    if (!this.proxy) throw new ApiError('Reader mode needs the proxy (Settings).', 0);
    const u = new URL(this.proxy + '/fetch');
    u.searchParams.set('url', url);
    const res = await fetch(u, { headers: this.proxyKey ? { 'X-Proxy-Key': this.proxyKey } : {} });
    if (!res.ok) throw new ApiError(`Could not load page (${res.status})`, res.status);
    return { html: await res.text(), url: res.headers.get('X-Final-Url') || url };
  }
}
