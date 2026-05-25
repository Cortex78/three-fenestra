// Headless capture for the asia-building demo.
//
//   node scripts/capture.mjs [--shot] [--video]
//   node scripts/capture.mjs                  # both
//
// Assumes `npm run dev` is *not* already running; we start vite ourselves.

import { spawn } from 'node:child_process';
import { mkdir, rename, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ASSETS = join(ROOT, 'assets');

const args = new Set(process.argv.slice(2));
const wantShot = args.size === 0 || args.has('--shot');
const wantVideo = args.size === 0 || args.has('--video');

// Capture settings.
const VIEWPORT = { width: 2560, height: 1440 };
const DPR = 1;

// --shot accepts repeated `camT=<frac>:<label>` pairs to capture multiple frames.
const SHOT_VARIANTS = (() => {
  const fromArgs = process.argv.slice(2)
    .filter(a => a.startsWith('camT='))
    .map(a => {
      const v = a.slice(5);
      const [t, label] = v.split(':');
      return { t: parseFloat(t), label: label || `t${t}` };
    });
  if (fromArgs.length) return fromArgs;
  return [{ t: 0.92, label: 'wide' }];
})();
const VIDEO_URL = (host) =>
  `${host}/?night=1&hideUi=1`; // autoplay loop, no freeze

// Strip ANSI escape sequences from a string so we can grep the URL out of
// vite's coloured output even when env-var color flags are ignored.
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

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
  const vite = spawn('npx', ['vite', '--port', '5179', '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  vite.on('error', (e) => console.error('[vite spawn error]', e));
  const m = await waitForLine(vite, /Local:\s+(http:\/\/[^\s]+)/i, 45_000);
  // Trim trailing slash off the URL.
  const host = m[1].replace(/\/$/, '');
  console.log(`[capture] vite up at ${host}`);
  return { vite, host };
}

async function stopVite(vite) {
  return new Promise((res) => {
    vite.once('exit', () => res());
    vite.kill('SIGTERM');
    setTimeout(() => { try { vite.kill('SIGKILL'); } catch {} res(); }, 3000);
  });
}

async function takeScreenshots(host) {
  const browser = await chromium.launch({ headless: true });
  const outs = [];
  for (const v of SHOT_VARIANTS) {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DPR,
    });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[page error]', msg.text());
    });
    const url = `${host}/?night=1&hideUi=1&camT=${v.t}`;
    console.log(`[capture] screenshot ${v.label}: ${url}`);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__demoReady === true, null, { timeout: 30_000 });
    await page.waitForTimeout(800);
    const out = join(ASSETS, `demo-night-${v.label}.png`);
    await page.screenshot({ path: out, type: 'png', fullPage: false });
    console.log(`[capture] wrote ${out}`);
    outs.push(out);
    await ctx.close();
  }
  await browser.close();
  return outs;
}

// Deterministic video capture. We drive the cinematic clock from outside
// (window.__renderFrame) and screenshot one frame per call. Frame *render*
// can take as long as it needs; the *playback* fps is whatever we encode at.
async function recordVideo(host) {
  const FPS = process.env.FPS ? parseInt(process.env.FPS, 10) : 60;
  const DURATION_S = process.env.DURATION ? parseFloat(process.env.DURATION) : 10;
  const COUNT = FPS * DURATION_S;
  const VIDEO_SIZE = { width: 1280, height: 720 };
  // SSAA is tempting but headless Chromium uses software GL (swiftshader),
  // and the cost scales much worse than O(n²) with framebuffer size — 2× DPR
  // pushed per-frame render from ~50 ms to ~1.7 s. Stay at 1× and rely on
  // the renderer's built-in MSAA (4× by default with antialias: true).
  const SSAA = 1;

  // Natural-speed camera. The cinematic spline lives in real time, so we
  // just feed it elapsed = videoTime; the rise from the sidewalk plays at
  // its authored pace and we capture whatever fits inside DURATION_S.
  const camElapsedAt = (i) => i / FPS;
  // Palette locked at night (mix = 0) for the whole clip.
  const paletteMixAt = () => 0;

  const framesDir = join(ASSETS, '.frames-tmp');
  if (existsSync(framesDir)) await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIDEO_SIZE,
    deviceScaleFactor: SSAA,
  });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page error]', msg.text());
  });

  // Note: no ?night=1 here — the capture script drives the palette per-frame.
  const url = `${host}/?hideUi=1`;
  console.log(`[capture] video: ${url}  (${COUNT} frames @ ${FPS}fps, night, bottom→top)`);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__demoReady === true, null, { timeout: 30_000 });

  for (let i = 0; i < COUNT; i++) {
    const t = camElapsedAt(i);
    const mix = paletteMixAt(i);
    await page.evaluate(([t, mix]) => (window).__renderFrame(t, mix), [t, mix]);
    const out = join(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: out, type: 'png' });
    if (i % 20 === 0 || i === COUNT - 1) {
      console.log(`[capture]   frame ${i + 1}/${COUNT}  camT=${t.toFixed(2)}s mix=${mix.toFixed(2)}`);
    }
  }

  await ctx.close();
  await browser.close();

  // Encode to h264 mp4 — broadest playback compatibility, small file size.
  const outVideo = join(ASSETS, 'demo-cinematic.mp4');
  console.log(`[capture] encoding ${outVideo}`);
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-i', join(framesDir, 'frame-%04d.png'),
      // Lanczos downscale from the SSAA render (2560×1440) to the output
      // (1280×720). Acts as a high-quality AA pass on top of the renderer.
      '-vf', `scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:flags=lanczos`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '20',
      '-movflags', '+faststart',
      outVideo,
    ], { stdio: 'inherit' });
    ff.on('exit', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
  });
  await rm(framesDir, { recursive: true, force: true });
  console.log(`[capture] wrote ${outVideo}`);
  return outVideo;
}

const { vite, host } = await startVite();
try {
  if (wantShot)  await takeScreenshots(host);
  if (wantVideo) await recordVideo(host);
} finally {
  await stopVite(vite);
}
// Playwright sometimes leaves keep-alive timers / subprocesses that prevent
// node from exiting cleanly. Force it.
process.exit(0);
