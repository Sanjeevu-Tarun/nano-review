import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate, reWarmCloudflare } from './browser.js';

// ─── Caches ───────────────────────────────────────────────────────────────────
const searchCache = new Map();
const pageCache   = new Map();
const SEARCH_TTL  = 5  * 60 * 1000;
const PAGE_TTL    = 10 * 60 * 1000;

function evict(cache, maxSize = 100) {
    if (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

// ─── Type detection ───────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
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
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - n.length * 0.1;
};

// ─── Image extraction ─────────────────────────────────────────────────────────
function extractImages($) {
    const images = new Set();
    $('img').each((_, img) => {
        for (const attr of ['data-src', 'src', 'srcset', 'data-srcset']) {
            const val = $(img).attr(attr);
            if (!val) continue;
            for (const part of val.split(',')) pushSrc(part.trim().split(' ')[0], images);
        }
        $(img).closest('picture').find('source').each((_, s) => {
            for (const attr of ['srcset', 'data-srcset']) {
                const val = $(s).attr(attr);
                if (val) for (const part of val.split(',')) pushSrc(part.trim().split(' ')[0], images);
            }
        });
    });
    return [...images];
}

function pushSrc(src, set) {
    if (!src) return;
    if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
    const lc = src.toLowerCase();
    if (src.startsWith('http') && !lc.includes('logo') && !lc.includes('icon') && !lc.includes('avatar') && !lc.includes('.svg'))
        set.add(src);
}

// ─── Cloudflare detection ─────────────────────────────────────────────────────
function isCloudflareBlock(html, title) {
    const lcTitle = (title || '').toLowerCase();
    const lcHtml  = (html   || '').toLowerCase();
    return (
        lcTitle.includes('just a moment') ||
        lcTitle.includes('attention required') ||
        lcTitle === 'nanoreview.net' ||           // CF default — no real content
        lcHtml.includes('cf-browser-verification') ||
        lcHtml.includes('challenge-form') ||
        lcHtml.includes('cloudflare') && lcHtml.includes('ray id')
    );
}

// ─── Search — direct HTTP fetch, no browser needed ────────────────────────────
export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_TTL) return cached.results;

    const types = detectLikelyTypes(query);

    const fetchType = async (type) => {
        try {
            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Referer': 'https://nanoreview.net/',
                },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch {
            return [];
        }
    };

    const allResults = (await Promise.all(types.map(fetchType))).flat();
    if (!allResults.length) return [];

    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

    searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    evict(searchCache);
    return allResults;
};

// ─── Shared page scraper — with CF bypass logic ───────────────────────────────
async function scrapePage(context, url, parseHtml) {
    const cached = pageCache.get(url);
    if (cached && Date.now() - cached.timestamp < PAGE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        // Only block fonts/media — keep CSS & JS so Cloudflare challenges can execute
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for CF challenge to resolve OR real content to appear
        // Real content on NanoReview has .specs-table or .device-specs or h1 with device name
        let html = '';
        let resolved = false;

        for (let attempt = 0; attempt < 6; attempt++) {
            html = await page.content();
            const title = await page.title().catch(() => '');

            if (!isCloudflareBlock(html, title)) {
                // Check if h1 has actual device content (not just site title)
                const h1 = await page.$eval('h1', el => el.textContent.trim()).catch(() => '');
                if (h1 && h1.toLowerCase() !== 'nanoreview' && h1.length > 3) {
                    resolved = true;
                    break;
                }
                // Page might still be loading JS-rendered content — wait a bit
                if (attempt < 3) {
                    await page.waitForTimeout(1500);
                    continue;
                }
                resolved = true; // Accept it as-is after retries
                break;
            }

            // Still on CF challenge — wait for it to auto-solve
            await page.waitForTimeout(2000);
        }

        if (!resolved) {
            // Re-warm CF session (re-visit homepage to get fresh cookies) then retry once
            await reWarmCloudflare();
            await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(3000);
            html = await page.content();
            const title = await page.title().catch(() => '');
            if (isCloudflareBlock(html, title)) {
                throw new Error('Cloudflare is blocking this request. The server IP may need to be whitelisted or try again in a moment.');
            }
        }

        html = await page.content();
        const data = parseHtml(html, url);

        // Only cache if we got real data (avoid caching CF walls)
        if (data.title && data.title.toLowerCase() !== 'nanoreview.net') {
            pageCache.set(url, { data, timestamp: Date.now() });
            evict(pageCache);
        }

        return data;
    } finally {
        await page.close();
    }
}

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = (context, deviceUrl) =>
    scrapePage(context, deviceUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: url,
            images: extractImages($),
            scores: {},
            pros: [],
            cons: [],
            specs: {},
        };

        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim()
                       || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim()
                       || $(el).text().replace(/[^0-9]/g, '').trim();
            if (label && value && label !== value) data.scores[label] = value;
        });

        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
            const t = $(el).text().trim(); if (t) data.pros.push(t);
        });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
            const t = $(el).text().trim(); if (t) data.cons.push(t);
        });

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
    });

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = (context, compareUrl) =>
    scrapePage(context, compareUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: url,
            images: extractImages($),
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
                    if (feature) {
                        section[feature] = {
                            [data.device1.name || 'Device 1']: cells.eq(1).text().trim(),
                            [data.device2.name || 'Device 2']: cells.eq(2).text().trim(),
                        };
                    }
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });

        return data;
    });

// ─── Ranking page ─────────────────────────────────────────────────────────────
export const scrapeRankingPage = (context, rankingUrl) =>
    scrapePage(context, rankingUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: url, rankings: [] };

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
    });
