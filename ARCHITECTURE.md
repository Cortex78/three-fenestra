# three-fenestra: On-the-Fly Shader Streaming Architecture

> **Branch:** `claude/shader-streaming-architecture-PBSVg`  
> **Status:** Design + Prototype implementation

---

## 1. Executive Summary

**three-fenestra** today is a pure-client Three.js library. Every window samples
from a single shared atlas; each window's "room" is determined by a deterministic
hash of its world-space centre — stable but static.

This document describes how to evolve the system into a **live multi-user building
visualiser** where:

- Each user **owns one or more windows** (identified by `window_id`).
- Users can upload custom room images, overlay/curtain images, or invoke a
  **generative-AI pipeline** (Google Imagen / Gemini-Flash) to produce full PBR
  texture sets on demand.
- Mutations to a window's shader uniforms and textures are **broadcast in real-time**
  to every client viewing that building via **Supabase Realtime**.
- Concurrent edits are protected by **PostgreSQL-level atomicity** (row-level
  locking + optimistic concurrency control).
- Buildings and windows carry **PostGIS geometry** so the system can answer spatial
  queries: "Which windows can I see from this vantage point?" or "Which users are
  in the same tower?".

The GLSL shader code is **never streamed** — it is compiled once per shader variant.
What streams is the **uniform payload**: texture URLs + float knobs. Textures are
fetched from Supabase Storage (backed by a CDN), decoded via a client-side LRU
`TextureStreamCache`, and hot-swapped into the live `InteriorMappingMaterial`
without dropping a frame.

---

## 2. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT  (Browser / WebGL)                      │
│                                                                       │
│  ┌──────────────┐  subscribe   ┌──────────────────────────────────┐  │
│  │  Three.js     │◄────────────│  SupabaseShaderStream             │  │
│  │  Scene        │             │  • Realtime channel per building  │  │
│  │               │  hot-swap   │  • Presence tracking              │  │
│  │  window[N]    │◄────────────│  • Broadcast for hi-freq updates  │  │
│  │  .material    │             └──────────────┬───────────────────┘  │
│  │               │  load URL   ┌──────────────▼───────────────────┐  │
│  │               │◄────────────│  TextureStreamCache               │  │
│  └──────────────┘             │  • LRU eviction (max N textures)  │  │
│                                │  • Progressive: 128px → full-res  │  │
│  ┌──────────────────────────┐  └──────────────────────────────────┘  │
│  │  WindowCustomizationPanel│                                         │
│  │  • Texture upload        │  Supabase JS SDK (supabase-js v2)       │
│  │  • AI generation prompt  │──────────────────────────────────────── │
│  │  • PBR sliders           │                                         │
│  └──────────────────────────┘                                         │
└──────────────────────────────────────────────────────────────────────┘
                        │ HTTPS + WebSocket
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SUPABASE PLATFORM                                 │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  Auth (JWT)   │  │  Storage     │  │  Realtime                │   │
│  │  • email/pw   │  │  • textures/ │  │  • postgres_changes      │   │
│  │  • magic link │  │  • uploads/  │  │  • broadcast channel     │   │
│  │  • OAuth      │  │  • generated/│  │  • presence              │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  PostgreSQL + PostGIS                                            │ │
│  │                                                                  │ │
│  │  buildings ──< windows ──< window_states                        │ │
│  │  (geography)    (PointZ)    (uniforms JSON + texture URLs)       │ │
│  │                                                                  │ │
│  │  user_textures            shader_generation_jobs                 │ │
│  │  (S3 key + meta)          (prompt → Imagen → URL)               │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Edge Functions (Deno)                                        │    │
│  │  • generate-pbr-textures  (calls Google Imagen API)          │    │
│  │  • process-texture-upload (resize, MIP, convert to WebP)     │    │
│  │  • window-state-sync      (validate + atomic upsert)         │    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model & PostGIS Schema

### 3.1 Entity Relationship

