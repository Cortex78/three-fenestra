/**
 * Edge Function: generate-pbr-textures
 *
 * Generates PBR texture layers from a text prompt using Google Gemini
 * gemini-2.0-flash-preview-image-generation via the Generative Language REST API.
 *
 * KEY FIX: uses EdgeRuntime.waitUntil() so the background generation keeps running
 * after the HTTP response has been returned (Edge Functions terminate on response
 * completion without this).
 *
 * TEMPLATE GUIDANCE: the default 4×4 rooms atlas (rooms.webp) is sent to Gemini
 * as a reference inlineData image so outputs are always square, correct-perspective
 * interior views that match the atlas tile format.
 *
 * Request body (JSON):
 *   {
 *     windowId:       string,
 *     prompt:         string,
 *     negativePrompt: string | undefined,
 *     layers:         ('back'|'front'|'normal'|'roughness'|'metalness')[],
 *     modelParams:    object | undefined,
 *   }
 *
 * Response: { jobId, status: 'processing', message }
 * Progress tracked via shader_generation_jobs Realtime subscription.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders }  from '../_shared/cors.ts';
import { ROOMS_TEMPLATE_B64, ROOMS_TEMPLATE_MIME } from '../_shared/rooms-template-b64.ts';

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_API_KEY     = Deno.env.get('GEMINI_API_KEY') ?? '';
const GENERATOR_PROVIDER = Deno.env.get('GENERATOR_PROVIDER') ?? 'google-gemini';

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json({ error: 'Missing Authorization header' }, { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const token    = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return Response.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
    }

    if (!GEMINI_API_KEY && GENERATOR_PROVIDER === 'google-gemini') {
      return Response.json({ error: 'GEMINI_API_KEY not configured on this server' }, { status: 503, headers: corsHeaders });
    }

    const body = await req.json() as {
      windowId:        string;
      prompt:          string;
      negativePrompt?: string;
      layers?:         string[];
      modelParams?:    Record<string, unknown>;
    };

    const { windowId, prompt, negativePrompt, layers = ['back'], modelParams = {} } = body;

    if (!windowId || !prompt) {
      return Response.json({ error: 'windowId and prompt are required' }, { status: 400, headers: corsHeaders });
    }

    const safePrompt = sanitisePrompt(prompt);

    // Create job record
    const { data: job, error: jobError } = await supabase
      .from('shader_generation_jobs')
      .insert({
        user_id:         user.id,
        window_id:       windowId,
        prompt:          safePrompt,
        negative_prompt: negativePrompt ?? null,
        layers,
        model_provider:  GENERATOR_PROVIDER,
        model_params:    modelParams,
        status:          'pending',
      })
      .select()
      .single();

    if (jobError) {
      return Response.json({ error: jobError.message }, { status: 500, headers: corsHeaders });
    }

    // ──────────────────────────────────────────────────────
    // CRITICAL: use EdgeRuntime.waitUntil() so the function
    // instance stays alive until generation completes, even
    // after the HTTP response has been sent.  Without this,
    // Supabase terminates the isolate on response and the
    // background processJob() never runs.
    // ──────────────────────────────────────────────────────
    const background = processJob(supabase, job.id, user.id, {
      prompt: safePrompt,
      negativePrompt,
      layers,
      windowId,
      modelParams,
    }).catch(async (err: Error) => {
      console.error('Generation failed:', err);
      await supabase
        .from('shader_generation_jobs')
        .update({ status: 'failed', error_message: err.message })
        .eq('id', job.id);
    });

    // Keep the isolate alive
    (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } })
      .EdgeRuntime?.waitUntil(background);

    return Response.json(
      { jobId: job.id, status: 'processing', message: `Generating ${layers.join(', ')} with ${GENERATOR_PROVIDER}` },
      { headers: corsHeaders },
    );

  } catch (err) {
    console.error('generate-pbr-textures error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
  }
});

// ─────────────────────────────────────────────────────────────
// Generation pipeline
// ─────────────────────────────────────────────────────────────

async function processJob(
  supabase: ReturnType<typeof createClient>,
  jobId:    string,
  userId:   string,
  params: {
    prompt:          string;
    negativePrompt?: string;
    layers:          string[];
    windowId:        string;
    modelParams:     Record<string, unknown>;
  },
): Promise<void> {
  await supabase
    .from('shader_generation_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId);

  const resultUrls: Record<string, string> = {};

  for (let i = 0; i < params.layers.length; i++) {
    const layer       = params.layers[i];
    const layerPrompt = buildLayerPrompt(params.prompt, layer);

    const { bytes, mimeType } = await generateImage(layerPrompt, params.negativePrompt, params.modelParams);

    // Determine extension from returned MIME (Gemini may return PNG or JPEG)
    const mimeToExt: Record<string, string> = {
      'image/png':  'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    };
    const ext          = mimeToExt[mimeType] ?? 'png';
    const storagePath  = `generated/${userId}/${jobId}/${layer}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('textures')
      .upload(storagePath, bytes, { contentType: mimeType, upsert: true });

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    const { data: { publicUrl } } = supabase.storage.from('textures').getPublicUrl(storagePath);
    resultUrls[layer] = publicUrl;

    await supabase.from('user_textures').insert({
      user_id:           userId,
      storage_path:      storagePath,
      url:               publicUrl,
      texture_type:      layer === 'back' ? 'back' : layer,
      atlas_cols:        1,
      atlas_rows:        1,
      format:            ext,
      origin:            'generated',
      generation_job_id: jobId,
    });

    await supabase
      .from('shader_generation_jobs')
      .update({ progress: Math.round(((i + 1) / params.layers.length) * 100) })
      .eq('id', jobId);
  }

  await supabase
    .from('shader_generation_jobs')
    .update({
      status:       'completed',
      result_urls:  resultUrls,
      completed_at: new Date().toISOString(),
      credits_used: params.layers.length,
      progress:     100,
    })
    .eq('id', jobId);
}

// ─────────────────────────────────────────────────────────────
// Google Gemini 2.0 Flash Image Generation
// ─────────────────────────────────────────────────────────────

async function generateImage(
  prompt:          string,
  negativePrompt?: string,
  _params:         Record<string, unknown> = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  switch (GENERATOR_PROVIDER) {
    case 'google-gemini':
      return generateWithGemini(prompt, negativePrompt);
    case 'stability-ai':
      return generateWithStabilityAI(prompt, negativePrompt);
    default:
      throw new Error(`Unknown provider: ${GENERATOR_PROVIDER}`);
  }
}

/**
 * Generate an image using gemini-2.0-flash-preview-image-generation.
 *
 * Sends the 4×4 rooms atlas (rooms.webp) as an inductive reference image alongside
 * the text prompt.  This constrains Gemini to always output:
 *   - Exactly square (1:1) images
 *   - Correct interior-mapping depth perspective (eye-level view from outside)
 *   - The same photorealistic quality as the reference atlas tiles
 */
