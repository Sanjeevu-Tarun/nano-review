/**
 * routes.js - API routes
 * All browser management handled transparently inside scraper.js
 */
import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { cache } from './cache.js';

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu': 'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc': 'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu': 'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

function getSlug(item) {
    return item.slug ||
           item.url_name ||
           item.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export const setupRoutes = (fastify) => {

    // ── /api/search ──────────────────────────────────────────────────────
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        const t0 = Date.now();
        try {
            const results = await searchDevices(q, 5);
            if (!results || results.length === 0) {
                return reply.status(404).send({ success: false, error: 'No devices found' });
            }

            let item;
            if (index !== undefined) {
                const idx = Math.min(parseInt(index, 10) || 0, results.length - 1);
                item = results[idx];
            } else {
                item = results.find(r => r.name.toLowerCase() === q.toLowerCase()) || results[0];
            }

            const slug = getSlug(item);
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
            const data = await scrapeDevicePage(deviceUrl);

            data.matchedQuery = q;
            data.searchResults = results.map((r, i) => ({
                index: i,
                name: r.name,
                type: r.content_type,
                slug: getSlug(r),
            }));
            data._ms = Date.now() - t0;

            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/compare ─────────────────────────────────────────────────────
    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });

        const t0 = Date.now();
        try {
            const [results1, results2] = await Promise.all([
                searchDevices(q1, 3),
                searchDevices(q2, 3),
            ]);

            if (!results1.length || !results2.length) {
                return reply.status(404).send({ success: false, error: 'One or both devices not found' });
            }

            const item1 = results1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || results1[0];
            const item2 = results2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || results2[0];

            const slug1 = getSlug(item1);
            const slug2 = getSlug(item2);
            const type = item1.content_type;
            const compareUrl = `https://nanoreview.net/en/${type}-compare/${slug1}-vs-${slug2}`;

            const data = await scrapeComparePage(compareUrl);
            data._ms = Date.now() - t0;

            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/suggestions ─────────────────────────────────────────────────
    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        const t0 = Date.now();
        try {
            const results = await searchDevices(q, 10);
            const formattedResults = results.map((r, i) => {
                const slug = getSlug(r);
                return {
                    index: i,
                    name: r.name,
                    type: r.content_type,
                    slug,
                    url: `https://nanoreview.net/en/${r.content_type}/${slug}`,
                    _raw: r,
                };
            });
            return reply.send({ success: true, contentType: 'suggestions', data: formattedResults, _ms: Date.now() - t0 });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/rankings ────────────────────────────────────────────────────
    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });

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
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /health ──────────────────────────────────────────────────────────
    fastify.get('/health', async (req, reply) => {
        return reply.send({
            status: 'ok',
            cache: cache.stats(),
            uptime: process.uptime(),
        });
    });
};
