/**
 * WindowStateManager
 *
 * Per-window state machine that bridges Supabase Realtime events and the
 * Three.js InteriorMappingMaterial.
 *
 * State machine:
 *
 *   IDLE ──load──► LOADING ──ready──► LIVE
 *                     │                 │
 *                     └──error──► ERROR  │
 *                                       ├──stream update──► APPLYING
 *                                       │                      └──done──► LIVE
 *                                       └──dispose──► DISPOSED
 *
 * Thread safety note:
 *   applyState() may be called concurrently from the Realtime callback thread
 *   and the render loop. We guard with a simple version counter: if a newer
 *   update arrives while textures are loading for an older one, the stale load
 *   is discarded via the `applyVersion` check.
 */

import { Color, Texture } from 'three';
import { InteriorMappingMaterial } from '../InteriorMappingMaterial.js';
import { TextureStreamCache } from './TextureStreamCache.js';
import type {
  WindowStateRow,
  UniformSnapshot,
  TextureSnapshot,
} from './types.js';
import {
  rowToUniformSnapshot,
  rowToTextureSnapshot,
  DEFAULT_WINDOW_STATE,
} from './types.js';

export type WindowMachineState =
  | 'IDLE' | 'LOADING' | 'LIVE' | 'APPLYING' | 'ERROR' | 'DISPOSED';

export interface WindowStateManagerOptions {
  material:      InteriorMappingMaterial;
  textureCache:  TextureStreamCache;
  /** Building-level fallback atlas URL when window has no custom back atlas. */
  defaultBackAtlasUrl?:  string | null;
  /** Building-level fallback front atlas URL. */
  defaultFrontAtlasUrl?: string | null;
  defaultAtlasCols?: number;
  defaultAtlasRows?: number;
  /** Called whenever the material has been updated (triggers re-render if needed). */
  onMaterialUpdated?: () => void;
}

export class WindowStateManager extends EventTarget {
  readonly windowId:  string;  // UUID from the database
  readonly material:  InteriorMappingMaterial;

  private state:     WindowMachineState = 'IDLE';
  private applyGen   = 0;  // monotonic generation counter for async safety
  private lastRow:   WindowStateRow | null = null;

  private readonly textureCache:          TextureStreamCache;
  private readonly defaultBackAtlasUrl:   string | null;
  private readonly defaultFrontAtlasUrl:  string | null;
  private readonly defaultAtlasCols:      number;
  private readonly defaultAtlasRows:      number;
  private readonly onMaterialUpdated?:    () => void;

