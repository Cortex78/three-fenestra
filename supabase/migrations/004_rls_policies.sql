-- Migration 004: Row Level Security policies.
--
-- Security model:
--   buildings       — public read; owner or service_role write
--   windows         — public read; owner write (geometry is set-once by admin)
--   window_states   — public read; only owner can mutate their own state
--   user_textures   — private (owner-only read/write)
--   shader_generation_jobs — private (owner-only read/write)

-- ─────────────────────────────────────────────────────────────
-- Enable RLS on all tables
-- ─────────────────────────────────────────────────────────────
ALTER TABLE buildings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE windows               ENABLE ROW LEVEL SECURITY;
ALTER TABLE window_states         ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_textures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE shader_generation_jobs ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- buildings
-- ─────────────────────────────────────────────────────────────
-- Anyone (including anonymous) can read public buildings.
CREATE POLICY "buildings: public read"
  ON buildings FOR SELECT
  USING (is_public = true OR owner_user_id = auth.uid());

-- Only the owner (or service_role) can create/update/delete buildings.
CREATE POLICY "buildings: owner write"
  ON buildings FOR ALL
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- windows
-- ─────────────────────────────────────────────────────────────
-- Everyone reads windows in public buildings.
CREATE POLICY "windows: public read"
  ON windows FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM buildings b
      WHERE b.id = windows.building_id
        AND (b.is_public = true OR b.owner_user_id = auth.uid())
    )
  );

-- Window geometry is set-once by building owner / service_role.
-- After assignment, only the building owner may update geometry.
CREATE POLICY "windows: building owner write"
  ON windows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM buildings b
      WHERE b.id = windows.building_id
        AND b.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM buildings b
      WHERE b.id = windows.building_id
        AND b.owner_user_id = auth.uid()
    )
  );

-- Window owner can update ownership-related fields on their own window
-- (e.g. transferring ownership is done via building admin panel).
CREATE POLICY "windows: owner update"
  ON windows FOR UPDATE
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- window_states
-- ─────────────────────────────────────────────────────────────
-- Public read (all viewers see all window states).
CREATE POLICY "window_states: public read"
  ON window_states FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM windows w
      JOIN buildings b ON b.id = w.building_id
      WHERE w.id = window_states.window_id
        AND (b.is_public = true OR b.owner_user_id = auth.uid())
    )
  );

-- Only the window owner can insert/update their state.
-- Locking is enforced: if is_locked=true nobody can write (except service_role).
CREATE POLICY "window_states: owner write"
  ON window_states FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM windows w
      WHERE w.id = window_states.window_id
        AND w.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "window_states: owner update"
  ON window_states FOR UPDATE
  USING (
    updated_by = auth.uid()
    AND is_locked = false
    AND EXISTS (
      SELECT 1 FROM windows w
      WHERE w.id = window_states.window_id
        AND w.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM windows w
      WHERE w.id = window_states.window_id
        AND w.owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────
-- user_textures  (private)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "user_textures: owner read"
  ON user_textures FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_textures: owner write"
  ON user_textures FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- shader_generation_jobs  (private)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "gen_jobs: owner read"
  ON shader_generation_jobs FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "gen_jobs: owner write"
  ON shader_generation_jobs FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can cancel their own jobs (set status = 'cancelled').
CREATE POLICY "gen_jobs: owner cancel"
  ON shader_generation_jobs FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
