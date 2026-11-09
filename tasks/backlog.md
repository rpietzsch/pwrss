# Backlog

See AGENTS.md for conventions.

## In progress

## Next

- [ ] Obtain a Feedly OAuth client ID/secret (request from Feedly; redirect URI = the app URL) and test the sign-in flow against the real service (spec: #accounts-and-proxy)
- [ ] Decide on a fallback backend (Inoreader, Miniflux or FreshRSS) if Feedly access isn't granted
- [ ] Verify against a real Feedly account and proxy: counts, mark-all and continuation paging (spec: #accounts-and-proxy)
- [ ] Undo toast after swipe and mark-all (spec: #gestures)
- [ ] Search within the current stream (Feedly `/v3/search/contents`)
- [ ] Per-feed "always open in Reader mode" preference (spec: #article-view)

## Later

- [ ] Prefetch Reader-mode content for the next article
- [ ] Image proxying through the worker for privacy
- [ ] Manage subscriptions (add/remove feeds, rename categories)

## Done

- [x] 2026-11-09 — OAuth "Sign in with Feedly" with token refresh via Worker; dev token kept as fallback. Tested against mocks only, not the real Feedly (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Proxy worker live on Cloudflare via Git-connected Workers Builds; public `/health` check (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Toolbar position setting (bottom by default, top optional) for thumb reach (spec: #theme-and-appearance)
- [x] 2026-11-08 — Light/dark mode following the system setting, quick theme toggle (`T`), synced `theme-color` (spec: #theme-and-appearance)
- [x] 2026-11-08 — Taskfile with lifecycle targets, scripted build, smoke test
- [x] 2026-11-08 — Initial PWA: sources, list, article, reader mode, gestures, offline queue, demo, proxy worker, Pages deploy
