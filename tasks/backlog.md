# Backlog

See AGENTS.md for conventions.

## In progress

## Next

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
