# Supabase Setup Guide

This guide walks through configuring a Supabase project to power the
three-fenestra streaming layer — from a blank project to a running
streaming demo in under 15 minutes.

---

## Prerequisites

- [Supabase account](https://supabase.com) (free tier is sufficient for development)
- [Supabase CLI](https://supabase.com/docs/guides/cli) `>= 1.150`
- Node.js `>= 18`

```bash
npm install -g supabase
supabase --version   # should print 1.150+
```

---

## Option A — Cloud project (recommended)

### 1. Create a project

1. Go to [app.supabase.com](https://app.supabase.com) → **New project**
2. Choose a region close to your users
3. Note down your **Project URL** and **anon public key** (from Settings → API)

### 2. Link the CLI to your project

```bash
supabase login
supabase link --project-ref <your-project-ref>
# Project ref is the part of your URL after app.supabase.com/project/
```

### 3. Apply all migrations

```bash
cd /path/to/three-fenestra
supabase db push
```

This runs all 5 migration files in order:

| Migration | What it creates |
|---|---|
| `001_postgis_setup.sql` | PostGIS, uuid-ossp, pg_trgm, btree_gin extensions |
| `002_buildings_windows.sql` | `buildings` table with geographic location + footprint; `windows` table with 3D ECEF coordinates and GIST spatial indexes |
| `003_window_states.sql` | `window_states` table (all 23 shader uniforms); `update_window_state()` stored procedure with `SELECT FOR UPDATE` + optimistic locking; versioning trigger |
| `004_rls_policies.sql` | Row Level Security — public read, owner-only write on all tables |
| `005_realtime_and_views.sql` | Supabase Realtime publication on `window_states` + `shader_generation_jobs`; `v_building_window_states` denorm view; `get_nearby_buildings()` PostGIS function |

Verify in Supabase Studio → Table Editor that `buildings`, `windows`, and `window_states` exist.

### 4. Seed demo data (optional)

```bash
supabase db seed
```

This inserts the `asia-building` demo building row and one placeholder window.
Replace the atlas URLs in `supabase/seed.sql` with your actual Supabase Storage
public URLs before running this in production.

### 5. Configure Storage

Create a public storage bucket named `textures`:

```bash
supabase storage create-bucket textures --public
```

Or via the Dashboard: **Storage** → **New bucket** → name: `textures`, Public: ✓

Upload the starter atlases:

```bash
supabase storage upload textures starter/rooms.webp   textures/starter/rooms.webp
supabase storage upload textures starter/overlay.webp textures/starter/overlay.webp
```

Update `supabase/seed.sql` with the actual public URLs (Settings → Storage → click the file → Copy URL), then re-run seed if needed.

### 6. Deploy Edge Functions

```bash
# Deploy all three functions
supabase functions deploy generate-pbr-textures
supabase functions deploy process-texture-upload
supabase functions deploy window-state-sync
```

Verify in Dashboard → **Edge Functions** that all three show status **Active**.

### 7. Set secrets

```bash
# Required only for AI texture generation
supabase secrets set GOOGLE_IMAGEN_API_KEY=your-google-ai-studio-key

# Alternative: Stability AI
supabase secrets set STABILITY_AI_API_KEY=your-stability-key
supabase secrets set GENERATOR_PROVIDER=stability-ai
```

To get a Google Imagen 3 API key:
1. [Google AI Studio](https://aistudio.google.com/app/apikey) → Create API key
2. The key must have the `Generative Language API` permission

### 8. Configure the streaming demo

```bash
cp examples/streaming-demo/.env.example examples/streaming-demo/.env.local
```

Edit `.env.local`:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...  # from Dashboard → Settings → API
VITE_BUILDING_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890  # from seed.sql or your own building row
```

### 9. Run the streaming demo

```bash
npm run dev:streaming
# Open http://localhost:5174
```

---

## Option B — Local Supabase stack (no cloud account needed)

The Supabase CLI can run the full stack locally via Docker.

### Prerequisites

- Docker Desktop running

### 1. Start the local stack

```bash
supabase start
```

On first run this pulls Docker images (~1 GB). Once running, output looks like:

```
Started supabase local development setup.

         API URL: http://localhost:54321
     GraphQL URL: http://localhost:54321/graphql/v1
  S3 Storage URL: http://localhost:54321/storage/v1/s3
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324
      JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
        anon key: eyJ...
service_role key: eyJ...
```

Note the `anon key` — you will need it in `.env.local`.

### 2. Apply migrations and seed

```bash
# Drop everything and re-apply from scratch (safe during development)
supabase db reset
```

This runs `supabase/migrations/*.sql` in order and then `supabase/seed.sql`.

### 3. Serve Edge Functions locally

```bash
# Create local secrets file
cat > supabase/.env.local <<EOF
GOOGLE_IMAGEN_API_KEY=your-key-if-testing-ai
GENERATOR_PROVIDER=google-imagen-3
EOF

supabase functions serve --env-file supabase/.env.local
```

Edge Functions will be available at `http://localhost:54321/functions/v1/`.

### 4. Open Supabase Studio

```bash
# Studio opens automatically, or visit:
open http://localhost:54323
```

Explore the schema, run SQL queries, inspect storage, test Realtime.

### 5. Configure streaming demo for local

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=eyJ...   # from supabase start output
VITE_BUILDING_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### 6. Stop the local stack

```bash
supabase stop
# Or to also wipe local DB volumes:
supabase stop --no-backup
```

---

## Configuring Realtime

By default migration `005` adds `window_states` and `shader_generation_jobs` to
the `supabase_realtime` publication. Verify this in Studio:

```sql
-- Run in Studio → SQL Editor
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```

Expected output:
```
tablename
─────────────────────────
window_states
shader_generation_jobs
```

If `window_states` is missing (some Supabase tiers restrict publication mutations):

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE window_states;
ALTER PUBLICATION supabase_realtime ADD TABLE shader_generation_jobs;
```

Also ensure **Replication** is enabled in Dashboard → **Database** → **Replication**
for the `window_states` table.

---

## Enabling user sign-up

The streaming demo uses email/password auth. Enable it in Dashboard →
**Authentication** → **Providers** → **Email** → toggle on.

For production, also configure:
- SMTP (for confirmation emails) in Auth → Settings → SMTP
- Allowed redirect URLs in Auth → URL Configuration

For testing without real email confirmation, disable "Confirm email" in Auth → Settings.

---

## Uploading your own building

### 1. Create a buildings row

```sql
INSERT INTO buildings (name, slug, location, model_url, default_back_atlas_url, default_atlas_cols, default_atlas_rows, is_public)
VALUES (
  'My Building',
  'my-building',
  ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326),  -- lng, lat
  'https://your-cdn.com/building.gltf',
  'https://<project>.supabase.co/storage/v1/object/public/textures/starter/rooms.webp',
  4, 4,
  true
)
RETURNING id;
```

Note the returned `id` — this is your `VITE_BUILDING_ID`.

### 2. Import window geometry

Run the Blender extraction script on your GLTF:

```bash
cd examples/asia-building/tools
# Edit extract_windows.py to point to your .gltf file, then:
blender --background --python extract_windows.py
# Produces windows.json
```

Then insert the windows via a migration or the Supabase import tool:

```bash
# Using psql:
psql "$(supabase db url)" -c "\copy windows (building_id, window_index, center_x, ...) FROM 'windows.csv' CSV HEADER"
```

### 3. Assign window ownership

```sql
-- Assign a specific window to a user
UPDATE windows
SET owner_user_id = '<user-uuid>'
WHERE building_id = '<building-uuid>' AND window_index = 5;

-- Assign an entire floor to a user
UPDATE windows
SET owner_user_id = '<user-uuid>'
WHERE building_id = '<building-uuid>' AND floor_number = 3;
```

---

## Spatial queries with PostGIS

Once buildings have geographic locations, you can run proximity queries:

```sql
-- Buildings within 500 m of Times Square, NYC
SELECT * FROM get_nearby_buildings(-73.9857, 40.7484, 500);

-- Count lit windows per floor in a building
SELECT floor_number, COUNT(*) FILTER (WHERE is_lit) AS lit_count
FROM v_building_window_states
WHERE building_id = '<uuid>'
GROUP BY floor_number ORDER BY floor_number;

-- All customised windows in a building
SELECT window_uuid, label, owner_user_id, back_atlas_url
FROM v_building_window_states
WHERE building_id = '<uuid>'
  AND back_atlas_url IS NOT NULL;
```

---

## Troubleshooting

### `supabase db push` fails with "extension not found"

PostGIS may not be enabled on your project. Go to Dashboard → **Database** →
**Extensions** → search "postgis" → enable.

### Edge Function returns 401

Check that you are passing `Authorization: Bearer <access_token>` in your request.
Use the user's `session.access_token`, not the `anon key`.

### Realtime events not arriving

1. Verify `window_states` is in the publication (see above).
2. Check RLS: the subscribing user must pass the `public read` policy.
3. In Studio → **Realtime**, use the inspector to confirm events are firing.

### `serialization_failure` on every write

This means two clients are writing the same window concurrently. The `window-state-sync` Edge Function retries up to 3 times with exponential back-off. If it still fails, the client receives a `409` and should re-fetch the latest row before retrying.

### AI generation job stays `pending`

1. Check Edge Function logs: Dashboard → **Edge Functions** → `generate-pbr-textures` → Logs.
2. Verify the secret is set: `supabase secrets list`.
3. For Google Imagen: confirm the API key has the `Generative Language API` permission in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
