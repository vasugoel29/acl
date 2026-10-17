import { Queue, Worker, type Job } from 'bullmq';
import { createBullRedisConnection } from '../redis.js';
import { importUsersCsv, roleExpirySweep, semesterRollover } from './handlers.js';
import { exportUsersCsv } from './export.js';

export const QUEUE = 'acl-jobs';

let queue: Queue | null = null;
export function getQueue() {
  return (queue ??= new Queue(QUEUE, {
    connection: createBullRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: {
        age: 86400,
        count: 1000,
      },
      removeOnFail: {
        age: 7 * 86400,
      },
    },
  }));
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
    { connection: createBullRedisConnection() },
  );
  // Hourly expiry sweep (idempotent scheduler upsert).
  getQueue()
    .upsertJobScheduler('expiry-sweep', { pattern: '0 * * * *' }, { name: 'expiry-sweep', data: {} })
    .catch((err) => {
      console.error('Failed to upsert expiry-sweep job scheduler:', err);
    });
  return worker;
}
