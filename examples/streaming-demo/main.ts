/**
 * three-fenestra Streaming Demo
 *
 * Demonstrates on-the-fly shader streaming for a multi-user building scene:
 *   • Scene hydrated from Supabase (window geometry + initial states)
 *   • Realtime updates via SupabaseShaderStream
 *   • Click-to-select windows with Raycaster
 *   • Customisation panel: sliders, texture upload, AI generation
 *   • Broadcast preview (live slider drag before committing to DB)
 *   • Presence: see which windows other users are editing
 *
 * Configuration:
 *   Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
 *   Set VITE_BUILDING_ID to the UUID of the building you want to render.
 */

import * as THREE from 'three';
import { GLTFLoader }             from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls }          from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer }         from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }             from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }        from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }             from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createClient }           from '@supabase/supabase-js';

import { InteriorMappingMaterial }  from '../../src/index.js';
import { TextureStreamCache, SupabaseShaderStream } from '../../src/streaming/index.js';
import type { BuildingWindowStateRow, PresencePayload } from '../../src/streaming/index.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  as string;
const SUPABASE_KEY  = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const BUILDING_ID   = import.meta.env.VITE_BUILDING_ID   as string ?? 'demo-building-uuid';
const EDGE_FUNCTION_BASE = `${SUPABASE_URL}/functions/v1`;

// ─────────────────────────────────────────────────────────────
// Scene setup
// ─────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping      = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 80, 300);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Lighting
const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x32363f, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d6, 1.6);
sun.position.set(80, 200, 100);
sun.castShadow = true;
scene.add(sun);

// Post-processing
const composer  = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.18, 0.4, 0.95,
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Raycaster for window selection
const raycaster  = new THREE.Raycaster();
const pointer    = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────
// Streaming infrastructure
// ─────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const textureCache = new TextureStreamCache({
  maxEntries: 128,
  anisotropy:  renderer.capabilities.getMaxAnisotropy(),
  onEvict: (url) => console.debug('[Cache evict]', url),
});

const stream = new SupabaseShaderStream(supabase, textureCache, {
  debug: import.meta.env.DEV,
});

// ─────────────────────────────────────────────────────────────
// Admin role
// ─────────────────────────────────────────────────────────────
let isAdmin = false;

async function checkAdminRole(): Promise<void> {
  try {
    const { data } = await supabase
      .from('admin_users')
      .select('user_id')
      .maybeSingle();
    isAdmin = !!data;
  } catch {
    isAdmin = false;
  }
  document.getElementById('admin-panel')!.classList.toggle('visible', isAdmin);
}

// ─────────────────────────────────────────────────────────────
// Scene state
// ─────────────────────────────────────────────────────────────

// Map from window_uuid → {mesh, material}
const windowMeshes = new Map<string, THREE.Mesh>();
const windowGroup  = new THREE.Group();
scene.add(windowGroup);

// Currently selected window
let selectedWindowId: string | null = null;
let currentVersion:   number        = 0;

// ─────────────────────────────────────────────────────────────
// Auth flow
// ─────────────────────────────────────────────────────────────
const loginOverlay  = document.getElementById('login-overlay')!;
const loginEmail    = document.getElementById('login-email')    as HTMLInputElement;
const loginPassword = document.getElementById('login-password') as HTMLInputElement;
const loginBtn      = document.getElementById('login-btn')!;
const anonBtn       = document.getElementById('anon-btn')!;
const loginError    = document.getElementById('login-error')!;

loginBtn.addEventListener('click', async () => {
  loginBtn.textContent = 'Signing in…';
  const { error } = await supabase.auth.signInWithPassword({
    email:    loginEmail.value.trim(),
    password: loginPassword.value,
  });
  if (error) {
    loginError.textContent = error.message;
    loginError.style.display = 'block';
    loginBtn.textContent = 'Sign In';
  } else {
    loginOverlay.remove();
    await checkAdminRole();
    initScene();
  }
});

anonBtn.addEventListener('click', () => {
  loginOverlay.remove();
  initScene();
});

