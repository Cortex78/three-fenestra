import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // Use jsdom so DOM globals (EventTarget, URL, etc.) are available
    environment: 'jsdom',

    // Only run files in __tests__/ directories inside src/
    include: ['src/**/__tests__/**/*.test.ts'],

    // Coverage via V8 (built-in; no extra binary needed)
    coverage: {
      provider: 'v8',
      include:  ['src/streaming/**/*.ts'],
      exclude:  ['src/streaming/__tests__/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },

    // Slightly more verbose output so failures are easy to read in CI
    reporters: ['verbose'],
  },

  resolve: {
    alias: [
      // Allow test imports of `../types.js` → the TS source
      { find: /^(\.+\/.+)\.js$/, replacement: '$1' },
      // Allow `three-fenestra` bare import
      { find: /^three-fenestra$/, replacement: resolve(__dirname, 'src/index.ts') },
    ],
  },
});