```
buildings  (1) ──────< (N) windows  (1) ──────< (1) window_states
                             │
                             ├──< user_textures  (N:M via window_states JSONB)
                             └──< shader_generation_jobs
```

### 3.2 Key Design Decisions

**Why PostGIS?**
- Buildings are geo-referenced (lat/lng + altitude).
- Spatial queries: "give me all windows within 300m of coordinates X,Y".
- Floor-level vertical stacking is encoded as `PointZ` in ECEF coordinates.
- Future: shadow simulation from sun azimuth, line-of-sight checks between buildings.

**Why per-window `window_states` row (not inline on `windows`)?**
- Separates mutable rendering state from immutable geometry.
- Enables Supabase Realtime to publish fine-grained `UPDATE` events.
- Allows row-level locking without touching the geometry table.

**Why JSONB for `custom_metadata`?**
- Free-form escape hatch: seasonal themes, corporate branding, accessibility flags.
- PostgreSQL JSONB is indexed (`gin`) and queryable without schema migrations.

**Texture URL strategy**
- `back_atlas_url` and `front_atlas_url` are **Supabase Storage public URLs**.
- Client `TextureStreamCache` resolves these to THREE.Texture instances.
- `null` → fall back to the building-level default atlas.
- A 1×1 custom atlas (`back_atlas_cols=1, back_atlas_rows=1`) gives the user a
  whole window filled with their custom room image, without touching the GLSL.

---

## 4. Real-Time Streaming Protocol

### 4.1 Two-Channel Architecture

```
Building channel  ← postgres_changes on window_states
  • Event: INSERT / UPDATE / DELETE
  • Payload: full new row (texture URLs + float uniforms)
  • Debounce: Supabase broadcasts within ~10 ms of commit
  • Use case: persistent state changes (new texture, ownership transfer)

Broadcast channel ← ephemeral pub/sub (no DB write)
  • Event: "uniform-update"
  • Payload: { windowId: uuid, uniforms: Partial<UniformSnapshot> }
  • Use case: smooth interpolation during day/night transition,
              live slider preview before committing to DB
```

### 4.2 Client Subscription Flow

```typescript
// 1. Subscribe to building
await stream.subscribeTo(buildingId);

// 2. Realtime delivers window_state row on change
stream.on('window-state-changed', (windowUuid, newState) => {
  const mat = materialRegistry.get(windowUuid);
  if (!mat) return;

  // Non-texture uniforms: zero-copy hot-swap, no needsUpdate
  mat.depth              = newState.depth;
  mat.backScale          = newState.back_scale;
  mat.frontTransmission  = newState.front_transmission;
  // ...

  // Texture swap: async, LRU-cached
  if (newState.back_atlas_url) {
    textureCache.load(newState.back_atlas_url).then(tex => {
      mat.setBackAtlas(tex);
      // Changing atlas DIMENSIONS requires needsUpdate=true (shader recompile)
      if (newState.back_atlas_cols !== mat.interiorUniforms.uBackAtlasCols.value) {
        mat.interiorUniforms.uBackAtlasCols.value = newState.back_atlas_cols;
        mat.interiorUniforms.uBackAtlasRows.value = newState.back_atlas_rows;
        mat.needsUpdate = true;
      }
    });
  }
});

// 3. Broadcast channel for hi-freq preview
stream.onBroadcast('uniform-update', ({ windowId, uniforms }) => {
  applyUniformSnapshot(materialRegistry.get(windowId), uniforms);
});
```

### 4.3 Shader Variant Pre-Compilation Strategy

Changing atlas dimensions (cols/rows) forces `needsUpdate = true` on the
`MeshStandardMaterial` subclass, which triggers a GLSL recompile. This stalls the
GPU for ~5–50 ms. To avoid this:

**Pre-define four shader variants at scene load time:**

| Variant | backAtlasCols | backAtlasRows | Covers |
|---------|--------------|--------------|--------|
| `1x1`   | 1            | 1            | Custom single-room textures |
| `2x2`   | 2            | 2            | Small custom atlases |
| `4x4`   | 4            | 4            | Default starter pack |
| `custom`| runtime      | runtime      | User-defined grids |

