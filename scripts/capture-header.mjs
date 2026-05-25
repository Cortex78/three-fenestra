// Deterministic capture of the README header composition.
//
// Renders assets/header/index.html through headless Chromium. Each frame:
// pause the bg video, seek it to fractional time, step every CSS animation
// to the same time, wait one paint, screenshot. Encode with ffmpeg.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ASSETS = join(ROOT, 'assets');

const FPS = process.env.FPS ? parseInt(process.env.FPS, 10) : 60;
const DURATION_S = process.env.DURATION ? parseFloat(process.env.DURATION) : 10;
const COUNT = FPS * DURATION_S;
const VIDEO_SIZE = { width: 1280, height: 720 };

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
function waitForLine(child, regex, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      const s = stripAnsi(buf.toString());
      process.stdout.write(s);
      const m = s.match(regex);
      if (m) { cleanup(); resolve(m); }
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${regex}`)); }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}
async function startVite() {
  // Positional `.` overrides the config's root so assets/ is reachable.
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

const framesDir = join(ASSETS, '.header-frames-tmp');
if (existsSync(framesDir)) await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const { vite, host } = await startVite();
try {
  const url = `${host}/assets/header/index.html`;
  console.log(`[capture-header] ${url}  (${COUNT} frames @ ${FPS}fps)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIDEO_SIZE,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));

  await page.goto(url, { waitUntil: 'load' });
  // Wait for video metadata + first paint.
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2;
  }, null, { timeout: 15_000 });

  // Pause everything immediately so we can drive time ourselves.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.pause();
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.getAnimations()) a.pause();
    }
  });

  for (let i = 0; i < COUNT; i++) {
    const tSec = i / FPS;
    await page.evaluate(async (tSec) => {
      const v = document.querySelector('video');
      // Seek the bg video.
      const seeked = new Promise(r => { v.onseeked = r; });
      v.currentTime = tSec;
      await seeked;
      // Step every CSS animation in lockstep.
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.getAnimations()) a.currentTime = tSec * 1000;
      }
      // Two RAFs to let layout + paint settle (backdrop-filter, SVG filter).
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, tSec);

    const out = join(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: out, type: 'png' });
    if (i % 20 === 0 || i === COUNT - 1) {
      console.log(`[capture-header]   frame ${i + 1}/${COUNT}  t=${tSec.toFixed(3)}s`);
    }
  }

  await ctx.close();
  await browser.close();

  // First pass: encode the raw frame sequence.
  const rawVideo = join(ASSETS, '.header-raw.mp4');
  console.log(`[capture-header] encoding raw frames → ${rawVideo}`);
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-i', join(framesDir, 'frame-%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '20',
      '-movflags', '+faststart',
      rawVideo,
    ], { stdio: 'inherit' });
    ff.on('exit', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
  });
  await rm(framesDir, { recursive: true, force: true });

  // Second pass: seamless-loop via xfade. Take the raw clip, crossfade its
  // last XFADE_S into a fresh copy of itself starting at t=0. The resulting
  // tail blends end-frame → start-frame, so the loop point becomes invisible
  // (both camera-jump and any leftover foreground state vanish into the
  // blend). Output keeps the original duration.
  const XFADE_S = 0.6;
  const outVideo = join(ASSETS, 'header-cinematic.mp4');
  console.log(`[capture-header] seamless-looping → ${outVideo}`);
  await new Promise((res, rej) => {
    const filter = [
      `[0:v]trim=0:${DURATION_S - XFADE_S},setpts=PTS-STARTPTS[head]`,
      `[0:v]trim=${DURATION_S - XFADE_S}:${DURATION_S},setpts=PTS-STARTPTS[tail]`,
      `[1:v]trim=0:${XFADE_S},setpts=PTS-STARTPTS[start]`,
      `[tail][start]xfade=transition=fade:duration=${XFADE_S}:offset=0[blend]`,
      `[head][blend]concat=n=2:v=1[v]`,
    ].join(';');
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', rawVideo,
      '-i', rawVideo,
      '-filter_complex', filter,
      '-map', '[v]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '20',
      '-movflags', '+faststart',
      outVideo,
    ], { stdio: 'inherit' });
    ff.on('exit', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
  });
  await rm(rawVideo, { force: true });
  console.log(`[capture-header] wrote ${outVideo}`);
} finally {
  await stopVite(vite);
}
process.exit(0);
