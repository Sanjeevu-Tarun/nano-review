import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';

const searchCache = new Map();
const deviceCache = new Map();
const SEARCH_TTL = 5  * 60 * 1000;   // 5 min
const DEVICE_TTL = 10 * 60 * 1000;   // 10 min

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

// ─── Scoring: exact > full-word exact > substring > partial words ─────────────
// Penalises names that are SHORTER than the query (avoids "X300" beating "X300 Pro")
const scoreMatch = (name, query) => {
    const n = name.toLowerCase().trim();
    const q = query.toLowerCase().trim();

    if (n === q) return 10000;

    // All query words present and in the right order (e.g. "vivo x300 pro")
    const qWords = q.split(/\s+/);
    const allWords = qWords.every(w => n.includes(w));
    if (allWords) {
        // Prefer names closer in length to the query (punish extra words heavily)
        const lengthDiff = Math.abs(n.split(/\s+/).length - qWords.length);
        return 5000 - (lengthDiff * 200);
    }

    // Partial word matches
    let score = 0;
    for (const w of qWords) if (n.includes(w)) score += 100;

    // Penalise names much longer than the query (wrong product family)
    score -= Math.max(0, n.length - q.length) * 0.5;
    return score;
};

// ─── Search ───────────────────────────────────────────────────────────────────
export const searchDevices = async (context, query, limit = 10) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    const page = await context.newPage();

    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        try {
            await waitForCloudflare(page, 'body', 10000);
        } catch {
            const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
            if (!hasContent) throw new Error('Page failed to load');
        }

        // Fetch with higher limit (15) so variants like "Pro", "Ultra", "Plus" aren't cut off
        const allResults = await page.evaluate(async ({ query, limit, types }) => {
            const seen = new Set();
            const fetchPromises = types.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 4000);
                    const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                    clearTimeout(timeoutId);
                    if (!response.ok) return [];
                    const data = await response.json();
                    return Array.isArray(data)
                        ? data.map(r => ({ ...r, content_type: r.content_type || type }))
                        : [];
                } catch {
                    return [];
                }
            });

            const resultsArrays = await Promise.all(fetchPromises);
            // Deduplicate by name (keep first occurrence)
            const deduped = [];
            for (const r of resultsArrays.flat()) {
                const key = r.name?.toLowerCase().trim();
                if (key && !seen.has(key)) {
                    seen.add(key);
                    deduped.push(r);
                }
            }
            return deduped;
        }, { query, limit: Math.max(limit, 15), types });

        if (allResults.length === 0) return [];

        allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

        // Cache and trim to requested limit
        const trimmed = allResults.slice(0, limit);
        searchCache.set(cacheKey, { results: trimmed, timestamp: Date.now() });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);

        return trimmed;
    } finally {
        await page.close();
    }
};

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = async (context, deviceUrl) => {
    const cached = deviceCache.get(deviceUrl);
    if (cached && Date.now() - cached.timestamp < DEVICE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image'].includes(type)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        // Confirm we're on the right page — title must be present
        const pageTitle = await page.title();
        if (/just a moment|cloudflare|403|404|not found/i.test(pageTitle)) {
            throw new Error(`Failed to load device page: "${pageTitle}"`);
        }

        const html = await page.content();
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
        $('img').each((_, img) => {
            const extractUrls = (str) => {
                if (!str) return [];
                return str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
            };
            const sources = [
                $(img).attr('data-src'),
                $(img).attr('src'),
                ...extractUrls($(img).attr('srcset')),
                ...extractUrls($(img).attr('data-srcset')),
            ];
            $(img).closest('picture').find('source').each((__, source) => {
                sources.push(...extractUrls($(source).attr('srcset')));
                sources.push(...extractUrls($(source).attr('data-srcset')));
            });
            sources.forEach(src => {
                if (!src) return;
                if (src.startsWith('/')) src = 'https://nanoreview.net' + src;
                const l = src.toLowerCase();
                if (src.startsWith('http') && /\.(jpe?g|png|webp)/i.test(src) &&
                    !l.includes('logo') && !l.includes('icon') && !l.includes('avatar') && !l.includes('svg')) {
                    data.images.push(src);
                }
            });
        });
        data.images = [...new Set(data.images)].slice(0, 8);

        // Scores
        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim()
                || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim()
                || $(el).text().replace(/[^0-9.]/g, '').trim();
            if (label && value && label !== value && /\d/.test(value)) {
                data.scores[label] = value;
            }
        });

        // Pros & cons
        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
            const text = $(el).text().trim();
            if (text) data.pros.push(text);
        });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
            const text = $(el).text().trim();
            if (text) data.cons.push(text);
        });

        // Specs — cards/sections with tables
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 2) {
                    const label = cells.first().text().trim().replace(/:$/, '');
                    const value = cells.last().text().trim();
                    if (label && value && label !== value && label.length < 80) {
                        section[label] = value;
                    }
                }
            });
            if (Object.keys(section).length > 0) {
                data.specs[sectionTitle] = { ...(data.specs[sectionTitle] || {}), ...section };
            }
        });

        // Fallback: all tables
        if (Object.keys(data.specs).length === 0) {
            $('table').each((_, table) => {
                const section = {};
                $(table).find('tr').each((__, row) => {
                    const cells = $(row).find('td, th');
                    if (cells.length >= 2) {
                        const label = cells.first().text().trim().replace(/:$/, '');
                        const value = cells.last().text().trim();
                        if (label && value && label !== value) section[label] = value;
                    }
                });
                if (Object.keys(section).length > 0) data.specs['Specifications'] = { ...(data.specs['Specifications'] || {}), ...section };
            });
        }

        deviceCache.set(deviceUrl, { data, timestamp: Date.now() });
        if (deviceCache.size > 200) deviceCache.delete(deviceCache.keys().next().value);
        return data;
    } finally {
        await page.close();
    }
};

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = async (context, compareUrl) => {
    const cached = deviceCache.get(compareUrl);
    if (cached && Date.now() - cached.timestamp < DEVICE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image'].includes(type)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const html = await page.content();
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
            const text = $(el).text().trim();
            if (text && !/^vs$/i.test(text)) headers.push(text);
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
                    if (feature) section[feature] = {
                        [data.device1.name || 'Device 1']: val1,
                        [data.device2.name || 'Device 2']: val2,
                    };
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });

        deviceCache.set(compareUrl, { data, timestamp: Date.now() });
        if (deviceCache.size > 200) deviceCache.delete(deviceCache.keys().next().value);
        return data;
    } finally {
        await page.close();
    }
};

// ─── Rankings page ────────────────────────────────────────────────────────────
export const scrapeRankingPage = async (context, rankingUrl) => {
    const cached = deviceCache.get(rankingUrl);
    if (cached && Date.now() - cached.timestamp < DEVICE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image'].includes(type)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const html = await page.content();
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

        deviceCache.set(rankingUrl, { data, timestamp: Date.now() });
        if (deviceCache.size > 200) deviceCache.delete(deviceCache.keys().next().value);
        return data;
    } finally {
        await page.close();
    }
};
