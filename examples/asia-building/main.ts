import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pane } from 'tweakpane';
import { InteriorMappingMaterial } from 'three-fenestra';

type WindowDef = {
  center: [number, number, number];
  right:  [number, number, number];
  up:     [number, number, number];
  normal: [number, number, number];
  width: number;
  height: number;
};

// ─── URL params (for headless screenshot / video capture) ───────────────────
// ?night=1     force night palette and disable the day↔night autoplay
// ?hideUi=1    hide the title plate, tweakpane, and cinematic hint
// ?camT=0.65   freeze the cinematic camera at loop fraction t∈[0,1]
// ?play=1      keep the cinematic loop running (default when no camT)
const _params = new URLSearchParams(location.search);
const PARAM_NIGHT  = _params.get('night')  === '1';
const PARAM_HIDEUI = _params.get('hideUi') === '1';
const PARAM_CAM_T  = _params.has('camT') ? Math.max(0, Math.min(1, parseFloat(_params.get('camT')!))) : null;

if (PARAM_HIDEUI) {
  const css = document.createElement('style');
  css.textContent = '#title,#pane,#cinematic-overlay,#fps{display:none !important}';
  document.head.appendChild(css);
}

// ─── Quality tier (mobile vs desktop) ────────────────────────────────────────
// Phones run out of VRAM rendering this scene at full devicePixelRatio + 2K
// shadow map + bloom. Detect once and downgrade a few costs.
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/.test(navigator.userAgent)
              || matchMedia('(max-width: 900px), (pointer: coarse)').matches;
const MAX_DPR     = IS_MOBILE ? 1.5  : window.devicePixelRatio;
const SHADOW_SIZE = IS_MOBILE ? 1024 : 2048;

// ─── Renderer / scene / camera ────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: !IS_MOBILE, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 5000);

// ─── Environment map ─────────────────────────────────────────────────────────
// Real HDRI (Shanghai riverside) used as both the visible skybox and the PBR
// env map. Background rotation lets us frame the building against the better
// part of the panorama.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
new RGBELoader().load(
  new URL('./textures/shanghai_riverside_1k.hdr', import.meta.url).href,
  (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const env = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = env;
    scene.background = hdr;
    scene.backgroundBlurriness = 0.0;
    hdr.dispose = hdr.dispose;
  },
);

