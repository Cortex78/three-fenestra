# Streaming Layer — API Reference

> **Also read:** [Supabase setup guide](supabase-setup.md) · [Architecture overview](../ARCHITECTURE.md)

The streaming layer (`three-fenestra/streaming`) connects a Three.js building scene to Supabase Realtime. Every window's shader state — 23 float uniforms plus up to 6 texture URLs — can be mutated by its owner and broadcast to all viewers in real-time without dropping a frame.

---

## Import

```ts
import {
  TextureStreamCache,
  WindowStateManager,
  SupabaseShaderStream,
} from 'three-fenestra/streaming';

// Types only (no runtime cost):
import type {
  WindowStateRow,
  BuildingWindowStateRow,
  UniformSnapshot,
  TextureSnapshot,
  PresencePayload,
} from 'three-fenestra/streaming';
```

Requires `@supabase/supabase-js ^2.43.0`.  
The base `InteriorMappingMaterial` has no streaming dependency.

---

## TextureStreamCache

LRU cache for `THREE.Texture` objects loaded from URLs. Handles:
- Single in-flight promise per URL (no duplicate network requests)
- LRU eviction with GPU `texture.dispose()` on eviction
- Progressive loading (thumbnail → full-res)
- URL origin allowlist for security

### Constructor

```ts
new TextureStreamCache(opts?: TextureStreamCacheOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxEntries` | `number` | `64` | Maximum textures to keep in GPU memory at once. |
| `anisotropy` | `number` | `8` | Texture anisotropy. Use `renderer.capabilities.getMaxAnisotropy()`. |
| `allowedOrigins` | `string[]` | `['*']` | URL origins to accept. Pass your Supabase Storage domain in production. Example: `['https://xyz.supabase.co']`. |
| `onEvict` | `(url: string) => void` | — | Called when an entry is evicted (useful for diagnostics). |

### Methods

#### `load(url: string): Promise<Texture>`

Load a texture from a URL. Returns cached texture if present; deduplicates concurrent calls for the same URL.

```ts
const tex = await textureCache.load('https://storage.supabase.co/.../room.webp');
material.setBackAtlas(tex);
```

#### `loadProgressive(thumbUrl, fullUrl, onFullResReady): Promise<Texture>`

Immediately resolves with the thumbnail texture while the full-res loads in the background. The callback fires when the full-res is ready.

```ts
const thumbTex = await textureCache.loadProgressive(
  thumbUrl, fullUrl,
  (fullTex) => material.setBackAtlas(fullTex),
);
material.setBackAtlas(thumbTex);  // show thumb immediately
```

#### `peek(url: string): Texture | null`

Synchronous cache check. Returns `null` if not yet loaded or still loading.

#### `evict(url: string): void`

Remove a URL from cache and dispose its GPU texture.

#### `dispose(): void`

Dispose all cached textures and clear the cache. Call on scene teardown.

#### `size: number` (getter)

Current number of entries in cache.

---

## WindowStateManager

Per-window state machine that routes Supabase updates to an `InteriorMappingMaterial`.

State machine:

```
IDLE ──load──► LOADING ──ready──► LIVE
                  │                 │
                  └──error──► ERROR ├──stream update──► APPLYING ──done──► LIVE
                                    └──dispose──► DISPOSED
```

You normally don't instantiate `WindowStateManager` directly — `SupabaseShaderStream.registerMaterial()` creates one for you.

### Constructor

```ts
new WindowStateManager(windowId: string, opts: WindowStateManagerOptions)
```

| Option | Type | Description |
|---|---|---|
| `material` | `InteriorMappingMaterial` | The material to keep in sync. |
| `textureCache` | `TextureStreamCache` | Shared texture cache. |
| `defaultBackAtlasUrl` | `string \| null` | Building-level fallback if window has no custom back atlas. |
| `defaultFrontAtlasUrl` | `string \| null` | Building-level fallback front atlas. |
| `defaultAtlasCols` | `number` | Building default atlas columns. |
| `defaultAtlasRows` | `number` | Building default atlas rows. |
| `onMaterialUpdated` | `() => void` | Called after every material update. Hook into your render loop here. |

### Methods

#### `applyRow(row: WindowStateRow): Promise<void>`

Apply a full database row. Float uniforms update synchronously; textures load asynchronously. Concurrent calls are protected by a generation counter — stale loads are silently discarded.

#### `applyUniformBroadcast(uniforms: Partial<UniformSnapshot>): void`

Apply a partial uniform snapshot synchronously (from the broadcast channel). No texture changes. Zero allocations.

#### `resetToDefaults(): Promise<void>`

Reset to building defaults. Clears custom textures and re-applies default uniform values.

#### `dispose(): void`

Mark as disposed. All future `applyRow` calls are no-ops.

### Properties

| Property | Type | Description |
|---|---|---|
| `windowId` | `string` | UUID from the database. |
| `material` | `InteriorMappingMaterial` | The managed material. |
| `machineState` | `WindowMachineState` | Current FSM state. |
| `currentRow` | `WindowStateRow \| null` | Last applied database row. |

