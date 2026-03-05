import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from '../routes.js';

let app = null;

async function getApp() {
    if (app) return app;
    app = Fastify({ logger: false });
    await app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
    setupRoutes(app);
    await app.ready();
    return app;
}

export default async function handler(req, res) {
    const fastify = await getApp();
    fastify.server.emit('request', req, res);
}
