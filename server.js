import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

// Health check for Render
fastify.get('/health', async () => ({ status: 'ok' }));

setupRoutes(fastify);

const start = async () => {
    try {
        const port = parseInt(process.env.PORT) || 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Server live on port ${port}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();
