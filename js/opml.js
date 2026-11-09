// OPML import/export. Folders become categories (one level: the folder a feed sits in).

const attr = (el, name) => {
  const want = name.toLowerCase();
  for (const a of Array.from(el.attributes)) if (a.name.toLowerCase() === want) return a.value.trim();
  return '';
};

export function parseOPML(xml) {
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName.toLowerCase() !== 'opml') {
    throw new Error('This doesn’t look like an OPML file');
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, category) => {
    for (const o of Array.from(parent.children)) {
      if (o.localName !== 'outline') continue;
      const url = attr(o, 'xmlUrl');
      const label = attr(o, 'text') || attr(o, 'title');
      if (url) {
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, title: attr(o, 'title') || attr(o, 'text'), website: attr(o, 'htmlUrl'), category });
      } else {
        walk(o, label || category);
      }
    }
  };
  const body = Array.from(doc.documentElement.children).find((c) => c.localName === 'body');
  if (body) walk(body, null);
  return out;
}

const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// feeds: [{ url, title, website, category }]
export function buildOPML(feeds, title = 'Pwrss feeds') {
  const line = (f, pad) => `${pad}<outline type="rss" text="${x(f.title || f.url)}" title="${x(f.title || f.url)}" xmlUrl="${x(f.url)}"${f.website ? ` htmlUrl="${x(f.website)}"` : ''}/>`;
  const byCat = new Map();
  for (const f of feeds) {
    const k = f.category || '';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(f);
  }
  const lines = [];
  for (const [cat, list] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!cat) continue;
    lines.push(`    <outline text="${x(cat)}" title="${x(cat)}">`, ...list.map((f) => line(f, '      ')), '    </outline>');
  }
  for (const f of byCat.get('') || []) lines.push(line(f, '    '));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${x(title)}</title></head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`;
}