### Events

```ts
manager.addEventListener('statechange', (e: CustomEvent<WindowMachineState>) => {
  console.log('New state:', e.detail);
});
```

---

## SupabaseShaderStream

Main integration class. One instance per scene.

### Constructor

```ts
new SupabaseShaderStream(
  supabase:     SupabaseClient,
  textureCache: TextureStreamCache,
  opts?:        ShaderStreamOptions,
)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Log Realtime events and state changes to console. |
| `presenceIntervalMs` | `number` | `30000` | Presence heartbeat interval (ms). |
| `allowedTextureOrigins` | `string[]` | `['*']` | Passed to `TextureStreamCache`. |

### Subscribing

#### `subscribeTo(buildingId, hydrationCallback): Promise<void>`

Subscribe to all window state changes for a building. Fires `hydrationCallback` once with all window rows for initial scene setup, then keeps all registered materials in sync via Realtime.

```ts
await stream.subscribeTo(buildingId, async (rows) => {
  for (const row of rows) {
    const material = SupabaseShaderStream.buildMaterial(row, defaultAtlas);
    const mesh     = buildMesh(row, material);
    scene.add(mesh);

    stream.registerMaterial(row.window_uuid, material, row, {
      onMaterialUpdated: () => renderer.render(scene, camera),
    });
  }
});
```

#### `unsubscribeFrom(buildingId): Promise<void>`

Unsubscribe and release the Realtime channel for a building.

### Registering materials

#### `registerMaterial(windowUuid, material, initialRow, opts?): WindowStateManager`

Register an `InteriorMappingMaterial` so the stream can route Realtime updates to it. Returns the `WindowStateManager` for the window.

```ts
const manager = stream.registerMaterial(row.window_uuid, material, row, {
  defaultBackAtlasUrl:  row.default_back_atlas_url,
  defaultFrontAtlasUrl: row.default_front_atlas_url,
  defaultAtlasCols:     row.back_atlas_cols,
  defaultAtlasRows:     row.back_atlas_rows,
  onMaterialUpdated:    () => { /* e.g. trigger a re-render */ },
});
```

### Static factory

#### `SupabaseShaderStream.buildMaterial(row, defaultBackAtlas, opts?): InteriorMappingMaterial`

Create a fully configured `InteriorMappingMaterial` from a `BuildingWindowStateRow` hydration row. The material starts with the building's default atlas; `registerMaterial` will async-swap to any custom textures after construction.

```ts
const material = SupabaseShaderStream.buildMaterial(row, defaultBackAtlas, {
  defaultFrontAtlas: overlayAtlas,
  glassDirtMap:      dirtTex,
});
```

### Mutations

#### `updateWindowState(windowId, state, expectedVersion?): Promise<WindowStateRow>`

Atomically persist a window's shader state to the database. Supabase Realtime then broadcasts the `UPDATE` to all subscribers.

- `state` accepts any combination of `UniformSnapshot` fields (camelCase) or raw DB column names (snake_case).
- `expectedVersion` enables optimistic locking: if another write has occurred since you read the state, the call throws with code `serialization_failure` and you should re-fetch before retrying.

```ts
// Unconditional write
await stream.updateWindowState(windowId, { depth: 1.5, isLit: false });

// Optimistic locking: only write if nobody else changed it since we read version 7
try {
  await stream.updateWindowState(windowId, { depth: 1.5 }, 7);
} catch (err) {
  if (err.message.includes('serialization_failure')) {
    // Another writer beat us — re-fetch and retry
  }
}
```

#### `broadcastUniformPreview(buildingId, windowId, uniforms): void`

Broadcast an ephemeral uniform update via the broadcast channel. **No database write.** All other viewers see the preview in real-time. Used for live slider dragging before the user commits.

```ts
// On slider input:
stream.broadcastUniformPreview(buildingId, windowId, {
  depth:             parseFloat(slider.value),
  interiorEmissiveR: 2.0,
});
```

#### `claimWindow(windowId): Promise<void>`

Assign ownership of an unowned window to the current authenticated user. Only works if `owner_user_id IS NULL`.

#### `releaseWindow(windowId): Promise<void>`

Remove ownership from the current user and reset the material to building defaults.

### Presence

#### `setFocusedWindow(buildingId, windowId | null): void`

Tell other viewers which window you are currently editing. Shows an editing indicator on that window.

#### `onPresenceUpdate(callback): () => void`

Subscribe to presence updates. Returns an unsubscribe function.

```ts
const unsub = stream.onPresenceUpdate((presences) => {
  presences.forEach(p => {
    console.log(p.username, 'is editing', p.focusedWindowId);
  });
});

