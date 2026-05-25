import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Three modes:
//   - serve         → dev server for the asia-building demo
//   - build (lib)   → the publishable npm package, output → dist/
//   - build --mode demo → static export of the asia-building demo, output →
//     dist-demo/. Use for hosting (drop the folder on any static host).
export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    return {
      root: 'examples/asia-building',
      server: { port: 5173, open: true },
      resolve: {
        // Array form so we can match subpaths via regex.
        // - `three-fenestra/starter/<file>` → repo-root `starter/<file>`
        // - `three-fenestra` (bare) → the TS entry, so dev edits hot-reload
        alias: [
          { find: /^three-fenestra\/starter\/(.*)$/, replacement: resolve(__dirname, 'starter/$1') },
          { find: /^three-fenestra$/, replacement: resolve(__dirname, 'src/index.ts') },
        ],
      },
    };
  }

  if (mode === 'demo') {
    return {
      root: 'examples/asia-building',
      base: './',
      build: {
        outDir: resolve(__dirname, 'dist-demo'),
        emptyOutDir: true,
        assetsInlineLimit: 0, // keep textures & models as real files, don't base64
      },
      resolve: {
        // Array form so we can match subpaths via regex.
        // - `three-fenestra/starter/<file>` → repo-root `starter/<file>`
        // - `three-fenestra` (bare) → the TS entry, so dev edits hot-reload
        alias: [
          { find: /^three-fenestra\/starter\/(.*)$/, replacement: resolve(__dirname, 'starter/$1') },
          { find: /^three-fenestra$/, replacement: resolve(__dirname, 'src/index.ts') },
        ],
      },
    };
  }

  // Library build.
  return {
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: ['three'],
      },
      sourcemap: true,
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
