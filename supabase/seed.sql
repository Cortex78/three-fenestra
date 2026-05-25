-- Seed data: creates the asia-building demo as a real Supabase record
-- and populates its 160 windows from the existing windows.json geometry.
--
-- Run after migrations:
--   supabase db seed

-- ─────────────────────────────────────────────────────────────
-- Demo building (matches the asia-building example)
-- ─────────────────────────────────────────────────────────────
INSERT INTO buildings (
  id, name, slug, description,
  location, altitude_m, height_m,
  default_back_atlas_url,
  default_front_atlas_url,
  default_atlas_cols, default_atlas_rows,
  is_public
) VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Asia Building Demo',
  'asia-building',
  'The three-fenestra reference building — a high-rise with 160 windows across 8 floors.',
  ST_SetSRID(ST_MakePoint(121.4737, 31.2304), 4326),  -- Shanghai approximate coords
  0.0,
  200.0,
  -- These URLs point to the bundled starter atlases.
  -- Replace with your Supabase Storage public URLs after uploading.
  'https://your-project.supabase.co/storage/v1/object/public/textures/starter/rooms.webp',
  'https://your-project.supabase.co/storage/v1/object/public/textures/starter/overlay.webp',
  4, 4,
  true
)
ON CONFLICT (slug) DO NOTHING;

-- NOTE: Individual window rows should be inserted by running the Python tool:
--   python3 examples/asia-building/tools/extract_windows.py
-- which outputs a windows.json that you then import:
--   supabase db seed --table windows --file windows_seed.csv
--
-- For demonstration, insert a single placeholder window:
INSERT INTO windows (
  id, building_id, window_index,
  center_x, center_y, center_z,
  right_x, right_y, right_z,
  up_x, up_y, up_z,
  normal_x, normal_y, normal_z,
  width_m, height_m,
  floor_number, label,
  location
) VALUES (
  gen_random_uuid(),
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  0,
  56.46, 144.07, -0.04,   -- center
   0.0,   0.0,   -1.0,   -- right
   1.0,   0.0,    0.0,   -- up
   0.0,  -1.0,    0.0,   -- normal
  20.23, 4.92,
  1, 'A-01-01',
  ST_SetSRID(ST_MakePoint(121.4737, 31.2304), 4326)
)
ON CONFLICT (building_id, window_index) DO NOTHING;
