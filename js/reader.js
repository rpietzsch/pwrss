// HTML sanitizing (DOMPurify) and full-page Reader mode (Mozilla Readability).

let baseUrl = null;
let hooked = false;

const IFRAME_OK = /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|w\.soundcloud\.com|bandcamp\.com|codepen\.io)\//i;

function abs(u) {
  if (!u) return u;
  try { return new URL(u, baseUrl || undefined).href; } catch { return u; }
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  const P = window.DOMPurify;
  P.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'iframe') {
      const src = abs(node.getAttribute('src') || '');
      if (!IFRAME_OK.test(src)) node.remove();
    }
  });
  P.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName;
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && !href.startsWith('#')) {
        node.setAttribute('href', abs(href));
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'IMG') {
      if (!node.getAttribute('src')) {
        const lazy = node.getAttribute('data-src') || node.getAttribute('data-lazy-src') || node.getAttribute('data-original');
        if (lazy) node.setAttribute('src', lazy);
      }
      node.setAttribute('src', abs(node.getAttribute('src')));
      const w = node.getAttribute('width');
      const h = node.getAttribute('height');
      if (w === '1' || h === '1') { node.remove(); return; } // tracking pixels
      const srcset = node.getAttribute('srcset');
      if (srcset && !/https?:\/\//.test(srcset)) node.removeAttribute('srcset');
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
      node.setAttribute('referrerpolicy', 'no-referrer');
    } else if (tag === 'IFRAME') {
      node.setAttribute('src', abs(node.getAttribute('src')));
      node.setAttribute('loading', 'lazy');
      node.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
      node.setAttribute('allowfullscreen', '');
    } else if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') {
      if (node.getAttribute('src')) node.setAttribute('src', abs(node.getAttribute('src')));
      if (tag !== 'SOURCE') node.setAttribute('controls', '');
      node.removeAttribute('autoplay');
    }
  });
}

export function sanitize(html, base) {
  if (!window.DOMPurify) return '';
  installHooks();
  baseUrl = base || null;
  return window.DOMPurify.sanitize(html || '', {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allowfullscreen', 'target', 'loading'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta'],
    FORBID_ATTR: ['style', 'class', 'id', 'align', 'bgcolor', 'color', 'face'],
  });
}

let readabilityLoad;
function loadReadability() {
  if (window.Readability) return Promise.resolve();
  readabilityLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/Readability.js', import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => { readabilityLoad = null; reject(new Error('Could not load Readability')); };
    document.head.append(s);
  });
  return readabilityLoad;
}

const cache = new Map();

export async function readerView(api, url) {
  if (cache.has(url)) return cache.get(url);
  const [{ html, url: finalUrl }] = await Promise.all([api.fetchPage(url), loadReadability()]);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.querySelector('base[href]')) {
    const b = doc.createElement('base');
    b.href = finalUrl;
    doc.head.prepend(b);
  }
  const art = new window.Readability(doc, { charThreshold: 300 }).parse();
  if (!art || !art.content) throw new Error('Reader mode could not find the article on this page');
  const out = {
    title: art.title,
    byline: art.byline,
    siteName: art.siteName,
    length: art.length,
    html: sanitize(art.content, finalUrl),
  };
  cache.set(url, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}