// ─────────────────────────────────────────────────────────────
// Scene initialisation
// ─────────────────────────────────────────────────────────────
async function initScene(): Promise<void> {
  setStatus('loading', 'Loading building…');

  // Load default atlases (starter pack)
  const loader = new THREE.TextureLoader();
  const [defaultBackAtlas, defaultFrontAtlas, glassDirtMap] = await Promise.all([
    loader.loadAsync(new URL('../../starter/rooms.webp',   import.meta.url).href),
    loader.loadAsync(new URL('../../starter/overlay.webp', import.meta.url).href),
    // Optionally load glass dirt — skip gracefully if 404
    loader.loadAsync(new URL(
      '../asia-building/models/asia_building/textures/glass_dirt.png', import.meta.url,
    ).href).catch(() => null),
  ]);

  configureAtlas(defaultBackAtlas,  4, 4);
  configureAtlas(defaultFrontAtlas, 4, 4);

  // Load GLTF building model (optional — falls back to placeholder)
  await loadBuildingModel().catch(console.warn);

  // Subscribe to Supabase and hydrate window states
  await stream.subscribeTo(BUILDING_ID, async (rows: BuildingWindowStateRow[]) => {
    for (const row of rows) {
      const material = SupabaseShaderStream.buildMaterial(row, defaultBackAtlas, {
        defaultFrontAtlas,
        glassDirtMap: glassDirtMap ?? undefined,
      });

      const geom = new THREE.PlaneGeometry(row.width_m, row.height_m);
      const mesh = new THREE.Mesh(geom, material);

      // Orient via frame vectors
      const right  = new THREE.Vector3(row.right_x,  row.right_y,  row.right_z);
      const up     = new THREE.Vector3(row.up_x,     row.up_y,     row.up_z);
      const normal = new THREE.Vector3(row.normal_x, row.normal_y, row.normal_z);
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, up, normal),
      );
      mesh.position.set(row.center_x, row.center_y, row.center_z);
      mesh.position.addScaledVector(normal, 0.01);

      mesh.userData.windowUuid   = row.window_uuid;
      mesh.userData.windowIndex  = row.window_index;
      mesh.userData.floorNumber  = row.floor_number;
      mesh.userData.ownerUserId  = row.owner_user_id;

      windowGroup.add(mesh);
      windowMeshes.set(row.window_uuid, mesh);

      stream.registerMaterial(row.window_uuid, material, row, {
        onMaterialUpdated: () => renderer.render(scene, camera),
      });
    }

    setStatus('live', `Live · ${rows.length} windows`);
  });

  // Presence listener: show editor avatars
  stream.onPresenceUpdate(updatePresenceBar);

  // Start render loop
  animate();
}

// ─────────────────────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────────────────────
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  composer.render();
}

// ─────────────────────────────────────────────────────────────
// Window selection
// ─────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('click', onCanvasClick);

function onCanvasClick(e: MouseEvent): void {
  pointer.set(
    (e.clientX / window.innerWidth)  *  2 - 1,
    (e.clientY / window.innerHeight) * -2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...windowMeshes.values()]);
  if (hits.length === 0) {
    deselectWindow();
    return;
  }

  const mesh     = hits[0].object as THREE.Mesh;
  const windowId = mesh.userData.windowUuid as string;
  selectWindow(windowId, mesh);
}

function selectWindow(windowId: string, mesh: THREE.Mesh): void {
  selectedWindowId = windowId;
  currentVersion   = 0;

  const floorNum  = mesh.userData.floorNumber ?? '?';
  const winIndex  = mesh.userData.windowIndex ?? '?';
  const ownerId   = mesh.userData.ownerUserId;

  document.getElementById('panel-window-name')!.textContent  = `Window ${winIndex}`;
  document.getElementById('panel-window-sub')!.textContent   = `Floor ${floorNum}`;
  document.getElementById('panel')!.classList.add('open');

  // Show/hide claim button based on ownership
  const claimBtn  = document.getElementById('claim-btn')!;
  const releaseBtn = document.getElementById('release-btn')!;
  claimBtn.style.display   = ownerId ? 'none' : 'inline-flex';
  releaseBtn.style.display = ownerId === currentUserId() ? 'inline-flex' : 'none';

  const windowInfo = document.getElementById('window-info')!;
  document.getElementById('window-info-text')!.textContent = `Window ${winIndex} · Floor ${floorNum}`;
  windowInfo.classList.add('visible');

  stream.setFocusedWindow(BUILDING_ID, windowId);
}

