# Pwrss

A fast, gesture-driven PWA feed reader, inspired by Reeder. Import your subscriptions from Feedly (or any reader) as an **OPML** file. No Feedly API access needed.

**Live:** https://rpietzsch.github.io/pwrss/ (tap *Try the demo* to look around without an account)

- Three-pane layout on desktop, two panes on tablets, one pane with sliding navigation on phones
- Article list with source, time, thumbnail and a two-line RSS snippet
- **Quick preview**: long-press (or right-click) an article for a peek sheet with a longer snippet
- **Reader mode**: fetches the full page and cleans it up with Mozilla Readability
- **Gestures**: swipe right/left on an article to toggle read/saved (configurable), swipe from the left edge to go back, flick left/right in an article for next/previous, pull down to refresh
- Mark as read on open or on scroll, mark all as read, unread/all filter, Today and Saved views
- Keyboard: `J`/`K` next/prev · `M` read · `S` save · `R` reader · `V` open · `U` filter · `T` theme · `Shift+A` mark all · `Shift+R` refresh · `Space` page down · `Esc` back
- Light and dark mode following your system setting by default; one-tap override (System → Light → Dark), plus sepia, text size and serif/sans
- Toolbars at the bottom of the screen for thumb reach on phones and tablets (switchable to top in Settings)
- Installable; your feeds and articles are stored on the device, so you can read offline
- No build step, no tracking. Your token stays in your browser's localStorage.

## Setup

Pwrss runs entirely in your browser. A small proxy of your own (a free Cloudflare Worker) is needed because browsers
can't fetch feeds or article pages from other sites directly (CORS).

### 1. Deploy the proxy <a id="proxy"></a>

The [Cloudflare Worker](worker/feedly-proxy.js) does four things:

- `POST /feeds` — fetches your RSS/Atom feeds in batches, with ETag/Last-Modified support
- `/fetch?url=…` — downloads article pages for Reader mode
- `/auth/*` and `/v3/*` — only for the optional Feedly account source (OAuth code exchange, API pass-through)
- `/health` — a public check that it's deployed

Deploy it either way:

**Git-connected (works from a phone)** — Cloudflare dashboard → Workers & Pages → Create → connect `rpietzsch/pwrss`.
Worker name `pwrss-proxy`, production branch = the branch you deploy from, **root directory `worker`**, build command
empty, deploy command `npx wrangler deploy`. Every push redeploys it.

**CLI**

```sh
cd worker
npx wrangler deploy
```

Then, in the Worker's own *Settings → Variables and Secrets* (not the Builds page), add a **Secret** named `PROXY_KEY`
with a long random value. `ALLOWED_ORIGINS` (set in `wrangler.toml`) already limits use to
`https://rpietzsch.github.io`; the key stops anyone else from using your Worker. Check it at `https://<your-worker>.workers.dev/health`.

### 2. Export your feeds from Feedly

Open <https://feedly.com/i/opml> in the Feedly web app while logged in (or Organize → *As OPML*) and save the file.
Boards, Read Later items and AI feeds aren't included, and neither is your read history.
Any other reader's OPML export works too.

### 3. Import and read

Open Pwrss → *Import feeds* (or Settings → Feeds → *Import OPML…*), pick the file, then enter your proxy URL and key in
Settings. Pwrss fetches all feeds and keeps articles, read and saved state in this browser (IndexedDB). Then
*Add to Home Screen* (iOS Safari: Share → Add to Home Screen).

Things to know:

- There is no sync between devices; export OPML any time to back up or move your feed list.
- Feeds only offer their latest items, so history starts when you first import.
- Feeds refresh when you open the app (if it's been 15+ minutes), when you return to it, and when you pull down.
- Feeds that fail to load are listed in Settings with the reason.

### Optional: Feedly account as the source

If you do have Feedly API access, set *Source* to **Feedly account** in Settings and either **Sign in with Feedly**
(OAuth, needs a client ID/secret issued by Feedly, stored as Worker **Secrets** `FEEDLY_CLIENT_ID` and
`FEEDLY_CLIENT_SECRET`, redirect URI `https://rpietzsch.github.io/pwrss/`) or paste a developer token from
<https://feedly.com/v3/auth/dev> (may need a paid plan). Feedly has restricted its API, so this may not be available to you.
Don't reuse another app's OAuth credentials.

## Development

Plain HTML/CSS/ES modules — no build step needed to develop. Tasks use [Task](https://taskfile.dev)
(`brew install go-task` or `npm i -g @go-task/cli`):

```sh
task dev            # serve the source tree on http://localhost:8080 — click "Try the demo"
task check          # syntax check, worker unit tests, Playwright end-to-end tests
task build          # build the deployable site into _site/
task preview        # build and serve _site/
task clean          # remove build output
task icons          # regenerate PNG icons from icons/icon.svg
task vendor         # update vendored Readability / DOMPurify / Lucide icons
task worker:deploy  # deploy the Cloudflare proxy (or connect the repo in Cloudflare)
```

Run `task` to list everything. See [AGENTS.md](AGENTS.md) for contributor/agent conventions,
[tasks/backlog.md](tasks/backlog.md) and [tasks/specs.md](tasks/specs.md) for plans and behaviour specs.

`js/demo.js` is a fake backend with the same interface as the Feedly client, used by demo mode.

```
index.html          app shell + icons
styles.css          all styles (themes via CSS variables)
js/app.js           state, rendering, actions, keyboard
js/local.js         local backend: OPML feeds, fetch, storage (IndexedDB)
js/feedparse.js     RSS/Atom/RDF parser
js/opml.js          OPML import/export
js/store.js         IndexedDB wrapper
js/api.js           Feedly API client (optional source)
js/gestures.js      swipe rows, long-press, edge-back, flick, pull-to-refresh
js/reader.js        DOMPurify sanitizing + Readability reader mode
js/demo.js          demo backend
scripts/build.sh    build into _site/ (used by task build and CI)
tests/smoke.cjs     end-to-end tests (demo mode, mocked OAuth)
tests/local.cjs     parser, OPML and local-feeds flow tests (mocked proxy)
tests/worker.cjs    unit tests for the proxy worker
tasks/              backlog.md + specs.md
sw.js               service worker (app-shell cache)
worker/             Cloudflare Worker proxy
vendor/             Readability (Apache-2.0), DOMPurify (Apache-2.0/MPL-2.0), Lucide icon sprite (ISC)
```

## Deployment

`.github/workflows/pages.yml` publishes the site to the `gh-pages` branch on every push to `main`.
In the repository's *Settings → Pages*, set the source to **Deploy from a branch → `gh-pages` / root** once.
