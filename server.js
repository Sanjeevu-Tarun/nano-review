import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupTLS, getCFCookies, fetchHtml, destroyTLS } from './tls.js';
import { prefetchBuildId } from './nextjs.js';

const fastify = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
    },
});

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 NanoReview API v4 (zero-browser) on port ${port}\n`);

// Warm up TLS + buildId ASAP (non-blocking — first requests may be slightly slower)
(async () => {
    try {
        await warmupTLS();
        await prefetchBuildId();
        console.log('[startup] TLS warm + buildId ready ✅');
    } catch (err) {
        console.warn('[startup] Warm-up error:', err.message);
    }
})();

// Refresh CF cookies every 20 min
setInterval(async () => {
    if (!getCFCookies()) return;
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 10 });
        console.log('[keepalive] CF cookies refreshed');
    } catch (err) {
        console.warn('[keepalive] refresh failed:', err.message);
    }
}, 20 * 60 * 1000).unref();

process.on('SIGTERM', async () => {
    await destroyTLS();
    process.exit(0);
});
