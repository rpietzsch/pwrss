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
  // oauth: { access, refresh, expires } when signed in via OAuth; onOAuth(oauth) persists refreshed tokens.
  constructor({ token, proxy, proxyKey, oauth, onOAuth, onAuthLost }) {
    this.oauth = oauth && oauth.access ? { ...oauth } : null;
    this.token = this.oauth ? this.oauth.access : token;
    this.proxy = (proxy || '').trim().replace(/\/+$/, '');
    this.proxyKey = proxyKey || '';
    this.onOAuth = onOAuth;
    this.onAuthLost = onAuthLost;
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

  // ----- OAuth (the proxy holds the client secret) -----
  static async authPost(proxy, proxyKey, path, body) {
    const base = (proxy || '').trim().replace(/\/+$/, '');
    if (!base) throw new ApiError('Set the proxy URL first (Settings).', 0);
    let res;
    try {
      res = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(proxyKey ? { 'X-Proxy-Key': proxyKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('Could not reach the proxy. Check the proxy URL in Settings.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = res.status === 403 ? 'The proxy rejected this app (origin or proxy key).'
        : data?.error === 'oauth_not_configured' ? 'Sign-in is not set up on the proxy yet.'
        : `Sign-in failed: ${data?.error || res.status}`;
      throw new ApiError(msg, res.status);
    }
    return data;
  }
  static authConfig(proxy, proxyKey) { return Feedly.authPost(proxy, proxyKey, '/auth/config'); }
  static async exchangeCode(proxy, proxyKey, code, redirectUri) {
    const t = await Feedly.authPost(proxy, proxyKey, '/auth/token', { code, redirect_uri: redirectUri });
    return Feedly.toOAuth(t);
  }
  static toOAuth(t, prev = {}) {
    return {
      access: t.access_token,
      refresh: t.refresh_token || prev.refresh,
      expires: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    };
  }

  refreshTokens() {
    if (!this.oauth?.refresh) return Promise.reject(new ApiError('Please sign in again.', 401));
    this._refreshing ??= Feedly.authPost(this.proxy, this.proxyKey, '/auth/refresh', { refresh_token: this.oauth.refresh })
      .then((t) => {
        this.oauth = Feedly.toOAuth(t, this.oauth);
        this.token = this.oauth.access;
        this.onOAuth?.(this.oauth);
      })
      .catch((e) => {
        if (e.status === 0 || e.status === 403) throw e; // network or proxy problem: keep the session
        this.onAuthLost?.();
        throw new ApiError('Your Feedly session expired. Please sign in again.', 401);
      })
      .finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async ensureFresh() {
    if (this.oauth?.refresh && this.oauth.expires - Date.now() < 5 * 60 * 1000) await this.refreshTokens();
  }

  async req(path, opts = {}) {
    await this.ensureFresh();
    try {
      return await this.request(path, opts);
    } catch (e) {
      if (e.status === 401 && this.oauth?.refresh && !opts._retried) {
        await this.refreshTokens();
        return this.req(path, { ...opts, _retried: true });
      }
      throw e;
    }
  }

  async request(path, { method = 'GET', params, body } = {}) {
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

  fetchPage(url) {
    return proxyFetchPage(this.proxy, this.proxyKey, url);
  }
}

// Fetch an article page through the proxy (Reader mode); shared by all backends.
export async function proxyFetchPage(proxy, proxyKey, url) {
  const base = (proxy || '').trim().replace(/\/+$/, '');
  if (!base) throw new ApiError('Reader mode needs the proxy (Settings).', 0);
  const u = new URL(base + '/fetch');
  u.searchParams.set('url', url);
  let res;
  try {
    res = await fetch(u, { headers: proxyKey ? { 'X-Proxy-Key': proxyKey } : {} });
  } catch {
    throw new ApiError('Could not reach the proxy. Check the proxy URL in Settings.', 0);
  }
  if (!res.ok) throw new ApiError(`Could not load page (${res.status})`, res.status);
  return { html: await res.text(), url: res.headers.get('X-Final-Url') || url };
}
