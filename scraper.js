/**
 * scraper.js
 *
 * THE KEY INSIGHT:
 * Nanoreview has a JSON API at /api/phone/{slug}, /api/cpu/{slug} etc.
 * We can call this FROM INSIDE the browser page using fetch() — no second
 * page needed, no extra Cloudflare challenge. One browser open, one page,
 * two fetch() calls: search + device details. Done in ~2-3s total.
 *
 * Flow:
 * 1. Open browser, navigate to nanoreview.net (pass CF)
 * 2. From that page, fetch() the search API → get slug + type
 * 3. From that SAME page, fetch() the device detail API → get full data
 * 4. Close browser, return data
 *
 * No second page.open(), no second CF challenge, no HTML scraping needed.
 */
import * as cheerio from 'cheerio';
import { getBrowserContext, waitForCloudflare, safeNavigate } from './browser.js';
import { cache, TTL } from './cache.js';

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
    const n = name.toLowerCase();
    const s = (slug || '').toLowerCase();
    const ql = q.toLowerCase();
    const qSlug = ql.replace(/\s+/g, '-');
    if (s === ql || s === qSlug) return 1000;
    if (n === ql) return 900;
    if (s.includes(qSlug)) return 700;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - (n.length * 0.1);
}

function pickBestMatch(results, query) {
    const q = query.toLowerCase().trim();
    const qSlug = q.replace(/\s+/g, '-');
    return (
        results.find(r => (r.slug || '') === q) ||
        results.find(r => (r.slug || '') === qSlug) ||
        results.find(r => r.name.toLowerCase() === q) ||
        results.find(r => (r.slug || '').includes(qSlug)) ||
        results.find(r => r.name.toLowerCase().includes(q)) ||
        results.find(r => q.split(/\s+/).every(w => r.name.toLowerCase().includes(w))) ||
        results[0]
    );
}

/**
 * Open ONE browser page, pass Cloudflare, then use fetch() inside that page
 * to call nanoreview's JSON APIs — search AND device details.
 * Returns full device data without ever opening a second page.
 */
async function fetchEverythingInOnePage(query, limit, types) {
    const { browser, context } = await getBrowserContext();
    try {
        const page = await context.newPage();
        try {
            // Block heavy resources — we only need JS + JSON API responses
            await page.route('**/*', route => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) route.abort();
                else route.continue();
            });

            // Navigate once — this is the only page load needed
            await safeNavigate(page, 'https://nanoreview.net/en/', {
                waitUntil: 'domcontentloaded',
                timeout: 20000,
            });

            // Wait for Cloudflare to clear
            try { await waitForCloudflare(page, 'body', 12000); } catch {}

            // Now do EVERYTHING via fetch() inside the browser page
            // Search + device details in ONE page.evaluate() call
            const result = await page.evaluate(async ({ query, limit, types }) => {
                const apiFetch = async (url) => {
                    const ctrl = new AbortController();
                    const tid = setTimeout(() => ctrl.abort(), 5000);
                    try {
                        const r = await fetch(url, {
                            signal: ctrl.signal,
                            headers: { Accept: 'application/json' },
                        });
                        clearTimeout(tid);
                        if (!r.ok) return null;
                        return await r.json();
                    } catch { clearTimeout(tid); return null; }
                };

                // Step 1: Search all types in parallel
                const searchResults = (await Promise.all(
                    types.map(async type => {
                        const data = await apiFetch(
                            `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`
                        );
                        if (!Array.isArray(data)) return [];
                        return data.map(r => ({ ...r, content_type: r.content_type || type }));
                    })
                )).flat();

                if (!searchResults.length) return { searchResults: [], deviceData: null };

                // Step 2: Pick best match
                const q = query.toLowerCase().trim();
                const qSlug = q.replace(/\s+/g, '-');
                const item = (
                    searchResults.find(r => r.slug === q) ||
                    searchResults.find(r => r.slug === qSlug) ||
                    searchResults.find(r => r.name?.toLowerCase() === q) ||
                    searchResults.find(r => r.slug?.includes(qSlug)) ||
                    searchResults.find(r => r.name?.toLowerCase().includes(q)) ||
                    searchResults[0]
                );

                const slug = item.slug || item.url_name || item.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const type = item.content_type;

                // Step 3: Fetch device details JSON API — from same page, no new CF challenge
                // Try multiple API patterns nanoreview might expose
                let deviceData = null;

                // Try the device detail API endpoints
                const apiAttempts = [
                    `https://nanoreview.net/api/${type}/${slug}`,
                    `https://nanoreview.net/api/device/${slug}`,
                    `https://nanoreview.net/api/item/${slug}`,
                ];

                for (const apiUrl of apiAttempts) {
                    const data = await apiFetch(apiUrl);
                    if (data && typeof data === 'object' && !Array.isArray(data)) {
                        deviceData = data;
                        break;
                    }
                }

                return { searchResults, selectedItem: item, deviceData, slug, type };
            }, { query, limit, types });

            return { result, page };
        } catch (err) {
            await page.close().catch(() => {});
            throw err;
        }
    } catch (err) {
        await browser.close().catch(() => {});
        throw err;
    }
}

/**
 * If the JSON API doesn't return device details, fall back to scraping
 * the HTML page — but reuse the SAME browser context (no new CF challenge).
 */