The `1x1` variant covers 99% of user-customised windows. Switching a window from
the shared `4x4` to a custom `1x1` atlas requires exactly one recompile, which
happens off the hot path during texture load.

---

## 5. Atomicity & Concurrency

### 5.1 Optimistic Locking

Every write to `window_states` passes the client's `last_known_updated_at`:

```sql
SELECT update_window_state(
  p_window_id       := $1::uuid,
  p_user_id         := auth.uid(),
  p_state           := $2::jsonb,
  p_expected_ver    := $3::timestamptz   -- null = unconditional write
);
```

If `p_expected_ver ≠ current updated_at`, the function raises
`serialization_failure (40001)`. The client retries with a fresh fetch.

### 5.2 Row-Level Security

```
windows.owner_user_id = auth.uid()           → full write access
windows.owner_user_id IS NULL                → read-only for everyone
buildings table                              → public read, admin-only write
window_states                                → owner writes, world reads
user_textures                                → private to owner
shader_generation_jobs                       → private to owner
```

### 5.3 Presence & Live Editing Indicators

The broadcast channel carries presence heartbeats:

```typescript
// Every 30 s:
stream.broadcastPresence({ userId, focusedWindowId, color: userColor });

// UI: show coloured dot on windows being edited by other users
stream.onPresence((presences) => {
  presences.forEach(p => windowOverlay.showEditor(p.focusedWindowId, p.color));
});
```

---

## 6. AI PBR Texture Generation Pipeline

```
User types prompt
      │
      ▼
POST /functions/v1/generate-pbr-textures
  { windowId, prompt, layers: ['back', 'front', 'normal', 'roughness'] }
      │
      ▼ (Deno Edge Function)
Insert shader_generation_jobs row  (status='pending')
      │
      ▼
Call Google Imagen 3 API
  • Single call: prompt → base color image
  • Second call: "convert to normal map" (ControlNet-style)
  • Third call: "generate roughness/metalness from base color"
      │
      ▼
Upload to supabase storage: generated/{jobId}/back.webp, normal.webp, ...
      │
      ▼
Update shader_generation_jobs: status='completed', result_urls=[...]
      │
      ▼  (Supabase Realtime fires)
Client receives job update
      │
      ▼
Client calls window-state-sync edge function to atomically apply new textures
      │
      ▼
All building viewers receive window_states UPDATE → hot-swap textures
```

**Alternative AI providers** (configurable via `GENERATOR_PROVIDER` env var):
- `google-imagen-3` (recommended for PBR quality)
- `stability-ai` (Stable Diffusion XL — open weights, self-hostable)
- `fal-ai` (fast inference, good for previews)

The Edge Function is provider-agnostic; only the adapter changes.

---

## 7. Texture Upload Pipeline

```
User selects image file
      │
      ▼
Client: validate MIME, check < 10 MB
      │
      ▼
POST /functions/v1/process-texture-upload
  (multipart: file + { windowId, textureType, atlasCols, atlasRows })
      │
      ▼ (Deno Edge Function)
Sharp-wasm: resize → 1024×1024, convert → WebP lossless
Generate thumbnail 128×128 (for LRU cache pre-warm)
      │
      ▼
Upload to supabase storage:
  textures/{userId}/{uuid}/full.webp
  textures/{userId}/{uuid}/thumb.webp
      │
      ▼
Insert user_textures row (url, thumb_url, atlas_cols, atlas_rows, texture_type)
      │
      ▼
Return { textureId, url, thumbUrl }
      │ (client can immediately preview via thumb)
      ▼
Call window-state-sync to apply → Realtime broadcast to all viewers
```

---

## 8. Client Library: `StreamingInteriorMappingMaterial`

The evolved material wraps the existing `InteriorMappingMaterial` with:

1. **`connectStream(stream, windowUuid)`** — subscribe to per-window state changes.
2. **`applyState(state: WindowStateSnapshot)`** — idempotent hot-swap of all uniforms
   + async texture loading.
3. **`previewState(partial: Partial<WindowStateSnapshot>)`** — ephemeral preview
   (broadcasts on the broadcast channel, does NOT write DB).
4. **`commitState()`** — persist the previewed state to DB via edge function.
5. **`dispose()`** — unsubscribe, evict textures from cache.

---

## 9. PostGIS Spatial Queries

```sql
-- Find all windows within 200m of a user's location
SELECT w.id, w.floor_number, ws.back_atlas_url
FROM windows w
JOIN buildings b ON b.id = w.building_id
JOIN window_states ws ON ws.window_id = w.id
WHERE ST_DWithin(
  b.location::geography,
  ST_SetSRID(ST_MakePoint($lon, $lat), 4326)::geography,
  200   -- metres
)
ORDER BY b.location::geography <-> ST_MakePoint($lon, $lat)::geography;

-- Count lit windows per floor (analytics)
SELECT floor_number, COUNT(*) FILTER (WHERE ws.is_lit) AS lit_count
FROM windows w
LEFT JOIN window_states ws ON ws.window_id = w.id
WHERE w.building_id = $1
GROUP BY floor_number
ORDER BY floor_number;

-- Buildings visible from a vantage point (bounding-box approximation)
SELECT b.name, b.location, b.footprint
FROM buildings b
WHERE ST_Intersects(
  b.footprint,
  ST_Buffer(ST_SetSRID(ST_MakePoint($lon, $lat), 4326)::geography, 500)::geometry
);
```

---

## 10. Implementation Roadmap

### Phase 1 — Foundation (this branch)
- [x] Architecture document
- [x] Supabase migrations (PostGIS schema + RLS + realtime functions)
- [x] `src/streaming/` TypeScript library
  - [x] `types.ts` — shared type definitions
  - [x] `TextureStreamCache.ts` — LRU texture loader
  - [x] `WindowStateManager.ts` — per-window state FSM
  - [x] `SupabaseShaderStream.ts` — Realtime integration
- [x] `StreamingInteriorMappingMaterial.ts` — evolved material
- [x] Supabase Edge Functions (generate-pbr, process-upload, state-sync)
- [x] `examples/streaming-demo/` — working browser demo

### Phase 2 — Polish
- [ ] Instanced renderer variant (1 draw call for N windows sharing an atlas)
- [ ] WebWorker texture decode (off main thread)
- [ ] WASM-accelerated atlas packing (when users upload multiple cells)
- [ ] Partial atlas update (replace single cell without re-uploading full atlas)
- [ ] Admin dashboard (building overview, window assignment, analytics)

### Phase 3 — Scale
- [ ] Edge CDN caching for texture URLs (cache-control headers)
- [ ] Delta compression for uniform snapshots (send only changed fields)
- [ ] Client-side GLSL hot-reload for power users (dev mode only)
- [ ] Self-hosted deployment guide (Supabase self-host + MinIO)

---

## 11. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Unauthorised window mutation | RLS: only `owner_user_id = auth.uid()` can write |
| Texture upload abuse | Edge Function: MIME check, 10 MB limit, virus scan (ClamAV on dedicated worker) |
| Prompt injection in AI generation | Edge Function sanitises prompt; model output is an image, not code |
| Realtime message spoofing | Broadcast payloads carry JWT claim; server-side re-validation on commit |
| Concurrent edit corruption | Optimistic locking (`expected_ver`) + serializable isolation |
| Storage bucket enumeration | Private bucket policy; CDN signed URLs with 1 h TTL |
| XSS via texture URL | TextureStreamCache validates URL origin against allowlist |

---

## 12. Dependency Additions

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.43.0"
  }
}
```

`@supabase/supabase-js` is added as an **optional runtime dependency** — the base
`InteriorMappingMaterial` continues to work with zero new deps. Only the
`src/streaming/` layer requires Supabase.
