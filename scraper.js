/**
 * scraper.js
 * 
 * Speed strategy (copied from GSM Arena API approach):
 * 1. Search via direct HTTP JSON API — no browser, instant
 * 2. Device HTML via direct HTTP with cookie jar — no browser, fast
 * 3. Browser ONLY as last resort if CF blocks both above
 * 
 * The cookie jar in http.js means cookies from the search request
 * carry over to device page requests — same effect as v1's shared context
 * but WITHOUT launching a browser at all.
 */
import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate, getBrowserContext } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml, isCloudflareBlock } from './http.js';

// ── Type detection ─────────────────────────────────────────────────────────

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return allTypes;
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase();
    const ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - (n.length * 0.1);
};

// ── HTML parser (cheerio, same as GSM Arena API) ───────────────────────────

function parseDeviceHtml(html, deviceUrl) {
    const $ = cheerio.load(html);

    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl: deviceUrl,
        images: [],
        scores: {},
        pros: [],
        cons: [],
        specs: {},
    };

    // Images
    const seenImgs = new Set();
    $('img').each((_, img) => {
        const extractUrls = (str) => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
        const srcs = [
            $(img).attr('data-src'), $(img).attr('src'),
            ...extractUrls($(img).attr('srcset')),
            ...extractUrls($(img).attr('data-srcset')),
        ];
        $(img).closest('picture').find('source').each((__, src) => {
            srcs.push(...extractUrls($(src).attr('srcset')));
        });
        srcs.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            if (src.startsWith('http') && !/(logo|icon|avatar|svg|sprite)/i.test(src) && !seenImgs.has(src)) {
                seenImgs.add(src);
                data.images.push(src);
            }
        });
    });

    // Scores
    $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
        const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim()
            || $(el).prev('div, p, span').text().trim();
        const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim()
            || $(el).text().replace(/[^0-9]/g, '').trim();
        if (label && value && label !== value) data.scores[label] = value;
    });

    // Pros & Cons
    $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.pros.push(t);
    });
    $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.cons.push(t);
    });

    // Specs — tables inside cards/sections
    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td, th');
            if (cells.length >= 2) {
                const label = cells.first().text().trim().replace(/:$/, '');
                const value = cells.last().text().trim();
                if (label && value && label !== value) section[label] = value;
            }
        });
        if (Object.keys(section).length > 0) data.specs[sectionTitle] = section;
    });

    return data;
}

function parseCompareHtml(html, compareUrl) {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl: compareUrl,
        images: [],
        device1: { name: '', score: '' },
        device2: { name: '', score: '' },
        comparisons: {},
    };
    const headers = [];
    $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.toLowerCase() !== 'vs') headers.push(t);
    });
    if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td, th');
            if (cells.length >= 3) {
                const feature = cells.eq(0).text().trim().replace(/:$/, '');
                const val1 = cells.eq(1).text().trim();
                const val2 = cells.eq(2).text().trim();
                if (feature) section[feature] = { [data.device1.name || 'Device 1']: val1, [data.device2.name || 'Device 2']: val2 };
            }
        });
        if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
    });
    return data;
}

function parseRankingHtml(html, rankingUrl) {
    const $ = cheerio.load(html);
    const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };
    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            const key = headers[i] ? headers[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
            item[key] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    return data;
}

// Exported for worker.js cache warming
export { parseDeviceHtml as scrapeDeviceHtml, parseRankingHtml as scrapeRankingHtml };

// ── Browser fallback (last resort only) ───────────────────────────────────

async function browserFetch(context, url, blockTypes = ['font', 'media', 'image']) {
    const page = await context.newPage();
    try {
        await page.route('**/*', route =>
            blockTypes.includes(route.request().resourceType()) ? route.abort() : route.continue()
        );
        await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCloudflare(page, 'body', 12000).catch(() => {});
        await page.waitForTimeout(1000);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 5) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP (no browser, like GSM Arena API)
    let results;
    try {
        results = await directSearch(query, limit, types);
    } catch { results = null; }

    // Browser fallback
    if (!results || results.length === 0) {
        const { browser, context } = await getBrowserContext();
        try {
            const page = await context.newPage();
            try {
                await page.route('**/*', route =>
                    ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue()
                );
                await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
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
            } finally {
                await page.close().catch(() => {});
            }
        } finally {
            await browser.close().catch(() => {});
        }
    }

    if (!results?.length) return [];
    results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    cache.set('search', cacheKey, results, TTL.search);
    return results;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;

    // Fast path: direct HTTP + cheerio (GSM Arena style — no browser)
    let data;
    try {
        const html = await directFetchHtml(deviceUrl);
        data = parseDeviceHtml(html, deviceUrl);
    } catch {
        // Browser fallback
        const { browser, context } = await getBrowserContext();
        try {
            const html = await browserFetch(context, deviceUrl);
            data = parseDeviceHtml(html, deviceUrl);
        } finally {
            await browser.close().catch(() => {});
        }
    }

    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    let data;
    try {
        const html = await directFetchHtml(compareUrl);
        data = parseCompareHtml(html, compareUrl);
    } catch {
        const { browser, context } = await getBrowserContext();
        try {
            const html = await browserFetch(context, compareUrl);
            data = parseCompareHtml(html, compareUrl);
        } finally {
            await browser.close().catch(() => {});
        }
    }

    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;

    let data;
    try {
        const html = await directFetchHtml(rankingUrl, 10000);
        data = parseRankingHtml(html, rankingUrl);
    } catch {
        const { browser, context } = await getBrowserContext();
        try {
            const html = await browserFetch(context, rankingUrl);
            data = parseRankingHtml(html, rankingUrl);
        } finally {
            await browser.close().catch(() => {});
        }
    }

    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};
