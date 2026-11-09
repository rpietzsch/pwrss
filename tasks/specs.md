# Pwrss specs

The current, authoritative behavior of the app. See AGENTS.md for how to maintain this file.

## Local feeds (default source)

- Pwrss works without any Feedly account. The feed list comes from an **OPML file** (Feedly: `feedly.com/i/opml`), imported in Settings → Feeds.
- OPML folders become categories, in file order; feeds at the top level are "Uncategorized". Duplicate feed URLs are merged.
- Importing again adds new feeds and categories at the end. Feeds already present are left unchanged, so edits made in the app (titles, categories, order) are never overwritten, and their articles and read state are kept.
- Export OPML (Settings and Manage feeds) writes the current state: categories and feeds in their current order, renamed titles, empty categories included, and Uncategorized feeds last. Importing that file again reproduces the same structure.
- Settings can also delete all local data after confirmation.
- Articles, feeds and read/saved state are stored on this device (IndexedDB). There is no sync between devices.
- The proxy's `/feeds` endpoint fetches feeds in batches of up to 25. The app parses RSS 2.0, RSS 1.0 (RDF) and Atom. A feed that can't be fetched or parsed shows up as failed in Settings and never blocks the others.
- The proxy fetches at most 6 feeds at a time per request (the platform's connection limit) and starts each feed's 8-second timeout only when its fetch begins. A feed that answers 429, 502, 503 or 504 is retried once after a short pause. Feed fetches identify as `Pwrss/1.0` (a feed reader), not as a browser.
- A feed larger than 2 MB (long podcast feeds) is cut after the newest complete items that fit, so it still loads with its latest episodes.
- Refresh uses conditional requests (ETag / Last-Modified), so unchanged feeds cost almost nothing.
- Refresh happens on launch when the last refresh is more than 15 minutes old, when returning to the app after more than 15 minutes, and on pull-to-refresh or the refresh button. The refresh button always fetches every feed.
- Failed feeds are listed in Settings → Feeds with their feed URL, the reason (e.g. `HTTP 503`) and, when available, what the server said (the start of its response text, or the content type and start of the page for "Not a valid feed"). The list shows all of them (scrollable). Each has a remove button that deletes that feed at once, without confirmation. **Retry failed** re-fetches only the failed feeds. **Remove all failed** asks for confirmation with the count, then removes them. Removing a feed deletes its unsaved articles; saved ones stay. The sources list and counts update after each removal.
- Progress shows as "Fetching feeds n/N…". The finished refresh reports how many new articles arrived and how many feeds failed.
- An automatic refresh reloads the list only when it is scrolled to the top. Otherwise it shows "N new articles" and leaves the list alone.
- When a feed is fetched for the first time, only articles from the last 7 days are unread. Older ones start as read.
- Article identity is the feed plus the item's GUID (or link). Updated items keep their read and saved state.
- Read, unsaved articles older than 60 days, or beyond the newest 300 of a feed, are pruned. Unread and saved articles are never pruned.
- Previews use the feed's own content. Reader mode is unchanged: it fetches the article page through the proxy and extracts it with Readability.

## Managing feeds

- **Manage feeds** opens from the sources header (local source only) and from Settings → Feeds. It lists categories in order, each with its feeds in order, and Uncategorized last.
- **Add feed**: a URL field with a category choice (Uncategorized by default). The feed is fetched and parsed first. If that fails, nothing is added and the reason is shown. The feed is added at the end of its category. Adding a feed that is already followed is refused.
- **Remove feed** asks for confirmation, then deletes the feed and its unsaved articles. Saved articles stay, with their feed name.
- **Rename feed**: changes the title shown everywhere. It survives refreshes.
- **Move feed to another category**: from the feed's category menu. It lands at the end of that category and keeps its articles and read state.
- **Reorder**: feeds move up/down within their category; categories move up/down among categories. The sources list and OPML export use this order. For local feeds the sources list isn't sorted alphabetically.
- **Categories**: create (empty categories are allowed and are kept), rename (names must be unique), and delete. Deleting a category keeps its feeds and makes them Uncategorized.
- Each change applies immediately, with no extra Save step. The sources list and unread counts update behind the dialog. If the open stream was removed, the list switches to All.

## Accounts and proxy

- Settings has a source: **Local feeds** (default) or **Feedly account**. Feedly needs API access that Feedly now restricts, so it is optional.
- The proxy is needed for local feeds (CORS) and for Reader mode.
- With the Feedly source, the user connects with OAuth sign-in or a developer access token (see below). Tokens are stored only in localStorage.
- All Feedly API calls (`/v3/*`), feed fetches (`/feeds`) and Reader-mode page fetches (`/fetch?url=`) go through the user's proxy worker. With no proxy configured, calls fail with an explanation that points to Settings.
- **Sign in with Feedly (OAuth)** is the regular login. It needs a Feedly-issued client ID and secret, stored as Worker secrets `FEEDLY_CLIENT_ID` and `FEEDLY_CLIENT_SECRET`. The client secret never reaches the browser.
- The Settings "Sign in with Feedly" button asks the Worker for `/auth/config`. If the Worker has no client credentials, the app says sign-in isn't set up and points to the README.
- Sign-in sends the browser to Feedly's authorize page with the app's own URL (origin plus path) as `redirect_uri`, scope `https://cloud.feedly.com/subscriptions` and a random `state` saved locally. That URL must be registered with the Feedly client.
- On return with `?code=…&state=…`, the app verifies `state`, exchanges the code through the Worker (`/auth/token`), saves the access token, refresh token and expiry, and removes the query string. A mismatched `state` or an `error` parameter shows a message and signs nothing in.
- The app refreshes the access token through the Worker (`/auth/refresh`) when it has under 5 minutes left, and once after a 401, then retries the request. If the refresh fails, the user is asked to sign in again.
- The pasted developer token remains as a fallback and is used only when not signed in via OAuth. Signing out clears both.
- The Worker only accepts a `redirect_uri` whose origin is in `ALLOWED_ORIGINS`.
- A 401 from Feedly shows "token expired?" and opens Settings.
- "Try the demo" runs the whole UI against a local fake backend, with no network access to Feedly.
- "Sign out" removes the Feedly token or session, caches and pending changes, and switches to local feeds. Local data is kept.
- The proxy rejects origins that aren't in `ALLOWED_ORIGINS`, a wrong `X-Proxy-Key` (when one is set), non-http(s) URLs and private hosts, and limits a `/feeds` request to 40 feeds, 8 seconds and 2 MB per feed. `/health` is public and reports whether origins are restricted and a key is set.

## Sources

- Sources come from the active backend. Smart streams at the top: All (with its unread count), Today (articles since local midnight) and Saved.
- Categories follow Feedly's order. Each one can collapse (remembered per device) and shows its unread count. Feeds inside are sorted alphabetically.
- With the unread filter on, feeds and categories with no unread articles are hidden, except the one currently selected.
- Subscriptions without a category appear under "Uncategorized".

## Article list

- Each row shows: an unread dot, feed icon (or a letter fallback), feed title, relative time, the title (up to 3 lines), a text snippet (2 lines), and a thumbnail if one exists and thumbnails are enabled.
- The unread/all filter (`U`) is a global setting and reloads the current stream.
- Infinite scroll loads 40 articles at a time.
- Articles marked read stay in the list until the next refresh.
- "Mark all as read" (`Shift+A`) asks for confirmation. It only marks articles up to the newest one loaded, so newer arrivals stay unread.
- Pull-to-refresh, the refresh button and `Shift+R` sync pending changes, then reload sources, counts and the stream.
- The app refreshes automatically when it returns to the foreground after more than 15 minutes.

## Gestures

- Swipe an article row right past 72px to toggle read (default). Swipe left to toggle saved. Settings can swap the two directions.
- Long-press (450ms), or right-click on desktop, opens the quick-preview sheet: title, image, a snippet of up to 700 characters, and Mark read, Save and Open buttons.
- Swiping from the left screen edge (within 24px) goes back on phones and tablets.
- A horizontal flick in the article view moves to the next or previous article. It doesn't trigger when the touch starts on code blocks, tables or embeds.

## Article view

- By default the view shows the feed's content, sanitized. Links open in a new tab. Only allow-listed iframes (YouTube, Vimeo and similar) are kept.
- Reader mode (`R`) fetches the page through the proxy and extracts the article with Readability. If that fails, the view falls back to the feed content and shows a toast.
- Opening an article marks it read when "Mark as read when opened" is on (the default).
- Toolbar actions: back, previous/next (`K`/`J`), read (`M`), save (`S`), reader (`R`), share, and open the original (`V`).

## Theme and appearance

- There are three theme modes: System (default), Light and Dark. Sepia is available in Settings.
- System mode follows `prefers-color-scheme` and updates live when the OS setting changes.
- The theme button in the sources header and the `T` key cycle System → Light → Dark.
- The browser/status-bar color (`theme-color`) matches the active theme.
- The saved theme is applied before the first paint, so there's no flash of the wrong theme.
- Text size runs from 14 to 24px, with a sans or serif article font.
- Toolbar position is a setting: Bottom (default) or Top. It applies to every pane's toolbar (sources, list, article).
- Bottom toolbars sit above the home indicator (safe-area inset), and toasts appear above them.
- Position only takes effect below 1100px width (phone and tablet layouts). Wide desktop windows always keep toolbars on top.
- The saved position is applied before the first paint, so the bars don't jump on launch.

## Offline and sync

- The service worker caches the app shell. Navigations are network-first, and other assets are stale-while-revalidate.
- Read and saved changes apply immediately in the UI, then go into a queue in localStorage. The queue is sent to Feedly in batches about 1 second later, when the app goes online, or when it's hidden.
- Changes that haven't synced yet override the server's state when articles are reloaded.
- The last loaded stream and the sources are cached, so the app paints instantly on launch.
