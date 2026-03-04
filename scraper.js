import { fetchJson, fetchHtml } from './fetch.js';
import * as cheerio from 'cheerio';

// ── In-memory cache ───────────────────────────────────────────────────────
const cache = new Map();
function cacheGet(k) {
    const e = cache.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { cache.delete(k); return null; }
    return e.val;
}
function cacheSet(k, val, ttlMs) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(k, { val, exp: Date.now() + ttlMs });
}

const SEARCH_TTL  = 10 * 60 * 1000;
const DEVICE_TTL  = 60 * 60 * 1000;

// ── Build ID ──────────────────────────────────────────────────────────────
let _buildId = null, _buildIdExp = 0;

async function getBuildId() {
    if (_buildId && Date.now() < _buildIdExp) return _buildId;
    const cached = cacheGet('__buildId');
    if (cached) { _buildId = cached; _buildIdExp = Date.now() + 2*60*60*1000; return _buildId; }
    try {
        const html = await fetchHtml('https://nanoreview.net/en/');
        const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
        if (m) {
            _buildId = m[1];
            _buildIdExp = Date.now() + 2*60*60*1000;
            cacheSet('__buildId', _buildId, 2*60*60*1000);
            console.log('[scraper] buildId:', _buildId);
        }
    } catch(e) { console.warn('[scraper] buildId failed:', e.message); }
    return _buildId;
}

