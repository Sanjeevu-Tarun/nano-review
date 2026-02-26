/**
 * scraper.js - Maximum speed nanoreview scraper
 *
 * CRITICAL PATH OPTIMIZATIONS:
 * 1. Race top-2 types first, start fetching device page the moment we have a slug
 * 2. Search + page fetch overlap via streaming pipeline
 * 3. Regex-extract __NEXT_DATA__ instead of full cheerio DOM parse
 * 4. Only fall back to full types if top-2 miss
 */
import * as cheerio from 'cheerio';
import { getCFCookies, browserFetchDirect, browserSearchDirect } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml } from './http.js';

// Top-2 most likely types per query pattern (used for fast-path race)
const detectTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core i[3579]|threadripper|xeon|celeron|pentium/i.test(q)) return { top: ['cpu', 'laptop'], rest: ['soc', 'phone', 'tablet', 'gpu'] };
    if (/snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic|helio/i.test(q)) return { top: ['soc', 'phone'], rest: ['tablet', 'laptop', 'cpu', 'gpu'] };
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|arc\s*a[0-9]/i.test(q)) return { top: ['gpu', 'laptop'], rest: ['cpu', 'phone', 'tablet', 'soc'] };
    if (/iphone|galaxy\s*s|pixel\s*[0-9]|oneplus|xiaomi|redmi|poco|realme|nothing\s*phone/i.test(q)) return { top: ['phone', 'soc'], rest: ['tablet', 'laptop', 'cpu', 'gpu'] };
    if (/ipad|galaxy\s*tab|surface\s*pro|tab\s*s[0-9]/i.test(q)) return { top: ['tablet', 'phone'], rest: ['soc', 'laptop', 'cpu', 'gpu'] };
    if (/macbook|thinkpad|xps|zenbook|vivobook|chromebook|ultrabook/i.test(q)) return { top: ['laptop', 'cpu'], rest: ['gpu', 'tablet', 'phone', 'soc'] };
    return { top: ['phone', 'laptop'], rest: ['tablet', 'soc', 'cpu', 'gpu'] };
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

function buildDeviceUrl(item) {
    const slug = item.slug || item.url_name ||
        item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (item.url?.startsWith('http')) return item.url;
    if (item.url) return `https://nanoreview.net${item.url}`;
    return `https://nanoreview.net/en/${item.content_type}/${slug}`;
}

function formatSearchResults(deduped) {
    return deduped.map((r, i) => ({
        index: i, name: r.name, type: r.content_type,
        slug: r.slug || r.url_name || r.url || null,
    }));
}

async function getHttp(url, cookies) {
    try { return await directFetchHtml(url, cookies || '', 6000); } catch { return null; }
}

/**
 * PIPELINE: Race top types, kick off page fetch the instant we have a slug.
 * Top-2 types fire first. If they return a result before all-types finishes,
 * we immediately start fetching the device page in parallel.
 */
