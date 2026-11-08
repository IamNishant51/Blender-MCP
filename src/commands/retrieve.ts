/**
 * Free real-asset retrieval (Blender-MCP 1.3.0 fix round) — `retrieve_asset`.
 *
 * TS mirror of blender_mcp/retrieve.py. Poly Haven models are CC0, no key,
 * direct downloads. Poly Pizza search returns HTTP 401 without a key since
 * 2026-11-08 — it is supported only with the user's own POLY_PIZZA_API_KEY
 * env var, otherwise the tool says so honestly. Downloads prefer the 1k
 * glTF package: Blender 4.2 imports glTF natively, and the .blend downloads
 * Poly Haven serves are Zstd-compressed, which Blender 4.2.0's library
 * loader rejects ("not a blend file", verified 2026-11-08).
 *
 * Verified retrieval (2026-11-08): `digital_wrist_watch` (Poly Haven, CC0)
 * is the smartwatch product. Poly Haven has NO fitting headphones / sneaker /
 * perfume-bottle model (full 521-model catalogue searched); those three are
 * rebuilt procedurally in products.ts.
 */

import { createHash } from 'crypto';

export const POLYHAVEN_API = 'https://api.polyhaven.com';
export const POLYHAVEN_LICENCE = 'CC0';
export const POLYHAVEN_USER_AGENT = 'blender-mcp/1.3.0 (https://github.com/IamNishant51/Blender-MCP)';
export const POLYPIZZA_API = 'https://api.poly.pizza/v1.1';

export interface KnownGoodAsset {
  slug: string;
  source: string;
  licence: string;
  url: string;
  format: string;
  resolution: string;
  description: string;
}

export const KNOWN_GOOD_ASSETS: Record<string, KnownGoodAsset> = {
  smartwatch: {
    slug: 'digital_wrist_watch',
    source: 'polyhaven',
    licence: 'CC0',
    url: 'https://polyhaven.com/a/digital_wrist_watch',
    format: 'gltf',
    resolution: '1k',
    description: 'Vintage digital wristwatch, brushed-steel bracelet, octagonal case, LCD readout.',
  },
};

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export interface RetrieveOptions {
  product?: string;
  query?: string;
  source?: string;
  resolution?: string;
}

