# AGENTS.md

Guidance for AI coding agents (and humans) working on Pwrss, a static PWA feed reader (local OPML feeds by default, optional Feedly source).

## Project basics

- Plain HTML/CSS/ES modules, no bundler, no framework. Don't add a build step or npm dependencies to the app.
- Third-party code lives in `vendor/` and is updated with `task vendor`. Don't edit vendored files by hand.
- Use `task` targets for the lifecycle: `task dev`, `task check`, `task build`, `task preview`, `task clean`.
- Run `task check` before committing. When you add a user-facing feature, add a check for it to `tests/smoke.cjs` that runs in demo mode.
- Backends (`js/local.js`, `js/api.js` for Feedly, `js/demo.js`) share one interface. Keep them in step: the demo backend must implement every method the app calls. `refreshAll` exists only on the local backend and is feature-checked.
- Browsers can't fetch feeds, article pages or Feedly directly (CORS), so every network call goes through the proxy in `worker/`. Never send the user's token anywhere else.
- Sync lives in `worker/sync-store.mjs` (Durable Object, SQLite) and `js/sync.js`. Any new local state that should follow the user across devices must go through that protocol (spec: `tasks/specs.md#sync-across-devices`). Personal data is never served without `PROXY_KEY`.
- Sanitize all feed and page HTML with `sanitize()` in `js/reader.js` before inserting it into the DOM.
- Icons come from **Lucide** (vendored sprite `vendor/lucide-sprite.svg`). Never hand-draw SVG icons. To add one, add it to the map in `scripts/lucide-sprite.cjs` and run `task vendor` (or the script directly), then use `#i-<id>`.
- Theming uses the CSS variables in `styles.css`. Every color needs a light and a dark value, and `auto` (system) is the default.

## Task tracking: `tasks/`

Keep two Markdown files in `tasks/`. Create them if they're missing.

### `tasks/backlog.md`: what to do

- Sections, in this order: `## In progress`, `## Next`, `## Later`, `## Done`.
- One item per line as a checkbox: `- [ ] Short imperative title — one-line context (spec: #anchor)`.
- At the start of a task, add it or move it to *In progress*. When it's finished, tick it and move it to the top of *Done*, with the date (`YYYY-MM-DD`).
- Write down bugs, ideas and follow-ups you notice but don't fix as items under *Next* or *Later*. Don't drop them silently.
- Keep *Done* to about the last 30 items. Delete older ones (git history keeps them).

### `tasks/specs.md`: how it should behave

- The current, authoritative description of user-visible behavior: features, gestures, keyboard shortcuts, settings, API usage and edge cases.
- One `##` section per feature area, with a stable anchor-friendly heading. Write each behavior as a short, testable statement.
- Update the spec in the same change that alters behavior. When code and spec disagree, either fix the code or update the spec and say so in the commit.
- Write a spec section before implementing anything non-trivial, and link to it from the backlog item.
- Describe behavior, not implementation. Leave out code and file walkthroughs.
