import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // The suite is fully offline; anything hitting the network is a bug.
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
