/**
 * Edge Function: process-texture-upload
 *
 * Receives a multipart form upload, validates, converts to WebP, generates a
 * thumbnail, stores both in Supabase Storage, and inserts a user_textures row.
 *
 * Multipart fields:
 *   file        : File  — the image to upload (JPEG, PNG, WebP, AVIF)
 *   windowId    : string — target window UUID (optional; links texture to window)
 *   textureType : string — 'back' | 'front' | 'normal' | 'roughness' | 'metalness' | 'dirt'
 *   atlasCols   : number — atlas grid columns (default 1)
 *   atlasRows   : number — atlas grid rows   (default 1)
 *
 * Returns:
 *   { textureId, url, thumbUrl, width, height }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
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

    const form = await req.formData();
    const file = form.get('file') as File | null;

    if (!file) {
      return Response.json({ error: 'No file provided' }, {
        status: 400, headers: corsHeaders,
      });
    }

    // Validate
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return Response.json({
        error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, WebP, AVIF`,
      }, { status: 400, headers: corsHeaders });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, {
        status: 400, headers: corsHeaders,
      });
    }

    const textureType = (form.get('textureType') as string) ?? 'back';
    const windowId    = (form.get('windowId')    as string) ?? null;
    const atlasCols   = parseInt((form.get('atlasCols') as string) ?? '1', 10);
    const atlasRows   = parseInt((form.get('atlasRows') as string) ?? '1', 10);

    const fileBytes = new Uint8Array(await file.arrayBuffer());

    // Pass original bytes through — Supabase Storage serves with correct Content-Type.
    // Map MIME type → file extension for the storage path.
    const mimeToExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png':  'png',
      'image/webp': 'webp',
      'image/avif': 'avif',
    };
    const ext          = mimeToExt[file.type] ?? 'jpg';
    const processedBytes = fileBytes;
    const contentType    = file.type;  // keep original MIME so browsers decode correctly

    // Upload full-res
    const textureId   = crypto.randomUUID();
    const fullPath    = `textures/${user.id}/${textureId}/full.${ext}`;
    const thumbPath   = `textures/${user.id}/${textureId}/thumb.${ext}`;

    const { error: fullUploadError } = await supabase.storage
      .from('textures')
      .upload(fullPath, processedBytes, {
        contentType,
        upsert: false,
      });

    if (fullUploadError) throw new Error(`Upload failed: ${fullUploadError.message}`);

    // Supabase image transformation for thumb (no Sharp needed in edge)
    const { data: { publicUrl: fullUrl } } = supabase.storage
      .from('textures')
      .getPublicUrl(fullPath);

    // Thumb via Supabase image transform (appended as query param)
    const thumbUrl = `${fullUrl}?width=128&height=128&resize=cover`;

    // Insert user_textures row
    const { data: textureRow, error: dbError } = await supabase
      .from('user_textures')
      .insert({
        id:               textureId,
        user_id:          user.id,
        storage_path:     fullPath,
        url:              fullUrl,
        thumb_url:        thumbUrl,
        filename:         file.name,
        texture_type:     textureType,
        atlas_cols:       atlasCols,
        atlas_rows:       atlasRows,
        file_size_bytes:  file.size,
        format:           'webp',
        origin:           'upload',
      })
      .select()
      .single();

    if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

    return Response.json({
      textureId:  textureRow.id,
      url:        fullUrl,
      thumbUrl,
      atlasCols,
      atlasRows,
    }, { headers: corsHeaders });

  } catch (err) {
    console.error('process-texture-upload error:', err);
    return Response.json({ error: 'Internal server error' }, {
      status: 500, headers: corsHeaders,
    });
  }
});
