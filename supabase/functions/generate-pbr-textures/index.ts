/**
 * Edge Function: generate-pbr-textures
 *
 * Accepts a text prompt and generates PBR texture layers using the configured
 * AI provider. Stores results in Supabase Storage and updates
 * shader_generation_jobs with the result URLs.
 *
 * Supported providers (configured via GENERATOR_PROVIDER env var):
 *   - google-imagen-3  (default)
 *   - stability-ai
 *   - fal-ai
 *
 * Request body (JSON):
 *   {
 *     windowId:       string,              // UUID of the window
 *     prompt:         string,              // user's text description
 *     negativePrompt: string | undefined,  // optional negative prompt
 *     layers:         ('back' | 'front' | 'normal' | 'roughness' | 'metalness')[],
 *     modelParams:    object | undefined,  // provider-specific params
 *   }
 *
 * Response (JSON):
 *   {
 *     jobId:    string,
 *     status:   'processing',
 *     message:  string,
 *   }
 *   — The job runs asynchronously. The client subscribes to
 *     shader_generation_jobs via Realtime to receive completion.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GENERATOR_PROVIDER = Deno.env.get('GENERATOR_PROVIDER') ?? 'google-imagen-3';
const IMAGEN_API_KEY     = Deno.env.get('GOOGLE_IMAGEN_API_KEY') ?? '';

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Auth: require a valid JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json({ error: 'Missing Authorization header' }, {
        status: 401, headers: corsHeaders,
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Decode user from JWT
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return Response.json({ error: 'Invalid token' }, {
        status: 401, headers: corsHeaders,
      });
    }

    // Parse body
    const body = await req.json() as {
      windowId:       string;
      prompt:         string;
      negativePrompt?: string;
      layers?:        string[];
      modelParams?:   Record<string, unknown>;
    };

    const { windowId, prompt, negativePrompt, layers = ['back'], modelParams = {} } = body;

    if (!windowId || !prompt) {
      return Response.json({ error: 'windowId and prompt are required' }, {
        status: 400, headers: corsHeaders,
      });
    }

    // Sanitise prompt: strip injection attempts
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
      return Response.json({ error: jobError.message }, {
        status: 500, headers: corsHeaders,
      });
    }

    // Fire-and-forget: run generation in the background
    // In production this would be a Supabase pg_net HTTP call or a queue
    processGenerationJob(supabase, job.id, user.id, {
      prompt:         safePrompt,
      negativePrompt: negativePrompt,
      layers,
      windowId,
      modelParams,
    }).catch(async (err: Error) => {
      console.error('Generation job failed:', err);
      await supabase
        .from('shader_generation_jobs')
        .update({ status: 'failed', error_message: err.message })
        .eq('id', job.id);
    });

    return Response.json({
      jobId:   job.id,
      status:  'processing',
      message: `Generating ${layers.join(', ')} textures with ${GENERATOR_PROVIDER}`,
    }, { headers: corsHeaders });

  } catch (err) {
    console.error('generate-pbr-textures error:', err);
    return Response.json({ error: 'Internal server error' }, {
      status: 500, headers: corsHeaders,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Generation pipeline
// ─────────────────────────────────────────────────────────────

async function processGenerationJob(
  supabase:   ReturnType<typeof createClient>,
  jobId:      string,
  userId:     string,
  params: {
    prompt:          string;
    negativePrompt?: string;
    layers:          string[];
    windowId:        string;
    modelParams:     Record<string, unknown>;
  },
): Promise<void> {
  // Mark as processing
  await supabase
    .from('shader_generation_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId);

  const resultUrls: Record<string, string> = {};
  let creditsUsed = 0;

  for (const layer of params.layers) {
    const layerPrompt = buildLayerPrompt(params.prompt, layer);
    const imageBytes  = await generateImage(layerPrompt, params.negativePrompt, params.modelParams);

    // Convert to WebP and upload to storage
    const storagePath = `generated/${userId}/${jobId}/${layer}.webp`;
    const { error: uploadError } = await supabase.storage
      .from('textures')
      .upload(storagePath, imageBytes, {
        contentType: 'image/webp',
        upsert:      true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    const { data: { publicUrl } } = supabase.storage
      .from('textures')
      .getPublicUrl(storagePath);

    resultUrls[layer] = publicUrl;

    // Insert user_textures record
    await supabase.from('user_textures').insert({
      user_id:           userId,
      storage_path:      storagePath,
      url:               publicUrl,
      texture_type:      layer === 'back' ? 'back' : layer,
      atlas_cols:        1,
      atlas_rows:        1,
      format:            'webp',
      origin:            'generated',
      generation_job_id: jobId,
    });

    creditsUsed += 1;

    // Update progress
    await supabase
      .from('shader_generation_jobs')
      .update({ progress: Math.round((creditsUsed / params.layers.length) * 100) })
      .eq('id', jobId);
  }

  // Mark complete
  await supabase
    .from('shader_generation_jobs')
    .update({
      status:       'completed',
      result_urls:  resultUrls,
      completed_at: new Date().toISOString(),
      credits_used: creditsUsed,
      progress:     100,
    })
    .eq('id', jobId);
}

/** Build a layer-specific prompt suffix. */
function buildLayerPrompt(basePrompt: string, layer: string): string {
  const suffixes: Record<string, string> = {
    back:      ', interior room photography, warm lighting, realistic, 4K',
    front:     ', window curtain or blind, RGBA with transparency, product shot',
    normal:    ', normal map, blue-purple tangent space, flat smooth surface',
    roughness: ', roughness map, grayscale, PBR material',
    metalness: ', metalness map, grayscale, PBR material',
  };
  return basePrompt + (suffixes[layer] ?? '');
}

