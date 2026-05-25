/**
 * Shared type definitions for the three-fenestra streaming layer.
 *
 * These types mirror the `window_states` table columns and the
 * Supabase Realtime payload format so that both the client library
 * and Edge Functions share a single source of truth.
 */

// ─────────────────────────────────────────────────────────────
// Database row types (snake_case, mirrors PostgreSQL column names)
// ─────────────────────────────────────────────────────────────

/** Full row from the `window_states` table. */
export interface WindowStateRow {
  id: string;
  window_id: string;

  back_atlas_url:       string | null;
  front_atlas_url:      string | null;
  front_normal_url:     string | null;
  front_roughness_url:  string | null;
  front_metalness_url:  string | null;
  glass_dirt_url:       string | null;

  back_atlas_cols:  number;
  back_atlas_rows:  number;
  front_atlas_cols: number;
  front_atlas_rows: number;

  depth:               number;
  back_scale:          number;
  interior_emissive_r: number;
  interior_emissive_g: number;
  interior_emissive_b: number;
  front_transmission:  number;
  front_alpha_boost:   number;
  front_normal_scale:  number;

  glass_thickness:        number;
  refraction_strength:    number;
  glass_dirt_strength:    number;
  glass_fresnel_strength: number;
  glass_fresnel_r:        number;
  glass_fresnel_g:        number;
  glass_fresnel_b:        number;
  glass_smudge_strength:  number;

  is_lit:    boolean;
  is_locked: boolean;
  theme:     string;

  custom_metadata: Record<string, unknown>;
  version:     number;
  updated_at:  string;
  updated_by:  string | null;
}

/**
 * Denormalised row from `v_building_window_states`.
 * Returned by the initial scene-load query — includes geometry + effective state
 * (fallback to building defaults for uncustomised windows).
 */
export interface BuildingWindowStateRow extends WindowStateRow {
  window_uuid:   string;
  building_id:   string;
  window_index:  number;

  center_x: number;
  center_y: number;
  center_z: number;
  right_x:  number;
  right_y:  number;
  right_z:  number;
  up_x:     number;
  up_y:     number;
  up_z:     number;
  normal_x: number;
  normal_y: number;
  normal_z: number;
  width_m:  number;
  height_m: number;

  floor_number:   number | null;
  label:          string | null;
  owner_user_id:  string | null;

  default_back_atlas_url:  string | null;
  default_front_atlas_url: string | null;
}

// ─────────────────────────────────────────────────────────────
// Streaming event types
// ─────────────────────────────────────────────────────────────

/** Type discriminator for Supabase Realtime postgres_changes events. */
export type RealtimeChangeEvent =
  | { eventType: 'INSERT'; new: WindowStateRow; old: null }
  | { eventType: 'UPDATE'; new: WindowStateRow; old: Partial<WindowStateRow> }
  | { eventType: 'DELETE'; new: null; old: Partial<WindowStateRow> };

/**
 * High-frequency broadcast payload (ephemeral — NOT persisted to DB).
 * Used for smooth slider preview before the user commits.
 */
export interface UniformBroadcast {
  windowId:  string;
  uniforms:  Partial<UniformSnapshot>;
  /** Preview-only: if true the change is not eligible to be committed to DB. */
  ephemeral?: boolean;
}

/**
 * Presence heartbeat payload — sent every 30 s to show who is editing what.
 */
export interface PresencePayload {
  userId:          string;
  username:        string;
  focusedWindowId: string | null;
  color:           string;  // hex
  joinedAt:        string;  // ISO timestamp
}

// ─────────────────────────────────────────────────────────────
// Client-side uniform snapshot (camelCase, ready to apply to material)
// ─────────────────────────────────────────────────────────────

/**
 * Flat object of all shader uniform values — can be applied to
 * `InteriorMappingMaterial` properties directly.
 * Derived by converting a `WindowStateRow` (snake_case) to camelCase.
 */
export interface UniformSnapshot {
  depth:              number;
  backScale:          number;
  interiorEmissiveR:  number;
  interiorEmissiveG:  number;
  interiorEmissiveB:  number;
  frontTransmission:  number;
  frontAlphaBoost:    number;
  frontNormalScale:   number;
  glassThickness:     number;
  refractionStrength: number;
  glassDirtStrength:  number;
  glassFresnelStrength: number;
  glassFresnelR:      number;
  glassFresnelG:      number;
  glassFresnelB:      number;
  glassSmudgeStrength: number;
  isLit:              boolean;
}

/** Texture set that may be loaded from URLs asynchronously. */
export interface TextureSnapshot {
  backAtlasUrl:      string | null;
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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Convert a WindowStateRow to a UniformSnapshot (no I/O, sync). */
export function rowToUniformSnapshot(row: WindowStateRow): UniformSnapshot {
  return {
    depth:               row.depth,
    backScale:           row.back_scale,
    interiorEmissiveR:   row.interior_emissive_r,
    interiorEmissiveG:   row.interior_emissive_g,
    interiorEmissiveB:   row.interior_emissive_b,
    frontTransmission:   row.front_transmission,
    frontAlphaBoost:     row.front_alpha_boost,
    frontNormalScale:    row.front_normal_scale,
    glassThickness:      row.glass_thickness,
    refractionStrength:  row.refraction_strength,
    glassDirtStrength:   row.glass_dirt_strength,
    glassFresnelStrength:row.glass_fresnel_strength,
    glassFresnelR:       row.glass_fresnel_r,
    glassFresnelG:       row.glass_fresnel_g,
    glassFresnelB:       row.glass_fresnel_b,
    glassSmudgeStrength: row.glass_smudge_strength,
    isLit:               row.is_lit,
  };
}

/** Extract the texture URL set from a row. */
export function rowToTextureSnapshot(row: WindowStateRow): TextureSnapshot {
  return {
    backAtlasUrl:      row.back_atlas_url,
    frontAtlasUrl:     row.front_atlas_url,
    frontNormalUrl:    row.front_normal_url,
    frontRoughnessUrl: row.front_roughness_url,
    frontMetalnessUrl: row.front_metalness_url,
    glassDirtUrl:      row.glass_dirt_url,
    backAtlasCols:     row.back_atlas_cols,
    backAtlasRows:     row.back_atlas_rows,
    frontAtlasCols:    row.front_atlas_cols,
    frontAtlasRows:    row.front_atlas_rows,
  };
}

/** Default state for an uncustomised window. */
export const DEFAULT_WINDOW_STATE: UniformSnapshot = {
  depth:               1.0,
  backScale:           0.66,
  interiorEmissiveR:   0.75,
  interiorEmissiveG:   0.75,
  interiorEmissiveB:   0.75,
  frontTransmission:   0.25,
  frontAlphaBoost:     1.0,
  frontNormalScale:    1.0,
  glassThickness:      0.039,
  refractionStrength:  0.002,
  glassDirtStrength:   0.35,
  glassFresnelStrength:0.0,
  glassFresnelR:       0.85,
  glassFresnelG:       0.92,
  glassFresnelB:       1.0,
  glassSmudgeStrength: 0.0,
  isLit:               true,
};