function deselectWindow(): void {
  selectedWindowId = null;
  document.getElementById('panel')!.classList.remove('open');
  document.getElementById('window-info')!.classList.remove('visible');
  stream.setFocusedWindow(BUILDING_ID, null);
}

document.getElementById('panel-close')!.addEventListener('click', deselectWindow);

// ─────────────────────────────────────────────────────────────
// Slider / toggle broadcast (ephemeral preview)
// ─────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLInputElement>('input[type=range][data-uniform]').forEach((slider) => {
  const valSpan = slider.nextElementSibling as HTMLElement;
  slider.addEventListener('input', () => {
    const v    = parseFloat(slider.value);
    const key  = slider.dataset.uniform!;
    valSpan.textContent = v.toFixed(slider.step.includes('.')
      ? slider.step.split('.')[1].length
      : 0,
    );

    if (!selectedWindowId) return;

    // Broadcast ephemeral preview (no DB write yet)
    stream.broadcastUniformPreview(BUILDING_ID, selectedWindowId, { [key]: v } as never);
  });
});

document.querySelectorAll<HTMLElement>('.toggle[data-uniform]').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    toggle.classList.toggle('on');
    if (!selectedWindowId) return;
    stream.broadcastUniformPreview(BUILDING_ID, selectedWindowId, {
      isLit: toggle.classList.contains('on'),
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Commit / discard
// ─────────────────────────────────────────────────────────────
document.getElementById('commit-btn')!.addEventListener('click', async () => {
  if (!selectedWindowId) return;
  const state = collectPanelState();
  try {
    setStatus('loading', 'Publishing…');
    await stream.updateWindowState(selectedWindowId, state, currentVersion || undefined);
    setStatus('live', 'Saved ✓');
  } catch (err) {
    console.error('Commit failed:', err);
    setStatus('error', 'Save failed — conflict?');
  }
});

document.getElementById('discard-btn')!.addEventListener('click', () => {
  if (!selectedWindowId) return;
  stream.broadcastUniformPreview(BUILDING_ID, selectedWindowId, {}); // triggers re-hydrate
});

// ─────────────────────────────────────────────────────────────
// Claim / release window
// ─────────────────────────────────────────────────────────────
document.getElementById('claim-btn')!.addEventListener('click', async () => {
  if (!selectedWindowId) return;
  await stream.claimWindow(selectedWindowId);
  document.getElementById('claim-btn')!.style.display    = 'none';
  document.getElementById('release-btn')!.style.display  = 'inline-flex';
});

document.getElementById('release-btn')!.addEventListener('click', async () => {
  if (!selectedWindowId) return;
  await stream.releaseWindow(selectedWindowId);
  deselectWindow();
});

// ─────────────────────────────────────────────────────────────
// Texture upload
// ─────────────────────────────────────────────────────────────
const uploadZone  = document.getElementById('upload-zone')!;
const fileInput   = document.getElementById('back-file-input') as HTMLInputElement;

uploadZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleTextureUpload(file, 'back');
});

// Drag-and-drop
uploadZone.addEventListener('dragover',  (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop',      (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) handleTextureUpload(file, 'back');
});