/** Call the configured AI provider to generate an image. */
async function generateImage(
  prompt:          string,
  negativePrompt?: string,
  params:          Record<string, unknown> = {},
): Promise<Uint8Array> {
  switch (GENERATOR_PROVIDER) {
    case 'google-imagen-3':
      return generateWithImagen3(prompt, negativePrompt, params);
    case 'stability-ai':
      return generateWithStabilityAI(prompt, negativePrompt, params);
    default:
      throw new Error(`Unknown provider: ${GENERATOR_PROVIDER}`);
  }
}

async function generateWithImagen3(
  prompt:          string,
  _negativePrompt?: string,
  _params:          Record<string, unknown> = {},
): Promise<Uint8Array> {
  // Google Imagen 3 API (preview endpoint — update when GA)
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${IMAGEN_API_KEY}`;

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount:    1,
        aspectRatio:    '1:1',
        outputMimeType: 'image/png',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Imagen 3 API error ${res.status}: ${err}`);
  }

  const json = await res.json() as {
    predictions: Array<{ bytesBase64Encoded: string }>;
  };

  const b64 = json.predictions[0].bytesBase64Encoded;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function generateWithStabilityAI(
  prompt:          string,
  negativePrompt?: string,
  params:          Record<string, unknown> = {},
): Promise<Uint8Array> {
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
        cfg_scale: params.cfg_scale ?? 7,
        height:    1024,
        width:     1024,
        samples:   1,
        steps:     params.steps ?? 30,
      }),
    },
  );

  if (!res.ok) throw new Error(`Stability AI error ${res.status}`);
  const json = await res.json() as { artifacts: Array<{ base64: string }> };
  const b64  = json.artifacts[0].base64;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sanitisePrompt(prompt: string): string {
  // Remove potential injection patterns; keep alphanumeric + common punctuation
  return prompt
    .replace(/<[^>]*>/g, '')          // strip HTML
    .replace(/[{}[\]\\]/g, '')        // strip code-like chars
    .slice(0, 500)                    // hard length cap
    .trim();
}
