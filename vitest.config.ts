import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://acl:acl@localhost:5433/acl_test',
      REDIS_URL: 'redis://localhost:6379/1',
      KEYS_FILE: 'keys/test.json',
      ISSUER: 'http://localhost:4000',
      BOOTSTRAP_ADMIN_EMAIL: 'root@nsut.ac.in',
      INLINE_WORKER: 'false',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
  },
});
