import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/server.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

let appPromise: ReturnType<typeof initApp> | null = null;

async function initApp() {
  await migrate();
  await seed();
  const app = await buildApp({ logger: true });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!appPromise) {
    appPromise = initApp().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  const app = await appPromise;
  app.server.emit('request', req, res);
}