export const searchAndFetch = async (query, limit = 10) => {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const cookies = await getCFCookies() || '';
    const { top, rest } = detectTypes(query);
    const allTypes = [...top, ...rest];

    // --- FAST PIPELINE ---
    // We race the search against itself: top-2 types finish ~2x faster.
    // The moment top-2 returns something good, we start the page fetch.
    // Meanwhile all-types keeps running in case top-2 misses.

    let deviceFetchPromise = null;
    let resolvedItem = null;
    let allDeduped = null;

    const runSearch = async (types) => {
        try {
            return await directSearch(query, limit, types, cookies);
        } catch {
            return [];
        }
    };

    // Fire top-2 and all-types simultaneously
    const topPromise = runSearch(top);
    const allPromise = runSearch(allTypes);

    // As soon as top-2 comes back with a result, start page fetch immediately
    const topResults = await topPromise;
    if (topResults.length > 0) {
        const deduped = dedupeAndSort(topResults, query);
        const item = pickBestMatch(deduped, query);
        const url = buildDeviceUrl(item);
        const devCached = cache.get('device', url);
        if (devCached) {
            // Already cached — cancel everything, return immediately
            devCached.searchResults = formatSearchResults(deduped);
            devCached.matchedDevice = item.name;
            return devCached;
        }
        // Kick off page fetch NOW, in parallel with all-types still running
        console.log(`[pipeline] Top-2 hit → pre-fetching ${url}`);
        deviceFetchPromise = getHttp(url, cookies);
        resolvedItem = item;
    }

    // Wait for all-types to finish (for better deduplication/sorting)
    const allResults = await allPromise;
    const merged = dedupeAndSort([...allResults, ...topResults], query);
    const finalItem = pickBestMatch(merged, query) || resolvedItem;

    if (!finalItem) {
        // All direct HTTP failed — fall back to browser for both search and fetch
        console.log('[pipeline] All direct HTTP failed, using browser...');
        const browserResults = await browserSearchDirect(query, limit, allTypes);
        if (!browserResults.length) return null;
        const bDeduped = dedupeAndSort(browserResults, query);
        const bItem = pickBestMatch(bDeduped, query);
        const bUrl = buildDeviceUrl(bItem);
        const bDevCached = cache.get('device', bUrl);
        if (bDevCached) {
            bDevCached.searchResults = formatSearchResults(bDeduped);
            bDevCached.matchedDevice = bItem.name;
            return bDevCached;
        }
        const bHtml = await browserFetchDirect(bUrl);
        const bData = parseDeviceHtml(bHtml, bUrl);
        bData.searchResults = formatSearchResults(bDeduped);
        bData.matchedDevice = bItem.name;
        cache.set('device', bUrl, bData, TTL.device);
        cache.set('device', cacheKey, bData, TTL.device);
        return bData;
    }

    const deviceUrl = buildDeviceUrl(finalItem);
    console.log('[pipeline] final URL:', deviceUrl);

    // Check cache again with final URL
    const devCachedFinal = cache.get('device', deviceUrl);
    if (devCachedFinal) {
        devCachedFinal.searchResults = formatSearchResults(merged);
        devCachedFinal.matchedDevice = finalItem.name;
        return devCachedFinal;
    }

    // If we already started fetching (from top-2 result), reuse that promise if URL matches
    // Otherwise start a fresh fetch for the final URL
    let html = null;
    if (deviceFetchPromise && resolvedItem && buildDeviceUrl(resolvedItem) === deviceUrl) {
        html = await deviceFetchPromise;
    }
    if (!html) {
        html = await getHttp(deviceUrl, cookies);
    }
    if (!html) {
        console.log('[pipeline] Direct HTML fetch failed, browser fallback...');
        html = await browserFetchDirect(deviceUrl);
    }

    const data = parseDeviceHtml(html, deviceUrl);
    data.searchResults = formatSearchResults(merged);
    data.matchedDevice = finalItem.name;

    cache.set('device', deviceUrl, data, TTL.device);
    cache.set('device', cacheKey, data, TTL.device);
    return data;
};

/**
 * Fast regex extraction of __NEXT_DATA__ — avoids full cheerio parse for the happy path.
 * Falls back to cheerio only if regex fails.
 */
function parseDeviceHtml(html, url) {
    // Fast path: regex extract __NEXT_DATA__ JSON without loading full DOM
    try {
        const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
        if (m) {
            const next = JSON.parse(m[1]);
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

    // Slow path: full DOM parse
    const $ = cheerio.load(html);
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

// ── Other exports ──────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const cookies = await getCFCookies() || '';
    const { top, rest } = detectTypes(query);
    let results = [];
    try {
        results = await directSearch(query, limit, [...top, ...rest], cookies);
    } catch {}
    if (!results.length) {
        results = await browserSearchDirect(query, limit, [...top, ...rest]);
    }
    const deduped = dedupeAndSort(results, query);
    cache.set('search', cacheKey, deduped, TTL.search);
    return deduped;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    let html = await getHttp(deviceUrl, cookies);
    if (!html) html = await browserFetchDirect(deviceUrl);
    const data = parseDeviceHtml(html, deviceUrl);
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    let html = await getHttp(compareUrl, cookies);
    if (!html) html = await browserFetchDirect(compareUrl);
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
    const cookies = await getCFCookies() || '';
    let html = await getHttp(rankingUrl, cookies);
    if (!html) html = await browserFetchDirect(rankingUrl);
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
