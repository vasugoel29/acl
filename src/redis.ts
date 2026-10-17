import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const keys = {
  aclVersion: (userId: string) => `aclver:${userId}`,
  denyJti: (jti: string) => `deny:jti:${jti}`,
  denyUser: (userId: string) => `deny:user:${userId}`,
  pendingAuth: (id: string) => `pending:${id}`,
  access: (userId: string, appId: string) => `access:${userId}:${appId}`,
  rolloverLock: () => 'lock:semester_rollover',
};
