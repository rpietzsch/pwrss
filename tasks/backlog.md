# Backlog

See AGENTS.md for conventions.

## In progress

## Next

- [ ] Find the cause of the 'Proxy error 404' on retry for the Hacker News feed (the new error text shows the endpoint and reply) (spec: #accounts-and-proxy)
- [ ] Feeds that block Cloudflare Worker addresses (Hacker News answers 419, w3.org and Forbes show a Cloudflare block page): offer another egress (e.g. Deno Deploy/Vercel proxy) or a per-feed alternative address (spec: #local-feeds-default-source)
- [ ] Diagnose why `https://hackernews.com/rss` (redirects to news.ycombinator.com/rss) fails on the deployed Worker: read the reason now shown in Settings after Retry failed (spec: #local-feeds-default-source)
- [ ] Show a hint per failure type (404/410 = gone for good; 403/530/timeouts may be the site blocking the proxy, so retry later) (spec: #local-feeds-default-source)
- [ ] Verify local feeds end to end on the deployed site with the real Worker and a real OPML (spec: #local-feeds-default-source)
- [ ] Optional: obtain a Feedly OAuth client ID/secret and test sign-in against the real service (spec: #accounts-and-proxy)
- [ ] Verify against a real Feedly account and proxy: counts, mark-all and continuation paging (spec: #accounts-and-proxy)
- [ ] Undo toast after swipe and mark-all (spec: #gestures)
- [ ] Search within the current stream (Feedly `/v3/search/contents`)
- [ ] Per-feed "always open in Reader mode" preference (spec: #article-view)

## Later

- [ ] Drag-and-drop reordering in Manage feeds (buttons only for now)
- [ ] Optional sync of local state across devices via the Worker (Cloudflare KV / D1)
- [ ] Feed discovery: paste a website URL and find its feed
- [ ] Background refresh via periodic sync where supported
- [ ] Prefetch Reader-mode content for the next article
- [ ] Image proxying through the worker for privacy
- [ ] Manage subscriptions (add/remove feeds, rename categories)

## Done

- [x] 2026-11-09 — Proxy URL cleaned (trailing slash, pasted /health /feeds /fetch); proxy errors name the endpoint and what the proxy said, 404 explains likely causes (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Retry feedback: toasts drawn above dialogs (they were hidden behind Settings), progress on Retry failed, per-feed retry in the failed list and Manage feeds, failures name the answering server (spec: #messages)
- [x] 2026-11-09 — Edit a feed's URL from Manage feeds and the failed list; failure reports show where a redirect ended up (spec: #managing-feeds)
- [x] 2026-11-09 — Feed fetching hardening: 6-at-a-time with per-fetch timeouts, honest feed-reader user agent, one retry on 429/5xx, big feeds cut to newest items, failure list shows URL and server message. Checked against the user's real OPML (70 feeds; most failures are dead feeds)
- [x] 2026-11-09 — Failed feeds: full scrollable list, per-feed remove, Retry failed, Remove all failed (spec: #local-feeds-default-source)
- [x] 2026-11-09 — Icons switched from hand-drawn SVG to the vendored Lucide sprite; test guards that every icon exists
- [x] 2026-11-09 — Manage feeds: add (with category), remove, rename, move between categories, reorder feeds and categories, create/rename/delete categories; OPML export reflects it; re-import never overwrites edits (spec: #managing-feeds)
- [x] 2026-11-09 — Local feeds: OPML import/export, add feed by URL, RSS/Atom/RDF parser, Worker `/feeds` batch endpoint with conditional requests, IndexedDB storage, auto refresh (spec: #local-feeds-default-source)
- [x] 2026-11-09 — OAuth "Sign in with Feedly" with token refresh via Worker; dev token kept as fallback. Tested against mocks only, not the real Feedly (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Proxy worker live on Cloudflare via Git-connected Workers Builds; public `/health` check (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Toolbar position setting (bottom by default, top optional) for thumb reach (spec: #theme-and-appearance)
- [x] 2026-11-08 — Light/dark mode following the system setting, quick theme toggle (`T`), synced `theme-color` (spec: #theme-and-appearance)
- [x] 2026-11-08 — Taskfile with lifecycle targets, scripted build, smoke test
- [x] 2026-11-08 — Initial PWA: sources, list, article, reader mode, gestures, offline queue, demo, proxy worker, Pages deploy
