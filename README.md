# Three-Fenestra: an interior mapping shader for Three.js

**Status:** v0.2.0, pre-1.0.

A `MeshStandardMaterial` subclass that adds parallax-based fake-3D rooms
inside flat window planes, plus an optional PBR front layer for curtains,
blinds, mullions, and glass dirt. Works in vanilla Three.js and React
Three Fiber.

![Three Fenestra: faux window interiors with interior mapping](assets/header-cinematic.webp)

**Live demo:** [three-fenestra.codedgar.com](https://three-fenestra.codedgar.com)

---

## Why Three-Fenestra

The interior mapping technique was proposed by Joost van Dongen in 2008
to fake the look of furnished rooms behind window planes without modelling
or lighting them. The original is one shader, one texture, no front layer.

Modern building renders need more than that: curtains that catch sun, glass
that gets dirty, mullions that cast shadow, windows that switch from "lit"
to "dark" by time of day. Three-Fenestra keeps the cheap ray-march at the
core and stacks the modern bits on top:

- A back atlas of interior rooms (the original technique)
- A PBR front overlay with optional normal / roughness / metalness atlases
- A transmission term so curtains can still bleed warm light at night
- Uniforms wired for a day/night controller (you supply the controller)

It is one material per window mesh. Drop it into any existing scene that
already uses Three's standard lighting and it composites correctly.

---

## Install

```bash
npm install three-fenestra three
```

`three >= 0.150` is a peer dependency.

### Starter atlases

The package ships two ready-to-use 4×4 atlases under `three-fenestra/starter/`
so you don't have to author your own to see something render on day one:

| Path | What it is |
|---|---|
| `three-fenestra/starter/rooms.webp` | Back atlas — 4×4 grid of interior rooms. |
| `three-fenestra/starter/overlay.webp` | Front atlas — 4×4 grid of curtain / blind variants with alpha. |

Any modern bundler (Vite, webpack, Parcel, esbuild) imports them as URLs.
Once you outgrow the starters, follow [Creating your own atlases](#creating-your-own-atlases).

---

## Quick start (vanilla Three.js)

```ts
import * as THREE from 'three';
import { InteriorMappingMaterial } from 'three-fenestra';
import roomsUrl   from 'three-fenestra/starter/rooms.webp';
import overlayUrl from 'three-fenestra/starter/overlay.webp';

const atlas = new THREE.TextureLoader().load(roomsUrl);
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;

const material = new InteriorMappingMaterial({
  backAtlas: atlas,
  backAtlasCols: 4,
  backAtlasRows: 4,
  depth: 1.0,
  backScale: 0.66,
  planeSize: new THREE.Vector2(width, height),
  windowId: new THREE.Vector3(x, y, z), // per-window seed for cell picking
  roughness: 0.15,
  metalness: 0.0,
});

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
```

The interior renders with no front textures. Add the PBR front layer at any
time — the starter `overlay.png` is a 4×4 curtain atlas you can drop in:

```ts
const overlay = new THREE.TextureLoader().load(overlayUrl);
overlay.colorSpace = THREE.SRGBColorSpace;
material.setFrontAtlas(overlay, 4, 4);

// Optional companion PBR maps if you have your own:
material.setFrontNormalAtlas(curtainNormal, 1);   // samples .xy
material.setFrontRoughnessAtlas(curtainRough);    // samples .g
material.setFrontMetalnessAtlas(curtainMetal);    // samples .b
```

Where front alpha is `0`, you see the interior through the "glass." Where
it is `1`, you see the front layer lit by scene lights via standard PBR,
fresnel included.

---

## React Three Fiber

R3F passes constructor arguments via `args` as a single-element array
(the material takes one options object):

```tsx
import { extend, type ThreeElement } from '@react-three/fiber';
import { InteriorMappingMaterial } from 'three-fenestra';

extend({ InteriorMappingMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    interiorMappingMaterial: ThreeElement<typeof InteriorMappingMaterial>;
  }
}

<mesh>
  <planeGeometry args={[width, height]} />
  <interiorMappingMaterial
    args={[{
      backAtlas: atlas,
      planeSize: new THREE.Vector2(width, height),
      windowId: new THREE.Vector3(x, y, z),
    }]}
  />
</mesh>
```

Setting individual props on `<interiorMappingMaterial />` after construction
works for the runtime knobs (`depth`, `backScale`, `interiorEmissive`,
`frontTransmission`, `frontAlphaBoost`) because those are wired to setters.
Texture swaps should go through `setFrontAtlas(...)` / `setBackAtlas(...)`
via a ref.

---

## API

### Constructor parameters

All `MeshStandardMaterialParameters` are accepted, plus:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `backAtlas` | `Texture` | **required** | The interior (rooms) atlas. |
| `backAtlasCols`, `backAtlasRows` | `number` | `4`, `4` | Grid dimensions of the back atlas. |
| `depth` | `number` | `1.0` | Apparent room depth, in plane-local units. |
| `backScale` | `number` | `0.66` | Back-wall fill factor (0.05–0.999). |
| `planeSize` | `Vector2` | **required** | Must match the geometry's width × height. |
| `windowId` | `Vector3` | **required** | Per-window seed (typically the window center) for atlas cell picking. |
| `interiorEmissive` | `Color` | `(1, 1, 1)` | Multiplier on the interior contribution before adding to the lit output. Use to tint warm and scale up for "lights on" night mode (e.g. `new Color(2, 1.5, 1)`). |
| `frontAtlas` | `Texture?` | — | Front overlay atlas (RGBA: color + alpha). |
| `frontAtlasCols`, `frontAtlasRows` | `number` | `1`, `1` | Front atlas grid. |
| `frontNormalAtlas` | `Texture?` | — | Tangent-space normal map atlas. |
| `frontNormalScale` | `number` | `1.0` | Multiplier on `.xy` of the normal sample. |
| `frontRoughnessAtlas` | `Texture?` | — | Roughness atlas (samples `.g`). |
| `frontMetalnessAtlas` | `Texture?` | — | Metalness atlas (samples `.b`). |
| `frontTransmission` | `number` | `0.25` | Fraction of interior light that bleeds through the opaque front layer, tinted by the front color. `0` = front fully blocks interior, `1` = no blocking. |
| `frontAlphaBoost` | `number` | `1.0` | Raises effective opacity of the front layer (`pow(alpha, 1/boost)`). `> 1` makes semi-transparent pixels read as more opaque without re-authoring the texture. |

#### Glass surface (optional)

These give the glass area (where the front layer is transparent) the look of
a real pane: dirt, refraction, fresnel sheen. All default to zero / off; turn
on the ones you want.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `glassThickness` | `number` | `0` | Apparent glass thickness in plane-local units. Parallax-shifts the front-overlay sample so it appears to sit on the *inside* face of the pane rather than glued to the outside surface. `0` disables. |
| `refractionStrength` | `number` | `0` | Magnitude (in cell-UV units) of the interior ray-march perturbation driven by `glassDirtMap`. Sells the "looking through real glass" effect. Keep tiny — typical range `0.003`–`0.015`. `0` disables. |
| `glassDirtMap` | `Texture?` | — | Grayscale noise texture used as the dirt/specular modulator over the glass area, *and* as the source of the refraction perturbation. Centered around `0.5`; values `> 0.5` roughen the glass, `< 0.5` polish it. |
| `glassDirtStrength` | `number` | `0.35` | How strongly the dirt map modulates roughness on the glass area. |
| `glassFresnelStrength` | `number` | `0` | Schlick fresnel sheen added to the glass at grazing angles. Primary "this is a pane of glass" cue. Demo uses `~0.5`. |
| `glassFresnelColor` | `Color` | `(0.85, 0.92, 1.0)` | Tint of the fresnel sheen. Cool white reads as sky reflection. |
| `glassSmudgeStrength` | `number` | `0` | Additive brightness of dirt visible as smudges on the glass surface. Different from `glassDirtStrength` (roughness modulation). |

### Runtime setters

```ts
// Core knobs
material.depth              = 0.8;
material.backScale          = 0.6;
material.interiorEmissive   = new THREE.Color(2.0, 1.5, 1.0);  // copies into uniform
material.frontTransmission  = 0.10;
material.frontAlphaBoost    = 1.0;

// Glass-surface knobs
material.glassThickness       = 0.04;
material.refractionStrength   = 0.005;
material.glassDirtStrength    = 0.35;
material.glassFresnelStrength = 0.5;
material.glassFresnelColor    = new THREE.Color(0.85, 0.92, 1.0);  // copies into uniform
material.glassSmudgeStrength  = 0.1;

// Texture swaps (pass null to disable)
material.setBackAtlas(newAtlas);
material.setFrontAtlas(tex, cols, rows);
material.setFrontNormalAtlas(tex, scale);
material.setFrontRoughnessAtlas(tex);
material.setFrontMetalnessAtlas(tex);
material.setGlassDirtMap(tex);
```

---

## Day / night

The library does not ship a day/night controller. It gives you the
uniforms to build one. Typical recipe:

```ts
const day   = { emissive: new THREE.Color(1, 1, 1),         transmission: 0.15 };
const night = { emissive: new THREE.Color(1.7, 1.35, 0.95), transmission: 0.10 };

function setMode(p: typeof day) {
  for (const m of materials) {
    m.interiorEmissive  = p.emissive;
    m.frontTransmission = p.transmission;
  }
}
```

For full "lights on at night," pair this with:

- Reduced scene ambient and sun, **but not to zero**. Building exteriors at
  night still receive skyglow, streetlights, and reflections. Curtain
  colours need ambient to read as fabric, not as backlit cutouts.
- A cool-tinted ambient with a warm interior `emissive` for the classic
  night-city contrast.
- `UnrealBloomPass` on the composer (low strength, around `0.4`) to spill
  the lit-window contribution onto neighbouring pixels.

The bundled `examples/asia-building` demo wires all three; check `main.ts`
for a working reference.

---

## Creating your own atlases

Two textures drive the look: the **back atlas** (interior rooms) and the
optional **front atlas** (curtains, blinds, glass overlays). Both are
grids of square cells; the shader picks a cell per window using a
deterministic hash of `windowId`, so the same window always gets the
same room across re-renders.

### Back atlas (interior rooms)

A grid of square room photos. Each cell is one "room" the ray-march will
land you inside.

| Spec | Recommendation |
|---|---|
| Grid | 4×4 (16 variants) is the sweet spot for masking repetition across hundreds of windows. 2×2 is fine for small scenes. |
| Cell aspect | Square (1:1). The ray-march assumes a unit cube per cell. |
| Image size | Power of two (`1024×1024`, `2048×2048`). Lets Three generate mipmaps. |
| Color space | sRGB. Set `texture.colorSpace = SRGBColorSpace` so sampling converts to linear for PBR. |
| Edge bleed | The shader insets each cell by `0.001` to prevent bleed; keep ~2 px gutter inside each cell as insurance. |
| Wrap | `ClampToEdgeWrapping` on both axes. |
| Filter | `LinearMipmapLinearFilter` (min) + `LinearFilter` (mag), `anisotropy: 8+`. |
| Content | Frame each cell as if looking through a window from outside. Centre the composition; the back wall should fill ~60–70% of the cell (matches default `backScale`). Already-lit photography works best; the shader treats interior pixels as pre-lit. |

### Front atlas (curtains, blinds, overlays)

A grid of window dressings. Each cell sits on top of one window using the
same cell-picking logic.

| Spec | Recommendation |
|---|---|
| Grid | Match the variety you want. 4×4 = 16 variants. |
| Cell aspect | Square. Real windows are not square; the shader stretches the cell to the window's actual aspect, so pick curtain compositions that survive a moderate stretch. |
| Format | PNG with alpha (RGBA). |
| Color space | sRGB. |
| Trim to edge | Each curtain should fill its cell edge-to-edge with no transparent gutter. If your source has padding, trim it:<br>`magick in.png -alpha set -fuzz 10% -bordercolor none -border 1 -trim +repage -resize 256x256^ -gravity center -extent 256x256 out.png` |
| Alpha encoding | The single biggest authoring decision. Opaque (alpha = 1) is curtain fabric. Transparent (alpha = 0) is the glass area you want the interior to show through. Anywhere between is "semi-sheer" and the shader reads it as fractional transmission. |

#### Sheer and lace curtains

Do not author the fabric itself at low alpha unless you genuinely want light
to pour through it. Anti-aliased edges are fine; intentional partial
transparency on every pixel of the curtain is what causes the "windows
evaporate at night" problem.

If you already have a texture with semi-transparent fabric and want it to
behave more solidly at night, raise `frontAlphaBoost` (try `2.0`–`2.5`). It
is a render-time knob; no re-export needed.

#### Front PBR maps (optional)

If you want the curtain fabric to receive proper PBR lighting (fresnel,
scene light response):

- **Normal atlas:** tangent-space, same grid as the albedo atlas. `RGB`
  channels = `XYZ`, encoded `[0..1]` mapping to `[-1..1]`.
- **Roughness atlas:** single-channel; the shader samples `.g`. White =
  rough, black = mirror.
- **Metalness atlas:** single-channel; the shader samples `.b`.
  Curtains and glass are non-metallic, so almost always `0`.

All three must share the front albedo atlas's grid dimensions.

### Window mesh setup

Each window is a `PlaneGeometry` sized to the real window dimensions.
Three things every material needs:

1. **`planeSize`**: the geometry's `(width, height)` as a `Vector2`. The
   shader uses it to normalise object-space `position` into local UV.
2. **`windowId`**: a `Vector3` unique per window. The window's centre in
   world space is a natural choice.
3. **The plane's local +Z** must be the outward-facing normal. If your
   geometry comes from a model with arbitrary orientation, build a basis
   from `(right, up, normal)` and apply it via
   `mesh.quaternion.setFromRotationMatrix(makeBasis(right, up, normal))`.

See `examples/asia-building/main.ts` for a complete example pulling
per-window data from a JSON descriptor.

### Helper scripts

The `examples/asia-building/tools/` folder has small Python scripts used
to build the demo's atlases:

- `detect_windows.py`, `extract_windows.py`: pull window crops from a
  facade photo
- `analyze_atlas.py`: sanity-check cell layout and channel content
- `glass_dirt.svg`: source for the glass-dirt overlay used in the demo

They are unsupported, not packaged, and exist as references. Adapt or
ignore.

---

## Limitations and roadmap

- **No envmap / cubemap reflections** on the glass area. Would require
  fresnel-modulated env sampling.
- **No refraction distortion.** A planned opt-in `refractionStrength`
  (default `0`) would perturb the ray direction using the front normal map.
- **One material per window mesh.** Each window carries its own
  `windowId` / `planeSize` uniforms. For very high window counts, an
  instanced-attribute variant (single material, per-instance attributes)
  is on the radar.
- **Pre-lit interior.** The atlas is treated as already-shaded photography;
  scene lights do not relight the interior. This is by design; relighting
  fake rooms would defeat the cost saving the technique exists for.

---

## Development

```bash
npm install
npm run dev          # serves examples/asia-building on :5173
npm run build        # produces dist/ (the publishable package)
npm run build:demo   # produces dist-demo/ (static export of the demo)
npm run typecheck
```

### Examples

- `examples/asia-building/` — the full demo: 160 windows on a real building,
  cinematic camera, day/night palette, glass dirt, PBR curtains. What
  `npm run dev` serves and what powers the [live demo](https://three-fenestra.codedgar.com).
- `examples/minimal/` — single window plane, ~60 lines. The shortest
  runnable example for understanding the API surface.

---

## Credits

- Joost van Dongen, *Interior Mapping: A new technique for rendering
  realistic buildings* (2008).
- The Three.js team for `MeshStandardMaterial` and the onBeforeCompile
  hook this material extends.

---

## License

[MIT](./LICENSE).
