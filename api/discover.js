// GET /api/discover?url=https://example.com  ->  { feeds: [{ url, title }] }
// 1) If the URL itself is a feed, return it.
// 2) Otherwise read the page's <link rel="alternate"> tags.
// 3) Otherwise try common feed paths.
const TIMEOUT_MS = 8000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*' } });
    if (!r.ok) return null;
    const text = await r.text();
    return { url: r.url || url, text: text.slice(0, 300000) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isFeed(text) {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000));
}

function feedTitle(text) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 80) : '';
}

function linkTags(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    const title = /title=["']([^"']*)["']/i.exec(tag);
    try {
      out.push({ url: new URL(href[1], base).href, title: title ? title[1] : '' });
    } catch {}
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let url = (req.query && req.query.url) || '';
  url = String(url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { res.status(400).json({ error: 'Bad URL' }); return; }

  const page = await get(url);
  if (!page) { res.status(200).json({ feeds: [], error: 'Could not load the page' }); return; }

  if (isFeed(page.text)) {
    res.status(200).json({ feeds: [{ url: page.url, title: feedTitle(page.text) }] });
    return;
  }

  const found = linkTags(page.text, page.url);
  if (found.length) {
    // Deduplicate and keep at most 8
    const seen = new Set();
    const uniq = found.filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true))).slice(0, 8);
    res.status(200).json({ feeds: uniq });
    return;
  }

  const origin = new URL(page.url).origin;
  const guesses = ['/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/all.atom.xml'];
  const tries = await Promise.all(
    guesses.map(async (p) => {
      const r = await get(origin + p);
      return r && isFeed(r.text) ? { url: r.url, title: feedTitle(r.text) } : null;
    })
  );
  const feeds = tries.filter(Boolean);
  const seen = new Set();
  res.status(200).json({ feeds: feeds.filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true))) });
};
