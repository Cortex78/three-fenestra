/**
 * Vite config for the streaming demo.
 * Run with: npm run dev:streaming  (port 5174)
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'examples/streaming-demo',
  server: { port: 5174, open: true },
  resolve: {
    alias: [
      { find: /^three-fenestra\/streaming$/, replacement: resolve(__dirname, 'src/streaming/index.ts') },
      { find: /^three-fenestra\/starter\/(.*)$/, replacement: resolve(__dirname, 'starter/$1') },
      { find: /^three-fenestra$/,               replacement: resolve(__dirname, 'src/index.ts') },
    ],
  },
});