/** Filter a `GET /assets?t=models` catalogue by keyword (pure, testable). */
export function searchPolyhavenCatalogue(
  catalogue: Record<string, { name?: string }>,
  query: string,
): string[] {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  return Object.entries(catalogue)
    .filter(([slug, info]) => {
      const hay = `${slug} ${info?.name ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map(([slug]) => slug);
}

/** Pick the glTF download plan out of a `GET /files/<slug>` response. */
export function pickPolyhavenGltfPackage(
  files: Record<string, unknown>,
  resolution = '1k',
): { main: Record<string, unknown>; include: Record<string, Record<string, unknown>> } {
  const gltf = (files.gltf ?? {}) as Record<string, Record<string, unknown>>;
  const res = gltf[resolution];
  if (!res || typeof res !== 'object') {
    const available = Object.keys(gltf).sort();
    throw new Error(
      `No glTF package at ${resolution} for this asset`
      + (available.length > 0 ? ` (available: ${available.join(', ')})` : '')
      + '. Try another resolution.',
    );
  }
  const main = res.gltf as Record<string, unknown> | undefined;
  if (!main || typeof main.url !== 'string') {
    throw new Error('glTF package has no main .gltf download URL.');
  }
  // NOTE: `include` is nested INSIDE the main entry (res["gltf"]
  // ["include"]), not a sibling of it — the first version of this code
  // read res["include"], downloaded only the .gltf, and Blender then
  // failed the import with "Missing resource, '<slug>.bin'".
  return { main, include: (main.include ?? {}) as Record<string, Record<string, unknown>> };
}

/** Honest status for a Poly Pizza search attempt (401 without a key). */
export function polyPizzaSearchStatus(apiKey?: string): [boolean, string] {
  const key = apiKey ?? process.env.POLY_PIZZA_API_KEY ?? '';
  if (!key) {
    return [false,
      'Poly Pizza search needs an API key since at least 2026-11-08 '
      + '(GET /v1.1/search returns HTTP 401 without one). No key is '
      + 'configured (POLY_PIZZA_API_KEY), so Poly Pizza was not searched. '
      + 'Poly Haven (CC0, no key) was searched instead.'];
  }
  return [true, 'Poly Pizza API key is configured.'];
}

function verifySizeAndMd5(buf: Buffer, expected: Record<string, unknown> | undefined): void {
  if (!expected) return;
  if (typeof expected.size === 'number' && buf.length !== expected.size) {
    throw new Error(`Download size mismatch: got ${buf.length}, expected ${expected.size}.`);
  }
  if (typeof expected.md5 === 'string') {
    const digest = createHash('md5').update(buf).digest('hex');
    if (digest !== expected.md5) throw new Error('Download md5 mismatch.');
  }
}

/**
 * Retrieve a free real asset. `fetchFn` / `writeFile` / `mkdir` are
 * injectable for tests; the caller passes the real ones.
 */
export async function retrieveAsset(
  opts: RetrieveOptions,
  cacheDir: string,
  fetchFn: FetchFn,
  writeFile: (p: string, d: Buffer) => void,
  mkdir: (p: string) => void,
): Promise<Record<string, unknown>> {
  const product = (opts.product || '').toLowerCase().trim();
  const query = opts.query || product;
  const source = (opts.source || 'polyhaven').toLowerCase().trim();
  const resolution = opts.resolution || '1k';

  if (source === 'poly_pizza') {
    const [ok, message] = polyPizzaSearchStatus();
    return { success: false, source: 'poly_pizza', retrieval_available: ok, error: message };
  }

  const known = product ? KNOWN_GOOD_ASSETS[product] : undefined;
  let slug: string;
  if (known) {
    slug = known.slug;
  } else {
    if (!query) {
      return { success: false, source: 'polyhaven', error: 'retrieve_asset needs a product or a query to search for.' };
    }
    let catalogue: Record<string, { name?: string }>;
    try {
      const res = await fetchFn(`${POLYHAVEN_API}/assets?t=models`, { headers: { 'User-Agent': POLYHAVEN_USER_AGENT } });
      if (!res.ok) throw new Error(`Poly Haven request failed (HTTP ${res.status}).`);
      catalogue = (await res.json()) as Record<string, { name?: string }>;
    } catch (e) {
      return { success: false, source: 'polyhaven', error: String(e) };
    }
    const matches = searchPolyhavenCatalogue(catalogue, query);
    if (matches.length === 0) {
      return { success: false, source: 'polyhaven', query, error: `No Poly Haven model matches '${query}'. Rebuild procedurally (build_product) instead of using a wrong asset.` };
    }
    slug = matches[0];
  }

  let plan: ReturnType<typeof pickPolyhavenGltfPackage>;
  try {
    const res = await fetchFn(`${POLYHAVEN_API}/files/${slug}`, { headers: { 'User-Agent': POLYHAVEN_USER_AGENT } });
    if (!res.ok) throw new Error(`Poly Haven request failed (HTTP ${res.status}): /files/${slug}`);
    plan = pickPolyhavenGltfPackage((await res.json()) as Record<string, unknown>, resolution);
  } catch (e) {
    return { success: false, source: 'polyhaven', slug, error: String(e) };
  }

  const dest = `${cacheDir}/${slug}`;
  mkdir(dest);
  const mainName = String(plan.main.url).split('/').pop() as string;
  const downloaded: string[] = [];
  try {
    const downloadOne = async (url: string, target: string, expected?: Record<string, unknown>): Promise<void> => {
      const res = await fetchFn(url, { headers: { 'User-Agent': POLYHAVEN_USER_AGENT } });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      verifySizeAndMd5(buf, expected);
      writeFile(target, buf);
      downloaded.push(target);
    };
    await downloadOne(String(plan.main.url), `${dest}/${mainName}`, plan.main);
    for (const [rel, entry] of Object.entries(plan.include)) {
      const dir = `${dest}/${rel.split('/').slice(0, -1).join('/')}`;
      if (dir !== dest) mkdir(dir);
      await downloadOne(String(entry.url), `${dest}/${rel}`, entry);
    }
  } catch (e) {
    return { success: false, source: 'polyhaven', slug, error: `Download failed: ${String(e)}` };
  }

  const asset: Record<string, unknown> = {
    slug,
    source: 'polyhaven',
    licence: POLYHAVEN_LICENCE,
    source_url: `https://polyhaven.com/a/${slug}`,
    format: 'gltf',
    resolution,
    gltf_path: `${dest}/${mainName}`,
    files: downloaded,
  };
  if (known) asset.description = known.description;
  return { success: true, asset };
}
