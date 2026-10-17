import { startWorker, getQueue } from './queue.js';
import { pool } from '../db/pool.js';
import { redis } from '../redis.js';

const worker = startWorker();
worker.on('error', (err) => {
  console.error('Worker error:', err);
});
console.log('worker started');

const shutdown = async (signal: string) => {
  console.log(`worker received ${signal}, shutting down gracefully...`);
  await worker.close();
  await getQueue().close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
