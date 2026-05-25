/**
 * Unit tests for src/streaming/types.ts
 *
 * These functions are pure (no I/O, no DOM, no Three.js) so they run
 * without any mocking or special environment setup.
 */

import { describe, it, expect } from 'vitest';
import {
  rowToUniformSnapshot,
  rowToTextureSnapshot,
  DEFAULT_WINDOW_STATE,
  type WindowStateRow,
} from '../types.js';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<WindowStateRow> = {}): WindowStateRow {
  return {
    id:                   'row-uuid',
    window_id:            'win-uuid',
    back_atlas_url:       'https://cdn.example.com/back.webp',
    front_atlas_url:      'https://cdn.example.com/front.webp',
    front_normal_url:     null,
    front_roughness_url:  null,
    front_metalness_url:  null,
    glass_dirt_url:       null,
    back_atlas_cols:      4,
    back_atlas_rows:      4,
    front_atlas_cols:     1,
    front_atlas_rows:     1,
    depth:                1.2,
    back_scale:           0.72,
    interior_emissive_r:  1.5,
    interior_emissive_g:  1.2,
    interior_emissive_b:  0.9,
    front_transmission:   0.3,
    front_alpha_boost:    1.8,
    front_normal_scale:   1.0,
    glass_thickness:      0.05,
    refraction_strength:  0.004,
    glass_dirt_strength:  0.4,
    glass_fresnel_strength: 0.6,
    glass_fresnel_r:      0.8,
    glass_fresnel_g:      0.9,
    glass_fresnel_b:      1.0,
    glass_smudge_strength: 0.15,
    is_lit:               true,
    is_locked:            false,
    theme:                'default',
    custom_metadata:      {},
    version:              3,
    updated_at:           '2026-05-25T00:00:00Z',
    updated_by:           'user-uuid',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// rowToUniformSnapshot
// ─────────────────────────────────────────────────────────────

describe('rowToUniformSnapshot', () => {
  it('maps every float field to the correct camelCase key', () => {
    const row  = makeRow();
    const snap = rowToUniformSnapshot(row);

    expect(snap.depth).toBe(1.2);
    expect(snap.backScale).toBe(0.72);
    expect(snap.interiorEmissiveR).toBe(1.5);
    expect(snap.interiorEmissiveG).toBe(1.2);
    expect(snap.interiorEmissiveB).toBe(0.9);
    expect(snap.frontTransmission).toBe(0.3);
    expect(snap.frontAlphaBoost).toBe(1.8);
    expect(snap.frontNormalScale).toBe(1.0);
    expect(snap.glassThickness).toBe(0.05);
    expect(snap.refractionStrength).toBe(0.004);
    expect(snap.glassDirtStrength).toBe(0.4);
    expect(snap.glassFresnelStrength).toBe(0.6);
    expect(snap.glassFresnelR).toBe(0.8);
    expect(snap.glassFresnelG).toBe(0.9);
    expect(snap.glassFresnelB).toBe(1.0);
    expect(snap.glassSmudgeStrength).toBe(0.15);
    expect(snap.isLit).toBe(true);
  });

  it('maps is_lit = false correctly', () => {
    const snap = rowToUniformSnapshot(makeRow({ is_lit: false }));
    expect(snap.isLit).toBe(false);
  });

  it('preserves HDR emissive values above 1', () => {
    const snap = rowToUniformSnapshot(makeRow({
      interior_emissive_r: 4.5,
      interior_emissive_g: 3.2,
      interior_emissive_b: 2.1,
    }));
    expect(snap.interiorEmissiveR).toBe(4.5);
    expect(snap.interiorEmissiveG).toBe(3.2);
    expect(snap.interiorEmissiveB).toBe(2.1);
  });

  it('returns a plain object with exactly 17 keys', () => {
    const snap = rowToUniformSnapshot(makeRow());
    expect(Object.keys(snap)).toHaveLength(17);
  });

  it('does not mutate the source row', () => {
    const row    = makeRow();
    const before = JSON.stringify(row);
    rowToUniformSnapshot(row);
    expect(JSON.stringify(row)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────
// rowToTextureSnapshot
// ─────────────────────────────────────────────────────────────

describe('rowToTextureSnapshot', () => {
  it('maps every texture URL field and atlas dimensions', () => {
    const row  = makeRow();
    const snap = rowToTextureSnapshot(row);

    expect(snap.backAtlasUrl).toBe('https://cdn.example.com/back.webp');
    expect(snap.frontAtlasUrl).toBe('https://cdn.example.com/front.webp');
    expect(snap.frontNormalUrl).toBeNull();
    expect(snap.frontRoughnessUrl).toBeNull();
    expect(snap.frontMetalnessUrl).toBeNull();
    expect(snap.glassDirtUrl).toBeNull();
    expect(snap.backAtlasCols).toBe(4);
    expect(snap.backAtlasRows).toBe(4);
    expect(snap.frontAtlasCols).toBe(1);
    expect(snap.frontAtlasRows).toBe(1);
  });

  it('carries null atlas URLs through without coercion', () => {
    const snap = rowToTextureSnapshot(makeRow({ back_atlas_url: null }));
    expect(snap.backAtlasUrl).toBeNull();
  });

  it('reflects custom atlas dimensions', () => {
    const snap = rowToTextureSnapshot(makeRow({
      back_atlas_cols: 2,
      back_atlas_rows: 2,
      front_atlas_cols: 3,
      front_atlas_rows: 3,
    }));
    expect(snap.backAtlasCols).toBe(2);
    expect(snap.backAtlasRows).toBe(2);
    expect(snap.frontAtlasCols).toBe(3);
    expect(snap.frontAtlasRows).toBe(3);
  });

  it('returns exactly 10 keys', () => {
    const snap = rowToTextureSnapshot(makeRow());
    expect(Object.keys(snap)).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────
// DEFAULT_WINDOW_STATE
// ─────────────────────────────────────────────────────────────

describe('DEFAULT_WINDOW_STATE', () => {
  it('has the correct default depth', () => {
    expect(DEFAULT_WINDOW_STATE.depth).toBe(1.0);
  });

  it('has the correct default backScale', () => {
    expect(DEFAULT_WINDOW_STATE.backScale).toBe(0.66);
  });

  it('has equal RGB emissive channels at 0.75', () => {
    expect(DEFAULT_WINDOW_STATE.interiorEmissiveR).toBe(0.75);
    expect(DEFAULT_WINDOW_STATE.interiorEmissiveG).toBe(0.75);
    expect(DEFAULT_WINDOW_STATE.interiorEmissiveB).toBe(0.75);
  });

  it('has isLit = true by default', () => {
    expect(DEFAULT_WINDOW_STATE.isLit).toBe(true);
  });

  it('has glass effects disabled by default', () => {
    expect(DEFAULT_WINDOW_STATE.glassFresnelStrength).toBe(0.0);
    expect(DEFAULT_WINDOW_STATE.glassSmudgeStrength).toBe(0.0);
  });

  it('matches all fields produced by rowToUniformSnapshot with default values', () => {
    const defaultRow = makeRow({
      depth:                1.0,
      back_scale:           0.66,
      interior_emissive_r:  0.75,
      interior_emissive_g:  0.75,
      interior_emissive_b:  0.75,
      front_transmission:   0.25,
      front_alpha_boost:    1.0,
      front_normal_scale:   1.0,
      glass_thickness:      0.039,
      refraction_strength:  0.002,
      glass_dirt_strength:  0.35,
      glass_fresnel_strength: 0.0,
      glass_fresnel_r:      0.85,
      glass_fresnel_g:      0.92,
      glass_fresnel_b:      1.0,
      glass_smudge_strength: 0.0,
      is_lit:               true,
    });

    const fromRow = rowToUniformSnapshot(defaultRow);
    expect(fromRow).toEqual(DEFAULT_WINDOW_STATE);
  });
});
