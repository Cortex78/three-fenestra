-- Migration 003: window_states, user_textures, shader_generation_jobs.
--
-- window_states is the HOT path — it is read on every scene load and written
-- whenever a user customises their window. Supabase Realtime watches this table
-- and broadcasts every UPDATE to all clients subscribed to the building channel.
--
-- user_textures tracks uploaded / generated textures. It is JOIN-ed by the
-- customisation UI and by the Edge Function that applies new textures.
--
-- shader_generation_jobs is the async job queue for AI texture generation.

-- ─────────────────────────────────────────────────────────────
-- window_states
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS window_states (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  window_id             uuid        NOT NULL REFERENCES windows(id) ON DELETE CASCADE UNIQUE,

  -- Texture URLs (null → fall back to building default atlas)
  back_atlas_url        text,
  front_atlas_url       text,
  front_normal_url      text,
  front_roughness_url   text,
  front_metalness_url   text,
  glass_dirt_url        text,

  -- Atlas grid dimensions for back and front
  back_atlas_cols       integer     DEFAULT 4,
  back_atlas_rows       integer     DEFAULT 4,
  front_atlas_cols      integer     DEFAULT 1,
  front_atlas_rows      integer     DEFAULT 1,

  -- Interior ray-march knobs
  depth                 float       DEFAULT 1.0  CHECK(depth BETWEEN 0.1 AND 20.0),
  back_scale            float       DEFAULT 0.66 CHECK(back_scale BETWEEN 0.05 AND 0.999),

  -- Interior emissive colour (RGB, HDR range allowed)
  interior_emissive_r   float       DEFAULT 0.75 CHECK(interior_emissive_r BETWEEN 0 AND 10),
  interior_emissive_g   float       DEFAULT 0.75 CHECK(interior_emissive_g BETWEEN 0 AND 10),
  interior_emissive_b   float       DEFAULT 0.75 CHECK(interior_emissive_b BETWEEN 0 AND 10),

  -- Front layer
  front_transmission    float       DEFAULT 0.25 CHECK(front_transmission BETWEEN 0 AND 1),
  front_alpha_boost     float       DEFAULT 1.0  CHECK(front_alpha_boost  BETWEEN 0.1 AND 5),
  front_normal_scale    float       DEFAULT 1.0  CHECK(front_normal_scale  BETWEEN 0 AND 5),

  -- Glass surface
  glass_thickness       float       DEFAULT 0.039 CHECK(glass_thickness   BETWEEN 0 AND 1),
  refraction_strength   float       DEFAULT 0.002 CHECK(refraction_strength BETWEEN 0 AND 0.1),
  glass_dirt_strength   float       DEFAULT 0.35  CHECK(glass_dirt_strength  BETWEEN 0 AND 2),
  glass_fresnel_strength float      DEFAULT 0.0   CHECK(glass_fresnel_strength BETWEEN 0 AND 2),
  glass_fresnel_r       float       DEFAULT 0.85,
  glass_fresnel_g       float       DEFAULT 0.92,
  glass_fresnel_b       float       DEFAULT 1.0,
  glass_smudge_strength float       DEFAULT 0.0   CHECK(glass_smudge_strength BETWEEN 0 AND 2),

  -- State flags
  is_lit                boolean     DEFAULT true,    -- window lights on/off
  is_locked             boolean     DEFAULT false,   -- prevent further edits
  theme                 text        DEFAULT 'default', -- named theme for quick switching

  -- Free-form metadata (custom brand colours, seasonal flags, etc.)
  custom_metadata       jsonb       DEFAULT '{}',

  -- Optimistic concurrency: client must pass current updated_at to prevent
  -- blind overwrites when two users edit the same window simultaneously.
  updated_at            timestamptz DEFAULT now(),
  updated_by            uuid        REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Version counter (monotonic, incremented on every write)
  version               bigint      DEFAULT 1
);

CREATE INDEX IF NOT EXISTS window_states_window_id_idx
  ON window_states(window_id);

CREATE INDEX IF NOT EXISTS window_states_theme_idx
  ON window_states(theme);

CREATE INDEX IF NOT EXISTS window_states_updated_at_idx
  ON window_states(updated_at DESC);

