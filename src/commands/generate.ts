/**
 * AI text/image-to-3D generation (Blender-MCP 1.3.0) — `generate_3d` support.
 *
 * Providers (per ~/workspace/research_notes/blender-product-realism-20261107/
 * notes/api-generation.md, read from each provider's official API docs only):
 *
 * - Meshy (first): POST /openapi/v2/text-to-3d (preview mode, then refine
 *   mode with preview_task_id), POST /openapi/v1/image-to-3d (URL or base64
 *   data URI, <= 20 MB). Poll GET <endpoint>/:id: PENDING -> IN_PROGRESS ->
 *   SUCCEEDED | FAILED | CANCELED. Download model_urls.glb — assets are
 *   kept only 3 days, so download immediately. Auth: Bearer key from env
 *   var MESHY_API_KEY only, never baked into source. Textured model =
 *   30 credits (20 preview + 10 refine); mesh-only draft = 5 credits
 *   (meshy-6-lite / smart-topology). API needs a paid plan (Free plan is
 *   web-only, returns 402).
 * - Tripo (second): POST /v3/generation/text-to-model and
 *   POST /v3/generation/image-to-model, poll GET /v3/tasks/{task_id}
 *   (queued -> running -> success | failed | cancelled). Download
 *   output.model_url (GLB) IMMEDIATELY inside the poll loop — the URL
 *   expires in 5 minutes. Auth: Bearer key from TRIPO_API_KEY.
 *   Textured text model $0.20 / image $0.30 (20 / 30 credits at $0.01).
 *
 * Hunyuan3D and Hyper3D Rodin are NOT implemented here (documented in the
 * README as future work): Hunyuan needs TC3-HMAC-SHA256 signing + a
 * Tencent Cloud account; Rodin needs a $120/mo Business plan for full API
 * access and a multipart / dual-ID flow.
 *
 * Honesty: no provider's docs state a GLB up-axis, so every import is
 * verified in Blender on import (min z, longest side) by the existing
 * import path — never assumed. No API key configured -> the tool says so
 * honestly instead of failing silently. No account was created and no key
 * exists for this repo; the no-key path and the request-building path are
 * what the tests cover (the HTTP layer is injectable for mocks).
 */

export const MESHY_BASE_URL = 'https://api.meshy.ai/openapi';
export const TRIPO_BASE_URL = 'https://openapi.tripo3d.ai/v3';

export const MESHY_STATUSES = ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED'] as const;
export const TRIPO_STATUSES = ['queued', 'running', 'success', 'failed', 'cancelled'] as const;

export type GenerateProvider = 'meshy' | 'tripo';
export type GenerateMode = 'text' | 'image';

export interface GenerateOptions {
  provider?: GenerateProvider; // default 'meshy'
  mode?: GenerateMode; // default 'text'
  prompt?: string; // text mode, max 800 chars (Meshy) / 1024 (Tripo)
  image_url?: string; // image mode: public URL, or data URI for Meshy
  image_base64?: string; // image mode: raw base64 (or data URI); converted to a Meshy data URI
  texture?: boolean; // default true: textured model (Meshy: preview + refine)
  target_polycount?: number; // Meshy: 100-300000, default 30000
  target_size?: number; // metres, longest side after import normalisation; default 1.0
  timeout_seconds?: number; // poll budget; default 600
  poll_interval_seconds?: number; // default 10 (Meshy) / 5 (Tripo)
  api_key?: string; // overrides the env var (tests only); never logged
}

export interface GenerateResult {
  success: boolean;
  provider?: GenerateProvider;
  mode?: GenerateMode;
  task_id?: string;
  preview_task_id?: string;
  output_path?: string; // local .blend with the imported, normalised model
  glb_path?: string; // downloaded GLB
  progress?: number;
  credits_note?: string;
  error?: string;
  generation_available?: boolean;
}

/** Minimal fetch shape used by the poller (injectable for tests). */
export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null };
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Request builders (pure — no network, fully unit-testable)
// ---------------------------------------------------------------------------

