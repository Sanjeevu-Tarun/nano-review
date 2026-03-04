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

    // GET /api/search?q=<query>[&index=<n>]
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q || !q.trim()) return reply.status(400).send({ success: false, error: 'Query "q" required' });
        const t0 = Date.now();
        try {
            if (index !== undefined) {
                const results = await searchDevices(q, 10);
                if (!results?.length) return reply.status(404).send({ success: false, error: 'No devices found for that query' });
                const idx = Math.min(parseInt(index, 10) || 0, results.length - 1);
                const item = results[idx];
                const url = `https://nanoreview.net/en/${item.content_type}/${getSlug(item)}`;
                const data = await scrapeDevicePage(url);
                if (!data) return reply.status(404).send({ success: false, error: 'Could not fetch device page' });
                data.matchedQuery = q;
                data.matchedDevice = item.name;
                data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
                data._ms = Date.now() - t0;
                return reply.send({ success: true, contentType: 'device_details', data });
            }

            const data = await searchAndFetch(q, 10);
            if (!data) return reply.status(404).send({ success: false, error: 'No devices found for that query' });
            data.matchedQuery = q;
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // GET /api/compare?q1=<query>&q2=<query>
    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Both q1 and q2 are required' });
        const t0 = Date.now();
        try {
            const [r1, r2] = await Promise.all([searchDevices(q1, 5), searchDevices(q2, 5)]);
            if (!r1?.length || !r2?.length) {
                const missing = !r1?.length ? q1 : q2;
                return reply.status(404).send({ success: false, error: `Device not found: "${missing}"` });
            }
            const item1 = pickBestMatch(r1, q1), item2 = pickBestMatch(r2, q2);
            if (!item1 || !item2) return reply.status(404).send({ success: false, error: 'Could not match one or both devices' });
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${getSlug(item1)}-vs-${getSlug(item2)}`;
            const data = await scrapeComparePage(compareUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // GET /api/suggestions?q=<query>
    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q || !q.trim()) return reply.status(400).send({ success: false, error: 'Query "q" required' });
        const t0 = Date.now();
        try {
            const results = await searchDevices(q, 10);
            return reply.send({
                success: true, contentType: 'suggestions', _ms: Date.now() - t0,
                data: (results || []).map((r, i) => ({
                    index: i, name: r.name, type: r.content_type,
                    slug: getSlug(r),
                    url: `https://nanoreview.net/en/${r.content_type}/${getSlug(r)}`,
                })),
            });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // GET /api/rankings?type=<type>
    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) {
            return reply.status(400).send({
                success: false,
                error: `Invalid type. Valid types: ${Object.keys(RANKING_URLS).join(', ')}`,
            });
        }
        const t0 = Date.now();
        try {
            const data = await scrapeRankingPage(targetUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // GET /health
    fastify.get('/health', async (req, reply) =>
        reply.send({ status: 'ok', cache: cache.stats(), uptime: Math.floor(process.uptime()) })
    );
};
