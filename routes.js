import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { getBrowserContext } from './browser.js';

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

function getSlug(r) {
    return r.slug || r.url_name || (r.name||'').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
}

function pickBest(results, query) {
    if (!results?.length) return null;
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    return results.find(r => getSlug(r) === qs)
        || results.find(r => (r.name||'').toLowerCase() === q)
        || results.find(r => getSlug(r).includes(qs))
        || results.find(r => (r.name||'').toLowerCase().includes(q))
        || results[0];
}

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q?.trim()) return reply.status(400).send({ success: false, error: 'Query "q" is required' });
        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            const results = await searchDevices(context, q.trim(), 10);
            if (!results?.length) return reply.status(404).send({ success: false, error: `No devices found for "${q}"` });

            const item = index !== undefined
                ? results[Math.min(parseInt(index,10)||0, results.length-1)]
                : pickBest(results, q.trim());

            const slug = getSlug(item);
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
            const data = await scrapeDevicePage(context, deviceUrl);
            if (!data) return reply.status(404).send({ success: false, error: 'Could not fetch device page' });

            data.matchedQuery = q.trim();
            data.matchedDevice = item.name;
            data.searchResults = results.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: getSlug(r) }));
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Both q1 and q2 required' });
        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;

            const [r1, r2] = await Promise.all([
                searchDevices(context, q1.trim(), 5),
                searchDevices(context, q2.trim(), 5),
            ]);
            if (!r1?.length || !r2?.length)
                return reply.status(404).send({ success: false, error: `Device not found: "${!r1?.length ? q1 : q2}"` });

            const item1 = pickBest(r1, q1), item2 = pickBest(r2, q2);
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${getSlug(item1)}-vs-${getSlug(item2)}`;
            const data = await scrapeComparePage(context, compareUrl);
            data._ms = Date.now() - t0;
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q?.trim()) return reply.status(400).send({ success: false, error: 'Query "q" required' });
        const t0 = Date.now();
        let browser;
        try {
            const b = await getBrowserContext();
            browser = b.browser;
            const context = b.context;
            const results = await searchDevices(context, q.trim(), 10);
            return reply.send({
                success: true, contentType: 'suggestions', _ms: Date.now() - t0,
                data: (results||[]).map((r, i) => ({
                    index: i, name: r.name, type: r.content_type, slug: getSlug(r),
                    url: `https://nanoreview.net/en/${r.content_type}/${getSlug(r)}`,
                })),
            });
        } catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: `Invalid type. Valid: ${Object.keys(RANKING_URLS).join(', ')}` });
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
            fastify.log.error(err);
            return reply.status(500).send({ success: false, error: err.message });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });

    fastify.get('/health', async (req, reply) =>
        reply.send({ status: 'ok', version: '2.0.0' })
    );
};