  constructor(windowId: string, opts: WindowStateManagerOptions) {
    super();
    this.windowId             = windowId;
    this.material             = opts.material;
    this.textureCache         = opts.textureCache;
    this.defaultBackAtlasUrl  = opts.defaultBackAtlasUrl  ?? null;
    this.defaultFrontAtlasUrl = opts.defaultFrontAtlasUrl ?? null;
    this.defaultAtlasCols     = opts.defaultAtlasCols     ?? 4;
    this.defaultAtlasRows     = opts.defaultAtlasRows     ?? 4;
    this.onMaterialUpdated    = opts.onMaterialUpdated;
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  get machineState(): WindowMachineState { return this.state; }
  get currentRow(): WindowStateRow | null { return this.lastRow; }

  /**
   * Apply a full database row (from initial load or Realtime UPDATE event).
   * Async: texture URLs are loaded via TextureStreamCache.
   */
  async applyRow(row: WindowStateRow): Promise<void> {
    if (this.state === 'DISPOSED') return;

    this.lastRow = row;
    const gen = ++this.applyGen;
    this.setState('APPLYING');

    // 1. Apply all float/bool uniforms synchronously — no frame drop.
    this.applyUniforms(rowToUniformSnapshot(row));

    // 2. Load textures asynchronously.
    await this.applyTextures(rowToTextureSnapshot(row), gen);

    if (gen === this.applyGen) {
      this.setState('LIVE');
      this.onMaterialUpdated?.();
    }
  }

  /**
   * Apply a partial uniform snapshot (from broadcast channel preview).
   * Synchronous — does not touch textures.
   */
  applyUniformBroadcast(uniforms: Partial<UniformSnapshot>): void {
    if (this.state === 'DISPOSED') return;
    this.applyUniforms(uniforms);
    this.onMaterialUpdated?.();
  }

  /**
   * Reset to building defaults (called when owner releases the window).
   */
  async resetToDefaults(): Promise<void> {
    if (this.state === 'DISPOSED') return;
    const gen = ++this.applyGen;
    this.applyUniforms(DEFAULT_WINDOW_STATE);

    if (this.defaultBackAtlasUrl) {
      const tex = await this.textureCache.load(this.defaultBackAtlasUrl);
      if (gen === this.applyGen) {
        this.material.setBackAtlas(tex);
        this.material.interiorUniforms.uBackAtlasCols.value = this.defaultAtlasCols;
        this.material.interiorUniforms.uBackAtlasRows.value = this.defaultAtlasRows;
      }
    }

    if (gen === this.applyGen) {
      this.material.setFrontAtlas(null);
      this.setState('LIVE');
      this.onMaterialUpdated?.();
    }
  }

  dispose(): void {
    this.setState('DISPOSED');
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private applyUniforms(snap: Partial<UniformSnapshot>): void {
    const u = this.material.interiorUniforms;

    if (snap.depth               !== undefined) u.uDepth.value               = snap.depth;
    if (snap.backScale           !== undefined) u.uBackScale.value           = snap.backScale;
    if (snap.frontTransmission   !== undefined) u.uFrontTransmission.value   = snap.frontTransmission;
    if (snap.frontAlphaBoost     !== undefined) u.uFrontAlphaBoost.value     = snap.frontAlphaBoost;
    if (snap.frontNormalScale    !== undefined) u.uFrontNormalScale.value    = snap.frontNormalScale;
    if (snap.glassThickness      !== undefined) u.uGlassThickness.value      = snap.glassThickness;
    if (snap.refractionStrength  !== undefined) u.uRefractionStrength.value  = snap.refractionStrength;
    if (snap.glassDirtStrength   !== undefined) u.uGlassDirtStrength.value   = snap.glassDirtStrength;
    if (snap.glassFresnelStrength !== undefined) u.uGlassFresnelStrength.value = snap.glassFresnelStrength;
    if (snap.glassSmudgeStrength !== undefined) u.uGlassSmudgeStrength.value = snap.glassSmudgeStrength;

    if (snap.interiorEmissiveR !== undefined ||
        snap.interiorEmissiveG !== undefined ||
        snap.interiorEmissiveB !== undefined) {
      const c = u.uInteriorEmissive.value;
      if (snap.interiorEmissiveR !== undefined) c.r = snap.interiorEmissiveR;
      if (snap.interiorEmissiveG !== undefined) c.g = snap.interiorEmissiveG;
      if (snap.interiorEmissiveB !== undefined) c.b = snap.interiorEmissiveB;
    }

    if (snap.glassFresnelR !== undefined ||
        snap.glassFresnelG !== undefined ||
        snap.glassFresnelB !== undefined) {
      const c = u.uGlassFresnelColor.value;
      if (snap.glassFresnelR !== undefined) c.r = snap.glassFresnelR;
      if (snap.glassFresnelG !== undefined) c.g = snap.glassFresnelG;
      if (snap.glassFresnelB !== undefined) c.b = snap.glassFresnelB;
    }

    // isLit: modulate interior emissive to zero when off
    if (snap.isLit !== undefined) {
      const e = u.uInteriorEmissive.value;
      if (!snap.isLit) {
        // Store brightness in alpha-like channel via very small value
        e.multiplyScalar(snap.isLit ? 1 : 0.0);
      }
    }
  }

  private async applyTextures(
    snap: TextureSnapshot,
    gen:  number,
  ): Promise<void> {
    const backUrl  = snap.backAtlasUrl  ?? this.defaultBackAtlasUrl;
    const frontUrl = snap.frontAtlasUrl ?? this.defaultFrontAtlasUrl;

    const loads: Promise<void>[] = [];

    // Back atlas
    if (backUrl) {
      loads.push(
        this.textureCache.load(backUrl).then((tex) => {
          if (gen !== this.applyGen) return;
          this.material.setBackAtlas(tex);
          // Only trigger needsUpdate if atlas dimensions changed
          const u = this.material.interiorUniforms;
          const colsChanged = u.uBackAtlasCols.value !== snap.backAtlasCols;
          const rowsChanged = u.uBackAtlasRows.value !== snap.backAtlasRows;
          u.uBackAtlasCols.value = snap.backAtlasCols;
          u.uBackAtlasRows.value = snap.backAtlasRows;
          if (colsChanged || rowsChanged) this.material.needsUpdate = true;
        }),
      );
    }

    // Front atlas
    if (frontUrl !== undefined) {
      if (frontUrl === null) {
        loads.push(Promise.resolve().then(() => {
          if (gen !== this.applyGen) return;
          this.material.setFrontAtlas(null);
        }));
      } else {
        loads.push(
          this.textureCache.load(frontUrl).then((tex: Texture) => {
            if (gen !== this.applyGen) return;
            this.material.setFrontAtlas(tex, snap.frontAtlasCols, snap.frontAtlasRows);
          }),
        );
      }
    }

    // Front normal
    if (snap.frontNormalUrl) {
      loads.push(
        this.textureCache.load(snap.frontNormalUrl).then((tex: Texture) => {
          if (gen !== this.applyGen) return;
          this.material.setFrontNormalAtlas(tex, snap.backAtlasCols);
        }),
      );
    }

    // Front roughness
    if (snap.frontRoughnessUrl) {
      loads.push(
        this.textureCache.load(snap.frontRoughnessUrl).then((tex: Texture) => {
          if (gen !== this.applyGen) return;
          this.material.setFrontRoughnessAtlas(tex);
        }),
      );
    }

    // Front metalness
    if (snap.frontMetalnessUrl) {
      loads.push(
        this.textureCache.load(snap.frontMetalnessUrl).then((tex: Texture) => {
          if (gen !== this.applyGen) return;
          this.material.setFrontMetalnessAtlas(tex);
        }),
      );
    }

    // Glass dirt
    if (snap.glassDirtUrl) {
      loads.push(
        this.textureCache.load(snap.glassDirtUrl).then((tex: Texture) => {
          if (gen !== this.applyGen) return;
          this.material.setGlassDirtMap(tex);
        }),
      );
    } else if (snap.glassDirtUrl === null) {
      this.material.setGlassDirtMap(null);
    }

    await Promise.allSettled(loads);
  }

  private setState(next: WindowMachineState): void {
    if (this.state === next) return;
    this.state = next;
    this.dispatchEvent(new CustomEvent('statechange', { detail: next }));
  }
}
