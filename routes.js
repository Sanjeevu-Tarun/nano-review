import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { getBrowserContext } from './browser.js';

// ─── Shared browser context (created once, reused across requests) ────────────
let sharedBrowser = null;
let sharedContext = null;
let browserInitializing = null;

async function getContext() {
    // If already alive, return it
    if (sharedContext && sharedBrowser?.isConnected()) {
        return { browser: sharedBrowser, context: sharedContext };
    }

    // Avoid parallel init races
    if (browserInitializing) return browserInitializing;

    browserInitializing = (async () => {
        try {
            const { browser, context } = await getBrowserContext();
            sharedBrowser = browser;
            sharedContext = context;

            // Clean up reference on unexpected close
            browser.on('disconnected', () => {
                sharedBrowser = null;
                sharedContext = null;
                browserInitializing = null;
            });

            return { browser, context };
        } finally {
            browserInitializing = null;
        }
    })();

    return browserInitializing;
}

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        try {
            const { context } = await getContext();
            const results = await searchDevices(context, q, 5);
            if (!results || results.length === 0) {
                return reply.status(404).send({ success: false, error: 'No devices found' });
            }

            let item;
            if (index !== undefined) {
                const idx = Math.min(parseInt(index, 10) || 0, results.length - 1);
                item = results[idx];
            } else {
                // Exact match first, then case-insensitive, then first result (already best-scored)
                item = results.find(r => r.name === q)
                    || results.find(r => r.name.toLowerCase() === q.toLowerCase())
                    || results[0];
            }

            const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
            const data = await scrapeDevicePage(context, deviceUrl);

            data.matchedQuery = q;
            data.searchResults = results.map((r, i) => ({
                index: i,
                name: r.name,
                type: r.content_type,
                slug: r.slug || r.url_name,
            }));

            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (error) {
            // If browser crashed, reset so next request gets a fresh one
            sharedBrowser = null; sharedContext = null;
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });

        try {
            const { context } = await getContext();
            const [results1, results2] = await Promise.all([
                searchDevices(context, q1, 3),
                searchDevices(context, q2, 3),
            ]);

            if (!results1.length || !results2.length)
                return reply.status(404).send({ success: false, error: 'One or both devices not found' });

            const item1 = results1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || results1[0];
            const item2 = results2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || results2[0];

            const slug1 = item1.slug || item1.url_name || item1.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const slug2 = item2.slug || item2.url_name || item2.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${slug1}-vs-${slug2}`;

            const data = await scrapeComparePage(context, compareUrl);
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (error) {
            sharedBrowser = null; sharedContext = null;
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        try {
            const { context } = await getContext();
            const results = await searchDevices(context, q, 10);
            const data = results.map((r, i) => {
                const slug = r.slug || r.url_name || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                return { index: i, name: r.name, type: r.content_type, slug, url: `https://nanoreview.net/en/${r.content_type}/${slug}` };
            });
            return reply.send({ success: true, contentType: 'suggestions', data });
        } catch (error) {
            sharedBrowser = null; sharedContext = null;
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });
        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: 'Invalid type. Valid: ' + Object.keys(RANKING_URLS).join(', ') });

        try {
            const { context } = await getContext();
            const data = await scrapeRankingPage(context, targetUrl);
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (error) {
            sharedBrowser = null; sharedContext = null;
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
};