-- ─────────────────────────────────────────────────────────────
-- user_textures
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_textures (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Storage
  storage_path    text        NOT NULL,    -- bucket path: textures/{userId}/{uuid}/full.webp
  url             text        NOT NULL,    -- public CDN URL
  thumb_url       text,                   -- 128×128 thumbnail URL

  -- Texture metadata
  filename        text,                   -- original upload filename
  texture_type    text        NOT NULL    -- 'back', 'front', 'normal', 'roughness', 'metalness', 'dirt'
                  CHECK(texture_type IN ('back','front','normal','roughness','metalness','dirt')),
  atlas_cols      integer     DEFAULT 1,
  atlas_rows      integer     DEFAULT 1,
  width_px        integer,
  height_px       integer,
  format          text        DEFAULT 'webp',
  file_size_bytes bigint,

  -- Origin: was this uploaded or AI-generated?
  origin          text        DEFAULT 'upload'
                  CHECK(origin IN ('upload', 'generated', 'starter')),
  generation_job_id uuid,                 -- FK set if origin='generated'

  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_textures_user_idx
  ON user_textures(user_id);

CREATE INDEX IF NOT EXISTS user_textures_type_idx
  ON user_textures(user_id, texture_type);

-- ─────────────────────────────────────────────────────────────
-- shader_generation_jobs
-- ─────────────────────────────────────────────────────────────
CREATE TYPE generation_status AS ENUM (
  'pending', 'processing', 'completed', 'failed', 'cancelled'
);

CREATE TABLE IF NOT EXISTS shader_generation_jobs (
  id              uuid              DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid              NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_id       uuid              REFERENCES windows(id) ON DELETE SET NULL,

  -- Generation request
  prompt          text              NOT NULL,
  negative_prompt text,
  layers          text[]            DEFAULT ARRAY['back'],  -- which textures to generate
  model_provider  text              DEFAULT 'google-imagen-3',
  model_params    jsonb             DEFAULT '{}',           -- seed, cfg_scale, etc.

  -- Execution state
  status          generation_status DEFAULT 'pending',
  progress        integer           DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  error_message   text,

  -- Results: map of layer → URL
  result_urls     jsonb             DEFAULT '{}',   -- e.g. {"back": "https://...", "normal": "..."}

  -- Timing
  created_at      timestamptz       DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  -- Estimated credits consumed (for usage tracking)
  credits_used    integer           DEFAULT 0
);

CREATE INDEX IF NOT EXISTS gen_jobs_user_idx
  ON shader_generation_jobs(user_id);

CREATE INDEX IF NOT EXISTS gen_jobs_window_idx
  ON shader_generation_jobs(window_id);

CREATE INDEX IF NOT EXISTS gen_jobs_status_idx
  ON shader_generation_jobs(status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- FK: user_textures.generation_job_id → shader_generation_jobs
-- (added after both tables exist)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE user_textures
  ADD CONSTRAINT fk_user_textures_gen_job
  FOREIGN KEY (generation_job_id)
  REFERENCES shader_generation_jobs(id)
  ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────
-- Trigger: auto-bump version + updated_at on window_states
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_window_states_versioning()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version    = OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_window_states_version
  BEFORE UPDATE ON window_states
  FOR EACH ROW EXECUTE FUNCTION fn_window_states_versioning();

-- ─────────────────────────────────────────────────────────────
-- Atomic update_window_state function (called by Edge Function)
--
-- Uses SELECT … FOR UPDATE to serialise concurrent writers on the same window.
-- Raises SQLSTATE 40001 (serialization_failure) on version mismatch so the
-- client can retry with fresh data.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_window_state(
  p_window_id       uuid,
  p_user_id         uuid,
  p_state           jsonb,
  p_expected_version bigint DEFAULT NULL  -- null = unconditional (first write / admin)
)
RETURNS window_states
LANGUAGE plpgsql
SECURITY DEFINER  -- runs as postgres, but we check ownership manually
AS $$
DECLARE
  v_result       window_states;
  v_owner_id     uuid;
  v_current_ver  bigint;
BEGIN
  -- ① Check window ownership
  SELECT owner_user_id INTO v_owner_id
  FROM windows
  WHERE id = p_window_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Window % not found', p_window_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_owner_id IS NULL THEN
    -- Unowned window: the first writer auto-claims it (first-come ownership).
    UPDATE windows SET owner_user_id = p_user_id WHERE id = p_window_id;
  ELSIF v_owner_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User % does not own window %', p_user_id, p_window_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ② Lock the existing row (serialises concurrent writers)
  SELECT version INTO v_current_ver
  FROM window_states
  WHERE window_id = p_window_id
  FOR UPDATE;

  -- ③ Optimistic concurrency check
  IF p_expected_version IS NOT NULL AND v_current_ver IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Concurrent modification: expected version %, got %',
      p_expected_version, v_current_ver
      USING ERRCODE = 'serialization_failure';  -- 40001
  END IF;

  -- ④ Atomic upsert (all fields from JSONB payload; missing keys keep current value)
  INSERT INTO window_states (
    window_id, updated_by,
    back_atlas_url, front_atlas_url, front_normal_url,
    front_roughness_url, front_metalness_url, glass_dirt_url,
    back_atlas_cols, back_atlas_rows, front_atlas_cols, front_atlas_rows,
    depth, back_scale,
    interior_emissive_r, interior_emissive_g, interior_emissive_b,
    front_transmission, front_alpha_boost, front_normal_scale,
    glass_thickness, refraction_strength, glass_dirt_strength,
    glass_fresnel_strength, glass_fresnel_r, glass_fresnel_g, glass_fresnel_b,
    glass_smudge_strength, is_lit, is_locked, theme, custom_metadata
  )
  VALUES (
    p_window_id, p_user_id,
    p_state->>'back_atlas_url',
    p_state->>'front_atlas_url',
    p_state->>'front_normal_url',
    p_state->>'front_roughness_url',
    p_state->>'front_metalness_url',
    p_state->>'glass_dirt_url',
    COALESCE((p_state->>'back_atlas_cols')::integer,   4),
    COALESCE((p_state->>'back_atlas_rows')::integer,   4),
    COALESCE((p_state->>'front_atlas_cols')::integer,  1),
    COALESCE((p_state->>'front_atlas_rows')::integer,  1),
    COALESCE((p_state->>'depth')::float,               1.0),
    COALESCE((p_state->>'back_scale')::float,          0.66),
    COALESCE((p_state->>'interior_emissive_r')::float, 0.75),
    COALESCE((p_state->>'interior_emissive_g')::float, 0.75),
    COALESCE((p_state->>'interior_emissive_b')::float, 0.75),
    COALESCE((p_state->>'front_transmission')::float,  0.25),
    COALESCE((p_state->>'front_alpha_boost')::float,   1.0),
    COALESCE((p_state->>'front_normal_scale')::float,  1.0),
    COALESCE((p_state->>'glass_thickness')::float,     0.039),
    COALESCE((p_state->>'refraction_strength')::float, 0.002),
    COALESCE((p_state->>'glass_dirt_strength')::float, 0.35),
    COALESCE((p_state->>'glass_fresnel_strength')::float, 0.0),
    COALESCE((p_state->>'glass_fresnel_r')::float,     0.85),
    COALESCE((p_state->>'glass_fresnel_g')::float,     0.92),
    COALESCE((p_state->>'glass_fresnel_b')::float,     1.0),
    COALESCE((p_state->>'glass_smudge_strength')::float, 0.0),
    COALESCE((p_state->>'is_lit')::boolean,            true),
    COALESCE((p_state->>'is_locked')::boolean,         false),
    COALESCE(p_state->>'theme',                        'default'),
    COALESCE(p_state->'custom_metadata',               '{}')
  )
  ON CONFLICT (window_id) DO UPDATE SET
    updated_by            = EXCLUDED.updated_by,
    back_atlas_url        = COALESCE(EXCLUDED.back_atlas_url,       window_states.back_atlas_url),
    front_atlas_url       = COALESCE(EXCLUDED.front_atlas_url,      window_states.front_atlas_url),
    front_normal_url      = COALESCE(EXCLUDED.front_normal_url,     window_states.front_normal_url),
    front_roughness_url   = COALESCE(EXCLUDED.front_roughness_url,  window_states.front_roughness_url),
    front_metalness_url   = COALESCE(EXCLUDED.front_metalness_url,  window_states.front_metalness_url),
    glass_dirt_url        = COALESCE(EXCLUDED.glass_dirt_url,       window_states.glass_dirt_url),
    back_atlas_cols       = EXCLUDED.back_atlas_cols,
    back_atlas_rows       = EXCLUDED.back_atlas_rows,
    front_atlas_cols      = EXCLUDED.front_atlas_cols,
    front_atlas_rows      = EXCLUDED.front_atlas_rows,
    depth                 = EXCLUDED.depth,
    back_scale            = EXCLUDED.back_scale,
    interior_emissive_r   = EXCLUDED.interior_emissive_r,
    interior_emissive_g   = EXCLUDED.interior_emissive_g,
    interior_emissive_b   = EXCLUDED.interior_emissive_b,
    front_transmission    = EXCLUDED.front_transmission,
    front_alpha_boost     = EXCLUDED.front_alpha_boost,
    front_normal_scale    = EXCLUDED.front_normal_scale,
    glass_thickness       = EXCLUDED.glass_thickness,
    refraction_strength   = EXCLUDED.refraction_strength,
    glass_dirt_strength   = EXCLUDED.glass_dirt_strength,
    glass_fresnel_strength= EXCLUDED.glass_fresnel_strength,
    glass_fresnel_r       = EXCLUDED.glass_fresnel_r,
    glass_fresnel_g       = EXCLUDED.glass_fresnel_g,
    glass_fresnel_b       = EXCLUDED.glass_fresnel_b,
    glass_smudge_strength = EXCLUDED.glass_smudge_strength,
    is_lit                = EXCLUDED.is_lit,
    is_locked             = EXCLUDED.is_locked,
    theme                 = EXCLUDED.theme,
    custom_metadata       = window_states.custom_metadata || EXCLUDED.custom_metadata
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;
