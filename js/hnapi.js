// Hacker News through its public Search API (https://hn.algolia.com/api). Hacker News itself refuses
// requests from Cloudflare's network, so these feeds are fetched by the browser directly (the API sends CORS headers).

export const HN_API = /^https:\/\/hn\.algolia\.com\/api\/v1\/(search|search_by_date)\?/i;
export const HN_HOSTS = /^https?:\/\/(www\.)?(news\.ycombinator\.com|hackernews\.com|hnrss\.org)(\/|$)/i;

export const isHNApi = (url) => HN_API.test(url || '');
export const isHNHost = (url) => HN_HOSTS.test(url || '');

const FRONT_PAGE = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
const NEWEST = 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=30';

/** The API address that replaces a blocked Hacker News feed address. */
export const hnApiReplacement = (url) => (/newest/i.test(url || '') ? NEWEST : FRONT_PAGE);

const item = (id) => `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;

function titleFor(url) {
  if (/tags=front_page/.test(url)) return 'Hacker News: Front Page';
  if (/search_by_date/.test(url)) return 'Hacker News: Newest';
  return 'Hacker News';
}

/** Search API JSON -> the shape parseFeed returns. */
export function parseHNApi(json, url) {
  if (!json || !Array.isArray(json.hits)) throw new Error('Not a valid feed');
  return {
    title: titleFor(url),
    website: 'https://news.ycombinator.com/',
    items: json.hits.filter((h) => h.objectID).map((h) => {
      const id = h.objectID;
      const stats = [h.points != null ? `${h.points} points` : '', h.num_comments != null ? `${h.num_comments} comments` : ''].filter(Boolean).join(' · ');
      const title = h.title || h.story_title || (h.comment_text ? String(h.comment_text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) : '') || '(untitled)';
      return {
        guid: String(id),
        title,
        link: h.url || h.story_url || item(h.story_id || id),
        author: h.author || '',
        published: h.created_at_i ? h.created_at_i * 1000 : null,
        html: h.comment_text || '',
        summary: `<p>${stats ? `${stats} · ` : ''}<a href="${item(id)}">Discussion on Hacker News</a></p>${h.story_text || ''}`,
        image: null,
      };
    }),
  };
}
