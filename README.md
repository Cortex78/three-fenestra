# Three-Fenestra: an interior mapping shader for Three.js

**Status:** v0.2.0, pre-1.0.

A `MeshStandardMaterial` subclass that adds parallax-based fake-3D rooms
inside flat window planes, plus an optional PBR front layer for curtains,
blinds, mullions, and glass dirt. Works in vanilla Three.js and React
Three Fiber.

**New in this branch:** a full [live shader streaming layer](#live-shader-streaming) powered by Supabase Realtime + PostGIS — each window in a building can be claimed, customised, and updated in real-time by any authenticated user, with all changes broadcast to every viewer within ~10 ms.

![Three Fenestra: faux window interiors with interior mapping](assets/header-cinematic.webp)

**Live demo:** [three-fenestra.codedgar.com](https://three-fenestra.codedgar.com)

---

## Table of Contents

1. [Why Three-Fenestra](#why-three-fenestra)
2. [Install](#install)
3. [Quick start](#quick-start-vanilla-threejs)
4. [React Three Fiber](#react-three-fiber)
5. [API — InteriorMappingMaterial](#api)
6. [Day / night](#day--night)
7. [Creating your own atlases](#creating-your-own-atlases)
8. **[Live shader streaming ✦](#live-shader-streaming)**
   - [Architecture overview](#architecture-overview)
   - [Streaming quick start](#streaming-quick-start)
   - [Supabase setup](#supabase-setup)
   - [Per-user window customisation](#per-user-window-customisation)
   - [AI PBR texture generation](#ai-pbr-texture-generation)
   - [Streaming API reference](#streaming-api-reference)
9. [Testing](#testing)
10. [Development](#development)
11. [Limitations and roadmap](#limitations-and-roadmap)

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
- **A streaming layer so every window's shader state is live-editable by its owner**

It is one material per window mesh. Drop it into any existing scene that
already uses Three's standard lighting and it composites correctly.

---

## Install

```bash
npm install three-fenestra three
```

`three >= 0.150` is a peer dependency.

For the streaming layer also install Supabase:

```bash
npm install @supabase/supabase-js
```

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
time — the starter `overlay.webp` is a 4×4 curtain atlas you can drop in:

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
a real pane: dirt, refraction, fresnel sheen. All default to zero / off.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `glassThickness` | `number` | `0` | Apparent glass thickness in plane-local units. Parallax-shifts the front-overlay sample so it appears to sit on the *inside* face of the pane. |
| `refractionStrength` | `number` | `0` | Magnitude (in cell-UV units) of the interior ray-march perturbation driven by `glassDirtMap`. Typical range `0.003`–`0.015`. |
| `glassDirtMap` | `Texture?` | — | Grayscale noise texture. Centered around `0.5`; values `> 0.5` roughen the glass, `< 0.5` polish it. Also drives refraction perturbation. |
| `glassDirtStrength` | `number` | `0.35` | How strongly the dirt map modulates roughness on the glass area. |
| `glassFresnelStrength` | `number` | `0` | Schlick fresnel sheen at grazing angles. Demo uses `~0.5`. |
| `glassFresnelColor` | `Color` | `(0.85, 0.92, 1.0)` | Tint of the fresnel sheen. Cool white reads as sky reflection. |
| `glassSmudgeStrength` | `number` | `0` | Additive brightness of dirt visible as smudges on the glass surface. |

### Runtime setters

```ts
material.depth              = 0.8;
material.backScale          = 0.6;
material.interiorEmissive   = new THREE.Color(2.0, 1.5, 1.0);
material.frontTransmission  = 0.10;
material.frontAlphaBoost    = 1.0;
material.glassThickness       = 0.04;
material.refractionStrength   = 0.005;
material.glassDirtStrength    = 0.35;
material.glassFresnelStrength = 0.5;
material.glassFresnelColor    = new THREE.Color(0.85, 0.92, 1.0);
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

For full "lights on at night," pair this with reduced scene ambient and sun,
a cool-tinted ambient with warm interior `emissive`, and `UnrealBloomPass`
(strength ~`0.4`) on the composer. See `examples/asia-building/main.ts`.

---

## Creating your own atlases

Two textures drive the look: the **back atlas** (interior rooms) and the
optional **front atlas** (curtains, blinds, glass overlays). Both are
grids of square cells; the shader picks a cell per window using a
deterministic hash of `windowId`, so the same window always gets the
same room across re-renders.

### Back atlas (interior rooms)

| Spec | Recommendation |
|---|---|
| Grid | 4×4 (16 variants) is the sweet spot. |
| Image size | Power of two (`1024×1024`, `2048×2048`). |
| Color space | sRGB. Set `texture.colorSpace = SRGBColorSpace`. |
| Wrap | `ClampToEdgeWrapping` on both axes. |
| Filter | `LinearMipmapLinearFilter` (min) + `LinearFilter` (mag), `anisotropy: 8+`. |
| Content | Frame each cell as if looking through a window from outside. Back wall should fill ~60–70% of the cell. Already-lit photography works best. |

### Front atlas (curtains, blinds, overlays)

| Spec | Recommendation |
|---|---|
| Format | PNG/WebP with alpha (RGBA). |
| Alpha encoding | `1` = opaque curtain, `0` = glass, `0.5` = sheer fabric. |
| Cell aspect | Square; the shader stretches to the window's real aspect. |

For sheer curtains that go solid at night, raise `frontAlphaBoost` to
`2.0`–`2.5` at runtime. No re-export needed.

### Helper scripts

See `examples/asia-building/tools/` for Python helpers:
- `extract_windows.py` — Blender script; extracts window frames from a GLTF as a `windows.json`
- `detect_windows.py` — finds window rects in a facade photograph
- `analyze_atlas.py` — reverse-engineers `backScale` / `depth` from room photography

---

## Live shader streaming

> **Full documentation:** [`docs/streaming.md`](docs/streaming.md)  
> **Setup guide:** [`docs/supabase-setup.md`](docs/supabase-setup.md)  
> **Architecture deep-dive:** [`ARCHITECTURE.md`](ARCHITECTURE.md)

The streaming layer turns a static building scene into a live multi-user
experience: any authenticated user can own a window, upload custom room
textures or generate PBR materials via AI, and see their changes broadcast
to every other viewer in real-time — all backed by Supabase Realtime and
PostGIS.

### Architecture overview

```
Browser A (owner)            Supabase                  Browser B (viewer)
──────────────────           ────────                  ─────────────────
drag slider                                             watching building
  │                                                          │
  ├─ broadcastUniformPreview ──► broadcast channel ──────────► applyUniformBroadcast()
  │   (ephemeral, no DB)         (< 5 ms)                   no frame drop
  │
  ├─ click "Publish"
  │   └─ updateWindowState()
  │       └─► update_window_state() RPC (Postgres, atomic)
  │             SELECT...FOR UPDATE + version check
  │               └─► Supabase Realtime fires UPDATE event ──► applyRow()
  │                   (window_states table)                      ├─ uniforms: sync
  │                                                              └─ textures: async
  │                                                                  TextureStreamCache
```

**Two channels per building:**
- `postgres_changes` on `window_states` — persistent state (DB writes)
- `broadcast` — ephemeral slider preview before committing

**Atomicity** is guaranteed by a PostgreSQL stored procedure that uses
`SELECT…FOR UPDATE` locking and raises `serialization_failure (40001)` on
version mismatch, retried automatically with exponential back-off.

**PostGIS** stores each building's geographic location + polygon footprint and
each window's 3D position in ECEF coordinates, enabling spatial queries like
"find all buildings within 500 m" or "how many windows are lit per floor."

### Streaming quick start

```ts
import { createClient }        from '@supabase/supabase-js';
import { TextureStreamCache, SupabaseShaderStream } from 'three-fenestra/streaming';

const supabase     = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const textureCache = new TextureStreamCache({ maxEntries: 64 });
const stream       = new SupabaseShaderStream(supabase, textureCache);

// Subscribe to a building — fires hydration callback once,
// then keeps all window materials in sync via Realtime.
await stream.subscribeTo(MY_BUILDING_ID, (rows) => {
  for (const row of rows) {
    // Build a material from the hydration row
    const material = SupabaseShaderStream.buildMaterial(row, defaultAtlas);
    const mesh = buildWindowMesh(row, material);

    // Register with the stream — future DB changes auto-apply to this material
    stream.registerMaterial(row.window_uuid, material, row);
  }
});
```

### Supabase setup

See [`docs/supabase-setup.md`](docs/supabase-setup.md) for the full walkthrough.
Quick summary:

```bash
# 1. Install Supabase CLI
npm install -g supabase

# 2. Link to your project
supabase login
supabase link --project-ref <your-project-ref>

# 3. Apply all migrations (PostGIS schema + RLS + Realtime)
supabase db push

# 4. Deploy Edge Functions
supabase functions deploy generate-pbr-textures
supabase functions deploy process-texture-upload
supabase functions deploy window-state-sync

# 5. Set AI provider secret (optional — only needed for AI generation)
supabase secrets set GOOGLE_IMAGEN_API_KEY=your-key-here
# or for Stability AI:
supabase secrets set STABILITY_AI_API_KEY=your-key-here GENERATOR_PROVIDER=stability-ai
```

### Per-user window customisation

```ts
// Claim an unowned window
await stream.claimWindow(windowId);

// Broadcast a live slider preview (no DB write, visible to all viewers)
stream.broadcastUniformPreview(buildingId, windowId, {
  depth:             1.5,
  interiorEmissiveR: 2.0,
  interiorEmissiveG: 1.6,
  interiorEmissiveB: 1.1,
});

// Commit to the database atomically (Realtime then broadcasts to all)
await stream.updateWindowState(windowId, {
  depth:             1.5,
  interiorEmissiveR: 2.0,
  interiorEmissiveG: 1.6,
  interiorEmissiveB: 1.1,
}, expectedVersion);   // pass version for optimistic locking

// Upload a custom room texture
const response = await fetch(`${SUPABASE_URL}/functions/v1/process-texture-upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: formDataWithFile,
});
const { url } = await response.json();
await stream.updateWindowState(windowId, { back_atlas_url: url, back_atlas_cols: 1, back_atlas_rows: 1 });

// Release ownership (resets to building defaults)
await stream.releaseWindow(windowId);
```

### AI PBR texture generation

```ts
// Submit a generation job (runs async via Edge Function)
const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-pbr-textures`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    windowId: myWindowId,
    prompt:   'A cosy Tokyo apartment at night, warm lamp light, bookshelf',
    layers:   ['back', 'front', 'normal', 'roughness'],   // PBR set
  }),
});
const { jobId } = await res.json();

// Subscribe to job progress via Supabase Realtime
supabase.channel(`job:${jobId}`)
  .on('postgres_changes', { event: 'UPDATE', table: 'shader_generation_jobs', filter: `id=eq.${jobId}` },
    (payload) => {
      if (payload.new.status === 'completed') {
        stream.updateWindowState(myWindowId, {
          back_atlas_url:   payload.new.result_urls.back,
          front_atlas_url:  payload.new.result_urls.front,
          front_normal_url: payload.new.result_urls.normal,
        });
      }
    })
  .subscribe();
```

Supported AI providers (set `GENERATOR_PROVIDER` environment variable):

| Provider | Env var value | Quality |
|---|---|---|
| Google Imagen 3 | `google-imagen-3` (default) | Best photorealism |
| Stability AI SDXL | `stability-ai` | Open weights, self-hostable |

### Streaming API reference

See [`docs/streaming.md`](docs/streaming.md) for the complete API reference
for `TextureStreamCache`, `WindowStateManager`, and `SupabaseShaderStream`.

---

## Testing

### Type checking

```bash
npm run typecheck       # runs tsc --noEmit across src/ + examples/
```

### Unit tests

```bash
npm test                # vitest — runs src/streaming/__tests__/
npm run test:watch      # watch mode
npm run test:coverage   # with V8 coverage report
```

The unit tests cover:
- `types.ts` — `rowToUniformSnapshot`, `rowToTextureSnapshot`, `DEFAULT_WINDOW_STATE`
- `TextureStreamCache` — LRU eviction, in-flight deduplication, URL allowlist, `dispose`

### Streaming demo (browser / manual)

```bash
# Copy .env template and fill in your Supabase credentials
cp examples/streaming-demo/.env.example examples/streaming-demo/.env.local

# Start the streaming demo dev server (port 5174)
npm run dev:streaming

# Or run both the classic demo and streaming demo simultaneously:
npm run dev          # port 5173 — asia-building (offline, no Supabase needed)
npm run dev:streaming # port 5174 — streaming demo (requires Supabase)
```

### Supabase local stack (full end-to-end without a cloud project)

```bash
# Start the full local Supabase stack (Postgres + Realtime + Storage + Edge Functions)
supabase start

# Apply migrations to the local DB
supabase db reset     # drops + re-creates, applies all migrations/ + seed.sql

# Serve Edge Functions locally with hot-reload
supabase functions serve --env-file supabase/.env.local

# Run migrations against the local stack and inspect the schema
supabase db diff      # shows pending migration diff
supabase studio       # opens Supabase Studio at localhost:54323
```

When `supabase start` is running, set these in your `.env.local`:

```
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<printed by supabase start>
VITE_BUILDING_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

## Development

```bash
npm install
npm run dev          # serves examples/asia-building on :5173
npm run dev:streaming # serves examples/streaming-demo on :5174
npm run build        # produces dist/ (the publishable package)
npm run build:demo   # produces dist-demo/ (static export of asia-building)
npm run typecheck    # TypeScript no-emit check
npm test             # Vitest unit tests
```

### Examples

| Example | What it shows |
|---|---|
| `examples/minimal/` | ~60 lines. Shortest path to a rendered window. |
| `examples/asia-building/` | Full demo: 160 windows, cinematic camera, day/night, glass dirt, PBR curtains. What `npm run dev` serves. |
| `examples/streaming-demo/` | **New.** Full streaming demo: auth, window selection, Realtime sync, texture upload, AI generation, presence avatars. |

### New source files

```
src/streaming/
├── types.ts              — shared DB row types + conversion helpers
├── TextureStreamCache.ts — LRU texture loader with GPU-safe eviction
├── WindowStateManager.ts — per-window state FSM; routes DB updates to material
├── SupabaseShaderStream.ts — Realtime integration; hydration + broadcast + presence
└── index.ts              — streaming sub-path re-exports

supabase/
├── migrations/
│   ├── 001_postgis_setup.sql      — PostGIS + extensions
│   ├── 002_buildings_windows.sql  — buildings (geography) + windows (PointZ)
│   ├── 003_window_states.sql      — shader uniforms table + atomic upsert RPC
│   ├── 004_rls_policies.sql       — Row Level Security
│   └── 005_realtime_and_views.sql — Realtime publication + denorm views
├── functions/
│   ├── generate-pbr-textures/  — Google Imagen / Stability AI generation
│   ├── process-texture-upload/ — multipart upload handler
│   └── window-state-sync/      — atomic state commit endpoint
└── seed.sql                    — demo building + placeholder window
```

---

## Limitations and roadmap

- **No envmap / cubemap reflections** on the glass area.
- **One material per window mesh.** An instanced-attribute variant for very
  high window counts is on the roadmap.
- **Pre-lit interior.** The atlas is always treated as already-shaded
  photography; scene lights do not relight the interior. This is by design.
- **Streaming: Edge Functions require a Supabase project** (or local CLI stack).
  The base `InteriorMappingMaterial` has no external runtime dependencies.
- **AI generation is async** and depends on third-party API quotas. For
  production use, add a credits/rate-limit table.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full streaming roadmap (Phase 2:
instanced renderer; Phase 3: delta compression, self-hosted deployment).

---

## Credits

- Joost van Dongen, *Interior Mapping: A new technique for rendering
  realistic buildings* (2008).
- The Three.js team for `MeshStandardMaterial` and the `onBeforeCompile`
  hook this material extends.
- Supabase for the Realtime + PostGIS platform underpinning the streaming layer.

---

## License

[MIT](./LICENSE).
