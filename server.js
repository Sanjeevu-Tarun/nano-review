import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { getBrowserContext, closeBrowser } from './browser.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

setupRoutes(fastify);

// Warm up the browser before the first request hits
getBrowserContext().then(() => {
    fastify.log.info('Browser context ready');
}).catch(err => {
    fastify.log.warn('Browser warm-up failed, will retry on first request:', err.message);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        await fastify.close();
        await closeBrowser();
        process.exit(0);
    });
}

try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    console.log(`Server live: http://localhost:${process.env.PORT || 3000}`);
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}
