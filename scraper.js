import * as cheerio from 'cheerio';

const searchCache = new Map();
const deviceCache = new Map();
const CACHE_TTL = 300000;

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q)) return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q)) return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone/i.test(q)) return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q)) return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q)) return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return allTypes;
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - n.length * 0.1;
};

// Run search API calls from nanoreview homepage (needed for correct origin/cookies)
const runSearchFetches = async (page, query, limit, types) => {
    return page.evaluate(async ({ query, limit, types }) => {
        const promises = types.map(async (type) => {
            try {
                const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                const c = new AbortController();
                setTimeout(() => c.abort(), 4000);
                const r = await fetch(url, { signal: c.signal, headers: { Accept: 'application/json' } });
                if (!r.ok) return [];
                const d = await r.json();
                return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
            } catch { return []; }
        });
        return (await Promise.all(promises)).flat();
    }, { query, limit, types });
};

// THE KEY OPTIMIZATION: search + scrape in ONE page object
// Page 1: goto homepage → fire all search fetches in parallel → get results
// Then: reuse SAME page, goto device page → scrape
// Result: 1 page, 2 navigations (was previously 2 pages, 2 navigations + CF solve each)
export const searchAndScrape = async (context, query, index) => {
    const cacheKey = `${query.toLowerCase()}-${index ?? 'top'}`;
    const cached = deviceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached;

    const types = detectLikelyTypes(query);
    const page = await context.newPage();

    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        // Navigation 1: homepage (needed for CF origin + cookies)
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Fire all type searches in parallel from this page
        const searchResults = await runSearchFetches(page, query, 5, types);

        if (!searchResults.length) return null;

        searchResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

        // Cache the search results
        const sk = `${query.toLowerCase()}-5`;
        if (!searchCache.has(sk)) searchCache.set(sk, { results: searchResults, timestamp: Date.now() });

        let item;
        if (index !== undefined) {
            item = searchResults[Math.min(parseInt(index, 10) || 0, searchResults.length - 1)];
        } else {
            item = searchResults.find(r => r.name.toLowerCase() === query.toLowerCase()) || searchResults[0];
        }

        const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

        // Navigation 2: device page — reusing the SAME page (no new page creation)
        await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: deviceUrl,
            images: extractImages($),
            scores: {},
            pros: [],
            cons: [],
            specs: {},
            matchedQuery: query,
            searchResults: searchResults.map((r, i) => ({
                index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name,
            })),
        };

        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim() || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
            if (label && value && label !== value) data.scores[label] = value;
        });
        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const st = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 2) {
                    const label = cells.first().text().trim().replace(/:$/, '');
                    const value = cells.last().text().trim();
                    if (label && value && label !== value) section[label] = value;
                }
            });
            if (Object.keys(section).length > 0) data.specs[st] = section;
        });

        const result = { data, searchResults };
        deviceCache.set(cacheKey, { ...result, timestamp: Date.now() });
        if (deviceCache.size > 50) deviceCache.delete(deviceCache.keys().next().value);
        return result;
    } finally {
        await page.close();
    }
};

export const searchDevicesDirect = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const results = await runSearchFetches(page, query, limit, types);
        results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
        return results;
    } finally {
        await page.close();
    }
};

const extractImages = ($) => {
    const images = [];
    $('img').each((_, img) => {
        const extractUrls = (str) => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
        const sources = [$(img).attr('data-src'), $(img).attr('src'), ...extractUrls($(img).attr('srcset')), ...extractUrls($(img).attr('data-srcset'))];
        $(img).closest('picture').find('source').each((_, s) => {
            sources.push(...extractUrls($(s).attr('srcset')), ...extractUrls($(s).attr('data-srcset')));
        });
        sources.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            const l = src.toLowerCase();
            if (src.startsWith('http') && !l.includes('logo') && !l.includes('icon') && !l.includes('avatar') && !l.includes('svg')) images.push(src);
        });
    });
    return [...new Set(images)];
};

export const scrapeComparePage = async (context, compareUrl) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image'].includes(type)) route.abort();
            else route.continue();
        });
        await page.goto(compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: compareUrl, images: extractImages($), device1: { name: '', score: '' }, device2: { name: '', score: '' }, comparisons: {} };
        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => { const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t); });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const st = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    if (feature) section[feature] = { [data.device1.name || 'Device 1']: cells.eq(1).text().trim(), [data.device2.name || 'Device 2']: cells.eq(2).text().trim() };
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[st] = section;
        });
        return data;
    } finally {
        await page.close();
    }
};

export const scrapeRankingPage = async (context, rankingUrl) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image'].includes(type)) route.abort();
            else route.continue();
        });
        await page.goto(rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: rankingUrl, rankings: [] };
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
    } finally {
        await page.close();
    }
};
