import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupTLS, getCFCookies } from './tls.js';
import { prefetchBuildId } from './nextjs.js';

const fastify = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
    },
});

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 NanoReview API v4 (zero-browser) live on port ${port}`);
console.log('   No Playwright, no Chromium — pure TLS impersonation\n');

// Warm up TLS session + pre-fetch buildId in background
// First real request will also trigger this if not done yet, but
// pre-warming means users get sub-100ms cache responses immediately.
warmupTLS()
    .then(async () => {
        await prefetchBuildId();
        console.log('[startup] TLS session warm + buildId ready ✅');
    })
    .catch(err => console.warn('[startup] Warm-up error:', err.message));

// Refresh CF cookies every 20 min (they last 30 min)
setInterval(async () => {
    const cookies = getCFCookies();
    if (!cookies) return; // not yet obtained, skip
    try {
        const { fetchHtml } = await import('./tls.js');
        await fetchHtml('https://nanoreview.net/en/', { timeout: 8000 });
        console.log('[keepalive] CF cookies refreshed');
    } catch (err) {
        console.warn('[keepalive] refresh failed:', err.message);
    }
}, 20 * 60 * 1000).unref();

// NOTE: Prevent Render free-tier sleep → use UptimeRobot (free)
// Monitor: https://your-app.onrender.com/health every 5 min
