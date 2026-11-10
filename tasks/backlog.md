# Backlog

See AGENTS.md for conventions.

## In progress

## Next

- [ ] Make the sync state (cursor, waiting changes) tab-safe like the article state (Web Locks around sync runs, per-article waiting records) (spec: #several-tabs-or-windows)
- [ ] Verify sync on the real Worker with two real devices (first deploy creates the Durable Object) (spec: #sync-across-devices)
- [ ] Sync settings that are per-device on purpose? (theme, toolbar) — decide whether to sync appearance (spec: #sync-across-devices)
- [ ] Confirm the earlier 'Proxy error 404' on retry doesn't come back (the error text now shows the endpoint and reply) (spec: #accounts-and-proxy)
- [ ] Other feeds that block Cloudflare Worker addresses (w3.org, Forbes show a Cloudflare block page): offer another egress (e.g. Deno Deploy/Vercel proxy) or per-feed alternatives (spec: #local-feeds-default-source)
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
- [ ] Feed discovery: paste a website URL and find its feed
- [ ] Background refresh via periodic sync where supported
- [ ] Prefetch Reader-mode content for the next article
- [ ] Image proxying through the worker for privacy
- [ ] Manage subscriptions (add/remove feeds, rename categories)

## Done

- [x] 2026-11-10 — Read state survives everything the randomized end-to-end test throws at it: durable queue for all marks (Mark all included), automatic reconnect to a lost database, per-article queue storage, state/content-separated writes so tabs can't overwrite each other, stable cross-device article keys (feed + link + title), visible save warning, Diagnostics panel (spec: #saving-changes, #several-tabs-or-windows, #sync-across-devices)
- [x] 2026-11-10 — Updates: installed app reloads itself onto a new version (it kept running old code), update check on foreground, version shown in Settings, one-time full re-read of cloud states to repair damaged read states (spec: #app-updates, #sync-across-devices)
- [x] 2026-11-09 — Sync timing: every feed list change (incl. removing/fixing failed feeds in Settings) schedules a sync; open app checks every 2 minutes (spec: #sync-across-devices)
- [x] 2026-11-09 — Read state survives refresh: never drop articles a feed still lists, Mark all covers everything loaded before the list (not just the newest visible), stable identity when a feed changes GUIDs, sync flags no longer overwrite unset fields (spec: #local-feeds-default-source, #sync-across-devices)
- [x] 2026-11-09 — Cross-device sync through the Worker (SQLite Durable Object): feed list and read/saved state, offline queue, latest change wins; two-device end-to-end test (spec: #sync-across-devices)
- [x] 2026-11-09 — Hacker News via the public HN Search API fetched directly by the browser (HN refuses Cloudflare's addresses); one-tap switch in the failed list (spec: #hacker-news)
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
