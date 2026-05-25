-- Migration 005: Enable Supabase Realtime on key tables + convenience views.

-- ─────────────────────────────────────────────────────────────
-- Realtime: enable on tables that need live broadcast
-- ─────────────────────────────────────────────────────────────
-- Supabase Realtime uses the publication "supabase_realtime".
-- We add only the tables whose changes should be broadcast.
-- window_states is the primary stream target.

ALTER PUBLICATION supabase_realtime ADD TABLE window_states;
ALTER PUBLICATION supabase_realtime ADD TABLE shader_generation_jobs;

-- NOTE: windows and buildings are infrequently mutated (geometry is set-once).
-- Add them only if you need admin-level building topology changes to propagate live.
-- ALTER PUBLICATION supabase_realtime ADD TABLE windows;

-- ─────────────────────────────────────────────────────────────
-- View: v_building_window_states
-- Denormalised view used by clients on initial scene load.
-- Returns all windows + their current state for a given building in one query.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_building_window_states AS
SELECT
  w.id                    AS window_uuid,
  w.building_id,
  w.window_index,
  w.center_x, w.center_y, w.center_z,
  w.right_x,  w.right_y,  w.right_z,
  w.up_x,     w.up_y,     w.up_z,
  w.normal_x, w.normal_y, w.normal_z,
  w.width_m,  w.height_m,
  w.floor_number,
  w.label,
  w.owner_user_id,
  -- window_states (null for uncustomised windows → client falls back to building defaults)
  ws.back_atlas_url,
  ws.front_atlas_url,
  ws.front_normal_url,
  ws.front_roughness_url,
  ws.front_metalness_url,
  ws.glass_dirt_url,
  COALESCE(ws.back_atlas_cols,        b.default_atlas_cols)  AS back_atlas_cols,
  COALESCE(ws.back_atlas_rows,        b.default_atlas_rows)  AS back_atlas_rows,
  COALESCE(ws.front_atlas_cols,       1)                     AS front_atlas_cols,
  COALESCE(ws.front_atlas_rows,       1)                     AS front_atlas_rows,
  COALESCE(ws.depth,                  1.0)                   AS depth,
  COALESCE(ws.back_scale,             0.66)                  AS back_scale,
  COALESCE(ws.interior_emissive_r,    0.75)                  AS interior_emissive_r,
  COALESCE(ws.interior_emissive_g,    0.75)                  AS interior_emissive_g,
  COALESCE(ws.interior_emissive_b,    0.75)                  AS interior_emissive_b,
  COALESCE(ws.front_transmission,     0.25)                  AS front_transmission,
  COALESCE(ws.front_alpha_boost,      1.0)                   AS front_alpha_boost,
  COALESCE(ws.front_normal_scale,     1.0)                   AS front_normal_scale,
  COALESCE(ws.glass_thickness,        0.039)                 AS glass_thickness,
  COALESCE(ws.refraction_strength,    0.002)                 AS refraction_strength,
  COALESCE(ws.glass_dirt_strength,    0.35)                  AS glass_dirt_strength,
  COALESCE(ws.glass_fresnel_strength, 0.0)                   AS glass_fresnel_strength,
  COALESCE(ws.glass_fresnel_r,        0.85)                  AS glass_fresnel_r,
  COALESCE(ws.glass_fresnel_g,        0.92)                  AS glass_fresnel_g,
  COALESCE(ws.glass_fresnel_b,        1.0)                   AS glass_fresnel_b,
  COALESCE(ws.glass_smudge_strength,  0.0)                   AS glass_smudge_strength,
  COALESCE(ws.is_lit,                 true)                  AS is_lit,
  COALESCE(ws.is_locked,              false)                 AS is_locked,
  ws.theme,
  ws.version,
  ws.updated_at,
  ws.updated_by,
  -- Building defaults (for client fallback)
  b.default_back_atlas_url,
  b.default_front_atlas_url
FROM windows w
JOIN buildings b ON b.id = w.building_id
LEFT JOIN window_states ws ON ws.window_id = w.id;

-- ─────────────────────────────────────────────────────────────
-- View: v_building_summary
-- Quick stats per building for dashboards.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_building_summary AS
SELECT
  b.id,
  b.name,
  b.slug,
  b.location,
  b.altitude_m,
  b.height_m,
  COUNT(w.id)                                                  AS total_windows,
  COUNT(w.owner_user_id)                                       AS owned_windows,
  COUNT(ws.id)                                                 AS customised_windows,
  COUNT(ws.id) FILTER (WHERE ws.is_lit = true)                 AS lit_windows,
  COUNT(ws.id) FILTER (WHERE ws.back_atlas_url IS NOT NULL)    AS custom_texture_windows
FROM buildings b
LEFT JOIN windows w   ON w.building_id = b.id
LEFT JOIN window_states ws ON ws.window_id = w.id
GROUP BY b.id, b.name, b.slug, b.location, b.altitude_m, b.height_m;

-- ─────────────────────────────────────────────────────────────
-- Function: get_nearby_buildings
-- PostGIS proximity query — used by multi-building clients.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_nearby_buildings(
  p_lon         float,
  p_lat         float,
  p_radius_m    float DEFAULT 500
)
RETURNS TABLE (
  id            uuid,
  name          text,
  slug          text,
  distance_m    float,
  total_windows bigint,
  lit_windows   bigint
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    b.id,
    b.name,
    b.slug,
    ST_Distance(
      b.location::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
    ) AS distance_m,
    COUNT(w.id)                                          AS total_windows,
    COUNT(ws.id) FILTER (WHERE ws.is_lit = true)         AS lit_windows
  FROM buildings b
  LEFT JOIN windows w     ON w.building_id = b.id
  LEFT JOIN window_states ws ON ws.window_id = w.id
  WHERE ST_DWithin(
    b.location::geography,
    ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
    p_radius_m
  )
    AND b.is_public = true
  GROUP BY b.id, b.name, b.slug
  ORDER BY distance_m;
$$;
