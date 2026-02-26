/**
 * scraper.js
 * Uses persistent browser context — pages open instantly since browser
 * is already running and CF cookies are already cached.
 *
 * Fast path: direct HTTP JSON API for search (no browser needed)
 * Then: reuse persistent context for device page (already past CF)
 */
import * as cheerio from 'cheerio';
import { getNewPage, waitForCloudflare, safeNavigate } from './browser.js';
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

function parseHtml(html, url, type = 'device') {
    const $ = cheerio.load(html);
    if (type === 'ranking') {
        const data = { title: $('h1').first().text().trim(), sourceUrl: url, rankings: [] };
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
        return data;
    }

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
    $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
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

async function browserFetch(url, blockTypes = ['font', 'media', 'image']) {
    const page = await getNewPage();
    try {
        await page.route('**/*', route =>
            blockTypes.includes(route.request().resourceType()) ? route.abort() : route.continue()
        );
        await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Short wait — context already past CF so page loads fast
        await page.waitForTimeout(500);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Search — tries direct HTTP first, browser fallback ────────────────────

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP JSON (no browser)
    let results;
    try { results = await directSearch(query, limit, types); } catch { results = null; }

    // Browser fallback
    if (!results?.length) {
        const page = await getNewPage();
        try {
            await page.route('**/*', route =>
                ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue()
            );
            await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForCloudflare(page, 'body', 12000).catch(() => {});
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
    }

    if (!results?.length) return [];
    const seen = new Set();
    results = results.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
    results.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));
    cache.set('search', cacheKey, results, TTL.search);
    return results;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;
    // Reuses persistent context — already past CF, opens instantly
    const html = await browserFetch(deviceUrl, ['font', 'media', 'image']);
    const data = parseHtml(html, deviceUrl, 'device');
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;
    const html = await browserFetch(compareUrl, ['font', 'media', 'image']);
    const data = parseHtml(html, compareUrl, 'compare');
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;
    const html = await browserFetch(rankingUrl, ['font', 'media', 'image']);
    const data = parseHtml(html, rankingUrl, 'ranking');
    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};

export const scrapeDeviceHtml = (html, url) => parseHtml(html, url, 'device');
export const scrapeRankingHtml = (html, url) => parseHtml(html, url, 'ranking');
