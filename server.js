import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmUp, getCFCookies, browserFetchDirect } from './browser.js';
import { prefetchBuildId } from './nextjs.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 Server live on port ${port}`);

// Start warmup immediately in background — don't block server startup.
// First request will wait on warmUpPromise if warmup isn't done yet.
warmUp()
    .then(async () => {
        const cookies = await getCFCookies() || '';
        await prefetchBuildId(cookies);
        console.log('[startup] Fully ready ✅');
    })
    .catch(err => console.warn('[startup] Warm-up error:', err.message));

// ── CF cookie refresh every 20 min ──────────────────────────────────────────
// Keeps the CF session alive so direct HTTP keeps working between requests.
setInterval(async () => {
    const cookies = await getCFCookies();
    if (!cookies) return;
    try {
        await browserFetchDirect('https://nanoreview.net/en/');
        console.log('[keepalive] CF cookies refreshed');
    } catch {}
}, 20 * 60 * 1000).unref();

// NOTE: To prevent Render free tier sleep (the main cause of 13s cold starts),
// set up UptimeRobot: https://uptimerobot.com
// → Add monitor → HTTP(s) → your-app.onrender.com/health → every 5 minutes
// This is FREE and keeps your service warm. Without it, every request after
// 15min idle will be a cold start regardless of any code optimizations.
