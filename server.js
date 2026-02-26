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

// Warm up immediately — browser + CF cookies + Next.js buildId all in parallel
warmUp()
    .then(async () => {
        const cookies = await getCFCookies() || '';
        await prefetchBuildId(cookies);
        console.log('[startup] Fully ready');
    })
    .catch(err => console.warn('[startup] Warm-up error:', err.message));

// ── Keep-alive: prevent Render free tier from sleeping ──────────────────────
// Render sleeps after 15 min inactivity → cold start → 13s per request
// Self-ping every 10 min keeps the process warm
const SELF = process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : (process.env.SELF_URL || `http://localhost:${port}`);

setInterval(async () => {
    try {
        await fetch(`${SELF}/health`, { signal: AbortSignal.timeout(5000) });
        console.log('[keepalive] ok');
    } catch {}
}, 10 * 60 * 1000).unref();

// ── CF cookie refresh every 20 min ──────────────────────────────────────────
setInterval(async () => {
    const cookies = await getCFCookies();
    if (!cookies) return;
    try {
        await browserFetchDirect('https://nanoreview.net/en/');
        console.log('[keepalive] CF refreshed');
    } catch {}
}, 20 * 60 * 1000).unref();
