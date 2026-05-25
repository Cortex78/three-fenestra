/**
 * SupabaseShaderStream
 *
 * Connects a Three.js building scene to Supabase Realtime.
 *
 * Responsibilities:
 *  1. Initial scene hydration: load all window states from `v_building_window_states`
 *     in a single query on subscribe.
 *  2. postgres_changes listener: receive INSERT/UPDATE/DELETE on `window_states`
 *     and route to the correct WindowStateManager.
 *  3. Broadcast channel: relay ephemeral uniform-update messages for hi-freq preview.
 *  4. Presence: heartbeat every 30 s, expose live editor list.
 *  5. Mutation helpers: `updateWindowState`, `claimWindow`, `releaseWindow`.
 *
 * Usage:
 *
 * ```typescript
 * import { createClient } from '@supabase/supabase-js';
 * import { SupabaseShaderStream } from 'three-fenestra/streaming';
 *
 * const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
 * const stream   = new SupabaseShaderStream(supabase, textureCache);
 *
 * await stream.subscribeTo(buildingId, (rows) => {
 *   for (const row of rows) {
 *     const mat = buildMaterial(row);  // your scene setup
 *     stream.registerMaterial(row.window_uuid, mat, row);
 *   }
 * });
 *
 * // Later — user edits their window:
 * await stream.updateWindowState(windowId, { depth: 1.5, isLit: false });
 * ```
 */

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { Vector2, Vector3, Color } from 'three';
import { InteriorMappingMaterial } from '../InteriorMappingMaterial.js';
import { TextureStreamCache } from './TextureStreamCache.js';
import { WindowStateManager } from './WindowStateManager.js';
import type {
  BuildingWindowStateRow,
  WindowStateRow,
  UniformBroadcast,
  PresencePayload,
  UniformSnapshot,
} from './types.js';
import { rowToUniformSnapshot } from './types.js';

export interface ShaderStreamOptions {
  /**
   * When true, logs Realtime events and state changes to console.
   * Default false.
   */
  debug?: boolean;
  /**
   * Interval in milliseconds for presence heartbeats. Default 30_000.
   */
  presenceIntervalMs?: number;
  /**
   * Origin allowlist for the TextureStreamCache. Default ['*'].
   */
  allowedTextureOrigins?: string[];
}

/** Callback invoked on initial load with all window rows for a building. */
export type SceneHydrationCallback = (
  rows: BuildingWindowStateRow[],
) => void | Promise<void>;

/** Callback for presence updates. */
export type PresenceCallback = (presences: PresencePayload[]) => void;

export class SupabaseShaderStream {
  private readonly supabase:     SupabaseClient;
  readonly textureCache:         TextureStreamCache;
  private readonly opts:         Required<ShaderStreamOptions>;

  /** window_uuid → manager */
  private readonly managers = new Map<string, WindowStateManager>();
  /** building_id → Realtime channel */
  private readonly channels = new Map<string, RealtimeChannel>();

  private presenceInterval?: ReturnType<typeof setInterval>;
  private currentUserId?:    string;
  private currentUsername?:  string;
  private focusedWindowId?:  string;
  private presenceColor:     string = this.randomColor();
  private presenceCallbacks: PresenceCallback[] = [];

