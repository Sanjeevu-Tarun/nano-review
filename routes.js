/**
 * routes.js
 * /api/search uses getDeviceData() — ONE browser open, ONE page,
 * fetches search + device details all via fetch() inside that page.
 * Much faster because no second page load / CF challenge.
 */
import { getDeviceData, searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
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

function pickBestMatch(results, query) {
    const q = query.toLowerCase().trim();
    const qSlug = q.replace(/\s+/g, '-');
    return (
        results.find(r => getSlug(r) === q) ||
        results.find(r => getSlug(r) === qSlug) ||
        results.find(r => r.name?.toLowerCase() === q) ||
        results.find(r => getSlug(r)?.includes(qSlug)) ||
        results.find(r => r.name?.toLowerCase().includes(q)) ||
        results.find(r => q.split(/\s+/).every(w => r.name?.toLowerCase().includes(w))) ||
        results[0]
    );
}

export const setupRoutes = (fastify) => {

    // Main search endpoint — uses single-page strategy
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        const t0 = Date.now();
        try {
            // If index is specified, we need to search first then pick by index
            if (index !== undefined) {
                let browser;
                try {
                    const b = await getBrowserContext();
                    browser = b.browser;
                    const results = await searchDevices(b.context, q, 10);
                    if (!results?.length) return reply.status(404).send({ success: false, error: 'No devices found' });

                    const item = results[Math.min(parseInt(index, 10) || 0, results.length - 1)];
                    const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${getSlug(item)}`;
                    const data = await scrapeDevicePage(b.context, deviceUrl);
                    data.matchedQuery = q;
                    data.matchedDevice = item.name;
                    data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
                    data._ms = Date.now() - t0;
                    return reply.send({ success: true, contentType: 'device_details', data });
                } finally {
                    if (browser) await browser.close().catch(() => {});
                }
            }

            // Normal flow: one-page fetch (search + details together)
            const data = await getDeviceData(q, 10);
            if (!data) return reply.status(404).send({ success: false, error: 'No devices found' });

            data.matchedQuery = q;
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
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
            const results = await searchDevices(b.context, q, 10);
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
            success: false, error: `Invalid type. Valid: ${Object.keys(RANKING_URLS).join(', ')}`,
        });

        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const data = await scrapeRankingPage(b.context, targetUrl);
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
