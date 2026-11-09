# Pwrss

A fast, gesture-driven PWA reader for your **Feedly** account, inspired by Reeder.

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
- Installable, works offline from cache; read/save changes are queued and synced when back online
- No build step, no tracking. Your token stays in your browser's localStorage.

## Setup

### 1. Get Feedly API access

Feedly has restricted its API, so what works depends on your account. Pwrss supports two ways in:

**A. Sign in with Feedly (OAuth, recommended)** — the regular login: tap *Sign in with Feedly* in Settings, log in on
Feedly, and you're back in the app. Sessions refresh automatically, so there's no 30-day token to replace.
It needs an OAuth **client ID and secret issued by Feedly** for your own app; Feedly now approves these on request.

1. Request API access/an OAuth client from Feedly (see <https://developers.feedly.com/>). Ask for the redirect URI
   `https://rpietzsch.github.io/pwrss/` (it must match exactly, including the trailing slash).
2. In the Cloudflare Worker → Settings → Variables and Secrets, add two **Secrets**: `FEEDLY_CLIENT_ID` and
   `FEEDLY_CLIENT_SECRET`. The secret stays in the Worker; the browser never sees it.
3. In Pwrss → Settings, enter the proxy URL (and key), then tap **Sign in with Feedly**.

**B. Access token (fallback)** — if your account can create one at <https://feedly.com/v3/auth/dev> (it may need a
paid plan), paste it under *Use an access token instead*. It expires after about 30 days.

> Don't reuse another app's OAuth credentials. They're tied to that app and its redirect address, and using them
> breaks Feedly's terms.

### 2. Deploy the proxy <a id="proxy"></a>

Feedly's API does not send CORS headers, so a web app can't call it from the browser directly.
Pwrss uses a tiny [Cloudflare Worker](worker/feedly-proxy.js) (the free plan is plenty) that:

- forwards `/v3/*` to `https://api.feedly.com/v3/*` and adds CORS headers
- handles the OAuth code exchange and refresh (`/auth/*`), so the client secret never reaches the browser
- serves `/fetch?url=…` so Reader mode can download article pages

Deploy it either way:

**Dashboard** — Cloudflare dashboard → Workers & Pages → Create → *Hello World* worker → *Edit code*, paste
[`worker/feedly-proxy.js`](worker/feedly-proxy.js), deploy. Then under *Settings → Variables* add
`ALLOWED_ORIGINS = https://rpietzsch.github.io` and optionally a secret `PROXY_KEY`.

**CLI**

```sh
cd worker
npx wrangler deploy
npx wrangler secret put PROXY_KEY   # optional
```

**Git-connected (no pasting, works from a phone)** — Worker → Settings → Builds → connect `rpietzsch/pwrss`,
production branch = the branch you deploy from, **root directory `worker`**, build command empty,
deploy command `npx wrangler deploy`. Every push then redeploys the worker. Add `PROXY_KEY` as a secret under the
Worker's own Settings → Variables and Secrets (not the Builds page).

Your token passes through the worker on its way to Feedly; it is never stored there. Because you deploy it to
your own Cloudflare account, nobody else sees it. `ALLOWED_ORIGINS` and `PROXY_KEY` keep others from using your
worker as an open proxy.

### 3. Connect

Open Pwrss → Settings, enter the worker URL (e.g. `https://pwrss-proxy.<you>.workers.dev`) and the
proxy key if you set one, then sign in (or paste a token). Then *Add to Home Screen* (iOS Safari: Share → Add to Home Screen).

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
task vendor         # update vendored Readability / DOMPurify
task worker:deploy  # deploy the Cloudflare proxy
```

Run `task` to list everything. See [AGENTS.md](AGENTS.md) for contributor/agent conventions,
[tasks/backlog.md](tasks/backlog.md) and [tasks/specs.md](tasks/specs.md) for plans and behaviour specs.

`js/demo.js` is a fake backend with the same interface as the Feedly client, used by demo mode.

```
index.html          app shell + icons
styles.css          all styles (themes via CSS variables)
js/app.js           state, rendering, actions, keyboard
js/api.js           Feedly API client
js/gestures.js      swipe rows, long-press, edge-back, flick, pull-to-refresh
js/reader.js        DOMPurify sanitizing + Readability reader mode
js/demo.js          demo backend
scripts/build.sh    build into _site/ (used by task build and CI)
tests/smoke.cjs     end-to-end tests (demo mode, mocked OAuth)
tests/worker.cjs    unit tests for the proxy worker
tasks/              backlog.md + specs.md
sw.js               service worker (app-shell cache)
worker/             Cloudflare Worker proxy
vendor/             Readability 0.6.0 (Apache-2.0), DOMPurify 3.4 (Apache-2.0/MPL-2.0)
```

## Deployment

`.github/workflows/pages.yml` publishes the site to the `gh-pages` branch on every push to `main`.
In the repository's *Settings → Pages*, set the source to **Deploy from a branch → `gh-pages` / root** once.
