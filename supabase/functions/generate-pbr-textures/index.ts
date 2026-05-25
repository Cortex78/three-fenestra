/**
 * Edge Function: generate-pbr-textures
 *
 * Generates PBR texture layers from a text prompt using Google Gemini
 * gemini-2.0-flash-preview-image-generation via the @google/genai SDK.
 *
 * Supported providers (GENERATOR_PROVIDER env var):
 *   google-gemini   — default, uses gemini-2.0-flash-preview-image-generation
 *   stability-ai    — Stability AI SDXL fallback
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

    // Run generation asynchronously (fire-and-forget)
    processJob(supabase, job.id, user.id, {
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

    const imageBytes = await generateImage(layerPrompt, params.negativePrompt, params.modelParams);

    const storagePath = `generated/${userId}/${jobId}/${layer}.webp`;
    const { error: uploadErr } = await supabase.storage
      .from('textures')
      .upload(storagePath, imageBytes, { contentType: 'image/webp', upsert: true });

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
      format:            'webp',
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
): Promise<Uint8Array> {
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
 * Uses the REST API directly (no Node SDK in Deno Edge Functions).
 */
async function generateWithGemini(
  prompt:          string,
  _negativePrompt?: string,
): Promise<Uint8Array> {
  const model    = 'gemini-2.0-flash-preview-image-generation';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role:  'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        // Minimal thinking for speed
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

  return Uint8Array.from(atob(imagePart.inlineData.data), (c) => c.charCodeAt(0));
}

async function generateWithStabilityAI(
  prompt:          string,
  negativePrompt?: string,
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
  return Uint8Array.from(atob(json.artifacts[0].base64), (c) => c.charCodeAt(0));
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function buildLayerPrompt(base: string, layer: string): string {
  const suffixes: Record<string, string> = {
    back:      `Interior room view from outside a window. ${base}. Photorealistic, warm interior lighting, depth visible through window glass. Square 1:1 composition.`,
    front:     `Window curtain or blind. ${base}. Product shot on transparent/white background, showing fabric texture. Square 1:1.`,
    normal:    `Tangent-space normal map for: ${base}. Blue-purple tones, flat surface, PBR material map, square 1:1.`,
    roughness: `Grayscale PBR roughness map for: ${base}. White=rough, black=smooth, square 1:1.`,
    metalness: `Grayscale PBR metalness map for: ${base}. White=metal, black=non-metal, mostly dark for fabric/glass, square 1:1.`,
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