  constructor(
    supabase:     SupabaseClient,
    textureCache: TextureStreamCache,
    opts:         ShaderStreamOptions = {},
  ) {
    this.supabase     = supabase;
    this.textureCache = textureCache;
    this.opts = {
      debug:                  opts.debug                  ?? false,
      presenceIntervalMs:     opts.presenceIntervalMs     ?? 30_000,
      allowedTextureOrigins:  opts.allowedTextureOrigins  ?? ['*'],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Subscription lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to all window state changes for `buildingId`.
   * Fires `hydrationCallback` once with all window rows for initial scene setup.
   */
  async subscribeTo(
    buildingId:        string,
    hydrationCallback: SceneHydrationCallback,
  ): Promise<void> {
    if (this.channels.has(buildingId)) {
      this.log(`Already subscribed to building ${buildingId}`);
      return;
    }

    // 1. Initial hydration query
    const { data, error } = await this.supabase
      .from('v_building_window_states')
      .select('*')
      .eq('building_id', buildingId);

    if (error) throw new Error(`SupabaseShaderStream: hydration failed — ${error.message}`);

    const rows = (data ?? []) as BuildingWindowStateRow[];
    this.log(`Hydrated ${rows.length} windows for building ${buildingId}`);

    // Fire callback so the caller can build materials + register them
    await hydrationCallback(rows);

    // 2. Realtime channel: postgres_changes on window_states
    const channel = this.supabase.channel(`building:${buildingId}`, {
      config: { broadcast: { self: false } },
    });

    channel
      // ── Persistent state changes (DB writes) ──
      .on(
        'postgres_changes',
        {
          event:  '*',
          schema: 'public',
          table:  'window_states',
        },
        (payload) => this.handleWindowStateChange(payload as unknown as {
          eventType: string;
          new: WindowStateRow;
          old: Partial<WindowStateRow>;
        }),
      )
      // ── Ephemeral broadcast (slider preview) ──
      .on('broadcast', { event: 'uniform-update' }, ({ payload }) => {
        this.handleBroadcast(payload as UniformBroadcast);
      })
      // ── Presence ──
      .on('presence', { event: 'sync' }, () => {
        // presenceState() returns { [presenceKey]: PresencePayload[] }.
        // Flatten, then deduplicate by userId — a single user can appear more
        // than once if track() was called before the server merged the entries,
        // or if a stale socket reconnected. Keep the most-recently-joined entry.
        const raw = Object.values(
          channel.presenceState<PresencePayload>(),
        ).flat();
        const byUser = new Map<string, PresencePayload>();
        for (const p of raw) {
          const existing = byUser.get(p.userId);
          if (!existing || p.joinedAt > existing.joinedAt) {
            byUser.set(p.userId, p);
          }
        }
        const presences = [...byUser.values()];
        this.presenceCallbacks.forEach((cb) => cb(presences));
      })
      .subscribe((status) => {
        this.log(`Channel building:${buildingId} → ${status}`);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Reconnect after 3 s — keeps realtime alive through transient drops
          setTimeout(() => {
            if (this.channels.has(buildingId)) {
              this.log(`Reconnecting channel for building ${buildingId}…`);
              this.supabase.removeChannel(channel).then(() => {
                this.channels.delete(buildingId);
                this.subscribeTo(buildingId, async () => { /* skip re-hydration on reconnect */ });
              });
            }
          }, 3_000);
        }
      });

    this.channels.set(buildingId, channel);

    // 3. Start presence heartbeat if user is authenticated
    this.startPresenceIfAuthed(channel);
  }

  /**
   * Unsubscribe from a building channel and release resources.
   */
  async unsubscribeFrom(buildingId: string): Promise<void> {
    const ch = this.channels.get(buildingId);
    if (!ch) return;
    await this.supabase.removeChannel(ch);
    this.channels.delete(buildingId);
  }

  /**
   * Register a material + its initial DB row so the stream can hot-swap it.
   * Call this inside the `hydrationCallback` for each window.
   */
  registerMaterial(
    windowUuid: string,
    material:   InteriorMappingMaterial,
    initialRow: BuildingWindowStateRow,
    opts?: {
      defaultBackAtlasUrl?:  string | null;
      defaultFrontAtlasUrl?: string | null;
      defaultAtlasCols?:     number;
      defaultAtlasRows?:     number;
      onMaterialUpdated?:    () => void;
    },
  ): WindowStateManager {
    const manager = new WindowStateManager(windowUuid, {
      material,
      textureCache:          this.textureCache,
      defaultBackAtlasUrl:   opts?.defaultBackAtlasUrl  ?? initialRow.default_back_atlas_url,
      defaultFrontAtlasUrl:  opts?.defaultFrontAtlasUrl ?? initialRow.default_front_atlas_url,
      defaultAtlasCols:      opts?.defaultAtlasCols     ?? initialRow.back_atlas_cols,
      defaultAtlasRows:      opts?.defaultAtlasRows     ?? initialRow.back_atlas_rows,
      onMaterialUpdated:     opts?.onMaterialUpdated,
    });

    this.managers.set(windowUuid, manager);

    // Apply initial state asynchronously
    manager.applyRow(initialRow).catch(console.warn);

    return manager;
  }

  // ─────────────────────────────────────────────────────────────
  // Mutations
  // ─────────────────────────────────────────────────────────────

  /**
   * Atomically update a window's shader state in the database.
   * On success, all subscribers (including the caller) receive the UPDATE event.
   *
   * Uses the `update_window_state` stored procedure which enforces:
   *   - ownership check
   *   - optimistic locking (pass `expectedVersion` to prevent blind overwrites)
   *   - serializable write
   */
  async updateWindowState(
    windowId:        string,
    state:           Partial<UniformSnapshot> & { [key: string]: unknown },
    expectedVersion?: number,
  ): Promise<WindowStateRow> {
    const { data, error } = await this.supabase.rpc('update_window_state', {
      p_window_id:        windowId,
      p_state:            this.toSnakeCase(state),
      p_expected_version: expectedVersion ?? null,
    });

    if (error) throw new Error(`updateWindowState failed: ${error.message}`);
    return data as WindowStateRow;
  }

  /**
   * Broadcast an ephemeral uniform update (no DB write).
   * All other viewers see the preview in real-time via the broadcast channel.
   */
  broadcastUniformPreview(
    buildingId: string,
    windowId:   string,
    uniforms:   Partial<UniformSnapshot>,
  ): void {
    const ch = this.channels.get(buildingId);
    if (!ch) return;

    ch.send({
      type:  'broadcast',
      event: 'uniform-update',
      payload: {
        windowId,
        uniforms,
        ephemeral: true,
      } satisfies UniformBroadcast,
    });
  }

  /**
   * Claim ownership of a window for the current user.
   */
  async claimWindow(windowId: string): Promise<void> {
    const userId = await this.getUserId();
    const { error } = await this.supabase
      .from('windows')
      .update({ owner_user_id: userId })
      .eq('id', windowId)
      .is('owner_user_id', null);  // only claim unowned windows

    if (error) throw new Error(`claimWindow failed: ${error.message}`);
  }

  /**
   * Release ownership of a window (resets to building defaults).
   */
  async releaseWindow(windowId: string): Promise<void> {
    const { error } = await this.supabase
      .from('windows')
      .update({ owner_user_id: null })
      .eq('id', windowId)
      .eq('owner_user_id', await this.getUserId());

    if (error) throw new Error(`releaseWindow failed: ${error.message}`);

    // Reset material to building defaults
    this.managers.get(windowId)?.resetToDefaults();
  }

  /**
   * Set focus to a window (for presence — shows editing indicator to others).
   */
  setFocusedWindow(buildingId: string, windowId: string | null): void {
    this.focusedWindowId = windowId ?? undefined;
    const ch = this.channels.get(buildingId);
    if (ch) this.trackPresence(ch);
  }

  // ─────────────────────────────────────────────────────────────
  // Presence
  // ─────────────────────────────────────────────────────────────

  onPresenceUpdate(callback: PresenceCallback): () => void {
    this.presenceCallbacks.push(callback);
    return () => {
      this.presenceCallbacks = this.presenceCallbacks.filter((c) => c !== callback);
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Utility: build InteriorMappingMaterial from a hydration row
  // ─────────────────────────────────────────────────────────────

  /**
   * Convenience factory: create an `InteriorMappingMaterial` from a hydration row.
   * The material starts with the building's default atlas; `registerMaterial` will
   * async-swap to any custom textures after construction.
   *
   * You must supply a pre-loaded default `backAtlas` texture and optionally
   * a `glassDirtMap`.
   */
  static buildMaterial(
    row:          BuildingWindowStateRow,
    defaultBackAtlas: import('three').Texture,
    opts?: {
      defaultFrontAtlas?: import('three').Texture;
      glassDirtMap?:       import('three').Texture;
    },
  ): InteriorMappingMaterial {
    const snap = rowToUniformSnapshot(row);
    return new InteriorMappingMaterial({
      backAtlas:            defaultBackAtlas,
      backAtlasCols:        row.back_atlas_cols,
      backAtlasRows:        row.back_atlas_rows,
      planeSize:            new Vector2(row.width_m, row.height_m),
      windowId:             new Vector3(row.center_x, row.center_y, row.center_z),
      depth:                snap.depth,
      backScale:            snap.backScale,
      interiorEmissive:     new Color(snap.interiorEmissiveR, snap.interiorEmissiveG, snap.interiorEmissiveB),
      frontTransmission:    snap.frontTransmission,
      frontAlphaBoost:      snap.frontAlphaBoost,
      frontAtlas:           opts?.defaultFrontAtlas,
      frontAtlasCols:       row.front_atlas_cols,
      frontAtlasRows:       row.front_atlas_rows,
      glassThickness:       snap.glassThickness,
      refractionStrength:   snap.refractionStrength,
      glassDirtMap:         opts?.glassDirtMap,
      glassDirtStrength:    snap.glassDirtStrength,
      glassFresnelStrength: snap.glassFresnelStrength,
      glassFresnelColor:    new Color(snap.glassFresnelR, snap.glassFresnelG, snap.glassFresnelB),
      glassSmudgeStrength:  snap.glassSmudgeStrength,
      roughness:            0.06,
      metalness:            0.0,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    clearInterval(this.presenceInterval);
    for (const buildingId of this.channels.keys()) {
      await this.unsubscribeFrom(buildingId);
    }
    for (const manager of this.managers.values()) {
      manager.dispose();
    }
    this.managers.clear();
    this.textureCache.dispose();
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Realtime handlers
  // ─────────────────────────────────────────────────────────────

  private handleWindowStateChange(payload: {
    eventType: string;
    new: WindowStateRow;
    old: Partial<WindowStateRow>;
  }): void {
    const { eventType, new: newRow, old: oldRow } = payload;

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const windowId = newRow.window_id;
      const manager  = this.managers.get(windowId);
      if (!manager) {
        this.log(`No manager for window ${windowId} — ignoring`);
        return;
      }
      this.log(`${eventType} → window ${windowId} (v${newRow.version})`);
      manager.applyRow(newRow).catch(console.warn);
    } else if (eventType === 'DELETE') {
      const windowId = oldRow.window_id;
      if (!windowId) return;
      this.log(`DELETE → window ${windowId}`);
      this.managers.get(windowId)?.resetToDefaults();
    }
  }

  private handleBroadcast(payload: UniformBroadcast): void {
    const manager = this.managers.get(payload.windowId);
    if (!manager) return;
    manager.applyUniformBroadcast(payload.uniforms);
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Presence
  // ─────────────────────────────────────────────────────────────

  private startPresenceIfAuthed(channel: RealtimeChannel): void {
    this.supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      this.currentUserId   = data.user.id;
      this.currentUsername = data.user.email?.split('@')[0] ?? 'anon';
      this.trackPresence(channel);

      this.presenceInterval = setInterval(
        () => this.trackPresence(channel),
        this.opts.presenceIntervalMs,
      );
    });
  }

  private trackPresence(channel: RealtimeChannel): void {
    if (!this.currentUserId) return;
    channel.track({
      userId:          this.currentUserId,
      username:        this.currentUsername ?? 'anon',
      focusedWindowId: this.focusedWindowId ?? null,
      color:           this.presenceColor,
      joinedAt:        new Date().toISOString(),
    } satisfies PresencePayload);
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Utilities
  // ─────────────────────────────────────────────────────────────

  private async getUserId(): Promise<string> {
    const { data } = await this.supabase.auth.getUser();
    if (!data.user) throw new Error('Not authenticated');
    return data.user.id;
  }

  /** Convert camelCase keys to snake_case for the RPC call. */
  private toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k.replace(/([A-Z])/g, '_$1').toLowerCase(),
        v,
      ]),
    );
  }

  private randomColor(): string {
    return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
  }

  private log(...args: unknown[]): void {
    if (this.opts.debug) console.log('[SupabaseShaderStream]', ...args);
  }
}