// Night sky: dark vertical gradient layered over the HDRI via a backside sphere.
// Mix factor is driven by palette `t` (0=day, 1=night). This lets us keep one
// HDRI but still sell "night" without swapping textures.
const nightSkyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTop:    { value: new THREE.Color(0x020409) },
    uBottom: { value: new THREE.Color(0x0a1426) },
    uMix:    { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldDir;
    void main() {
      vWorldDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vWorldDir;
    uniform vec3 uTop;
    uniform vec3 uBottom;
    uniform float uMix;
    void main() {
      float h = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 col = mix(uBottom, uTop, smoothstep(0.05, 0.7, h));
      gl_FragColor = vec4(col, uMix);
    }
  `,
  transparent: true,
});
const nightSky = new THREE.Mesh(new THREE.SphereGeometry(40000, 32, 16), nightSkyMat);
nightSky.renderOrder = 999; // draw after the background HDRI sphere so it can blend over it
scene.add(nightSky);

const _skySunDir = new THREE.Vector3();

// ─── Lights ──────────────────────────────────────────────────────────────────
const hemi = new THREE.HemisphereLight(0xb8d3ff, 0x2a2d36, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe6c2, 1.6);
sun.position.set(80, 120, 90);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.5;
scene.add(sun);
scene.add(sun.target);

// Warm street-level fill for night.
const streetA = new THREE.PointLight(0xffb070, 0.0, 80, 1.6);
const streetB = new THREE.PointLight(0xffc080, 0.0, 80, 1.6);
scene.add(streetA, streetB);

// ─── Post ────────────────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
// Bloom is the single most expensive pass; skip it on mobile.
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  IS_MOBILE ? 0 : 0.18, 0.4, 0.95,
);
if (!IS_MOBILE) composer.addPass(bloom);
composer.addPass(new OutputPass());

// ─── Palettes ────────────────────────────────────────────────────────────────
type Palette = {
  hemiSky: THREE.Color;  hemiGround: THREE.Color;  hemiIntensity: number;
  sunColor: THREE.Color; sunIntensity: number;
  sunElevationDeg: number;       // drives Sky shader + DirectionalLight direction
  skyTurbidity: number;
  skyRayleigh: number;
  nightSkyMix: number;           // 0 = pure Sky, 1 = night gradient
  streetIntensity: number; streetColor: THREE.Color;
  envIntensity: number;
  exposure: number;
  interiorEmissive: THREE.Color;
  frontTransmission: number;
  frontAlphaBoost: number;
  bloom: { strength: number; radius: number; threshold: number };
};

const dayPalette: Palette = {
  hemiSky:    new THREE.Color(0xcfe2ff), hemiGround: new THREE.Color(0x32363f), hemiIntensity: 0.45,
  sunColor:   new THREE.Color(0xfff0d6), sunIntensity: 1.6,
  sunElevationDeg: 55, skyTurbidity: 4.5, skyRayleigh: 2.0, nightSkyMix: 0.0,
  streetIntensity: 0.0, streetColor: new THREE.Color(0xffb070),
  envIntensity: 1.0,
  exposure: 0.95,
  interiorEmissive:  new THREE.Color(0.75, 0.75, 0.75),
  frontTransmission: 0.18,
  frontAlphaBoost:   1.15,
  bloom: { strength: 0.18, radius: 0.45, threshold: 0.95 },
};

const nightPalette: Palette = {
  hemiSky:    new THREE.Color(0x1a2236), hemiGround: new THREE.Color(0x080a10), hemiIntensity: 0.18,
  sunColor:   new THREE.Color(0x5e6f96), sunIntensity: 0.08,
  sunElevationDeg: -8, skyTurbidity: 10.0, skyRayleigh: 0.6, nightSkyMix: 1.0,
  streetIntensity: 8.0, streetColor: new THREE.Color(0xffb070),
  envIntensity: 0.15,
  exposure: 1.05,
  interiorEmissive:  new THREE.Color(1.75, 1.40, 1.0),
  frontTransmission: 0.08,
  frontAlphaBoost:   1.30,
  bloom: { strength: 0.45, radius: 0.55, threshold: 0.70 },
};

const livePalette: Palette = clonePalette(dayPalette);
function clonePalette(p: Palette): Palette {
  return {
    hemiSky:    p.hemiSky.clone(),  hemiGround: p.hemiGround.clone(),  hemiIntensity: p.hemiIntensity,
    sunColor:   p.sunColor.clone(), sunIntensity: p.sunIntensity,
    sunElevationDeg: p.sunElevationDeg, skyTurbidity: p.skyTurbidity,
    skyRayleigh: p.skyRayleigh, nightSkyMix: p.nightSkyMix,
    streetIntensity: p.streetIntensity, streetColor: p.streetColor.clone(),
    envIntensity: p.envIntensity,
    exposure: p.exposure,
    interiorEmissive: p.interiorEmissive.clone(),
    frontTransmission: p.frontTransmission,
    frontAlphaBoost:   p.frontAlphaBoost,
    bloom: { ...p.bloom },
  };
}

function lerpPalette(out: Palette, a: Palette, b: Palette, t: number): void {
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, t);
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.sunIntensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
  out.sunElevationDeg = THREE.MathUtils.lerp(a.sunElevationDeg, b.sunElevationDeg, t);
  out.skyTurbidity   = THREE.MathUtils.lerp(a.skyTurbidity,   b.skyTurbidity,   t);
  out.skyRayleigh    = THREE.MathUtils.lerp(a.skyRayleigh,    b.skyRayleigh,    t);
  out.nightSkyMix    = THREE.MathUtils.lerp(a.nightSkyMix,    b.nightSkyMix,    t);
  out.streetIntensity = THREE.MathUtils.lerp(a.streetIntensity, b.streetIntensity, t);
  out.streetColor.copy(a.streetColor).lerp(b.streetColor, t);
  out.envIntensity = THREE.MathUtils.lerp(a.envIntensity, b.envIntensity, t);
  out.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
  out.interiorEmissive.copy(a.interiorEmissive).lerp(b.interiorEmissive, t);
  out.frontTransmission = THREE.MathUtils.lerp(a.frontTransmission, b.frontTransmission, t);
  out.frontAlphaBoost   = THREE.MathUtils.lerp(a.frontAlphaBoost, b.frontAlphaBoost, t);
  out.bloom.strength  = THREE.MathUtils.lerp(a.bloom.strength,  b.bloom.strength,  t);
  out.bloom.radius    = THREE.MathUtils.lerp(a.bloom.radius,    b.bloom.radius,    t);
  out.bloom.threshold = THREE.MathUtils.lerp(a.bloom.threshold, b.bloom.threshold, t);
}

function applyPalette(p: Palette): void {
  renderer.toneMappingExposure = p.exposure;
  hemi.color.copy(p.hemiSky); hemi.groundColor.copy(p.hemiGround); hemi.intensity = p.hemiIntensity;
  sun.color.copy(p.sunColor); sun.intensity = p.sunIntensity;
  // Drive sun direction from palette elevation (HDRI sun is baked into the
  // environment map; this only steers the dynamic DirectionalLight).
  const phi = THREE.MathUtils.degToRad(90 - p.sunElevationDeg);
  const theta = THREE.MathUtils.degToRad(180);
  _skySunDir.setFromSphericalCoords(1, phi, theta);
  nightSkyMat.uniforms.uMix.value = p.nightSkyMix;
  scene.backgroundIntensity = THREE.MathUtils.lerp(1.0, 0.15, p.nightSkyMix);
  // Place the sun light along that direction, scaled to the scene.
  if (buildingBox) {
    const size = buildingBox.getSize(_tmpSize);
    const dist = Math.max(size.x, size.y, size.z) * 2.0;
    sun.position.copy(_skySunDir).multiplyScalar(dist).add(buildingCenter);
    sun.target.position.copy(buildingCenter);
    sun.target.updateMatrixWorld();
  }
  streetA.color.copy(p.streetColor); streetA.intensity = p.streetIntensity;
  streetB.color.copy(p.streetColor); streetB.intensity = p.streetIntensity;
  for (const m of buildingMaterials) m.envMapIntensity = p.envIntensity;
  for (const m of materials) {
    m.envMapIntensity = p.envIntensity;
    m.interiorEmissive  = p.interiorEmissive;
    m.frontTransmission = p.frontTransmission;
    m.frontAlphaBoost   = p.frontAlphaBoost;
  }
  bloom.strength  = p.bloom.strength;
  bloom.radius    = p.bloom.radius;
  bloom.threshold = p.bloom.threshold;
}

// ─── Atlases ─────────────────────────────────────────────────────────────────
const atlas = new THREE.TextureLoader().load(new URL('./textures/room-test.png', import.meta.url).href);
atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.minFilter = THREE.LinearMipmapLinearFilter;
atlas.magFilter = THREE.LinearFilter;
atlas.anisotropy = 8;

const overlayAtlas = new THREE.TextureLoader().load(new URL('./textures/overlay-test-trimmed.png', import.meta.url).href);
overlayAtlas.wrapS = overlayAtlas.wrapT = THREE.ClampToEdgeWrapping;
overlayAtlas.colorSpace = THREE.SRGBColorSpace;
overlayAtlas.minFilter = THREE.LinearMipmapLinearFilter;
overlayAtlas.magFilter = THREE.LinearFilter;
overlayAtlas.anisotropy = 8;

// Procedurally-generated (Inkscape from SVG feTurbulence) noise. Drives both
// the glass roughness modulation and the gentle refraction perturbation.
const glassDirt = new THREE.TextureLoader().load(new URL('./textures/glass_dirt.png', import.meta.url).href);
glassDirt.wrapS = glassDirt.wrapT = THREE.RepeatWrapping;
glassDirt.colorSpace = THREE.NoColorSpace; // linear data, not color
glassDirt.minFilter = THREE.LinearMipmapLinearFilter;
glassDirt.magFilter = THREE.LinearFilter;
glassDirt.anisotropy = 4;

// ─── Window planes ───────────────────────────────────────────────────────────
const windowGroup = new THREE.Group();
scene.add(windowGroup);

const sharedSettings = {
  depth: 0.83,
  backScale: 0.57,
  overlay: true,
  windowInset: -0.04,
  glassThickness: 0.039,
  refractionStrength: 0.0020,
  glassDirtStrength: 0.09,
  glassFresnelStrength: 0.55,
  glassSmudgeStrength: 0.08,
};
const materials: InteriorMappingMaterial[] = [];
const buildingMaterials: THREE.MeshStandardMaterial[] = [];
const _tmpSize = new THREE.Vector3();

function makeWindowMesh(w: WindowDef): THREE.Mesh {
  const insetFactor = 1.0 - sharedSettings.windowInset;
  const width  = w.width  * insetFactor;
  const height = w.height * insetFactor;

  const geom = new THREE.PlaneGeometry(width, height);
  const mat = new InteriorMappingMaterial({
    backAtlas: atlas,
    backAtlasCols: 4,
    backAtlasRows: 4,
    depth: sharedSettings.depth,
    backScale: sharedSettings.backScale,
    planeSize: new THREE.Vector2(width, height),
    windowId: new THREE.Vector3(...w.center),
    frontAtlas: sharedSettings.overlay ? overlayAtlas : undefined,
    frontAtlasCols: 4,
    frontAtlasRows: 4,
    glassThickness: sharedSettings.glassThickness,
    refractionStrength: sharedSettings.refractionStrength,
    glassDirtMap: glassDirt,
    glassDirtStrength: sharedSettings.glassDirtStrength,
    glassFresnelStrength: sharedSettings.glassFresnelStrength,
    glassSmudgeStrength: sharedSettings.glassSmudgeStrength,
    // PBR glass: very low roughness so the env-map shows up as a real specular
    // highlight, dielectric (metalness 0). Curtains/frames in the overlay atlas
    // are not separately authored — keeping the base low looks right for both
    // since the front diffuse multiplier still tints curtain pixels.
    roughness: 0.06,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  materials.push(mat);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  // Don't cast — the front layer is partially transparent; using its alpha for
  // shadows would need customDepthMaterial. Receiving keeps facade shadows on it.
  mesh.castShadow = false;
  const right  = new THREE.Vector3(...w.right);
  const up     = new THREE.Vector3(...w.up);
  const normal = new THREE.Vector3(...w.normal);
  const m = new THREE.Matrix4().makeBasis(right, up, normal);
  mesh.quaternion.setFromRotationMatrix(m);

  const eps = 0.05;
  mesh.position.set(
    w.center[0] + normal.x * eps,
    w.center[1] + normal.y * eps,
    w.center[2] + normal.z * eps,
  );
  return mesh;
}

function applySharedSettingsToMaterials(): void {
  for (const m of materials) {
    m.depth = sharedSettings.depth;
    m.backScale = sharedSettings.backScale;
    m.glassThickness = sharedSettings.glassThickness;
    m.refractionStrength = sharedSettings.refractionStrength;
    m.glassDirtStrength = sharedSettings.glassDirtStrength;
    m.glassFresnelStrength = sharedSettings.glassFresnelStrength;
    m.glassSmudgeStrength = sharedSettings.glassSmudgeStrength;
  }
}

// ─── Asset load ──────────────────────────────────────────────────────────────
const buildingP = new Promise<any>((resolve, reject) =>
  new GLTFLoader().load(
    new URL('./models/asia_building/scene.gltf', import.meta.url).href,
    resolve, undefined, reject,
  ),
);
const windowsP = fetch(new URL('./models/asia_building/windows.json', import.meta.url).href)
  .then(r => r.json()) as Promise<{ windows: WindowDef[] }>;

let buildingBox: THREE.Box3 | null = null;
let buildingCenter = new THREE.Vector3();

Promise.all([buildingP, windowsP]).then(([gltf, data]) => {
  const root = gltf.scene as THREE.Object3D;
  scene.add(root);

  let hidden = 0;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const mat = o.material;
    if (mat && (mat.name === 'build_01' || /build_01/i.test(mat.name))) {
      o.visible = false;
      hidden++;
      return;
    }
    if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      buildingMaterials.push(mat as THREE.MeshStandardMaterial);
    }
    o.castShadow = true;
    o.receiveShadow = true;
  });
  console.log(`hid ${hidden} build_01 mesh(es); spawning ${data.windows.length} window planes`);

  data.windows.forEach(w => windowGroup.add(makeWindowMesh(w)));

  const box = new THREE.Box3().setFromObject(root);
  buildingBox = box;
  buildingCenter = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  camera.near = maxDim / 500;
  camera.far  = maxDim * 30;
  camera.updateProjectionMatrix();

  // Sun shadow camera sized to the building's diagonal.
  const diag = size.length() * 0.7;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far  = maxDim * 6;
  sun.shadow.camera.left   = -diag;
  sun.shadow.camera.right  =  diag;
  sun.shadow.camera.top    =  diag;
  sun.shadow.camera.bottom = -diag;
  sun.shadow.camera.updateProjectionMatrix();

  controls.target.copy(buildingCenter);
  controls.minDistance = maxDim * 0.4;
  controls.maxDistance = maxDim * 4;

  // Position warm street lamps near the base, on the front side.
  const baseY = box.min.y + size.y * 0.04;
  const front = box.max.z + size.z * 0.05;
  streetA.position.set(buildingCenter.x - size.x * 0.35, baseY, front);
  streetB.position.set(buildingCenter.x + size.x * 0.35, baseY, front);

  applyPalette(livePalette);
  cinematic.ready = true;

  // URL-param overrides (headless capture).
  if (PARAM_NIGHT) {
    cinematicState.followAutoplay = false;
    paneBindings.autoplay = false;
    paneBindings.night = true;
    copyPalette(livePalette, nightPalette);
    applyPalette(livePalette);
  }
  if (PARAM_CAM_T !== null) {
    cinematic.playing = false;
    sampleCameraLoop(PARAM_CAM_T * cameraLoopSeconds, _camPos, _camTarget);
    camera.position.copy(_camPos);
    camera.lookAt(_camTarget);
    controls.target.copy(_camTarget);
  }
}).catch(err => console.error(err));

// ─── Controls (OrbitControls) ────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enabled = false; // off during cinematic

// ─── Cinematic camera ────────────────────────────────────────────────────────
const cinematic = {
  ready: false,
  playing: true,
  startTime: performance.now(),
  loopSeconds: 22,
};

const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

// Handheld cinematic on the modelled facade (+Z side). One continuous take:
// sidewalk look-up → step in and climb alongside the +X side close to the
// glass → cross the upper facade to show how many windows the shader covers
// → pull back into a wider frame that loops cleanly back to the start.
//
// Keys are expressed as fractions of the building box so the path adapts to
// whatever model is loaded. Position fractions:
//   px: offset from centre along X (− left / + right of facade)
//   py: height above building base, in fractions of size.y
//   pz: distance OUT from the facade (max.z + pz * size.z)
// Target fractions follow the same convention with tz relative to centre.z.

type CamKey = {
  t: number;
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
};

const cameraLoopSeconds = 38;

const cameraKeys: CamKey[] = [
  { t: 0.00, px:  0.18, py: 0.030, pz: 0.42,   tx:  0.05, ty: 0.55, tz: 0.0 }, // sidewalk, slight tilt up
  { t: 0.12, px:  0.14, py: 0.045, pz: 0.38,   tx:  0.02, ty: 0.78, tz: 0.0 }, // gaze rises toward the crown
  { t: 0.24, px:  0.34, py: 0.18,  pz: 0.22,   tx:  0.18, ty: 0.38, tz: 0.0 }, // step in alongside the +X side
  { t: 0.38, px:  0.46, py: 0.40,  pz: 0.14,   tx:  0.24, ty: 0.50, tz: 0.0 }, // close-up: gliding past windows
  { t: 0.54, px:  0.48, py: 0.68,  pz: 0.20,   tx:  0.18, ty: 0.78, tz: 0.0 }, // near the crown, still close
  { t: 0.68, px:  0.18, py: 0.78,  pz: 0.42,   tx:  0.00, ty: 0.70, tz: 0.0 }, // peel off, drift across upper facade
  { t: 0.82, px: -0.22, py: 0.72,  pz: 0.58,   tx: -0.12, ty: 0.62, tz: 0.0 }, // continue across, widen out
  { t: 0.92, px: -0.06, py: 0.46,  pz: 0.88,   tx: -0.02, ty: 0.52, tz: 0.0 }, // wide reset frame
  { t: 1.00, px:  0.18, py: 0.030, pz: 0.42,   tx:  0.05, ty: 0.55, tz: 0.0 }, // == key 0 for loop closure
];

function resolveKey(k: CamKey, outPos: THREE.Vector3, outTgt: THREE.Vector3): void {
  const size = buildingBox!.getSize(_tmpSize);
  const c = buildingCenter;
  const minY = buildingBox!.min.y;
  outPos.set(
    c.x + k.px * size.x,
    minY + k.py * size.y,
    buildingBox!.max.z + k.pz * size.z,
  );
  outTgt.set(
    c.x + k.tx * size.x,
    minY + k.ty * size.y,
    c.z + k.tz * size.z,
  );
}

// Cubic Hermite with uniform Catmull-Rom tangents on a closed loop.
// Velocity is continuous across keys (no per-keyframe pulse) and across
// the seam because key[N] == key[0] and the neighbour wrap uses modulo.
const _k0p = new THREE.Vector3(), _k0t = new THREE.Vector3();
const _k1p = new THREE.Vector3(), _k1t = new THREE.Vector3();
const _k2p = new THREE.Vector3(), _k2t = new THREE.Vector3();
const _k3p = new THREE.Vector3(), _k3t = new THREE.Vector3();

function hermite(p1: number, p2: number, m1: number, m2: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2*u3 - 3*u2 + 1) * p1 + (u3 - 2*u2 + u) * m1 + (-2*u3 + 3*u2) * p2 + (u3 - u2) * m2;
}

function sampleCameraLoop(elapsed: number, outPos: THREE.Vector3, outTgt: THREE.Vector3): void {
  if (!buildingBox) { outPos.set(0, 0, 0); outTgt.set(0, 0, 0); return; }
  const N = cameraKeys.length - 1; // unique points (last is a duplicate of first)
  const u = ((elapsed % cameraLoopSeconds) + cameraLoopSeconds) % cameraLoopSeconds / cameraLoopSeconds;
  let i = N - 1;
  for (let k = 0; k < N; k++) {
    if (u < cameraKeys[k + 1].t) { i = k; break; }
  }
  const k0 = cameraKeys[(i - 1 + N) % N];
  const k1 = cameraKeys[i];
  const k2 = cameraKeys[i + 1];
  const k3 = cameraKeys[(i + 2) % N];
  const segU = (u - k1.t) / (k2.t - k1.t);

  resolveKey(k0, _k0p, _k0t);
  resolveKey(k1, _k1p, _k1t);
  resolveKey(k2, _k2p, _k2t);
  resolveKey(k3, _k3p, _k3t);

  const mpx1 = 0.5 * (_k2p.x - _k0p.x), mpy1 = 0.5 * (_k2p.y - _k0p.y), mpz1 = 0.5 * (_k2p.z - _k0p.z);
  const mpx2 = 0.5 * (_k3p.x - _k1p.x), mpy2 = 0.5 * (_k3p.y - _k1p.y), mpz2 = 0.5 * (_k3p.z - _k1p.z);
  outPos.set(
    hermite(_k1p.x, _k2p.x, mpx1, mpx2, segU),
    hermite(_k1p.y, _k2p.y, mpy1, mpy2, segU),
    hermite(_k1p.z, _k2p.z, mpz1, mpz2, segU),
  );

  const mtx1 = 0.5 * (_k2t.x - _k0t.x), mty1 = 0.5 * (_k2t.y - _k0t.y), mtz1 = 0.5 * (_k2t.z - _k0t.z);
  const mtx2 = 0.5 * (_k3t.x - _k1t.x), mty2 = 0.5 * (_k3t.y - _k1t.y), mtz2 = 0.5 * (_k3t.z - _k1t.z);
  outTgt.set(
    hermite(_k1t.x, _k2t.x, mtx1, mtx2, segU),
    hermite(_k1t.y, _k2t.y, mty1, mty2, segU),
    hermite(_k1t.z, _k2t.z, mtz1, mtz2, segU),
  );
}

// Sum of incommensurate sines — gives a low-frequency, non-repeating wobble
// without the cost of a noise texture. Amplitude is set by the caller.
function handheldNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 0.37 + seed * 1.1) * 0.55 +
    Math.sin(t * 0.83 + seed * 2.3) * 0.30 +
    Math.sin(t * 1.61 + seed * 3.7) * 0.15
  );
}

function applyHandheld(elapsed: number, pos: THREE.Vector3, tgt: THREE.Vector3): void {
  const size = buildingBox!.getSize(_tmpSize);
  const baseAmp = Math.max(size.x, size.y, size.z) * 0.0035;
  pos.x += handheldNoise(elapsed,        0.0) * baseAmp;
  pos.y += handheldNoise(elapsed,        1.7) * baseAmp * 0.7;
  pos.z += handheldNoise(elapsed,        3.4) * baseAmp * 0.5;
  // Target shake is gentler so framing doesn't chatter.
  const tgtAmp = baseAmp * 0.55;
  tgt.x += handheldNoise(elapsed * 0.9 + 12.3, 5.1) * tgtAmp;
  tgt.y += handheldNoise(elapsed * 0.9 + 20.7, 6.4) * tgtAmp;
}

function updateCinematic(now: number): void {
  if (!cinematic.ready) return;
  const elapsed = (now - cinematic.startTime) / 1000;
  const u = (elapsed % cinematic.loopSeconds) / cinematic.loopSeconds;

  // Camera autoplay — drives position/target along the spline. Stops the
  // moment the user takes orbit control (cinematic.playing flips false).
  if (cinematic.playing) {
    sampleCameraLoop(elapsed, _camPos, _camTarget);
    applyHandheld(elapsed, _camPos, _camTarget);
    camera.position.copy(_camPos);
    camera.lookAt(_camTarget);
    controls.target.copy(_camTarget);
  }

  // Palette autoplay — independent of the camera. Keeps cycling day → dusk
  // → night → dusk → day even after the user takes manual camera control,
  // as long as the "Autoplay cycle" toggle stays on.
  if (!cinematicState.followAutoplay) return;
  // 0.00–0.35 = day, 0.35–0.55 = day→night, 0.55–0.80 = night, 0.80–1.00 = night→day
  let t = 0;
  if (u < 0.35)       t = 0;
  else if (u < 0.55)  t = smoothstep((u - 0.35) / 0.20);
  else if (u < 0.80)  t = 1;
  else                t = 1 - smoothstep((u - 0.80) / 0.20);
  cinematicState.phaseLabel = u < 0.35 ? 'Day' : u < 0.55 ? 'Dusk' : u < 0.80 ? 'Night' : 'Dawn';
  cinematicState.progress = u;
  lerpPalette(livePalette, dayPalette, nightPalette, t);
  applyPalette(livePalette);
}

const cinematicState = {
  followAutoplay: true,
  manualNight: false,
  phaseLabel: 'Day',
  progress: 0,
};

// ─── Click-to-take-control ───────────────────────────────────────────────────
const hint = document.getElementById('cinematic-overlay') as HTMLDivElement;
const replayBtn = document.getElementById('replay') as HTMLButtonElement;
const hintText = document.getElementById('hint') as HTMLDivElement;

function endCinematic(): void {
  if (!cinematic.playing) return;
  cinematic.playing = false;
  controls.enabled = true;
  // Hand current camera/target to OrbitControls cleanly.
  controls.update();
  hintText.style.display = 'none';
  replayBtn.style.display = 'inline-flex';
}

function startCinematic(): void {
  cinematic.playing = true;
  cinematic.startTime = performance.now();
  controls.enabled = false;
  cinematicState.followAutoplay = true;
  paneBindings.autoplay = true;
  paneBindings.night = false;
  pane.refresh();
  hintText.style.display = '';
  replayBtn.style.display = 'none';
}

renderer.domElement.addEventListener('pointerdown', () => endCinematic(), { once: false });
replayBtn.addEventListener('click', (e) => { e.stopPropagation(); startCinematic(); });

// ─── Rebuild windows (when inset changes) ────────────────────────────────────
function rebuildWindows(): void {
  windowGroup.children.forEach((m: any) => { m.geometry.dispose(); m.material.dispose(); });
  while (windowGroup.children.length) windowGroup.remove(windowGroup.children[0]);
  materials.length = 0;
  windowsP.then(data => {
    data.windows.forEach(w => windowGroup.add(makeWindowMesh(w)));
    applyPalette(livePalette);
  });
}

// ─── Tweakpane ───────────────────────────────────────────────────────────────
const paneBindings = {
  depth:     sharedSettings.depth,
  backScale: sharedSettings.backScale,
  inset:     sharedSettings.windowInset,
  overlay:   sharedSettings.overlay,
  glassThickness:    sharedSettings.glassThickness,
  refractionStrength:sharedSettings.refractionStrength,
  glassDirtStrength: sharedSettings.glassDirtStrength,
  glassFresnelStrength: sharedSettings.glassFresnelStrength,
  glassSmudgeStrength:  sharedSettings.glassSmudgeStrength,
  autoplay:  true,
  night:     false,
  exposure:  livePalette.exposure,
  bStrength: livePalette.bloom.strength,
  bRadius:   livePalette.bloom.radius,
  bThreshold:livePalette.bloom.threshold,
};

// Tweakpane v4 inherits addFolder/refresh from FolderApi in an external package
// that isn't installed as a separate dep — runtime is fine, types are partial.
const pane = new Pane({
  container: document.getElementById('pane')!,
  title: 'Scene',
  expanded: true,
}) as any;

const fMaterial = pane.addFolder({ title: 'Interior shader', expanded: true });
fMaterial.addBinding(paneBindings, 'depth', { min: 0.2, max: 3.0, step: 0.01, label: 'Room depth' })
  .on('change', (e: any) => { sharedSettings.depth = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'backScale', { min: 0.2, max: 1.0, step: 0.01, label: 'Back-wall fill' })
  .on('change', (e: any) => { sharedSettings.backScale = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'inset', { min: -0.15, max: 0.30, step: 0.01, label: 'Window inset' })
  .on('change', (e: any) => {
    if (Math.abs(e.value - sharedSettings.windowInset) < 1e-4) return;
    sharedSettings.windowInset = e.value;
    rebuildWindows();
  });
fMaterial.addBinding(paneBindings, 'overlay', { label: 'Curtain overlay' })
  .on('change', (e: any) => {
    sharedSettings.overlay = e.value;
    for (const m of materials) m.setFrontAtlas(e.value ? overlayAtlas : null, 4, 4);
  });
fMaterial.addBinding(paneBindings, 'glassThickness', { min: 0, max: 0.15, step: 0.001, label: 'Glass thickness' })
  .on('change', (e: any) => { sharedSettings.glassThickness = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'refractionStrength', { min: 0, max: 0.03, step: 0.0005, label: 'Refraction' })
  .on('change', (e: any) => { sharedSettings.refractionStrength = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'glassDirtStrength', { min: 0, max: 1, step: 0.01, label: 'Glass dirt' })
  .on('change', (e: any) => { sharedSettings.glassDirtStrength = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'glassFresnelStrength', { min: 0, max: 1.5, step: 0.01, label: 'Fresnel sheen' })
  .on('change', (e: any) => { sharedSettings.glassFresnelStrength = e.value; applySharedSettingsToMaterials(); });
fMaterial.addBinding(paneBindings, 'glassSmudgeStrength', { min: 0, max: 1, step: 0.01, label: 'Smudges' })
  .on('change', (e: any) => { sharedSettings.glassSmudgeStrength = e.value; applySharedSettingsToMaterials(); });

const fScene = pane.addFolder({ title: 'Time of day', expanded: true });
fScene.addBinding(paneBindings, 'autoplay', { label: 'Autoplay cycle' })
  .on('change', (e: any) => {
    cinematicState.followAutoplay = e.value;
    if (!e.value) {
      // Snap to whichever palette the night toggle says.
      const target = paneBindings.night ? nightPalette : dayPalette;
      copyPalette(livePalette, target);
      applyPalette(livePalette);
    }
  });
fScene.addBinding(paneBindings, 'night', { label: 'Night (manual)' })
  .on('change', (e: any) => {
    if (cinematicState.followAutoplay) {
      // Force-disable autoplay when user takes manual control of palette.
      paneBindings.autoplay = false;
      cinematicState.followAutoplay = false;
      pane.refresh();
    }
    copyPalette(livePalette, e.value ? nightPalette : dayPalette);
    applyPalette(livePalette);
  });
fScene.addBinding(cinematicState, 'phaseLabel', { readonly: true, label: 'Phase' });
fScene.addBinding(cinematicState, 'progress', { readonly: true, label: 'Loop', min: 0, max: 1, format: (v: number) => `${(v * 100).toFixed(0)}%` });

const fPost = pane.addFolder({ title: 'Post-processing', expanded: false });
fPost.addBinding(paneBindings, 'exposure', { min: 0.3, max: 2.0, step: 0.01, label: 'Exposure' })
  .on('change', (e: any) => { renderer.toneMappingExposure = e.value; });
fPost.addBinding(paneBindings, 'bStrength', { min: 0, max: 2, step: 0.01, label: 'Bloom strength' })
  .on('change', (e: any) => { bloom.strength = e.value; });
fPost.addBinding(paneBindings, 'bRadius', { min: 0, max: 1, step: 0.01, label: 'Bloom radius' })
  .on('change', (e: any) => { bloom.radius = e.value; });
fPost.addBinding(paneBindings, 'bThreshold', { min: 0, max: 1, step: 0.01, label: 'Bloom threshold' })
  .on('change', (e: any) => { bloom.threshold = e.value; });

function copyPalette(out: Palette, src: Palette): void {
  out.hemiSky.copy(src.hemiSky); out.hemiGround.copy(src.hemiGround); out.hemiIntensity = src.hemiIntensity;
  out.sunColor.copy(src.sunColor); out.sunIntensity = src.sunIntensity;
  out.sunElevationDeg = src.sunElevationDeg; out.skyTurbidity = src.skyTurbidity;
  out.skyRayleigh = src.skyRayleigh; out.nightSkyMix = src.nightSkyMix;
  out.streetIntensity = src.streetIntensity; out.streetColor.copy(src.streetColor);
  out.envIntensity = src.envIntensity;
  out.exposure = src.exposure;
  out.interiorEmissive.copy(src.interiorEmissive);
  out.frontTransmission = src.frontTransmission;
  out.frontAlphaBoost   = src.frontAlphaBoost;
  out.bloom.strength = src.bloom.strength;
  out.bloom.radius   = src.bloom.radius;
  out.bloom.threshold= src.bloom.threshold;
}

// Push live values into the pane each frame (cheap; tweakpane diffs internally).
function syncPaneReadouts(): void {
  paneBindings.exposure  = livePalette.exposure;
  paneBindings.bStrength = livePalette.bloom.strength;
  paneBindings.bRadius   = livePalette.bloom.radius;
  paneBindings.bThreshold= livePalette.bloom.threshold;
}

// ─── Resize ─────────────────────────────────────────────────────────────────
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});

// ─── FPS counter ────────────────────────────────────────────────────────────
const fpsEl = document.querySelector('#fps .num') as HTMLSpanElement | null;
let _fpsLast = performance.now();
let _fpsAccum = 0;
let _fpsFrames = 0;
let _fpsLastShown = 0;

// ─── Loop ────────────────────────────────────────────────────────────────────
let lastPaneSync = 0;
let _warmFrames = 0;
renderer.setAnimationLoop((now: number) => {
  updateCinematic(now);
  if (controls.enabled) controls.update();
  // Refresh pane readouts ~5x/sec while the palette is auto-cycling, so the
  // Phase/Loop indicators keep moving even after the user takes manual
  // camera control.
  if (cinematicState.followAutoplay && now - lastPaneSync > 200) {
    syncPaneReadouts();
    pane.refresh();
    lastPaneSync = now;
  }
  composer.render();
  // Signal "warmed up" for headless capture once the scene has had a few frames
  // to flush textures, compile shaders, and settle the camera.
  if (cinematic.ready) {
    _warmFrames++;
    if (_warmFrames === 12) (window as any).__demoReady = true;
  }

  // FPS counter: time-windowed average, refreshed 4x/sec.
  const dt = now - _fpsLast;
  _fpsLast = now;
  _fpsAccum += dt;
  _fpsFrames++;
  if (now - _fpsLastShown > 250) {
    const fps = 1000 / (_fpsAccum / _fpsFrames);
    if (fpsEl) fpsEl.textContent = String(Math.round(fps));
    _fpsAccum = 0;
    _fpsFrames = 0;
    _fpsLastShown = now;
  }
});

// ─── Headless capture: deterministic per-frame rendering ────────────────────
// Lets a Playwright script step the cinematic clock manually and snap one
// screenshot per virtual frame. Avoids the "real-time recorder duplicates
// frames when the scene can't keep up" failure mode of Playwright recordVideo.
//
// Usage from the capture script:
//   await page.evaluate((t) => (window as any).__renderFrame(t), tSeconds);
//   await page.screenshot({ path: 'frame.png' });
(window as any).__renderFrame = (tSeconds: number, paletteMix?: number) => {
  renderer.setAnimationLoop(null);
  cinematic.playing = true;
  cinematic.startTime = 0; // updateCinematic uses (now - startTime)/1000

  // If a palette mix is provided (0 = night, 1 = day), drive the palette
  // ourselves and tell updateCinematic to leave it alone. Otherwise let
  // updateCinematic's autoplay handle it.
  if (typeof paletteMix === 'number') {
    cinematicState.followAutoplay = false;
    const m = Math.max(0, Math.min(1, paletteMix));
    lerpPalette(livePalette, nightPalette, dayPalette, m);
    applyPalette(livePalette);
  }

  updateCinematic(tSeconds * 1000);
  composer.render();
};
