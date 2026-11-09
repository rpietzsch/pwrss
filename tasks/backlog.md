# Backlog

See AGENTS.md for conventions.

## In progress

## Next

- [ ] Verify against a real Feedly account and proxy: counts, mark-all and continuation paging (spec: #accounts-and-proxy)
- [ ] Undo toast after swipe and mark-all (spec: #gestures)
- [ ] Search within the current stream (Feedly `/v3/search/contents`)
- [ ] Per-feed "always open in Reader mode" preference (spec: #article-view)

## Later

- [ ] Optional OAuth flow if Feedly grants a client ID (avoids 30-day dev-token expiry)
- [ ] Prefetch Reader-mode content for the next article
- [ ] Image proxying through the worker for privacy
- [ ] Manage subscriptions (add/remove feeds, rename categories)

## Done

- [x] 2026-11-09 — Proxy worker live on Cloudflare via Git-connected Workers Builds; public `/health` check (spec: #accounts-and-proxy)
- [x] 2026-11-09 — Toolbar position setting (bottom by default, top optional) for thumb reach (spec: #theme-and-appearance)
- [x] 2026-11-08 — Light/dark mode following the system setting, quick theme toggle (`T`), synced `theme-color` (spec: #theme-and-appearance)
- [x] 2026-11-08 — Taskfile with lifecycle targets, scripted build, smoke test
- [x] 2026-11-08 — Initial PWA: sources, list, article, reader mode, gestures, offline queue, demo, proxy worker, Pages deploy
