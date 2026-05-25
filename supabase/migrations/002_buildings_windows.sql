-- Migration 002: buildings + windows tables with PostGIS geometry.
--
-- Design notes:
--   • buildings.location      : 2D geographic point (lat/lng WGS-84) for
--                               spatial proximity queries.
--   • buildings.footprint     : 2D polygon covering the building footprint —
--                               used for line-of-sight and "buildings near me".
--   • windows.location        : 2D geographic point derived from the 3D centre,
--                               useful for "windows I can see from the street".
--   • windows.position_ecef   : 3D PointZ in ECEF (EPSG:4978) coordinates —
--                               enables floor-level vertical stacking and
--                               precise camera frustum culling on the server.
--   • windows.center_[xyz]    : duplicated as plain floats for the Three.js
--                               scene (avoid ECEF→local reprojection client-side).

-- ─────────────────────────────────────────────────────────────
-- Buildings
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buildings (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name              text        NOT NULL,
  slug              text        UNIQUE,                 -- URL-friendly identifier
  description       text,

  -- Geographic location
  location          geography(Point, 4326),             -- lat/lng for proximity search
  footprint         geography(Polygon, 4326),           -- building outline on map
  altitude_m        float       DEFAULT 0.0,            -- base elevation above sea level
  height_m          float,                              -- approximate building height

  -- 3D model assets
  model_url         text,                               -- GLTF model URL
  windows_json_url  text,                               -- windows.json URL (geometry source)
  default_back_atlas_url    text,                       -- fallback room atlas for all windows
  default_front_atlas_url   text,                       -- fallback curtain atlas for all windows
  default_atlas_cols        integer DEFAULT 4,
  default_atlas_rows        integer DEFAULT 4,

  -- Metadata
  is_public         boolean     DEFAULT true,
  owner_user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  custom_metadata   jsonb       DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Spatial indexes
CREATE INDEX IF NOT EXISTS buildings_location_gist
  ON buildings USING GIST(location);

CREATE INDEX IF NOT EXISTS buildings_footprint_gist
  ON buildings USING GIST(footprint);

-- Text search index
CREATE INDEX IF NOT EXISTS buildings_name_trgm
  ON buildings USING GIN(name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- Windows
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS windows (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  building_id       uuid        NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  window_index      integer     NOT NULL,               -- index in windows.json

  -- 3D geometry (matches InteriorMappingMaterialParameters)
  center_x          float       NOT NULL,
  center_y          float       NOT NULL,
  center_z          float       NOT NULL,
  right_x           float,
  right_y           float,
  right_z           float,
  up_x              float,
  up_y              float,
  up_z              float,
  normal_x          float,
  normal_y          float,
  normal_z          float,
  width_m           float       NOT NULL,
  height_m          float       NOT NULL,

  -- Spatial columns (derived from center + building.location)
  location          geography(Point, 4326),             -- 2D lat/lng
  position_ecef     geometry(PointZ, 4978),             -- 3D ECEF

  -- Building organisation
  floor_number      integer,
  wing              text,                               -- e.g. "north", "east"
  label             text,                               -- friendly label e.g. "A-04-12"

  -- Ownership
  owner_user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at        timestamptz DEFAULT now(),

  UNIQUE(building_id, window_index)
);

CREATE INDEX IF NOT EXISTS windows_building_idx
  ON windows(building_id);

CREATE INDEX IF NOT EXISTS windows_location_gist
  ON windows USING GIST(location);

CREATE INDEX IF NOT EXISTS windows_ecef_gist
  ON windows USING GIST(position_ecef);

CREATE INDEX IF NOT EXISTS windows_floor_idx
  ON windows(building_id, floor_number);

CREATE INDEX IF NOT EXISTS windows_owner_idx
  ON windows(owner_user_id);

-- ─────────────────────────────────────────────────────────────
-- Function: auto-update updated_at on buildings
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_buildings_updated_at
  BEFORE UPDATE ON buildings
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
