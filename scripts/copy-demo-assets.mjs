// Vite hashes and bundles the .gltf file referenced via import.meta.url, but
// doesn't follow the GLTF's *internal* references to sibling files like
// `scene.bin` and `textures/*.jpeg`. Copy those into dist-demo/assets/ so
// the GLTFLoader resolves them relative to the hashed gltf path at runtime.
//
// Same idea applies to any future model — add its sibling files here.

import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = resolve(ROOT, 'examples/asia-building/models/asia_building');
const DEST = resolve(ROOT, 'dist-demo/assets');

await mkdir(DEST, { recursive: true });

const items = [
  { from: 'scene.bin', to: 'scene.bin' },
  { from: 'textures',  to: 'textures'  },
];

for (const { from, to } of items) {
  const src = resolve(SRC, from);
  const dst = resolve(DEST, to);
  await cp(src, dst, { recursive: true });
  console.log(`[copy-demo-assets] ${from} → dist-demo/assets/${to}`);
}
