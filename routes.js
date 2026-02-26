/**
 * routes.js - No browser management here.
 * scraper.js handles everything internally (HTTP first, browser fallback).
 * Uses app.inject() pattern from GSM Arena API for Vercel speed.
 */
import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
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

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query "q" required' });

        const t0 = Date.now();
        try {
            const results = await searchDevices(q, 5);
            if (!results?.length) return reply.status(404).send({ success: false, error: 'No devices found' });

            let item;
            if (index !== undefined) {
                item = results[Math.min(parseInt(index, 10) || 0, results.length - 1)];
            } else {
                item = results.find(r => r.name.toLowerCase() === q.toLowerCase()) || results[0];
            }

            const slug = getSlug(item);
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
            const data = await scrapeDevicePage(deviceUrl);

            data.matchedQuery = q;
            data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
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
            const [r1, r2] = await Promise.all([searchDevices(q1, 3), searchDevices(q2, 3)]);
            if (!r1.length || !r2.length) return reply.status(404).send({ success: false, error: 'Device(s) not found' });

            const item1 = r1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || r1[0];
            const item2 = r2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || r2[0];
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${getSlug(item1)}-vs-${getSlug(item2)}`;

            const data = await scrapeComparePage(compareUrl);
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
            const data = results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type,
                slug: getSlug(r), url: `https://nanoreview.net/en/${r.content_type}/${getSlug(r)}`,
            }));
            return reply.send({ success: true, contentType: 'suggestions', data, _ms: Date.now() - t0 });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query "type" required' });

        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({
            success: false,
            error: `Invalid type. Valid: ${Object.keys(RANKING_URLS).join(', ')}`,
        });

        const t0 = Date.now();
        try {
            const data = await scrapeRankingPage(targetUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (err) {
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    fastify.get('/health', async (req, reply) => {
        return reply.send({ status: 'ok', cache: cache.stats(), uptime: process.uptime() });
    });
};
