// Parse RSS 2.0, RSS 1.0 (RDF) and Atom into one shape:
//   { title, website, items: [{ guid, title, link, author, published, html, summary, image }] }

const NS = {
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  media: 'http://search.yahoo.com/mrss/',
  atom: 'http://www.w3.org/2005/Atom',
  rss1: 'http://purl.org/rss/1.0/',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
};
const RSS = [null, NS.rss1];
const ATOM = [NS.atom];

const nsOf = (el) => el.namespaceURI || null;
const kids = (el, name, nss) => Array.from(el.children).filter((c) => c.localName === name && nss.includes(nsOf(c)));
const first = (el, name, nss) => kids(el, name, nss)[0] || null;
const txt = (el) => (el ? el.textContent.trim() : '');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function plain(s) {
  s = (s || '').trim();
  if (!/[&<]/.test(s)) return s;
  const d = new DOMParser().parseFromString(s, 'text/html');
  return (d.documentElement.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseDate(str, now) {
  if (!str) return null;
  const t = Date.parse(str.trim());
  if (Number.isNaN(t)) return null;
  return Math.min(t, now + 24 * 3600 * 1000); // clamp far-future dates
}

// Atom text constructs: type="xhtml" holds markup, "text" is escaped, otherwise treat as HTML.
function body(el) {
  if (!el) return '';
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'xhtml') {
    const ser = new XMLSerializer();
    return Array.from(el.childNodes)
      .map((n) => (n.nodeType === 1 ? ser.serializeToString(n).replace(/ xmlns(:\w+)?="[^"]*"/g, '') : n.textContent))
      .join('').trim();
  }
  if (type === 'text') return `<p>${esc(el.textContent.trim())}</p>`;
  return el.textContent.trim();
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
function imageOf(item) {
  const ns = (n, name) => Array.from(item.getElementsByTagNameNS(n, name));
  for (const t of ns(NS.media, 'thumbnail')) if (t.getAttribute('url')) return t.getAttribute('url');
  for (const c of ns(NS.media, 'content')) {
    const url = c.getAttribute('url');
    const medium = c.getAttribute('medium');
    const type = c.getAttribute('type') || '';
    if (url && (medium === 'image' || type.startsWith('image/') || (!medium && !type && IMG_EXT.test(url)))) return url;
  }
  for (const e of kids(item, 'enclosure', RSS)) {
    const url = e.getAttribute('url');
    if (url && ((e.getAttribute('type') || '').startsWith('image/') || IMG_EXT.test(url))) return url;
  }
  for (const l of kids(item, 'link', ATOM)) {
    if (l.getAttribute('rel') === 'enclosure' && (l.getAttribute('type') || '').startsWith('image/')) return l.getAttribute('href');
  }
  const it = item.getElementsByTagNameNS(NS.itunes, 'image')[0];
  return it?.getAttribute('href') || null;
}

function atomLink(el) {
  const links = kids(el, 'link', ATOM);
  const alt = links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate' && l.getAttribute('href'));
  return (alt || links.find((l) => l.getAttribute('href') && l.getAttribute('rel') !== 'self'))?.getAttribute('href') || '';
}

function rssItem(it, now) {
  const link = txt(first(it, 'link', RSS));
  const date = txt(first(it, 'pubDate', RSS)) || txt(it.getElementsByTagNameNS(NS.dc, 'date')[0]) || txt(first(it, 'date', RSS));
  return {
    guid: txt(first(it, 'guid', RSS)) || link || txt(first(it, 'title', RSS)),
    title: plain(txt(first(it, 'title', RSS))),
    link,
    author: plain(txt(it.getElementsByTagNameNS(NS.dc, 'creator')[0]) || txt(first(it, 'author', RSS))),
    published: parseDate(date, now),
    html: txt(it.getElementsByTagNameNS(NS.content, 'encoded')[0]),
    summary: txt(first(it, 'description', RSS)),
    image: imageOf(it),
  };
}

function atomEntry(en, now) {
  const link = atomLink(en);
  const author = first(first(en, 'author', ATOM) || en, 'name', ATOM);
  return {
    guid: txt(first(en, 'id', ATOM)) || link || txt(first(en, 'title', ATOM)),
    title: plain(body(first(en, 'title', ATOM)).replace(/^<p>|<\/p>$/g, '')),
    link,
    author: plain(txt(author)),
    published: parseDate(txt(first(en, 'published', ATOM)) || txt(first(en, 'updated', ATOM)), now),
    html: body(first(en, 'content', ATOM)),
    summary: body(first(en, 'summary', ATOM)),
    image: imageOf(en),
  };
}

function toDoc(xml) {
  const clean = (s) => s.replace(/^﻿?\s+/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  let doc = new DOMParser().parseFromString(clean(xml), 'application/xml');
  if (doc.querySelector('parsererror')) {
    // common breakage: HTML entities such as &nbsp; or bare ampersands
    const fixed = clean(xml).replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
    doc = new DOMParser().parseFromString(fixed, 'application/xml');
  }
  if (doc.querySelector('parsererror')) throw new Error('Not a valid feed');
  return doc;
}

export function parseFeed(xml, now = Date.now()) {
  const root = toDoc(xml).documentElement;
  const name = root.localName;
  if (name === 'feed') {
    return {
      title: plain(txt(first(root, 'title', ATOM))),
      website: atomLink(root),
      items: kids(root, 'entry', ATOM).map((e) => atomEntry(e, now)),
    };
  }
  if (name === 'rss' || name === 'RDF') {
    const channel = first(name === 'rss' ? root : root, 'channel', RSS);
    if (!channel) throw new Error('Not a valid feed');
    const items = name === 'rss' ? kids(channel, 'item', RSS) : kids(root, 'item', RSS);
    return {
      title: plain(txt(first(channel, 'title', RSS))),
      website: txt(first(channel, 'link', RSS)),
      items: items.map((i) => rssItem(i, now)),
    };
  }
  throw new Error('Not an RSS or Atom feed');
}
