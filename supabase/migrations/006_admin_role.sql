-- Migration 006: Admin role — privileged users who can delete textures and reset buildings.
-- Admin operations that touch Storage must go through the admin-operations Edge Function
-- (which uses the service-role key) because the Storage bucket is not accessible via SQL.

-- ─────────────────────────────────────────────────────────────
-- Table: admin_users
-- Simple allow-list; populated manually by the platform owner.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the initial admin
INSERT INTO admin_users (user_id)
VALUES ('934af404-10a5-4961-a3eb-0ddcdfc3e30a')
ON CONFLICT DO NOTHING;

-- RLS: only the row-owner can see their own admin record (used by clients to check their role)
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_users: read own"
  ON admin_users FOR SELECT
  USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- Helper: is_admin()  — server-side, JWT-verified
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid())
$$;

-- ─────────────────────────────────────────────────────────────
-- RLS additions: admin can UPDATE or DELETE any window_state
-- (normal users can only touch windows they own)
-- ─────────────────────────────────────────────────────────────

-- Admin delete any window_state
DROP POLICY IF EXISTS "window_states: admin delete" ON window_states;
CREATE POLICY "window_states: admin delete"
  ON window_states FOR DELETE
  USING (is_admin());

-- Admin update any window_state (e.g. reset individual fields)
DROP POLICY IF EXISTS "window_states: admin update" ON window_states;
CREATE POLICY "window_states: admin update"
  ON window_states FOR UPDATE
  USING (is_admin());

-- ─────────────────────────────────────────────────────────────
-- Admin: delete a single window's state + linked textures
-- (table rows only; storage deletion goes through the Edge Function)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_delete_window_state(p_window_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Remove the state row (cascades to nothing; textures kept until storage delete)
  DELETE FROM window_states WHERE window_id = p_window_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Admin: reset all window states for a building (table rows)
-- Storage deletion is handled by the Edge Function caller.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_reset_building(p_building_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM window_states
  WHERE window_id IN (
    SELECT id FROM windows WHERE building_id = p_building_id
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Admin: list storage paths that belong to a building
-- Returns the storage_path values so the Edge Function can
-- delete them from the bucket before calling admin_reset_building.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_building_storage_paths(p_building_id uuid)
RETURNS TABLE(storage_path text) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT ut.storage_path
  FROM user_textures ut
  JOIN window_states ws ON (
       ws.back_atlas_url     = ut.url
    OR ws.front_atlas_url    = ut.url
    OR ws.front_normal_url   = ut.url
    OR ws.front_roughness_url = ut.url
    OR ws.front_metalness_url = ut.url
    OR ws.glass_dirt_url     = ut.url
  )
  JOIN windows w ON w.id = ws.window_id
  WHERE w.building_id = p_building_id
  UNION
  -- Also include generated textures linked by window_id (from shader_generation_jobs)
  SELECT ut2.storage_path
  FROM user_textures ut2
  JOIN shader_generation_jobs sgj ON sgj.id = ut2.generation_job_id
  JOIN windows w2 ON w2.id = sgj.window_id
  WHERE w2.building_id = p_building_id;
$$;

-- ─────────────────────────────────────────────────────────────
-- Admin: get storage paths for a single window
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_window_storage_paths(p_window_id uuid)
RETURNS TABLE(storage_path text) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT ut.storage_path
  FROM user_textures ut
  LEFT JOIN window_states ws ON ws.window_id = p_window_id
  WHERE (
       ut.url = ws.back_atlas_url
    OR ut.url = ws.front_atlas_url
    OR ut.url = ws.front_normal_url
    OR ut.url = ws.front_roughness_url
    OR ut.url = ws.front_metalness_url
    OR ut.url = ws.glass_dirt_url
  )
  UNION
  SELECT ut2.storage_path
  FROM user_textures ut2
  JOIN shader_generation_jobs sgj ON sgj.id = ut2.generation_job_id
  WHERE sgj.window_id = p_window_id;
$$;
