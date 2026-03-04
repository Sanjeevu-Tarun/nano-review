import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from '../routes.js';

const fastify = Fastify({ logger: false });
fastify.register(cors, { origin: '*', methods: ['GET', 'OPTIONS'] });
setupRoutes(fastify);

export default async function handler(req, res) {
    await fastify.ready();
    fastify.server.emit('request', req, res);
}