export function buildMeshyTextRequest(prompt: string, opts: GenerateOptions): Record<string, unknown> {
  if (!prompt || prompt.length > 800) {
    throw new Error('Meshy text-to-3D prompt is required and must be <= 800 characters.');
  }
  return {
    mode: 'preview',
    prompt,
    ai_model: 'latest',
    target_polycount: opts.target_polycount ?? 30000,
    target_formats: ['glb'],
    auto_size: true,
    origin_at: 'bottom',
  };
}

export function buildMeshyRefineRequest(previewTaskId: string, opts: GenerateOptions): Record<string, unknown> {
  return {
    mode: 'refine',
    preview_task_id: previewTaskId,
    enable_pbr: true,
    texture_resolution: '2k',
    target_formats: ['glb'],
    auto_size: true,
    origin_at: 'bottom',
  };
}

export function buildMeshyImageRequest(opts: GenerateOptions): Record<string, unknown> {
  const imageUrl = opts.image_url
    || (opts.image_base64
      ? (opts.image_base64.startsWith('data:') ? opts.image_base64 : `data:image/png;base64,${opts.image_base64}`)
      : undefined);
  if (!imageUrl) {
    throw new Error('Meshy image-to-3D needs image_url (public URL or data URI) or image_base64.');
  }
  return {
    image_url: imageUrl,
    should_texture: opts.texture !== false,
    enable_pbr: true,
    target_polycount: opts.target_polycount ?? 30000,
    target_formats: ['glb'],
    auto_size: true,
    origin_at: 'bottom',
  };
}

export function buildTripoTextRequest(prompt: string, opts: GenerateOptions): Record<string, unknown> {
  if (!prompt || prompt.length > 1024) {
    throw new Error('Tripo text-to-3D prompt is required and must be <= 1024 characters.');
  }
  return {
    prompt,
    model: 'v3.1-20260211',
    texture: opts.texture !== false,
    pbr: true,
    auto_size: true,
  };
}

export function buildTripoImageRequest(opts: GenerateOptions): Record<string, unknown> {
  if (!opts.image_url) {
    throw new Error('Tripo image-to-3D needs image_url (a public URL).');
  }
  return {
    input: opts.image_url,
    model: 'v3.1-20260211',
    texture: opts.texture !== false,
    pbr: true,
    auto_size: true,
  };
}

/** Terminal-state helpers (a rescheduled Meshy task can go back to PENDING — not an error). */
export function isMeshyTerminal(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELED';
}
export function isTripoTerminal(status: string): boolean {
  return ['success', 'failed', 'cancelled', 'banned', 'expired'].includes(status);
}

/** GLB URL out of a SUCCEEDED Meshy task object (a missing key = not generated). */
export function extractMeshyGlb(task: Record<string, unknown>): string | null {
  const urls = task.model_urls as Record<string, string> | undefined;
  return urls?.glb ?? null;
}

