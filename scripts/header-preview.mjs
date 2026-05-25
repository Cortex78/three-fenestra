// One-shot preview of the header composition at a fixed moment, so we can
// look at the final layout before committing to a full video render.
//
// Important: serves the page via Vite over http:// rather than loading it
// as file://. Chromium treats every file:// URL as a unique origin and
// blocks SVG fragment refs (e.g. backdrop-filter: url(#liquid-glass)),
// which silently turns the liquid-glass distortion into plain blur.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Chromium is currently the *only* engine that supports url(#filter) in
// backdrop-filter (Safari and Firefox silently drop it). The page must be
// served over http:// — file:// origins block SVG fragment refs.
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = `${ROOT}/assets/header`;
await mkdir(OUT_DIR, { recursive: true });

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
function waitForLine(child, regex, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      const s = stripAnsi(buf.toString());
      process.stdout.write(s);
      const m = s.match(regex);
      if (m) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        clearTimeout(timer);
        resolve(m);
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`Timed out waiting for ${regex}`));
    }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}
async function startVite() {
  // Override the config's root (examples/asia-building) so the header at
  // assets/header/index.html is reachable. The config's alias for
  // 'three-fenestra' still applies — only --root is overridden.
  // Positional `.` overrides the config's root (examples/asia-building).
  const vite = spawn('npx', ['vite', '.', '--port', '5179', '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const m = await waitForLine(vite, /Local:\s+(http:\/\/[^\s]+)/i, 30_000);
  return { vite, host: m[1].replace(/\/$/, '') };
}
async function stopVite(vite) {
  return new Promise((res) => {
    vite.once('exit', () => res());
    vite.kill('SIGTERM');
    setTimeout(() => { try { vite.kill('SIGKILL'); } catch {} res(); }, 3000);
  });
}

const { vite, host } = await startVite();
const HEADER_URL = `${host}/assets/header/index.html`;

const SHOTS = [
  { t: 4.0,  label: 'mid' },   // logo + title + sub revealed
  { t: 9.0,  label: 'end' },   // install line visible
];

// Use system Chrome (not Playwright's bundled chrome-headless-shell), which
// has a more complete compositing path and actually applies SVG filters in
// backdrop-filter. Confirmed visually in desktop Chrome on this machine.
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-experimental-web-platform-features'],
});
for (const s of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('console', m => m.type() === 'error' && console.error('[page]', m.text()));
  await page.goto(HEADER_URL, { waitUntil: 'load' });
  // Wait a beat so the video can buffer + first frame paint.
  await page.waitForTimeout(500);
  // Drive the bg video and all CSS animations to the same wall-clock time.
  await page.evaluate(async (tSec) => {
    const v = document.querySelector('video');
    v.pause();
    v.currentTime = tSec;
    await new Promise(r => v.onseeked = r);
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.getAnimations()) {
        a.currentTime = tSec * 1000;
        a.pause();
      }
    }
    // Give backdrop-filter / paint one frame to settle.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, s.t);
  const out = `${OUT_DIR}/preview-${s.label}.png`;
  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote ${out}  (t=${s.t}s)`);
  await ctx.close();
}
await browser.close();
await stopVite(vite);
process.exit(0);
