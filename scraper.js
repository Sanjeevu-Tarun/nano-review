import * as cheerio from 'cheerio';
import { getPooledPage, waitForCloudflare, safeNavigate } from './browser.js';
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

/**
 * THE KEY FIX:
 * Nanoreview's JSON search API sometimes returns items with no slug field.
 * Instead of guessing the slug from the name, we do ONE browser navigation
 * to nanoreview.net/en/ and then:
 * 1. Call search JSON API via fetch() — gets name + type (+ slug if available)
 * 2. Intercept the actual page navigation to get the REAL URL with slug
 * 3. Navigate directly to the device page in the same tab
 * 4. Extract HTML — all in ONE page, ONE CF pass
 */
export const searchAndFetch = async (query, limit = 10) => {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);
    const page = await getPooledPage();

    try {
        // Navigate to nanoreview — pass CF once
        await safeNavigate(page, 'https://nanoreview.net/en/');
        await waitForCloudflare(page, 10000);

        // Step 1: Search API — get all results including real slugs
        // We intercept ALL fetch/XHR responses to capture search API responses
        const searchResults = await page.evaluate(async ({ query, limit, types }) => {
            const results = [];

            await Promise.all(types.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                    const r = await fetch(url, { headers: { Accept: 'application/json' } });
                    if (!r.ok) return;
                    const data = await r.json();
                    if (Array.isArray(data)) {
                        data.forEach(item => {
                            results.push({ ...item, content_type: item.content_type || type });
                        });
                    }
                } catch {}
            }));

            return results;
        }, { query, limit, types });

        console.log('[search] results count:', searchResults.length);
        if (searchResults.length > 0) {
            console.log('[search] first item keys:', Object.keys(searchResults[0]));
            console.log('[search] first item:', JSON.stringify(searchResults[0]));
        }

        if (!searchResults.length) return null;

        // Dedupe and sort
        const seen = new Set();
        const deduped = searchResults.filter(r => {
            // Use any available identifier to dedupe
            const key = r.slug || r.url_name || r.url || r.id || r.name;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        deduped.sort((a, b) => {
            const sA = a.slug || a.url_name || a.url || '';
            const sB = b.slug || b.url_name || b.url || '';
            return scoreMatch(b.name, sB, query) - scoreMatch(a.name, sA, query);
        });

        const item = pickBestMatch(deduped, query);
        console.log('[search] picked item:', JSON.stringify(item));

        // Step 2: Get the real device URL
        // Priority: use slug/url_name if present, else navigate to search results page
        // and extract the real href from the HTML
        let deviceUrl = null;

        if (item.slug) {
            deviceUrl = `https://nanoreview.net/en/${item.content_type}/${item.slug}`;
        } else if (item.url_name) {
            deviceUrl = `https://nanoreview.net/en/${item.content_type}/${item.url_name}`;
        } else if (item.url && item.url.startsWith('http')) {
            deviceUrl = item.url;
        } else if (item.url) {
            deviceUrl = `https://nanoreview.net${item.url}`;
        } else {
            // No slug at all — navigate to search results page and extract real href
            console.log('[search] No slug found, scraping search page for real URL...');

            const searchPageUrl = `https://nanoreview.net/en/search?q=${encodeURIComponent(query)}`;
            await safeNavigate(page, searchPageUrl);
            await page.waitForTimeout(500);

            const foundUrl = await page.evaluate((itemName) => {
                // Look for a link whose text matches the device name
                const links = [...document.querySelectorAll('a[href]')];
                for (const link of links) {
                    const text = link.textContent?.trim() || '';
                    const href = link.getAttribute('href') || '';
                    // Match by name similarity
                    if (text.toLowerCase().includes(itemName.toLowerCase().split(' ').slice(-1)[0].toLowerCase())
                        && (href.includes('/phone/') || href.includes('/tablet/') || href.includes('/laptop/')
                            || href.includes('/cpu/') || href.includes('/gpu/') || href.includes('/soc/'))) {
                        return href.startsWith('http') ? href : `https://nanoreview.net${href}`;
                    }
                }

                // Fallback: grab first device link on page
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    if (/\/(phone|tablet|laptop|cpu|gpu|soc)\/[a-z0-9-]+/.test(href)) {
                        return href.startsWith('http') ? href : `https://nanoreview.net${href}`;
                    }
                }
                return null;
            }, item.name);

            if (foundUrl) {
                deviceUrl = foundUrl;
                console.log('[search] Found real URL from search page:', deviceUrl);
            } else {
                // Last resort: generate slug from name
                const generatedSlug = item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                deviceUrl = `https://nanoreview.net/en/${item.content_type}/${generatedSlug}`;
                console.log('[search] Generated slug URL:', deviceUrl);
            }
        }

        console.log('[search] device URL:', deviceUrl);

        // Check cache
        const deviceCached = cache.get('device', deviceUrl);
        if (deviceCached) {
            deviceCached.searchResults = deduped.map((r, i) => ({
                index: i, name: r.name, type: r.content_type,
                slug: r.slug || r.url_name || r.url || null,
            }));
            deviceCached.matchedDevice = item.name;
            return deviceCached;
        }

        // Step 3: Navigate to device page in SAME tab (already past CF, instant load)
        await safeNavigate(page, deviceUrl);
        await page.waitForTimeout(300);

        const html = await page.content();
        const data = parseDeviceHtml(html, deviceUrl);

        data.searchResults = deduped.map((r, i) => ({
            index: i, name: r.name, type: r.content_type,
            slug: r.slug || r.url_name || r.url || null,
        }));
        data.matchedDevice = item.name;

        cache.set('device', deviceUrl, data, TTL.device);
        cache.set('device', cacheKey, data, TTL.device);
        return data;

    } finally {
        await page.close().catch(() => {});
    }
};

function parseDeviceHtml(html, url) {
    const $ = cheerio.load(html);

    // Try __NEXT_DATA__ (Next.js sites embed full data as JSON — no selector needed)
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

// ── Other scrapers (compare, ranking) ─────────────────────────────────────

async function browserFetchHtml(url) {
    const page = await getPooledPage();
    try {
        await safeNavigate(page, url);
        await page.waitForTimeout(200);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);
    const page = await getPooledPage();
    try {
        await safeNavigate(page, 'https://nanoreview.net/en/');
        await waitForCloudflare(page, 10000);
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
        const deduped = results.filter(r => { const k = r.slug || r.name; if (seen.has(k)) return false; seen.add(k); return true; });
        deduped.sort((a, b) => scoreMatch(b.name, b.slug || '', query) - scoreMatch(a.name, a.slug || '', query));
        cache.set('search', cacheKey, deduped, TTL.search);
        return deduped;
    } finally { await page.close().catch(() => {}); }
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
        title: $('h1').first().text().trim(), sourceUrl: compareUrl,
        device1: { name: '' }, device2: { name: '' }, comparisons: {},
    };
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
        $(row).find('td').each((i, td) => { item[headers[i]?.toLowerCase().replace(/\s+/g, '_') || `col_${i}`] = $(td).text().trim(); });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    return data;
};