/** GLB URL out of a successful Tripo task object. */
export function extractTripoGlb(task: Record<string, unknown>): string | null {
  const output = task.output as Record<string, string> | undefined;
  return output?.model_url ?? null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function postJson(fetchFn: FetchFn, url: string, apiKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const code = res.status;
    if (code === 401) throw new Error('Generation API rejected the key (HTTP 401). Check MESHY_API_KEY / TRIPO_API_KEY.');
    if (code === 402) throw new Error('Generation API: insufficient credits or Free plan (HTTP 402). Meshy API access needs a paid plan; the Free plan is web-only.');
    if (code === 429) throw new Error('Generation API rate-limited (HTTP 429). Wait and retry.');
    throw new Error(`Generation API request failed (HTTP ${code}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function getJson(fetchFn: FetchFn, url: string, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { method: 'GET', headers: authHeaders(apiKey) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Generation API poll failed (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function downloadGlb(fetchFn: FetchFn, url: string, destPath: string, writeFile: (p: string, d: Buffer) => void): Promise<void> {
  const res = await fetchFn(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status}). The download URL may have expired — re-run generate_3d.`);
  writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Pollers (submit -> poll -> download). fetchFn injectable for tests.
// ---------------------------------------------------------------------------

export interface PollOutcome {
  task: Record<string, unknown>;
  glb_url: string;
  progress: number;
}

/** Poll a Meshy task until terminal or the timeout budget is exhausted. */
export async function pollMeshyTask(
  fetchFn: FetchFn,
  apiKey: string,
  endpoint: string,
  taskId: string,
  opts: GenerateOptions,
): Promise<PollOutcome> {
  const deadline = Date.now() + (opts.timeout_seconds ?? 600) * 1000;
  const interval = (opts.poll_interval_seconds ?? 10) * 1000;
  let last: Record<string, unknown> = {};
  for (;;) {
    const task = await getJson(fetchFn, `${MESHY_BASE_URL}${endpoint}/${taskId}`, apiKey);
    last = task;
    const status = String(task.status ?? '');
    if (status === 'SUCCEEDED') {
      const glb = extractMeshyGlb(task);
      if (!glb) throw new Error('Meshy task SUCCEEDED but returned no GLB URL (model_urls.glb missing).');
      return { task, glb_url: glb, progress: 100 };
    }
    if (status === 'FAILED') {
      const err = task.task_error as Record<string, unknown> | undefined;
      throw new Error(`Meshy generation FAILED${err?.message ? `: ${err.message}` : ''}. Credits are refunded for FAILED tasks.`);
    }
    if (status === 'CANCELED') throw new Error('Meshy generation was CANCELED.');
    if (Date.now() > deadline) {
      throw new Error(`Meshy generation timed out after ${opts.timeout_seconds ?? 600}s (task ${taskId}, last status ${status}). The task is NOT cancelled — keep the task ID and poll again later instead of paying for a second generation.`);
    }
    await sleep(interval);
  }
}

/** Poll a Tripo task until terminal; download the GLB inside the poll loop (URL expires in 5 min). */
export async function pollTripoTask(
  fetchFn: FetchFn,
  apiKey: string,
  taskId: string,
  opts: GenerateOptions,
  download: (url: string) => Promise<string>,
): Promise<PollOutcome> {
  const deadline = Date.now() + (opts.timeout_seconds ?? 600) * 1000;
  const interval = (opts.poll_interval_seconds ?? 5) * 1000;
  for (;;) {
    const task = await getJson(fetchFn, `${TRIPO_BASE_URL}/tasks/${taskId}`, apiKey);
    const status = String(task.status ?? '');
    if (status === 'success') {
      const glb = extractTripoGlb(task);
      if (!glb) throw new Error('Tripo task succeeded but returned no model URL (output.model_url missing).');
      // Download NOW: the URL expires in 5 minutes. Never store the URL as the asset.
      const localPath = await download(glb);
      return { task, glb_url: localPath, progress: 100 };
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(status)) {
      throw new Error(`Tripo generation ${status}: ${String(task.error_message ?? task.error_code ?? 'no detail')}.`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Tripo generation timed out after ${opts.timeout_seconds ?? 600}s (task ${taskId}, last status ${status}). Keep the task ID and poll again instead of paying for a second generation.`);
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// Full job: submit -> poll -> download GLB -> return paths for import.
// The caller (index.ts) imports the GLB via the existing import path and
// normalises it (longest side -> target_size, origin at bottom, min z = 0).
// ---------------------------------------------------------------------------

export async function runGenerate3d(
  fetchFn: FetchFn,
  opts: GenerateOptions,
  paths: { tempDir: string; glbName: string },
  writeFile: (p: string, d: Buffer) => void,
): Promise<GenerateResult> {
  const provider: GenerateProvider = opts.provider ?? 'meshy';
  const mode: GenerateMode = opts.mode ?? 'text';
  const envVar = provider === 'meshy' ? 'MESHY_API_KEY' : 'TRIPO_API_KEY';
  const apiKey = opts.api_key ?? process.env[envVar] ?? '';
  if (!apiKey) {
    return {
      success: false,
      provider,
      mode,
      generation_available: false,
      error:
        `No ${envVar} is configured, so AI 3D generation is not available. ` +
        `Set ${envVar} to your own ${provider === 'meshy' ? 'Meshy' : 'Tripo'} API key ` +
        `(a paid plan is required for API access — Meshy's Free plan is web-only) and call generate_3d again. ` +
        `Without a key the free local path still works: research_model -> build_from_spec / execute_blender_code -> render_model. ` +
        `No key is ever baked into source; keys come from environment variables only.`,
    };
  }

  const glbPath = `${paths.tempDir}/${paths.glbName}.glb`;
  try {
    if (provider === 'meshy') {
      if (mode === 'text') {
        const created = await postJson(fetchFn, `${MESHY_BASE_URL}/v2/text-to-3d`, apiKey, buildMeshyTextRequest(opts.prompt ?? '', opts));
        const previewId = String(created.result ?? '');
        if (!previewId) throw new Error('Meshy did not return a task ID (result field missing).');
        const preview = await pollMeshyTask(fetchFn, apiKey, '/v2/text-to-3d', previewId, opts);
        if (opts.texture === false) {
          await downloadGlb(fetchFn, preview.glb_url, glbPath, writeFile);
          return { success: true, provider, mode, task_id: previewId, preview_task_id: previewId, glb_path: glbPath, progress: 100, credits_note: 'Meshy mesh-only preview: 20 credits (meshy-7.1) / 5 credits (meshy-6-lite). No texture step was run.' };
        }
        const refined = await postJson(fetchFn, `${MESHY_BASE_URL}/v2/text-to-3d`, apiKey, buildMeshyRefineRequest(previewId, opts));
        const refineId = String(refined.result ?? '');
        if (!refineId) throw new Error('Meshy refine did not return a task ID.');
        const done = await pollMeshyTask(fetchFn, apiKey, '/v2/text-to-3d', refineId, opts);
        await downloadGlb(fetchFn, done.glb_url, glbPath, writeFile);
        return { success: true, provider, mode, task_id: refineId, preview_task_id: previewId, glb_path: glbPath, progress: 100, credits_note: 'Meshy textured model: 20 preview + 10 refine = 30 credits (meshy-7.1, 2K textures).' };
      }
      const created = await postJson(fetchFn, `${MESHY_BASE_URL}/v1/image-to-3d`, apiKey, buildMeshyImageRequest(opts));
      const taskId = String(created.result ?? '');
      if (!taskId) throw new Error('Meshy did not return a task ID (result field missing).');
      const done = await pollMeshyTask(fetchFn, apiKey, '/v1/image-to-3d', taskId, opts);
      await downloadGlb(fetchFn, done.glb_url, glbPath, writeFile);
      return { success: true, provider, mode, task_id: taskId, glb_path: glbPath, progress: 100, credits_note: 'Meshy image-to-3D textured model: 30 credits (meshy-7.1, 2K textures). Assets are kept only 3 days — the GLB is already downloaded locally.' };
    }

    // Tripo
    const endpoint = mode === 'text' ? '/generation/text-to-model' : '/generation/image-to-model';
    const body = mode === 'text' ? buildTripoTextRequest(opts.prompt ?? '', opts) : buildTripoImageRequest(opts);
    const created = await postJson(fetchFn, `${TRIPO_BASE_URL}${endpoint}`, apiKey, body);
    const taskId = String((created as Record<string, unknown>).task_id ?? (created.data as Record<string, unknown> | undefined)?.task_id ?? '');
    if (!taskId) throw new Error('Tripo did not return a task_id.');
    const done = await pollTripoTask(fetchFn, apiKey, taskId, opts, async (url) => {
      await downloadGlb(fetchFn, url, glbPath, writeFile);
      return glbPath;
    });
    void done;
    return { success: true, provider, mode, task_id: taskId, glb_path: glbPath, progress: 100, credits_note: `Tripo ${mode === 'text' ? 'text' : 'image'}-to-3D textured model: ${mode === 'text' ? '$0.20 (20 credits)' : '$0.30 (30 credits)'} at $0.01/credit. The GLB was downloaded immediately — its URL expires in 5 minutes.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, provider, mode, generation_available: true, error: message };
  }
}
