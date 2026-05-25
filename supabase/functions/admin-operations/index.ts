/**
 * Edge Function: admin-operations
 *
 * Privileged admin actions that require both DB mutations AND Storage bucket deletions.
 * Only users present in the `admin_users` table can call this function.
 *
 * Request body (JSON):
 *   { action: 'deleteWindowTexture', windowId: string }
 *     → Deletes all Storage files linked to this window's textures,
 *       removes user_textures rows, and deletes the window_state row.
 *
 *   { action: 'resetBuilding', buildingId: string }
 *     → Deletes ALL Storage files linked to every window in the building,
 *       removes corresponding user_textures rows, and resets all window_states.
 *
 * Response:
 *   { success: true, deletedStoragePaths: string[], deletedStateCount: number }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders }  from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    }

    // Use service-role client for Storage operations
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Verify the calling user's JWT
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return Response.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
    }

    // Check admin role
    const { data: adminRow } = await supabase
      .from('admin_users')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!adminRow) {
      return Response.json({ error: 'Forbidden: admin access required' }, { status: 403, headers: corsHeaders });
    }

    const body = await req.json() as {
      action:      string;
      windowId?:   string;
      buildingId?: string;
    };

    switch (body.action) {
      case 'deleteWindowTexture':
        return handleDeleteWindowTexture(supabase, body.windowId, corsHeaders);

      case 'resetBuilding':
        return handleResetBuilding(supabase, body.buildingId, corsHeaders);

      default:
        return Response.json({ error: `Unknown action: ${body.action}` }, { status: 400, headers: corsHeaders });
    }

  } catch (err) {
    console.error('admin-operations error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
  }
});

// ─────────────────────────────────────────────────────────────
// Action: deleteWindowTexture
// ─────────────────────────────────────────────────────────────

async function handleDeleteWindowTexture(
  supabase:  ReturnType<typeof createClient>,
  windowId?: string,
  headers?:  Record<string, string>,
): Promise<Response> {
  if (!windowId) {
    return Response.json({ error: 'windowId is required' }, { status: 400, headers });
  }

  // 1. Collect storage paths for this window
  const { data: paths, error: pathErr } = await supabase.rpc(
    'admin_get_window_storage_paths',
    { p_window_id: windowId },
  );
  if (pathErr) throw new Error(`admin_get_window_storage_paths: ${pathErr.message}`);

  const storagePaths: string[] = (paths ?? []).map((r: { storage_path: string }) => r.storage_path);

  // 2. Delete from Storage bucket (batch, ignore missing-file errors)
  const deletedPaths: string[] = [];
  if (storagePaths.length > 0) {
    const { data: deleted, error: storageErr } = await supabase.storage
      .from('textures')
      .remove(storagePaths);

    if (storageErr) {
      console.warn('Storage deletion partial error:', storageErr.message);
    }
    deletedPaths.push(...(deleted ?? []).map((f: { name: string }) => f.name));
  }

  // 3. Delete user_textures rows where storage_path matches
  if (storagePaths.length > 0) {
    await supabase
      .from('user_textures')
      .delete()
      .in('storage_path', storagePaths);
  }

  // 4. Delete the window_state row (clears all URL columns + shader uniforms)
  const { error: stateErr } = await supabase.rpc('admin_delete_window_state', { p_window_id: windowId });
  if (stateErr) throw new Error(`admin_delete_window_state: ${stateErr.message}`);

  return Response.json({
    success:              true,
    deletedStoragePaths:  deletedPaths,
    deletedStateCount:    1,
  }, { headers });
}

// ─────────────────────────────────────────────────────────────
// Action: resetBuilding
// ─────────────────────────────────────────────────────────────

async function handleResetBuilding(
  supabase:   ReturnType<typeof createClient>,
  buildingId?: string,
  headers?:   Record<string, string>,
): Promise<Response> {
  if (!buildingId) {
    return Response.json({ error: 'buildingId is required' }, { status: 400, headers });
  }

  // 1. Collect all storage paths linked to this building
  const { data: paths, error: pathErr } = await supabase.rpc(
    'admin_get_building_storage_paths',
    { p_building_id: buildingId },
  );
  if (pathErr) throw new Error(`admin_get_building_storage_paths: ${pathErr.message}`);

  const storagePaths: string[] = (paths ?? []).map((r: { storage_path: string }) => r.storage_path);

  // 2. Delete from Storage in batches of 100 (Supabase limit)
  const deletedPaths: string[] = [];
  const BATCH = 100;
  for (let i = 0; i < storagePaths.length; i += BATCH) {
    const batch = storagePaths.slice(i, i + BATCH);
    const { data: deleted, error: storageErr } = await supabase.storage
      .from('textures')
      .remove(batch);

    if (storageErr) console.warn('Storage batch delete error:', storageErr.message);
    deletedPaths.push(...(deleted ?? []).map((f: { name: string }) => f.name));
  }

  // 3. Delete user_textures rows
  if (storagePaths.length > 0) {
    await supabase
      .from('user_textures')
      .delete()
      .in('storage_path', storagePaths);
  }

  // 4. Reset all window_states for this building (SQL-level, no storage needed)
  const { data: resetCount, error: resetErr } = await supabase.rpc(
    'admin_reset_building',
    { p_building_id: buildingId },
  );
  if (resetErr) throw new Error(`admin_reset_building: ${resetErr.message}`);

  return Response.json({
    success:             true,
    deletedStoragePaths: deletedPaths,
    deletedStateCount:   resetCount ?? 0,
  }, { headers });
}
