import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';

async function start() {
    const fastify = Fastify({ logger: true });
    await fastify.register(cors, {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    });
    setupRoutes(fastify);
    try {
        await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
        console.log(`Server live: http://localhost:${process.env.PORT || 3000}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
}

start();