// ── Type detection ────────────────────────────────────────────────────────
function detectTypes(q) {
    q = q.toLowerCase();
    if (/ryzen|intel\s*core|threadripper|xeon|celeron|pentium|core\s*i[3579]|amd/i.test(q)) return ['cpu','laptop','soc','phone','tablet','gpu'];
    if (/snapdragon|mediatek|dimensity|exynos|a\d{2}\s*bionic|helio|kirin/i.test(q))        return ['soc','phone','tablet','laptop','cpu','gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|quadro|arc\s*a\d/i.test(q))                  return ['gpu','laptop','cpu','phone','tablet','soc'];
    if (/iphone|galaxy|pixel\s*\d|oneplus|xiaomi|oppo|vivo|realme|redmi|poco|motorola|nokia|sony|samsung|huawei|nothing/i.test(q)) return ['phone','soc','tablet','laptop','cpu','gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s\d/i.test(q))                                     return ['tablet','phone','soc','laptop','cpu','gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|chromebook|ideapad|pavilion|inspiron/i.test(q)) return ['laptop','cpu','gpu','tablet','phone','soc'];
    return ['phone','tablet','laptop','soc','cpu','gpu'];
}

// ── Search ────────────────────────────────────────────────────────────────
export async function searchDevices(query, limit = 10) {
    const key = `search:${query.toLowerCase()}:${limit}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const types = detectTypes(query);

    // Fire all type searches in parallel
    const results = await Promise.all(types.map(async type => {
        try {
            const data = await fetchJson(
                `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`
            );
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    }));

    const seen = new Set();
    const flat = results.flat().filter(r => {
        const k = r.slug || r.url_name || r.name;
        if (!k || seen.has(k)) return false;
        seen.add(k); return true;
    }).sort((a, b) => score(b, query) - score(a, query));

    if (flat.length) cacheSet(key, flat, SEARCH_TTL);
    return flat;
}

function score(r, query) {
    const n = (r.name || '').toLowerCase();
    const s = (r.slug || r.url_name || '').toLowerCase();
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    if (s === qs || s === q) return 1000;
    if (n === q)              return 950;
    if (s.startsWith(qs))     return 850;
    if (n.startsWith(q))      return 800;
    if (s.includes(qs))       return 700;
    if (n.includes(q))        return 650;
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return 0;
    return (words.filter(w => n.includes(w) || s.includes(w)).length / words.length) * 400;
}

export function pickBest(results, query) {
    if (!results?.length) return null;
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    return results.find(r => getSlug(r) === qs)
        || results.find(r => (r.name||'').toLowerCase() === q)
        || results.find(r => getSlug(r).startsWith(qs))
        || results.find(r => (r.name||'').toLowerCase().includes(q))
        || results[0];
}

export function getSlug(r) {
    return r.slug || r.url_name || (r.name||'').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
}

// ── Device data ───────────────────────────────────────────────────────────
const DEVICE_KEYS = ['device','phone','laptop','cpu','gpu','soc','tablet','item','data','pageData'];

function extractDevice(props) {
    if (!props) return null;
    for (const k of DEVICE_KEYS) { if (props[k]?.name) return props[k]; }
    for (const v of Object.values(props)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && v.name && (v.specs || v.params)) return v;
    }
    return null;
}

function normalize(d, sourceUrl) {
    const specs = {};
    if (Array.isArray(d.specs)) {
        for (const g of d.specs) {
            if (g.title && Array.isArray(g.items)) {
                const sec = {};
                for (const i of g.items) { if (i.name && i.value != null) sec[i.name] = String(i.value); }
                if (Object.keys(sec).length) specs[g.title] = sec;
            } else if (g.name && g.value != null) {
                (specs['Specs'] = specs['Specs'] || {})[g.name] = String(g.value);
            }
        }
    } else if (d.specs && typeof d.specs === 'object') Object.assign(specs, d.specs);

    if (Array.isArray(d.params)) {
        for (const g of d.params) {
            if (g.name && Array.isArray(g.params)) {
                const sec = {};
                for (const p of g.params) { if (p.name && p.value != null) sec[p.name] = String(p.value); }
                if (Object.keys(sec).length) specs[g.name] = sec;
            }
        }
    } else if (d.params && typeof d.params === 'object') Object.assign(specs, d.params);

    const scores = {};
    if (Array.isArray(d.scores)) { for (const s of d.scores) { if (s.name && s.value != null) scores[s.name] = String(s.value); } }
    else if (d.scores && typeof d.scores === 'object') Object.assign(scores, d.scores);
    for (const k of ['total_score','score','rating','nanoreview_score']) { if (d[k] != null) scores[k] = String(d[k]); }

    const toStr = x => typeof x === 'string' ? x : (x?.text || x?.name || '');
    return {
        title: d.name || d.title || '',
        sourceUrl,
        images: [...new Set([d.image, d.image_url, ...(d.images||[])].filter(Boolean))],
        scores,
        pros: [...new Set([...(d.pros||[]),...(d.advantages||[])].map(toStr).filter(Boolean))],
        cons: [...new Set([...(d.cons||[]),...(d.disadvantages||[])].map(toStr).filter(Boolean))],
        specs,
        _source: 'next_data',
    };
}

export async function fetchDevice(contentType, slug, sourceUrl) {
    const key = `device:${contentType}:${slug}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    // Strategy 1: /_next/data/ JSON — pure JSON, fastest
    const buildId = await getBuildId();
    if (buildId) {
        try {
            const json = await fetchJson(
                `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`
            );
            const d = extractDevice(json?.pageProps);
            if (d?.name) {
                const result = normalize(d, sourceUrl);
                cacheSet(key, result, DEVICE_TTL);
                console.log(`[scraper] /_next/data hit: ${slug}`);
                return result;
            }
        } catch(e) {
            if (/404/.test(e.message)) { _buildId = null; } // stale buildId
            else console.warn(`[scraper] next/data failed for ${slug}:`, e.message);
        }
    }

    // Strategy 2: Full page HTML + __NEXT_DATA__
    try {
        const html = await fetchHtml(sourceUrl);
        const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
        if (m) {
            const d = extractDevice(JSON.parse(m[1])?.props?.pageProps);
            if (d?.name) {
                const result = normalize(d, sourceUrl);
                cacheSet(key, result, DEVICE_TTL);
                console.log(`[scraper] __NEXT_DATA__ hit: ${slug}`);
                return result;
            }
        }
    } catch(e) { console.warn(`[scraper] HTML fetch failed for ${slug}:`, e.message); }

    return null;
}

export async function fetchCompare(compareUrl) {
    const cached = cacheGet(`compare:${compareUrl}`);
    if (cached) return cached;
    const html = await fetchHtml(compareUrl);
    const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    if (m) {
        try {
            const props = JSON.parse(m[1])?.props?.pageProps;
            const comp = props?.comparison || props?.data;
            if (comp) {
                const result = {
                    title: comp.title || '', sourceUrl: compareUrl,
                    device1: { name: comp.device1?.name || comp.phones?.[0]?.name || '' },
                    device2: { name: comp.device2?.name || comp.phones?.[1]?.name || '' },
                    comparisons: comp.comparisons || comp.specs || {},
                };
                cacheSet(`compare:${compareUrl}`, result, DEVICE_TTL);
                return result;
            }
        } catch {}
    }
    // cheerio fallback
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: compareUrl, device1: { name: '' }, device2: { name: '' }, comparisons: {} };
    const headers = [];
    $('th').each((_, el) => { const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t); });
    if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
    $('table tr').each((_, row) => {
        const cells = $(row).find('td,th');
        if (cells.length >= 3) {
            const f = cells.eq(0).text().trim();
            if (f) (data.comparisons['Specs'] = data.comparisons['Specs'] || {})[f] = {
                [data.device1.name||'Device 1']: cells.eq(1).text().trim(),
                [data.device2.name||'Device 2']: cells.eq(2).text().trim(),
            };
        }
    });
    cacheSet(`compare:${compareUrl}`, data, DEVICE_TTL);
    return data;
}

export async function fetchRankings(rankingUrl) {
    const cached = cacheGet(`ranking:${rankingUrl}`);
    if (cached) return cached;
    const html = await fetchHtml(rankingUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };
    const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    if (m) {
        try {
            const props = JSON.parse(m[1])?.props?.pageProps;
            const items = props?.items || props?.devices || props?.list;
            if (Array.isArray(items) && items.length) {
                data.rankings = items.map((item, i) => ({
                    rank: i+1, name: item.name||item.title,
                    score: item.score||item.total_score||item.rating,
                    slug: item.slug||item.url_name,
                    url: `https://nanoreview.net/en/${item.content_type||'soc'}/${item.slug||item.url_name}`,
                }));
                cacheSet(`ranking:${rankingUrl}`, data, DEVICE_TTL);
                return data;
            }
        } catch {}
    }
    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            item[headers[i]||`col_${i}`] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length) data.rankings.push(item);
    });
    cacheSet(`ranking:${rankingUrl}`, data, DEVICE_TTL);
    return data;
}