async function handleTextureUpload(file: File, textureType: string): Promise<void> {
  if (!selectedWindowId) { alert('Select a window first'); return; }

  const progressWrap = document.getElementById('upload-progress')!;
  const progressBar  = progressWrap.querySelector('.progress-fill') as HTMLElement;
  progressWrap.style.display = 'block';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { alert('Sign in to upload textures'); return; }

    const form = new FormData();
    form.append('file',        file);
    form.append('windowId',    selectedWindowId);
    form.append('textureType', textureType);
    form.append('atlasCols',   '1');
    form.append('atlasRows',   '1');

    progressBar.style.width = '30%';

    const res = await fetch(`${EDGE_FUNCTION_BASE}/process-texture-upload`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body:    form,
    });

    progressBar.style.width = '80%';

    if (!res.ok) throw new Error(await res.text());
    const { url, atlasCols, atlasRows } = await res.json();
    progressBar.style.width = '100%';

    // Commit the new texture URL immediately
    await stream.updateWindowState(selectedWindowId, {
      back_atlas_url:  url,
      back_atlas_cols: atlasCols,
      back_atlas_rows: atlasRows,
    } as never);

    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);

  } catch (err) {
    console.error('Upload failed:', err);
    alert(`Upload failed: ${(err as Error).message}`);
    progressWrap.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// AI generation
// ─────────────────────────────────────────────────────────────
document.getElementById('ai-generate-btn')!.addEventListener('click', async () => {
  if (!selectedWindowId) { alert('Select a window first'); return; }

  const prompt    = (document.getElementById('ai-prompt') as HTMLTextAreaElement).value.trim();
  const layersStr = (document.getElementById('ai-layer-select') as HTMLSelectElement).value;

  if (!prompt) { alert('Enter a prompt'); return; }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { alert('Sign in to use AI generation'); return; }

  const aiProgress     = document.getElementById('ai-progress')!;
  const aiProgressFill = document.getElementById('ai-progress-fill')!;
  const aiStatusText   = document.getElementById('ai-status-text')!;

  aiProgress.style.display = 'block';
  aiProgressFill.style.width = '10%';
  aiStatusText.textContent = 'Submitting job…';

  try {
    const res = await fetch(`${EDGE_FUNCTION_BASE}/generate-pbr-textures`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        windowId: selectedWindowId,
        prompt,
        layers:   layersStr.split(','),
      }),
    });

    if (!res.ok) throw new Error(await res.text());
    const { jobId } = await res.json();

    aiStatusText.textContent = 'Generating textures…';

    // Subscribe to job progress via Realtime
    const jobChannel = supabase
      .channel(`job:${jobId}`)
      .on('postgres_changes', {
        event:  'UPDATE',
        schema: 'public',
        table:  'shader_generation_jobs',
        filter: `id=eq.${jobId}`,
      }, async (payload) => {
        const job = payload.new as { status: string; progress: number; result_urls: Record<string, string> };
        aiProgressFill.style.width = `${job.progress}%`;

        if (job.status === 'completed') {
          aiStatusText.textContent = 'Done! Applying textures…';
          await supabase.removeChannel(jobChannel);

          // Apply results
          const state: Record<string, unknown> = {};
          if (job.result_urls.back)      { state.back_atlas_url  = job.result_urls.back; state.back_atlas_cols = 1; state.back_atlas_rows = 1; }
          if (job.result_urls.front)     state.front_atlas_url     = job.result_urls.front;
          if (job.result_urls.normal)    state.front_normal_url    = job.result_urls.normal;
          if (job.result_urls.roughness) state.front_roughness_url = job.result_urls.roughness;

          await stream.updateWindowState(selectedWindowId!, state as never);
          setTimeout(() => { aiProgress.style.display = 'none'; }, 2000);

        } else if (job.status === 'failed') {
          aiStatusText.textContent = '✗ Generation failed';
          await supabase.removeChannel(jobChannel);
        }
      })
      .subscribe();

  } catch (err) {
    console.error('AI generation failed:', err);
    aiStatusText.textContent = '✗ Failed';
  }
});

