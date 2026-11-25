// Offline demo backend with the same interface as Feedly, so the UI can be
// tried (and tested) without an account or proxy.

const UID = 'demo';
const cat = (label) => ({ id: `user/${UID}/category/${label}`, label });
const CATS = [cat('Tech'), cat('Design'), cat('Science'), cat('Blogs')];

const FEEDS = [
  ['Byte Ledger', 'byteledger.example', 0],
  ['Kernel Notes', 'kernelnotes.example', 0],
  ['The Stack Weekly', 'stackweekly.example', 0],
  ['Grid & Glyph', 'gridandglyph.example', 1],
  ['Pixel Margins', 'pixelmargins.example', 1],
  ['Orbit Daily', 'orbitdaily.example', 2],
  ['Field Lab', 'fieldlab.example', 2],
  ['Slow Coffee', 'slowcoffee.example', 3],
  ['Long Walks', 'longwalks.example', 3],
].map(([title, host, c]) => ({
  id: `feed/https://${host}/rss`,
  title,
  website: `https://${host}`,
  categories: [CATS[c]],
  iconUrl: null,
}));

const TOPICS = [
  ['Why small tools win', 'A look at software that does one thing well, and why teams keep coming back to it.'],
  ['Notes on offline-first apps', 'Service workers, background sync and the art of pretending the network is optional.'],
  ['The quiet return of RSS', 'Feeds never went away. They just stopped asking for attention.'],
  ['Type scales that breathe', 'How to pick a modular scale that works from phone to desktop without media-query soup.'],
  ['Measuring what matters', 'Dashboards are easy. Knowing which numbers to ignore is hard.'],
  ['A field guide to color contrast', 'Practical tips for accessible palettes in light and dark modes.'],
  ['Telescopes on a budget', 'You do not need a mortgage to see the rings of Saturn.'],
  ['The physics of a good espresso', 'Pressure, temperature and grind size, explained without the snobbery.'],
  ['Writing for the scroll', 'Short paragraphs, honest headlines, and other ways to respect a reader’s time.'],
  ['Gestures that feel native', 'Thresholds, velocity and haptics: tuning swipe interactions on the web.'],
  ['What the soil remembers', 'Researchers find decades of farming history recorded in microbial communities.'],
  ['Learning to walk slower', 'An essay on noticing things at three kilometres per hour.'],
  ['Shipping on Fridays', 'It is fine if your pipeline is boring enough.'],
  ['A kinder code review', 'Comments that teach instead of score points.'],
  ['Mapping the night sky with phones', 'Citizen science projects are turning pocket cameras into observatories.'],
];

function para(t) {
  return `<p>${t} Lorem ipsum is not used here; instead this demo paragraph exists to show how longer article bodies look in Pwrss, with comfortable line length and spacing.</p>`;
}

