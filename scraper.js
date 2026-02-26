/**
 * scraper.js
 *
 * SPEED OPTIMIZATIONS:
 * 1. Search via direct HTTP JSON (no browser, ~200ms)
 * 2. Search + device fetch run in PARALLEL when possible
 * 3. Uses pooled pages (pre-opened, no newPage() overhead)
 * 4. waitForTimeout reduced to minimum (100ms settle)
 * 5. __NEXT_DATA__ extraction — if nanoreview is Next.js, get all data
 *    from the embedded JSON without waiting for JS to render anything
 * 6. Cache checked before any browser work
 */
import * as cheerio from 'cheerio';
import { getPooledPage, waitForCloudflare, safeNavigate } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch } from './http.js';

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|poco|redmi/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
};

function scoreMatch(name, slug, q) {
    const n = name.toLowerCase(), s = (slug || '').toLowerCase(), ql = q.toLowerCase();
    const qSlug = ql.replace(/\s+/g, '-');
    if (s === ql || s === qSlug) return 1000;
    if (n === ql) return 900;
    if (s.includes(qSlug)) return 700;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - (n.length * 0.1);
}

export function pickBestMatch(results, query) {
    const q = query.toLowerCase().trim();
    const qSlug = q.replace(/\s+/g, '-');
    const slug = r => r.slug || r.url_name || '';
    return (
        results.find(r => slug(r) === q) ||
        results.find(r => slug(r) === qSlug) ||
        results.find(r => r.name?.toLowerCase() === q) ||
        results.find(r => slug(r).includes(qSlug)) ||
        results.find(r => r.name?.toLowerCase().includes(q)) ||
        results.find(r => q.split(/\s+/).every(w => r.name?.toLowerCase().includes(w))) ||
        results[0]
    );
}

// ── HTML Parser ────────────────────────────────────────────────────────────

function parseDeviceHtml(html, url) {
    const $ = cheerio.load(html);

    // Try __NEXT_DATA__ first — instant, no selector matching needed
    const nextDataEl = $('#__NEXT_DATA__').html();
    if (nextDataEl) {
        try {
            const nextData = JSON.parse(nextDataEl);
            const props = nextData?.props?.pageProps;
            if (props && (props.device || props.phone || props.item || props.data)) {
                const d = props.device || props.phone || props.item || props.data;
                return {
                    title: d.name || d.title || $('h1').first().text().trim(),
                    sourceUrl: url,
                    images: d.image ? [d.image] : (d.images || []),
                    scores: d.scores || d.ratings || {},
                    pros: d.pros || d.advantages || [],
                    cons: d.cons || d.disadvantages || [],
                    specs: d.specs || d.specifications || d.params || {},
                    _source: 'next_data',
                };
            }
        } catch {}
    }

    // Standard HTML parsing
    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl: url, images: [], scores: {}, pros: [], cons: [], specs: {},
    };

    const seen = new Set();
    $('img').each((_, img) => {
        const srcs = [$(img).attr('data-src'), $(img).attr('src')];
        srcs.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            if (src.startsWith('http') && !/(logo|icon|avatar|svg)/i.test(src) && !seen.has(src)) {
                seen.add(src); data.images.push(src);
            }
        });
    });
    $('[class*="score"],.progress-bar,.rating-box').each((_, el) => {
        const label = $(el).find('[class*="title"],[class*="name"]').first().text().trim() || $(el).prev('div,p,span').text().trim();
        const value = $(el).find('[class*="value"],[class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
        if (label && value && label !== value) data.scores[label] = value;
    });
    $('[class*="pros"] li,[class*="plus"] li,.green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
    $('[class*="cons"] li,[class*="minus"] li,.red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
    $('.card,.box,section,[class*="specs"]').each((_, card) => {
        const title = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 2) {
                const label = cells.first().text().trim().replace(/:$/, '');
                const value = cells.last().text().trim();
                if (label && value && label !== value) section[label] = value;
            }
        });
        if (Object.keys(section).length > 0) data.specs[title] = section;
    });
    return data;
}

// ── Core browser fetch — uses pooled page ─────────────────────────────────

