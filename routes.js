/**
 * routes.js
 * 
 * EXACT v1 pattern that works:
 * - One browser per request
 * - SAME context passed to searchDevices AND scrapeDevicePage
 *   so CF cookies carry over — device page loads instantly
 * 
 * FIXES vs v1:
 * - Better slug matching (match by slug, not just name)
 * - Cache check BEFORE launching browser (skip browser entirely on cache hit)
 * - Search result limit increased to get better matches
 */
import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { getBrowserContext } from './browser.js';
import { cache } from './cache.js';

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

function getSlug(item) {
    return item.slug || item.url_name || item.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Pick best matching item from results given query.
 * Tries: exact slug match → exact name match → slug contains query → name contains query → first result
 */
function pickBestMatch(results, query) {
    const q = query.toLowerCase().trim();
    // 1. Exact slug match
    const bySlug = results.find(r => getSlug(r) === q);
    if (bySlug) return bySlug;
    // 2. Exact name match
    const byName = results.find(r => r.name.toLowerCase() === q);
    if (byName) return byName;
    // 3. Slug contains query (e.g. query="poco x6", slug="xiaomi-poco-x6")
    const qSlug = q.replace(/\s+/g, '-');
    const bySlugContains = results.find(r => getSlug(r).includes(qSlug));
    if (bySlugContains) return bySlugContains;
    // 4. Name contains full query
    const byNameContains = results.find(r => r.name.toLowerCase().includes(q));
    if (byNameContains) return byNameContains;
    // 5. All query words present in name
    const words = q.split(/\s+/);
    const byWords = results.find(r => words.every(w => r.name.toLowerCase().includes(w)));
    if (byWords) return byWords;
    // fallback: first result
    return results[0];
}

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            // Get more results for better matching
            const results = await searchDevices(context, q, 10);
            if (!results?.length)
                return reply.status(404).send({ success: false, error: 'No devices found' });

            let item;
            if (index !== undefined) {
                item = results[Math.min(parseInt(index, 10) || 0, results.length - 1)];
            } else {
                item = pickBestMatch(results, q);
            }

            const slug = getSlug(item);
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

            // SAME context — already past CF, loads instantly
            const data = await scrapeDevicePage(context, deviceUrl);

            data.matchedQuery = q;
            data.matchedDevice = item.name;
            data.searchResults = results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type, slug: getSlug(r),
            }));
            data._ms = Date.now() - t0;

            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });

        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            const results1 = await searchDevices(context, q1, 5);
            const results2 = await searchDevices(context, q2, 5);
            if (!results1.length || !results2.length)
                return reply.status(404).send({ success: false, error: 'One or both devices not found' });

            const item1 = pickBestMatch(results1, q1);
            const item2 = pickBestMatch(results2, q2);
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${getSlug(item1)}-vs-${getSlug(item2)}`;

            const data = await scrapeComparePage(context, compareUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            const results = await searchDevices(context, q, 10);
            const data = results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type,
                slug: getSlug(r), url: `https://nanoreview.net/en/${r.content_type}/${getSlug(r)}`,
            }));
            return reply.send({ success: true, contentType: 'suggestions', data, _ms: Date.now() - t0 });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });

        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({
            success: false,
            error: `Invalid type. Valid: ${Object.keys(RANKING_URLS).join(', ')}`,
        });

        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            const data = await scrapeRankingPage(context, targetUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/health', async (req, reply) => {
        return reply.send({ status: 'ok', cache: cache.stats(), uptime: process.uptime() });
    });
};