async function scrapeDevicePageHtml(context, deviceUrl) {
    const page = await context.newPage();
    try {
        await page.route('**/*', route =>
            ['font', 'media', 'image'].includes(route.request().resourceType())
                ? route.abort() : route.continue()
        );
        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(800);

        const html = await page.content();
        return parseDeviceHtml(html, deviceUrl);
    } finally {
        await page.close().catch(() => {});
    }
}

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

    const seenImgs = new Set();
    $('img').each((_, img) => {
        const extractUrls = str => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
        const srcs = [
            $(img).attr('data-src'), $(img).attr('src'),
            ...extractUrls($(img).attr('srcset')),
            ...extractUrls($(img).attr('data-srcset')),
        ];
        srcs.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            if (src.startsWith('http') && !/(logo|icon|avatar|svg)/i.test(src) && !seenImgs.has(src)) {
                seenImgs.add(src); data.images.push(src);
            }
        });
    });

    $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
        const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim() || $(el).prev('div,p,span').text().trim();
        const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
        if (label && value && label !== value) data.scores[label] = value;
    });

    $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
    $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });

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

function mapJsonToDeviceData(jsonData, deviceUrl, item) {
    // Map whatever nanoreview's JSON API returns into our standard format
    return {
        title: jsonData.name || jsonData.title || item?.name || '',
        sourceUrl: deviceUrl,
        images: jsonData.image ? [jsonData.image] : (jsonData.images || []),
        scores: jsonData.scores || jsonData.ratings || {},
        pros: jsonData.pros || jsonData.advantages || [],
        cons: jsonData.cons || jsonData.disadvantages || [],
        specs: jsonData.specs || jsonData.specifications || jsonData.params || jsonData,
    };
}

// ── Public API ─────────────────────────────────────────────────────────────

export const getDeviceData = async (query, limit = 10) => {
    const cacheKey = `device_query:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    const { result, page: browserPage } = await fetchEverythingInOnePage(query, limit, types)
        .catch(err => { throw err; });

    const { searchResults, selectedItem, deviceData, slug, type } = result;

    if (!searchResults?.length) return null;

    const deviceUrl = `https://nanoreview.net/en/${type}/${slug}`;

    let finalData;

    if (deviceData && Object.keys(deviceData).length > 0) {
        // JSON API worked — fast path, no HTML scraping needed
        finalData = mapJsonToDeviceData(deviceData, deviceUrl, selectedItem);
        await browserPage.close().catch(() => {});
    } else {
        // JSON API returned nothing — scrape HTML using same context (no new CF challenge)
        const context = browserPage.context();
        await browserPage.close().catch(() => {});
        finalData = await scrapeDevicePageHtml(context, deviceUrl);
    }

    // Always close browser after we're done
    try { await browserPage.context().browser().close(); } catch {}

    finalData.searchResults = searchResults.map((r, i) => ({
        index: i,
        name: r.name,
        type: r.content_type,
        slug: r.slug || r.url_name,
    }));
    finalData.matchedDevice = selectedItem?.name;

    cache.set('device', cacheKey, finalData, TTL.device);
    return finalData;
};

// Keep these for routes that need them separately
export const searchDevices = async (context, query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);
    const page = await context.newPage();
    try {
        await page.route('**/*', route =>
            ['font', 'media', 'image', 'stylesheet'].includes(route.request().resourceType())
                ? route.abort() : route.continue()
        );
        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        try { await waitForCloudflare(page, 'body', 10000); } catch {}

        const results = await page.evaluate(async ({ query, limit, types }) => {
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

        const seen = new Set();
        const deduped = results.filter(r => { const s = r.slug || ''; if (seen.has(s)) return false; seen.add(s); return true; });
        deduped.sort((a, b) => scoreMatch(b.name, b.slug, query) - scoreMatch(a.name, a.slug, query));

        cache.set('search', cacheKey, deduped, TTL.search);
        return deduped;
    } finally {
        await page.close().catch(() => {});
    }
};

export const scrapeDevicePage = async (context, deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;
    const data = await scrapeDevicePageHtml(context, deviceUrl);
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (context, compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    const page = await context.newPage();
    try {
        await page.route('**/*', route =>
            ['font', 'media', 'image'].includes(route.request().resourceType()) ? route.abort() : route.continue()
        );
        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(800);
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').first().text().trim(), sourceUrl: compareUrl, images: [],
            device1: { name: '', score: '' }, device2: { name: '', score: '' }, comparisons: {},
        };
        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
            const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t);
        });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    const val1 = cells.eq(1).text().trim(); const val2 = cells.eq(2).text().trim();
                    if (feature) section[feature] = { [data.device1.name || 'Device 1']: val1, [data.device2.name || 'Device 2']: val2 };
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });
        cache.set('compare', compareUrl, data, TTL.compare);
        return data;
    } finally { await page.close().catch(() => {}); }
};

export const scrapeRankingPage = async (context, rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;
    const page = await context.newPage();
    try {
        await page.route('**/*', route =>
            ['font', 'media', 'image'].includes(route.request().resourceType()) ? route.abort() : route.continue()
        );
        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(800);
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
        cache.set('ranking', rankingUrl, data, TTL.ranking);
        return data;
    } finally { await page.close().catch(() => {}); }
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
