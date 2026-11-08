# Pwrss specs

The current, authoritative behavior of the app. See AGENTS.md for how to maintain this file.

## Accounts and proxy

- The user connects with a Feedly developer access token, entered in Settings and stored only in localStorage.
- All Feedly API calls (`/v3/*`) and Reader-mode page fetches (`/fetch?url=`) go through the user's proxy worker. With no proxy configured, calls fail with an explanation that points to Settings.
- A 401 from Feedly shows "token expired?" and opens Settings.
- "Try the demo" runs the whole UI against a local fake backend, with no network access to Feedly.
- "Sign out" removes the token, caches and pending changes.
- The proxy rejects origins that aren't in `ALLOWED_ORIGINS`, a wrong `X-Proxy-Key` (when one is set), non-http(s) URLs and private hosts.

## Sources

- Smart streams at the top: All (with its unread count), Today (articles since local midnight) and Saved.
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

## Offline and sync

- The service worker caches the app shell. Navigations are network-first, and other assets are stale-while-revalidate.
- Read and saved changes apply immediately in the UI, then go into a queue in localStorage. The queue is sent to Feedly in batches about 1 second later, when the app goes online, or when it's hidden.
- Changes that haven't synced yet override the server's state when articles are reloaded.
- The last loaded stream and the sources are cached, so the app paints instantly on launch.
