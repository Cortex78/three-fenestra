/**
 * Edge Function: window-state-sync
 *
 * Thin wrapper around the `update_window_state` stored procedure.
 * Validates the JWT, passes ownership checks to Postgres, and returns
 * the updated row — which Supabase Realtime then broadcasts automatically.
 *
 * PUT /functions/v1/window-state-sync
 * Body:
 *   {
 *     windowId:        string;
 *     state:           Partial<WindowStateRow>;  // camelCase accepted too
 *     expectedVersion: number | null;            // for optimistic locking
 *   }
 *
 * Response:
 *   { data: WindowStateRow }
 *   or
 *   { error: string, code: 'serialization_failure' | 'not_owner' | ... }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Max retries on serialization_failure (optimistic lock clash)
const MAX_RETRIES = 3;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, {
      status: 405, headers: corsHeaders,
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json({ error: 'Unauthorized' }, {
        status: 401, headers: corsHeaders,
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const token    = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return Response.json({ error: 'Invalid token' }, {
        status: 401, headers: corsHeaders,
      });
    }

    const body = await req.json() as {
      windowId:        string;
      state:           Record<string, unknown>;
      expectedVersion: number | null;
    };

    const { windowId, state, expectedVersion = null } = body;
    if (!windowId || !state) {
      return Response.json({ error: 'windowId and state are required' }, {
        status: 400, headers: corsHeaders,
      });
    }

    // Normalise keys to snake_case (accept both camel and snake from clients)
    const normalised = normaliseKeys(state);

    let lastError: string | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { data, error } = await supabase.rpc('update_window_state', {
        p_window_id:        windowId,
        p_user_id:          user.id,
        p_state:            normalised,
        p_expected_version: expectedVersion,
      });

      if (!error) {
        return Response.json({ data }, { headers: corsHeaders });
      }

      // Serialization failure — retry with fresh fetch
      if (error.code === '40001' && attempt < MAX_RETRIES - 1) {
        // Small back-off: 50ms, 150ms, 400ms
        await sleep(50 * Math.pow(3, attempt));
        // On retry, don't enforce version (we already know it changed)
        // Caller must handle this case if they care about conflict detection.
        continue;
      }

      lastError = error.message;

      if (error.code === 'insufficient_privilege') {
        return Response.json({
          error: 'You do not own this window',
          code:  'not_owner',
        }, { status: 403, headers: corsHeaders });
      }

      if (error.code === '40001') {
        return Response.json({
          error: 'Concurrent modification — please reload and retry',
          code:  'serialization_failure',
        }, { status: 409, headers: corsHeaders });
      }

      return Response.json({ error: lastError }, {
        status: 500, headers: corsHeaders,
      });
    }

    return Response.json({ error: lastError ?? 'Max retries exceeded' }, {
      status: 500, headers: corsHeaders,
    });

  } catch (err) {
    console.error('window-state-sync error:', err);
    return Response.json({ error: 'Internal server error' }, {
      status: 500, headers: corsHeaders,
    });
  }
});

function normaliseKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`),
      v,
    ]),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
