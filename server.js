/**
 * server.js - Fastify server
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { startWarmup, startPeriodicRefresh } from './worker.js';

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

const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3000', 10);
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`[server] Live: http://localhost:${port}`);

        // Warm cache in background (non-blocking)
        if (process.env.DISABLE_WARMUP !== '1') {
            startWarmup().catch(err => console.warn('[server] Cache warmup error:', err.message));
        }

        startPeriodicRefresh();
    } catch (err) {
        console.error('[server] Startup failed:', err);
        process.exit(1);
    }
};

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });
process.on('uncaughtException', (err) => console.error('[server] Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[server] Unhandled rejection:', reason));

start();