// Later:
unsub();
```

The `PresencePayload` type:

```ts
interface PresencePayload {
  userId:          string;
  username:        string;
  focusedWindowId: string | null;
  color:           string;   // random hex assigned per session
  joinedAt:        string;   // ISO timestamp
}
```

### Dispose

#### `dispose(): Promise<void>`

Unsubscribe all channels, dispose all managers and the texture cache. Call on component unmount or page navigation.

```ts
window.addEventListener('beforeunload', () => stream.dispose());
```

---

## Type reference

### `UniformSnapshot`

All 23 shader float/bool uniforms in camelCase. Used for `broadcastUniformPreview` and `updateWindowState`.

```ts
interface UniformSnapshot {
  depth:               number;   // 0.1–20.0,   default 1.0
  backScale:           number;   // 0.05–0.999, default 0.66
  interiorEmissiveR:   number;   // 0–10 (HDR), default 0.75
  interiorEmissiveG:   number;
  interiorEmissiveB:   number;
  frontTransmission:   number;   // 0–1, default 0.25
  frontAlphaBoost:     number;   // 0.1–5, default 1.0
  frontNormalScale:    number;   // 0–5, default 1.0
  glassThickness:      number;   // 0–1, default 0.039
  refractionStrength:  number;   // 0–0.1, default 0.002
  glassDirtStrength:   number;   // 0–2, default 0.35
  glassFresnelStrength:number;   // 0–2, default 0.0
  glassFresnelR:       number;   // 0–1, default 0.85
  glassFresnelG:       number;   // 0–1, default 0.92
  glassFresnelB:       number;   // 0–1, default 1.0
  glassSmudgeStrength: number;   // 0–2, default 0.0
  isLit:               boolean;  // default true
}
```

### `TextureSnapshot`

The texture URL set for a window.

```ts
interface TextureSnapshot {
  backAtlasUrl:      string | null;  // null → use building default
  frontAtlasUrl:     string | null;
  frontNormalUrl:    string | null;
  frontRoughnessUrl: string | null;
  frontMetalnessUrl: string | null;
  glassDirtUrl:      string | null;
  backAtlasCols:     number;
  backAtlasRows:     number;
  frontAtlasCols:    number;
  frontAtlasRows:    number;
}
```

### Helper functions

```ts
// Convert a DB row to a UniformSnapshot (sync, no I/O)
rowToUniformSnapshot(row: WindowStateRow): UniformSnapshot

// Extract texture URLs from a DB row
rowToTextureSnapshot(row: WindowStateRow): TextureSnapshot

// Default uniform values for an uncustomised window
DEFAULT_WINDOW_STATE: UniformSnapshot
```

---

## Streaming two-channel protocol in detail

### Channel 1 — `postgres_changes` (persistent state)

Fires on `INSERT`, `UPDATE`, `DELETE` to the `window_states` table.
Payload contains the full new row. `WindowStateManager.applyRow()` handles it:

1. Apply all float uniforms synchronously (zero GPU stall).
2. Load changed texture URLs from `TextureStreamCache` (async).
3. If atlas *dimensions* change (cols/rows), set `material.needsUpdate = true` — triggers a one-time GLSL recompile (~20 ms; isolated to one window).

### Channel 2 — broadcast (ephemeral preview)

Sub-millisecond latency; no database write. Used for slider drag previews.
Payload: `{ windowId, uniforms: Partial<UniformSnapshot>, ephemeral: true }`.
`WindowStateManager.applyUniformBroadcast()` applies it in zero allocs.

> **Important:** ephemeral broadcasts are *not* persisted. If the user refreshes before clicking "Publish", the preview is lost. Always call `updateWindowState()` to persist.

### Presence

Each authenticated viewer tracks its session every `presenceIntervalMs` (default 30 s).
Presence state is visible to all subscribers via `channel.presenceState()`.
The `sync` event fires whenever any viewer joins, leaves, or updates its payload.

---

## Concurrency and atomicity details

### Optimistic locking workflow

```
Client A reads window_states row → version = 7
Client B reads window_states row → version = 7

Client A writes (expectedVersion = 7) → OK → version = 8
Client B writes (expectedVersion = 7) → FAIL: serialization_failure (40001)
  → Client B fetches fresh row (version = 8)
  → Client B merges changes
  → Client B writes (expectedVersion = 8) → OK → version = 9
```

The `update_window_state()` stored procedure:
1. Checks `windows.owner_user_id = p_user_id` (ownership).
2. `SELECT version FROM window_states WHERE window_id = p_window_id FOR UPDATE` — acquires a row lock.
3. Compares `version` to `p_expected_version`. Raises `40001` on mismatch.
4. Upserts the full row in one statement.
5. The versioning trigger increments `version` and stamps `updated_at`.

### Row Level Security summary

| Table | Read | Write |
|---|---|---|
| `buildings` | Everyone (if `is_public`) | Owner user |
| `windows` | Everyone (public building) | Building owner |
| `window_states` | Everyone | Window owner (`is_locked = false`) |
| `user_textures` | Owner only | Owner only |
| `shader_generation_jobs` | Owner only | Owner only |
