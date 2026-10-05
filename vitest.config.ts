import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    maxWorkers: 3,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