const now = Date.now();
let ENTRIES = [];
let n = 0;
for (let i = 0; i < 60; i++) {
  const feed = FEEDS[i % FEEDS.length];
  const [title, summary] = TOPICS[(i * 7) % TOPICS.length];
  const t = now - i * 47 * 60 * 1000 - (i % 5) * 600000;
  const id = `demo-entry-${n++}`;
  const hasImg = i % 3 === 0;
  ENTRIES.push({
    id,
    title: i < TOPICS.length ? title : `${title} (part ${Math.floor(i / TOPICS.length) + 1})`,
    author: ['Ada', 'Lin', 'Sam', 'Noor', 'Jo'][i % 5],
    published: t,
    crawled: t,
    origin: { streamId: feed.id, title: feed.title, htmlUrl: feed.website },
    alternate: [{ href: `${feed.website}/posts/${id}`, type: 'text/html' }],
    summary: {
      content: `<p>${summary}</p>${para('In this piece we dig into the details.')}${para('There is more in the full article.')}`,
    },
    visual: hasImg ? { url: `https://picsum.photos/seed/pwrss${i}/800/450` } : undefined,
    unread: i > 8 ? i % 4 !== 0 : true,
    tags: i % 11 === 2 ? [{ id: `user/${UID}/tag/global.saved` }] : [],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isSaved = (e) => e.tags?.some((t) => t.id.endsWith('global.saved'));

export class DemoFeedly {
  constructor() { this.userId = UID; this.demo = true; }
  allId() { return `user/${UID}/category/global.all`; }
  savedId() { return `user/${UID}/tag/global.saved`; }
  async profile() { await sleep(80); return { id: UID, fullName: 'Demo' }; }
  async categories() { return CATS; }
  async subscriptions() { return FEEDS; }

  async counts() {
    const map = new Map();
    const add = (id) => map.set(id, (map.get(id) || 0) + 1);
    for (const e of ENTRIES) {
      if (!e.unread) continue;
      add(this.allId());
      add(e.origin.streamId);
      const f = FEEDS.find((x) => x.id === e.origin.streamId);
      f.categories.forEach((c) => add(c.id));
    }
    return [...map].map(([id, count]) => ({ id, count, updated: now }));
  }

  match(streamId, e) {
    if (streamId === this.allId()) return true;
    if (streamId === this.savedId()) return isSaved(e);
    if (streamId.startsWith('feed/')) return e.origin.streamId === streamId;
    const f = FEEDS.find((x) => x.id === e.origin.streamId);
    return f.categories.some((c) => c.id === streamId);
  }

  async stream(streamId, { count = 40, unreadOnly, continuation, ranked = 'newest', newerThan } = {}) {
    await sleep(250);
    let list = ENTRIES.filter((e) => this.match(streamId, e) && (!unreadOnly || e.unread) && (!newerThan || e.crawled > newerThan));
    if (ranked === 'oldest') list = list.slice().reverse();
    const start = continuation ? Number(continuation) : 0;
    const items = list.slice(start, start + count).map((e) => ({ ...e }));
    return { id: streamId, items, continuation: start + count < list.length ? String(start + count) : undefined };
  }

  async markers(action, ids) {
    await sleep(60);
    for (const e of ENTRIES) {
      if (!ids.includes(e.id)) continue;
      if (action === 'markAsRead') e.unread = false;
      if (action === 'keepUnread') e.unread = true;
      if (action === 'markAsSaved' && !isSaved(e)) e.tags = [...(e.tags || []), { id: this.savedId() }];
      if (action === 'markAsUnsaved') e.tags = (e.tags || []).filter((t) => !t.id.endsWith('global.saved'));
    }
  }

  async markStreamRead(streamId, asOf) {
    for (const e of ENTRIES) if (this.match(streamId, e) && e.crawled <= asOf) e.unread = false;
  }

  async fetchPage(url) {
    await sleep(400);
    const e = ENTRIES.find((x) => x.alternate[0].href === url) || ENTRIES[0];
    const img = e.visual ? `<figure><img src="${e.visual.url}" alt=""><figcaption>Demo image</figcaption></figure>` : '';
    const html = `<!doctype html><html><head><title>${e.title}</title></head><body>
      <nav>Home · About · Archive · Subscribe</nav>
      <aside class="sidebar">Popular posts · Newsletter signup · Ads</aside>
      <article><h1>${e.title}</h1><p class="byline">By ${e.author}</p>${img}
      ${e.summary.content}
      <h2>The longer version</h2>
      ${para('This is the full page fetched for Reader mode.')}${para('Readability strips navigation, sidebars and ads.')}
      <blockquote>Good tools get out of the way.</blockquote>
      ${para('That is what Reader mode does for the web.')}
      <pre><code>const reader = new Readability(doc).parse();</code></pre>
      ${para('And that is the end of the demo article.')}
      </article><footer>© Demo site · Privacy · Cookies</footer></body></html>`;
    return { html, url };
  }
}
