import { searchAndFetch, searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage, pickBestMatch } from './scraper.js';
import { cache } from './cache.js';

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

const getSlug = r => r.slug || r.url_name || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query "q" required' });
        const t0 = Date.now();
        try {
            if (index !== undefined) {
                // Index mode: search first, then fetch by index
                const results = await searchDevices(q, 10);
                if (!results?.length) return reply.status(404).send({ success: false, error: 'No devices found' });
                const item = results[Math.min(parseInt(index, 10) || 0, results.length - 1)];
                const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${getSlug(item)}`;
                const data = await scrapeDevicePage(deviceUrl);
                data.matchedQuery = q;
                data.matchedDevice = item.name;
                data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
                data._ms = Date.now() - t0;
                return reply.send({ success: true, contentType: 'device_details', data });
            }

            // Normal mode: optimized single call
            const data = await searchAndFetch(q, 10);
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
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'q1 and q2 required' });
        const t0 = Date.now();
        try {
            // Search both in parallel
            const [r1, r2] = await Promise.all([searchDevices(q1, 5), searchDevices(q2, 5)]);
            if (!r1.length || !r2.length) return reply.status(404).send({ success: false, error: 'Device(s) not found' });
            const item1 = pickBestMatch(r1, q1), item2 = pickBestMatch(r2, q2);
            const data = await scrapeComparePage(`https://nanoreview.net/en/${item1.content_type}-compare/${getSlug(item1)}-vs-${getSlug(item2)}`);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query "q" required' });
        const t0 = Date.now();
        try {
            const results = await searchDevices(q, 10);
            return reply.send({ success: true, contentType: 'suggestions', _ms: Date.now() - t0,
                data: results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r), url: `https://nanoreview.net/en/${r.content_type}/${getSlug(r)}` })) });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: `Invalid type. Valid: ${Object.keys(RANKING_URLS).join(', ')}` });
        const t0 = Date.now();
        try {
            const data = await scrapeRankingPage(targetUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    fastify.get('/health', async (req, reply) =>
        reply.send({ status: 'ok', cache: cache.stats(), uptime: process.uptime() })
    );
};
