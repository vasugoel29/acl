import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { importUsersCsv, roleExpirySweep, semesterRollover } from './handlers.js';
import { exportUsersCsv } from './export.js';

export const QUEUE = 'acl-jobs';

function parseRedis() {
  const u = new URL(config.redisUrl);
  const dbPath = u.pathname && u.pathname.length > 1 ? Number.parseInt(u.pathname.slice(1), 10) : 0;
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(Number.isFinite(dbPath) && dbPath > 0 ? { db: dbPath } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null as null,
  };
}

let queue: Queue | null = null;
export function getQueue() {
  return (queue ??= new Queue(QUEUE, { connection: parseRedis() }));
}

export function startWorker() {
  const worker = new Worker(
    QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case 'import-users':
          return importUsersCsv(job.data.csv, job.data.actorId, job.id);
        case 'export-users':
          return exportUsersCsv(job.data.opts ?? {}, job.data.actorId, job.id);
        case 'rollover':
          return semesterRollover(job.data.opts ?? {}, job.data.actorId, job.id);
        case 'expiry-sweep':
          return roleExpirySweep();
        default:
          throw new Error(`unknown job ${job.name}`);
      }
    },
    { connection: parseRedis() },
  );
  // Hourly expiry sweep (idempotent scheduler upsert).
  getQueue().upsertJobScheduler('expiry-sweep', { pattern: '0 * * * *' }, { name: 'expiry-sweep', data: {} });
  return worker;
}