async function generateWithGemini(
  prompt:          string,
  _negativePrompt?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const model    = 'gemini-2.0-flash-preview-image-generation';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role:  'user',
          parts: [
            // Reference atlas: the 4×4 rooms template constrains output format
            {
              inlineData: {
                mimeType: ROOMS_TEMPLATE_MIME,
                data:     ROOMS_TEMPLATE_B64,
              },
            },
            // Structured text prompt that references the atlas
            {
              text: [
                'You are generating interior room textures for a real-time building shader.',
                '',
                'The attached image is a 4×4 atlas of 16 room interiors. Each cell is a',
                'PERFECTLY SQUARE (1:1 ratio) view of a room interior as seen from outside',
                'the window — eye-level perspective, correct depth, warm interior lighting.',
                '',
                `Generate ONE new room in the EXACT same style and format: ${prompt}`,
                '',
                'Requirements (STRICT):',
                '• Output a single SQUARE image (1:1 aspect ratio, no letterboxing)',
                '• Interior viewed from outside looking in (window-frame perspective)',
                '• Photorealistic, matching the reference atlas quality',
                '• Warm interior lighting with realistic depth visible through the glass',
                '• No window frames, no UI, just the room interior fill',
              ].join('\n'),
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errBody}`);
  }

  const json = await res.json() as {
    candidates: Array<{
      content: {
        parts: Array<{
          inlineData?: { mimeType: string; data: string };
          text?: string;
        }>;
      };
    }>;
  };

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart?.inlineData) {
    const textPart = parts.find((p) => p.text);
    throw new Error(`Gemini returned no image. Text: ${textPart?.text ?? '(none)'}`);
  }

  return {
    bytes:    Uint8Array.from(atob(imagePart.inlineData.data), (c) => c.charCodeAt(0)),
    mimeType: imagePart.inlineData.mimeType,
  };
}

async function generateWithStabilityAI(
  prompt:          string,
  negativePrompt?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const apiKey = Deno.env.get('STABILITY_AI_API_KEY') ?? '';
  const res = await fetch(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept':        'application/json',
      },
      body: JSON.stringify({
        text_prompts: [
          { text: prompt,                weight: 1 },
          { text: negativePrompt ?? '', weight: -1 },
        ],
        cfg_scale: 7,
        height:    1024,
        width:     1024,
        samples:   1,
        steps:     30,
      }),
    },
  );

  if (!res.ok) throw new Error(`Stability AI error ${res.status}`);
  const json = await res.json() as { artifacts: Array<{ base64: string }> };
  return {
    bytes:    Uint8Array.from(atob(json.artifacts[0].base64), (c) => c.charCodeAt(0)),
    mimeType: 'image/png',
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function buildLayerPrompt(base: string, layer: string): string {
  const suffixes: Record<string, string> = {
    back: base,   // Full context supplied by the system prompt above
    front:
      `A semi-transparent window curtain or blind, seen from outside. ${base} style. ` +
      `White/neutral background behind fabric. Square 1:1, product-shot style.`,
    normal:
      `Tangent-space normal map (PBR material): ${base}. ` +
      `Blue-purple dominant tones as per OpenGL convention. Flat, square 1:1.`,
    roughness:
      `Grayscale PBR roughness map: ${base}. White = rough, black = mirror-smooth. ` +
      `Simple gradient or texture, square 1:1.`,
    metalness:
      `Grayscale PBR metalness map: ${base}. White = metallic, black = non-metal. ` +
      `Mostly black for organic/fabric surfaces. Square 1:1.`,
  };
  return suffixes[layer] ?? base;
}

function sanitisePrompt(prompt: string): string {
  return prompt
    .replace(/<[^>]*>/g, '')
    .replace(/[{}[\]\\]/g, '')
    .slice(0, 500)
    .trim();
}
