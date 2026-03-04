/**
 * scraper.js — search + device data pipeline
 *
 * Uses parallelSearchInBrowser() for CF-bypass search,
 * then fetchDeviceData() for fast Next.js JSON extraction.
 */
import { parallelSearchInBrowser, fetchPageHtml } from './browser.js';
import { fetchDeviceData } from './nextjs.js';
import { cache, TTL } from './cache.js';
import * as cheerio from 'cheerio';

const ALL_TYPES = ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet'];

function detectTypes(query) {
    const q = query.toLowerCase().trim();
    if (q.length <= 7 && !q.includes(' ')) return ALL_TYPES;
    if (/ryzen|intel\s*core|threadripper|xeon|celeron|pentium|core\s*i[3579]/i.test(q)) return ['cpu', 'laptop', 'soc', 'phone', 'tablet', 'gpu'];
    if (/snapdragon|mediatek|dimensity|exynos|a\d{2}\s*bionic|helio|kirin/i.test(q)) return ['soc', 'phone', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|arc\s*a\d|quadro/i.test(q)) return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel\s*\d|oneplus|xiaomi|redmi|poco|realme|oppo|vivo|samsung|huawei|nothing\s*phone|motorola|nokia|sony\s*xperia/i.test(q)) return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface\s*pro|tab\s*s\d|mediapad/i.test(q)) return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|chromebook|ultrabook|ideapad|pavilion|inspiron/i.test(q)) return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return ALL_TYPES;
}

function scoreMatch(name, slug, query) {
    const n = (name || '').toLowerCase();
    const s = (slug || '').toLowerCase();
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    if (s === q || s === qs) return 1000;
    if (n === q)              return 950;
    if (s.startsWith(qs))     return 850;
    if (n.startsWith(q))      return 800;
    if (s.includes(qs))       return 700;
    if (n.includes(q))        return 650;
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return 0;
    const hits = words.filter(w => n.includes(w) || s.includes(w)).length;
    return (hits / words.length) * 400 - n.length * 0.05;
}

function dedupe(results, query) {
    const seen = new Set();
    return results
        .filter(r => {
            const k = r.slug || r.url_name || r.id || r.name;
            if (!k || seen.has(k)) return false;
            seen.add(k); return true;
        })
        .sort((a, b) =>
            scoreMatch(b.name, b.slug || b.url_name || '', query) -
            scoreMatch(a.name, a.slug || a.url_name || '', query)
        );
}

export function getSlug(item) {
    return item.slug || item.url_name ||
        (item.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export function pickBestMatch(results, query) {
    if (!results?.length) return null;
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    return results.find(r => r.slug === qs)
        || results.find(r => r.slug === q)
        || results.find(r => (r.name || '').toLowerCase() === q)
        || results.find(r => r.slug?.startsWith(qs))
        || results.find(r => r.slug?.includes(qs))
        || results.find(r => (r.name || '').toLowerCase().includes(q))
        || results[0];
}

function deviceUrl(item) {
    const type = item.content_type || 'phone';
    const slug = getSlug(item);
    if (item.url?.startsWith('http')) return item.url;
    if (item.url) return `https://nanoreview.net${item.url}`;
    return `https://nanoreview.net/en/${type}/${slug}`;
}

export async function searchDevices(query, limit = 10) {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectTypes(query);
    const raw = await parallelSearchInBrowser(query, limit, types);
    const results = dedupe(raw, query);
    if (results.length) cache.set('search', cacheKey, results, TTL.search);
    return results;
}

export async function searchAndFetch(query, limit = 10) {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const results = await searchDevices(query, limit);
    if (!results.length) return null;

    // Try top 3 candidates in case first page fetch fails
    const candidates = results.slice(0, Math.min(3, results.length));
    const best = pickBestMatch(results, query);
    const bestIdx = candidates.findIndex(r => r === best);
    if (bestIdx > 0) { candidates.splice(bestIdx, 1); candidates.unshift(best); }

    for (const candidate of candidates) {
        const url = deviceUrl(candidate);
        const type = candidate.content_type || 'phone';
        const slug = getSlug(candidate);
        const data = await fetchDeviceData(type, slug, url);
        if (data) {
            data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
            data.matchedDevice = candidate.name;
            cache.set('device', cacheKey, data, TTL.device);
            return data;
        }
    }
    return null;
}

export async function scrapeDevicePage(url) {
    const cached = cache.get('device', url);
    if (cached) return cached;
    const m = url.match(/nanoreview\.net\/en\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const [, type, slug] = m;
    const data = await fetchDeviceData(type, slug, url);
    if (data) cache.set('device', url, data, TTL.device);
    return data;
}

export async function scrapeComparePage(compareUrl) {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    const html = await fetchPageHtml(compareUrl);

    try {
        const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
        if (m) {
            const next = JSON.parse(m[1]);
            const props = next?.props?.pageProps;
            if (props?.comparison || props?.data) {
                const comp = props.comparison || props.data;
                const result = {
                    title: comp.title || '',
                    sourceUrl: compareUrl,
                    device1: { name: comp.device1?.name || comp.phones?.[0]?.name || '' },
                    device2: { name: comp.device2?.name || comp.phones?.[1]?.name || '' },
                    comparisons: comp.comparisons || comp.specs || {},
                    _source: 'next_data',
                };
                cache.set('compare', compareUrl, result, TTL.compare);
                return result;
            }
        }
    } catch {}

    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: compareUrl, device1: { name: '' }, device2: { name: '' }, comparisons: {} };
    const headers = [];
    $('th, [class*="title"], [class*="name"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.toLowerCase() !== 'vs' && t.length > 1) headers.push(t);
    });
    if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const sTitle = $(card).find('h2,h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const f = cells.eq(0).text().trim().replace(/:$/, '');
                if (f) section[f] = { [data.device1.name || 'Device 1']: cells.eq(1).text().trim(), [data.device2.name || 'Device 2']: cells.eq(2).text().trim() };
            }
        });
        if (Object.keys(section).length) data.comparisons[sTitle] = section;
    });
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
}

export async function scrapeRankingPage(rankingUrl) {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;

    const html = await fetchPageHtml(rankingUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };

    try {
        const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
        if (m) {
            const next = JSON.parse(m[1]);
            const items = next?.props?.pageProps?.items || next?.props?.pageProps?.devices || next?.props?.pageProps?.list;
            if (Array.isArray(items) && items.length) {
                data.rankings = items.map((item, i) => ({
                    rank: i + 1, name: item.name || item.title,
                    score: item.score || item.total_score || item.rating,
                    slug: item.slug || item.url_name,
                    url: `https://nanoreview.net/en/${item.content_type || 'soc'}/${item.slug || item.url_name}`,
                }));
                cache.set('ranking', rankingUrl, data, TTL.ranking);
                return data;
            }
        }
    } catch {}

    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            item[headers[i] || `col_${i}`] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length) data.rankings.push(item);
    });

    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
}
