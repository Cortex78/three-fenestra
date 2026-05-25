// Minimal three-fenestra example: one window plane, one back atlas, no
// front layer, no day/night controller. The smallest runnable scene.
//
// Uses the starter atlas that ships with the npm package — same import
// path a downstream consumer would write.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { InteriorMappingMaterial } from 'three-fenestra';
import roomsUrl from 'three-fenestra/starter/rooms.webp';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 3.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(2, 3, 4);
scene.add(sun);

// Back atlas: the 4x4 starter that ships with the package.
const atlas = new THREE.TextureLoader().load(roomsUrl);
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
atlas.minFilter = THREE.LinearMipmapLinearFilter;
atlas.magFilter = THREE.LinearFilter;
atlas.anisotropy = 8;

const W = 2, H = 2;
const material = new InteriorMappingMaterial({
  backAtlas: atlas,
  backAtlasCols: 4,
  backAtlasRows: 4,
  depth: 0.9,
  backScale: 0.6,
  planeSize: new THREE.Vector2(W, H),
  windowId: new THREE.Vector3(0, 0, 0),
  roughness: 0.2,
  metalness: 0,
});

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), material);
scene.add(mesh);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