// ─────────────────────────────────────────────────────────────
// Presence bar
// ─────────────────────────────────────────────────────────────
function updatePresenceBar(presences: PresencePayload[]): void {
  const bar = document.getElementById('presence-bar')!;
  bar.innerHTML = '';
  for (const p of presences.slice(0, 6)) {
    const el = document.createElement('div');
    el.className = 'avatar';
    el.style.background = p.color;
    el.title = p.username + (p.focusedWindowId ? ' (editing)' : '');
    el.textContent = (p.username[0] ?? '?').toUpperCase();
    bar.appendChild(el);
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function setStatus(kind: 'live' | 'loading' | 'error', text: string): void {
  const dot = document.getElementById('status-dot')!;
  dot.className = `status-dot ${kind}`;
  document.getElementById('status-text')!.textContent = text;
}

function collectPanelState(): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement>('input[type=range][data-uniform]').forEach((s) => {
    state[s.dataset.uniform!] = parseFloat(s.value);
  });
  document.querySelectorAll<HTMLElement>('.toggle[data-uniform]').forEach((t) => {
    state[t.dataset.uniform!] = t.classList.contains('on');
  });
  return state;
}

async function loadBuildingModel(): Promise<void> {
  const loader = new GLTFLoader();
  const gltf   = await loader.loadAsync(
    new URL('../asia-building/models/asia_building/scene.gltf', import.meta.url).href,
  );
  gltf.scene.traverse((n) => {
    if ((n as THREE.Mesh).isMesh) {
      const m = n as THREE.Mesh;
      m.castShadow    = true;
      m.receiveShadow = true;
    }
  });
  scene.add(gltf.scene);
}

function configureAtlas(tex: THREE.Texture, cols: number, rows: number): void {
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter       = THREE.LinearMipmapLinearFilter;
  tex.magFilter       = THREE.LinearFilter;
  tex.wrapS           = THREE.ClampToEdgeWrapping;
  tex.wrapT           = THREE.ClampToEdgeWrapping;
  tex.anisotropy      = renderer.capabilities.getMaxAnisotropy();
  tex.userData        = { cols, rows };
  tex.needsUpdate     = true;
}

function currentUserId(): string | null {
  // Synchronous peek — session is cached after login
  const session = (supabase.auth as unknown as { currentSession?: { user?: { id?: string } } }).currentSession;
  return session?.user?.id ?? null;
}

// ─────────────────────────────────────────────────────────────
// Admin operations
// ─────────────────────────────────────────────────────────────

async function callAdminOp(body: Record<string, unknown>): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');

  const res = await fetch(`${EDGE_FUNCTION_BASE}/admin-operations`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
}

document.getElementById('admin-delete-texture-btn')!.addEventListener('click', async () => {
  if (!selectedWindowId) { alert('Select a window first'); return; }
  if (!confirm(`Delete ALL textures for this window and reset its shader state?\n\nThis cannot be undone.`)) return;

  const statusEl = document.getElementById('admin-status')!;
  statusEl.textContent = '⏳ Deleting…';
  try {
    await callAdminOp({ action: 'deleteWindowTexture', windowId: selectedWindowId });
    statusEl.textContent = '✓ Window texture deleted';
    deselectWindow();
  } catch (err) {
    statusEl.textContent = `✗ ${(err as Error).message}`;
    console.error('Admin delete failed:', err);
  }
});

document.getElementById('admin-reset-building-btn')!.addEventListener('click', async () => {
  if (!confirm(`⚠️ RESET ENTIRE BUILDING?\n\nThis will delete ALL custom textures and shader states for every window in the building.\n\nThis cannot be undone.`)) return;

  const statusEl = document.getElementById('admin-status')!;
  statusEl.textContent = '⏳ Resetting building…';
  try {
    const res = await (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const r = await fetch(`${EDGE_FUNCTION_BASE}/admin-operations`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetBuilding', buildingId: BUILDING_ID }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    })();
    statusEl.textContent = `✓ Reset ${res.deletedStateCount} windows, removed ${res.deletedStoragePaths.length} files`;
    deselectWindow();
  } catch (err) {
    statusEl.textContent = `✗ ${(err as Error).message}`;
    console.error('Admin reset failed:', err);
  }
});

// Resize handler
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
