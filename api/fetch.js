// POST /api/fetch  { sources: [{ id, url }] }  ->  { results: [{ id, ok, error, items }] }
// Fetches up to 15 feeds in parallel, parses RSS 2.0 / Atom / RDF, returns compact items.
const { XMLParser } = require('fast-xml-parser');

const MAX_SOURCES = 15;
const MAX_ITEMS = 60;
const TIMEOUT_MS = 9000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  processEntities: false,   // large feeds (Google News, Guardian) exceed the parser's entity limit
  htmlEntities: false,
});

const NAMED = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', ndash:'–', mdash:'—', hellip:'…', rsquo:'’', lsquo:'‘', rdquo:'”', ldquo:'“', copy:'©', reg:'®', trade:'™', euro:'€', pound:'£', shy:'' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') {
    if (v['#text'] != null) return String(v['#text']);
    if (v['@_href']) return String(v['@_href']);
    return '';
  }
  return String(v);
}

function stripHtml(s) {
  // entities are decoded twice on purpose: feeds often double-escape HTML inside descriptions
  return decode(decode(String(s || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function firstImg(html) {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(decode(String(html || '')));
  return m ? m[1] : '';
}

function atomLink(link) {
  if (!link) return '';
  const arr = Array.isArray(link) ? link : [link];
  const alt = arr.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  if (alt) return alt['@_href'] || '';
  return txt(arr[0]);
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? null : t;
}

function mediaUrl(item) {
  const cands = [item['media:content'], item['media:thumbnail'], item['enclosure'], item['image']];
  for (const c of cands) {
    if (!c) continue;
    const arr = Array.isArray(c) ? c : [c];
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const type = e['@_type'] || '';
      const url = e['@_url'] || e['@_href'] || txt(e.url);
      if (url && (!type || /image/i.test(type) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) return url;
    }
  }
  if (item['media:group'] && item['media:group']['media:content']) return mediaUrl(item['media:group']);
  return '';
}

function normalizeItems(xmlObj, isGoogleNews) {
  let raw = [];
  if (xmlObj.rss && xmlObj.rss.channel) {
    raw = xmlObj.rss.channel.item || [];
  } else if (xmlObj.feed) {
    raw = xmlObj.feed.entry || [];
  } else if (xmlObj['rdf:RDF']) {
    raw = xmlObj['rdf:RDF'].item || [];
  } else {
    throw new Error('Not a recognised RSS/Atom feed');
  }
  if (!Array.isArray(raw)) raw = [raw];

  const out = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    let title = stripHtml(txt(it.title));
    let link = it.link ? decode(atomLink(it.link)) : '';
    if (!link && it.guid && /^https?:/i.test(txt(it.guid))) link = txt(it.guid);
    if (!link && it.id && /^https?:/i.test(txt(it.id))) link = txt(it.id);
    link = String(link || '').trim();
    if (!title || !link) continue;

    const date =
      parseDate(txt(it.pubDate)) ||
      parseDate(txt(it.published)) ||
      parseDate(txt(it.updated)) ||
      parseDate(txt(it['dc:date'])) ||
      null;

    const rawDesc = txt(it.description) || txt(it.summary) || txt(it['content:encoded']) || txt(it.content) || '';
    const desc = stripHtml(rawDesc).slice(0, 220);
    const img = mediaUrl(it) || firstImg(rawDesc);

    let sname = '';
    if (isGoogleNews) {
      sname = stripHtml(txt(it.source));
      const m = / - ([^-]{2,60})$/.exec(title);
      if (m) {
        if (!sname) sname = m[1].trim();
        title = title.slice(0, m.index).trim();
      }
    }

    out.push({ t: title, l: link, d: date, desc, img, sn: sname || undefined });
  }
  return out;
}

async function fetchOne(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(src.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!r.ok) return { id: src.id, ok: false, error: 'HTTP ' + r.status };
    const body = await r.text();
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 4000))) {
      return { id: src.id, ok: false, error: 'Response is not an RSS/Atom feed' };
    }
    const obj = parser.parse(body);
    const isGN = /news\.google\.com/i.test(src.url);
    const items = normalizeItems(obj, isGN);
    return { id: src.id, ok: true, items };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'Timeout' : (e && e.message) || 'Fetch failed';
    return { id: src.id, ok: false, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const sources = (body && Array.isArray(body.sources) ? body.sources : []).filter(
    (s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)
  );
  if (!sources.length) {
    res.status(400).json({ error: 'No sources' });
    return;
  }
  const batch = sources.slice(0, MAX_SOURCES).map((s) => ({ id: String(s.id || s.url), url: s.url }));
  const results = await Promise.all(batch.map(fetchOne));
  res.status(200).json({ results, at: Date.now() });
};
