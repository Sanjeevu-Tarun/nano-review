import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmUp, getCFCookies, browserFetchDirect } from './browser.js';
import { prefetchBuildId } from './nextjs.js';
import { hasTlsClient } from './tlsclient.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 Server live on port ${port}`);

if (hasTlsClient()) {
    console.log('[startup] TLS client available — no browser warmup needed for most requests');
    // Prefetch Next.js buildId immediately (no browser needed with TLS client)
    prefetchBuildId('').catch(() => {});
    // Still launch browser in background as fallback — but don't block anything
    warmUp().catch(() => {});
} else {
    console.log('[startup] No TLS client — using browser. Warming up...');
    // Browser warmup is critical path when no TLS client
    warmUp()
        .then(async () => {
            const cookies = await getCFCookies() || '';
            await prefetchBuildId(cookies);
            console.log('[startup] Browser warm and ready');
        })
        .catch(err => console.warn('[startup] Warm-up failed:', err.message));
}

// ── Keep-alive: prevent Render free tier sleep ───────────────────────────────
const SELF = process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : (process.env.SELF_URL || `http://localhost:${port}`);

setInterval(async () => {
    try {
        await fetch(`${SELF}/health`, { signal: AbortSignal.timeout(5000) });
        console.log('[keepalive] ping ok');
    } catch {}
}, 10 * 60 * 1000).unref();

// ── CF cookie refresh every 20 min (only needed without TLS client) ──────────
setInterval(async () => {
    if (hasTlsClient()) return; // TLS client doesn't need cookies
    const cookies = await getCFCookies();
    if (!cookies) return;
    try {
        await browserFetchDirect('https://nanoreview.net/en/');
        console.log('[keepalive] CF refreshed');
    } catch {}
}, 20 * 60 * 1000).unref();
