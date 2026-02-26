/**
 * scraper.js - Speed-optimized nanoreview scraper
 *
 * STRATEGY (fastest to slowest):
 * 1. Memory cache hit → <5ms
 * 2. File cache hit → <20ms
 * 3. Direct HTTP with CF cookies → ~300-600ms (search + page fetch in parallel)
 * 4. Direct HTTP without CF cookies → might fail, falls back
 * 5. Browser (single navigation, directly to device page) → ~2-4s
 *
 * The browser is NEVER used for search API calls — only for HTML page fetching
 * when CF cookies aren't available or have expired.
 */
import * as cheerio from 'cheerio';
import { getCFCookies, waitForCloudflare, browserFetchDirect, browserSearchDirect, warmUp as browserWarmUp } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml } from './http.js';

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
    return (
        results.find(r => r.slug === q) ||
        results.find(r => r.slug === qSlug) ||
        results.find(r => r.name?.toLowerCase() === q) ||
        results.find(r => r.slug?.includes(qSlug)) ||
        results.find(r => r.name?.toLowerCase().includes(q)) ||
        results.find(r => q.split(/\s+/).every(w => r.name?.toLowerCase().includes(w))) ||
        results[0]
    );
}

function dedupeAndSort(results, query) {
    const seen = new Set();
    return results
        .filter(r => {
            const key = r.slug || r.url_name || r.url || r.id || r.name;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => {
            const sA = a.slug || a.url_name || a.url || '';
            const sB = b.slug || b.url_name || b.url || '';
            return scoreMatch(b.name, sB, query) - scoreMatch(a.name, sA, query);
        });
}

/**
 * Search: try direct HTTP first (with CF cookies if available), then browser.
 * Direct HTTP is ~10-20x faster than browser.
 */
async function fastSearch(query, limit = 10) {
    const types = detectLikelyTypes(query);
    const cookies = await getCFCookies() || '';

    try {
        const results = await directSearch(query, limit, types, cookies);
        if (results.length > 0) {
            console.log(`[search] Direct HTTP OK (${results.length} results)`);
            return results;
        }
        console.log('[search] Direct HTTP returned 0 results, trying browser...');
    } catch (err) {
        console.log('[search] Direct HTTP failed:', err.message, '— using browser');
    }

    return browserSearchDirect(query, limit, types);
}

/**
 * Fetch device HTML: try direct HTTP first (with CF cookies), then browser.
 */
async function fastFetchHtml(url) {
    const cookies = await getCFCookies() || '';
    try {
        const html = await directFetchHtml(url, cookies, 6000);
        console.log('[html] Direct HTTP OK');
        return html;
    } catch (err) {
        console.log('[html] Direct HTTP failed:', err.message, '— using browser');
        return browserFetchDirect(url);
    }
}

function buildDeviceUrl(item) {
    if (item.slug)
        return `https://nanoreview.net/en/${item.content_type}/${item.slug}`;
    if (item.url_name)
        return `https://nanoreview.net/en/${item.content_type}/${item.url_name}`;
    if (item.url?.startsWith('http'))
        return item.url;
    if (item.url)
        return `https://nanoreview.net${item.url}`;
    const slug = item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return `https://nanoreview.net/en/${item.content_type}/${slug}`;
}

/**
 * MAIN: searchAndFetch
 * Runs search + device page fetch in parallel when possible.
 */
export const searchAndFetch = async (query, limit = 10) => {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    // Search to get the device slug/URL
    const rawResults = await fastSearch(query, limit);
    if (!rawResults.length) return null;

    const deduped = dedupeAndSort(rawResults, query);
    const item = pickBestMatch(deduped, query);
    console.log('[search] picked:', item.name, '→', item.content_type);

    const deviceUrl = buildDeviceUrl(item);
    console.log('[search] URL:', deviceUrl);

    // Check device-level cache
    const deviceCached = cache.get('device', deviceUrl);
    if (deviceCached) {
        deviceCached.searchResults = formatSearchResults(deduped);
        deviceCached.matchedDevice = item.name;
        return deviceCached;
    }

    // Fetch device HTML
    const html = await fastFetchHtml(deviceUrl);
    const data = parseDeviceHtml(html, deviceUrl);
    data.searchResults = formatSearchResults(deduped);
    data.matchedDevice = item.name;

    cache.set('device', deviceUrl, data, TTL.device);
    cache.set('device', cacheKey, data, TTL.device);
    return data;
};

function formatSearchResults(deduped) {
    return deduped.map((r, i) => ({
        index: i,
        name: r.name,
        type: r.content_type,
        slug: r.slug || r.url_name || r.url || null,
    }));
}

function parseDeviceHtml(html, url) {
    const $ = cheerio.load(html);

    // __NEXT_DATA__ is the richest, fastest parse path
    try {
        const raw = $('#__NEXT_DATA__').html();
        if (raw) {
            const next = JSON.parse(raw);
            const props = next?.props?.pageProps;
            const d = props?.device || props?.phone || props?.item || props?.data || props?.pageData;
            if (d?.name) {
                return {
                    title: d.name,
                    sourceUrl: url,
                    images: d.image ? [d.image] : (d.images || []),
                    scores: d.scores || d.ratings || {},
                    pros: d.pros || d.advantages || [],
                    cons: d.cons || d.disadvantages || [],
                    specs: d.specs || d.specifications || d.params || {},
                    _source: 'next_data',
                };
            }
        }
    } catch {}

    const title = $('h1').first().text().trim();
    const data = { title, sourceUrl: url, images: [], scores: {}, pros: [], cons: [], specs: {} };

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
        const label = $(el).find('[class*="title"],[class*="name"]').first().text().trim() || $(el).prev().text().trim();
        const value = $(el).find('[class*="value"],[class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
        if (label && value && label !== value) data.scores[label] = value;
    });
    $('[class*="pros"] li,[class*="plus"] li,.green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
    $('[class*="cons"] li,[class*="minus"] li,.red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
    $('.card,.box,section,[class*="specs"]').each((_, card) => {
        const sTitle = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 2) {
                const label = cells.first().text().trim().replace(/:$/, '');
                const value = cells.last().text().trim();
                if (label && value && label !== value) section[label] = value;
            }
        });
        if (Object.keys(section).length > 0) data.specs[sTitle] = section;
    });
    return data;
}

// ── searchDevices ──────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const results = await fastSearch(query, limit);
    const deduped = dedupeAndSort(results, query);
    cache.set('search', cacheKey, deduped, TTL.search);
    return deduped;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;
    const html = await fastFetchHtml(deviceUrl);
    const data = parseDeviceHtml(html, deviceUrl);
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;
    const html = await fastFetchHtml(compareUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: compareUrl, device1: { name: '' }, device2: { name: '' }, comparisons: {} };
    const headers = [];
    $('th,[class*="title"]').each((_, el) => { const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t); });
    if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
    $('.card,.box,section,[class*="specs"]').each((_, card) => {
        const sTitle = $(card).find('h2,h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const f = cells.eq(0).text().trim().replace(/:$/, '');
                const v1 = cells.eq(1).text().trim(), v2 = cells.eq(2).text().trim();
                if (f) section[f] = { [data.device1.name || 'Device 1']: v1, [data.device2.name || 'Device 2']: v2 };
            }
        });
        if (Object.keys(section).length > 0) data.comparisons[sTitle] = section;
    });
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;
    const html = await fastFetchHtml(rankingUrl);
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
        $(row).find('td').each((i, td) => { item[headers[i]?.toLowerCase().replace(/\s+/g, '_') || `col_${i}`] = $(td).text().trim(); });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    return data;
};