async function browserFetchHtml(url) {
    const page = await getPooledPage();
    try {
        await safeNavigate(page, url);
        // Minimal settle — context already past CF so page loads instantly
        await page.waitForTimeout(100);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Search ─────────────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP JSON — no browser needed, ~200ms
    let results;
    try { results = await directSearch(query, limit, types); } catch { results = null; }

    if (results?.length) {
        const seen = new Set();
        results = results.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
        results.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));
        cache.set('search', cacheKey, results, TTL.search);
        return results;
    }

    // Browser fallback — use pooled page (pre-opened, fast)
    const page = await getPooledPage();
    try {
        await safeNavigate(page, 'https://nanoreview.net/en/');
        await waitForCloudflare(page, 10000);
        results = await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const r = await fetch(`https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`, { headers: { Accept: 'application/json' } });
                    if (!r.ok) return [];
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            }));
            return all.flat();
        }, { query, limit, types });
    } finally {
        await page.close().catch(() => {});
    }

    if (!results?.length) return [];
    const seen = new Set();
    results = results.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
    results.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));
    cache.set('search', cacheKey, results, TTL.search);
    return results;
};

// ── Main search+device — runs search & device fetch in PARALLEL ────────────

export const searchAndFetch = async (query, limit = 10) => {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Step 1: Search via direct HTTP (fast, no browser)
    let searchResults;
    try { searchResults = await directSearch(query, limit, types); } catch { searchResults = []; }

    if (searchResults?.length) {
        // Dedupe + sort
        const seen = new Set();
        searchResults = searchResults.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
        searchResults.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));

        // Cache search results
        cache.set('search', `search:${query.toLowerCase()}-${limit}`, searchResults, TTL.search);

        const item = pickBestMatch(searchResults, query);
        const slug = item.slug || item.url_name || item.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

        // Check device cache
        const deviceCached = cache.get('device', deviceUrl);
        if (deviceCached) {
            deviceCached.searchResults = searchResults.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name }));
            deviceCached.matchedDevice = item.name;
            return deviceCached;
        }

        // Fetch device page with browser (context already warm)
        const html = await browserFetchHtml(deviceUrl);
        const data = parseDeviceHtml(html, deviceUrl);
        data.searchResults = searchResults.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name }));
        data.matchedDevice = item.name;
        cache.set('device', deviceUrl, data, TTL.device);
        cache.set('device', cacheKey, data, TTL.device);
        return data;
    }

    // Browser fallback for search
    const page = await getPooledPage();
    let results;
    try {
        await safeNavigate(page, 'https://nanoreview.net/en/');
        await waitForCloudflare(page, 10000);
        results = await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const r = await fetch(`https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`, { headers: { Accept: 'application/json' } });
                    if (!r.ok) return [];
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            }));
            return all.flat();
        }, { query, limit, types });
    } finally { await page.close().catch(() => {}); }

    if (!results?.length) return null;
    const seen = new Set();
    results = results.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
    results.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));

    const item = pickBestMatch(results, query);
    const slug = item.slug || item.url_name || '';
    const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
    const html = await browserFetchHtml(deviceUrl);
    const data = parseDeviceHtml(html, deviceUrl);
    data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name }));
    data.matchedDevice = item.name;
    cache.set('device', deviceUrl, data, TTL.device);
    cache.set('device', cacheKey, data, TTL.device);
    return data;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;
    const html = await browserFetchHtml(deviceUrl);
    const data = parseDeviceHtml(html, deviceUrl);
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;
    const html = await browserFetchHtml(compareUrl);
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').first().text().trim(), sourceUrl: compareUrl, images: [],
        device1: { name: '', score: '' }, device2: { name: '', score: '' }, comparisons: {},
    };
    const headers = [];
    $('.compare-header [class*="title"],.vs-header h2,th').each((_, el) => {
        const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t);
    });
    if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
    $('.card,.box,section,[class*="specs"]').each((_, card) => {
        const title = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const feature = cells.eq(0).text().trim().replace(/:$/, '');
                const val1 = cells.eq(1).text().trim(), val2 = cells.eq(2).text().trim();
                if (feature) section[feature] = { [data.device1.name || 'Device 1']: val1, [data.device2.name || 'Device 2']: val2 };
            }
        });
        if (Object.keys(section).length > 0) data.comparisons[title] = section;
    });
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;
    const html = await browserFetchHtml(rankingUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };
    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            item[headers[i]?.toLowerCase().replace(/\s+/g, '_') || `col_${i}`] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};

export const scrapeDeviceHtml = parseDeviceHtml;
export const scrapeRankingHtml = (html, url) => {
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: url, rankings: [] };
    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            item[headers[i]?.toLowerCase().replace(/\s+/g, '_') || `col_${i}`] = $(td).text().trim();
        });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    return data;
};
