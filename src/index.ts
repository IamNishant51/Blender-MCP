/**
 * Blender MCP Server - Main entry point
 * Connects AI assistants to Blender for 3D creation
 *
 * Simplified stdio implementation without external SDK dependency
 */

import { createLogger } from './utils/logger.js';
import { config, type ServerConfig } from './config/index.js';
import { SearchService } from './commands/search.js';
import {
  ModelBuilder,
  getMaterialScript,
  getSmartUVScript,
  buildPolyhavenMaterialScript,
  pickPolyhavenMaps,
  POLYHAVEN_API,
  POLYHAVEN_USER_AGENT,
  POLYHAVEN_LICENCE,
  type ModelResult,
  type PolyHavenMaps,
} from './commands/model.js';
import { generateModelScript } from './commands/generators.js';
import { buildFromSpec } from './commands/spec.js';
import { buildImportScript, IMPORT_OPERATORS, SUPPORTED_IMPORT_FORMATS } from './commands/import.js';
import { buildRenderScript, type RenderOptions } from './commands/render.js';
import {
  runGenerate3d,
  type FetchFn,
  type GenerateOptions,
  type GenerateProvider,
} from './commands/generate.js';
import { getDetailScript, DETAIL_TYPES } from './commands/details.js';
import { getProductScript, getRetrievedProductScript, PRODUCTS } from './commands/products.js';
import { retrieveAsset, type RetrieveOptions } from './commands/retrieve.js';
import {
  buildCritiqueScript,
  parseCritiqueJson,
  buildCritiquePrompt,
  MAX_REFINE_ROUNDS,
  CRITIQUE_NOTE,
  type CritiqueCheck,
} from './commands/critique.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { join } from 'path';

/** Minimal PNG decode check (magic + IHDR + IDAT inflate). No image library needed. */
function pngDecodes(pngPath: string): boolean {
  try {
    const buf = readFileSync(pngPath);
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return false;
    let offset = 8;
    const idat: Buffer[] = [];
    let sawIhdr = false;
    while (offset + 8 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      if (type === 'IHDR') sawIhdr = true;
      if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + len));
      if (type === 'IEND') break;
      offset += 12 + len;
    }
    if (!sawIhdr || idat.length === 0) return false;
    inflateSync(Buffer.concat(idat));
    return true;
  } catch {
    return false;
  }
}

interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class BlenderMCPServer {
  private config: ServerConfig;
  private logger = createLogger('server', config.debug);
  private searchService: SearchService;
  private modelBuilder: ModelBuilder;
  private requestId = 1;

  constructor(cfg?: Partial<ServerConfig>) {
    this.config = { ...config, ...cfg };
    this.logger.info(`Starting Blender MCP Server v${this.config.version}`);

    // Initialize services
    this.searchService = new SearchService(this.config.search);
    this.modelBuilder = new ModelBuilder(this.config.blender, this.config.paths);
  }

  private getToolsList(): unknown {
    return {
      tools: [
        {
          name: 'research_model',
          description: 'RESEARCH FIRST: Research a model before any code is written. Runs the model/texture search and returns top references (name, source, url) plus the part-breakdown schema. PREFER A REAL ASSET OVER PRIMITIVES: if a Poly Haven / Sketchfab / Poly Pizza asset in the results fits the request, the result names it as recommended_path — import it with import_from_url instead of modelling from primitives. Optional reference_image (local path or URL): with a generation key (MESHY_API_KEY / TRIPO_API_KEY) it drives image-to-3D via generate_3d (route A); without one it is the visual reference the spec is built from — parts, proportions, colours, materials recorded in the spec (route B). Use the references to work out the real parts and dimensions, then produce a JSON scene spec and call build_from_spec. No code is written before this step.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to model, e.g. "Bajaj auto rickshaw" or "Indian thali"' },
              reference_image: { type: 'string', description: 'Optional reference image: local file path or public URL. With a generation key it drives image-to-3D; without one it is the visual reference for the spec.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'build_from_spec',
          description: 'BUILD FROM SPEC: Build a scene from a JSON scene spec {objects: [{name, kind, size_m, position_m, rotation_deg, material, attach}]}. Conventions: position_m is the BOTTOM-CENTRE of the object, sizes in metres, Z-up, ground z = 0; kind is cube/sphere/cylinder/cone/torus; attach is a mate (grounded, on_top_of:<name>, centred_on:<name>) solved from the parent bounding box. The spec is validated first (sizes > 0, z >= 0, inside a 10 m work area, mates must touch within 0.05 m); on failure the exact failed checks are returned and nothing is built. On success returns object names, bounding boxes and min z.',
          inputSchema: {
            type: 'object',
            properties: {
              spec: { description: 'Scene spec object, or a JSON string of one' },
            },
            required: ['spec'],
          },
        },
        {
          name: 'render_model',
          description: 'RENDER / LOOK: Render a saved .blend with the presentation preset (camera auto-framed on the bounding-box centre, 3-point + rim area-light rig, sun + world light, ground plane) as PNGs, one per view. Engine EEVEE (default, fast previews) or CYCLES (final stills: CPU path tracer, 128-256 samples + OpenImageDenoise, Khronos PBR Neutral for catalogue shots / AgX for hero shots). Optional studio HDRI via hdri "polyhaven:<slug>" (CC0, verified licence; falls back to world+sun if the download fails), transparent-background product shots (Cycles Shadow Catcher + Film Transparent; EEVEE has no shadow catcher), turntable_frames (extra orbit frames, exactly 360 deg about Z). Lens: 50 mm default, 85 mm hero, 90-105 mm macro. Every PNG is verified to exist on disk and be non-empty before success is reported — a missing/empty PNG returns success:false, never success:true. Returns the PNG paths and file sizes.',
          inputSchema: {
            type: 'object',
            properties: {
              blend_path: { type: 'string', description: 'Path to the .blend file to render' },
              output_path: { type: 'string', description: 'Output file prefix; each view renders to <prefix>_<view>.png' },
              views: { type: 'array', items: { type: 'string' }, description: 'Views to render (default ["front","side","perspective"]); allowed: front, side, back, top, perspective' },
              engine: { type: 'string', description: 'EEVEE (default) or CYCLES (final stills)' },
              samples: { type: 'number', description: 'Cycles samples; default 128 (keep 128-256 on CPU)' },
              view_transform: { type: 'string', description: 'Khronos PBR Neutral (catalogue) or AgX (hero)' },
              lens: { type: 'number', description: 'Camera lens in mm; 50 default, 85 hero, 90-105 macro' },
              fill_fraction: { type: 'number', description: 'Fraction of the frame the subject fills on its binding axis; default 0.7 (exact fill-based framing — the old distance heuristic rendered small products tiny)' },
              transparent: { type: 'boolean', description: 'Transparent background product shot (Cycles shadow catcher)' },
              turntable_frames: { type: 'number', description: 'Extra orbit frames (0 = off); renders <prefix>_turntable_<nn>.png' },
              resolution: { type: 'array', items: { type: 'number' }, description: 'Resolution [width, height]; default EEVEE [960,720], Cycles [1280,720]' },
              hdri: { type: 'string', description: 'Studio HDRI: "polyhaven:<slug>" (CC0, auto-downloaded) or a local .hdr/.exr path. Empty = world+sun fallback.' },
            },
            required: ['blend_path', 'output_path'],
          },
        },
        {
          name: 'generate_3d',
          description: 'AI GENERATION (Meshy first, Tripo second): generate a textured 3D model from a text prompt or a reference image, then import it normalised (longest side = target_size, origin at bottom, min z = 0). Needs the user\'s own API key from env var MESHY_API_KEY (Meshy) or TRIPO_API_KEY (Tripo) — never baked into source. NO KEY = the tool says so honestly and points at the free local path (research_model -> build_from_spec / execute_blender_code); it never fails silently and never invents a model. Meshy text-to-3D is two billed steps (preview 20 credits + refine 10 = 30 for a textured model; texture:false stops after the mesh-only preview); Meshy image-to-3D is 30 credits; assets are kept only 3 days so the GLB is downloaded immediately. Tripo: text $0.20 / image $0.30 textured; its GLB URL expires in 5 minutes so it is downloaded inside the poll loop. No provider states a GLB up-axis — orientation/scale are verified in Blender on import. Hunyuan3D / Rodin are not implemented (see README).',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Text prompt (text mode). Meshy max 800 chars, Tripo max 1024.' },
              image_url: { type: 'string', description: 'Image mode: public image URL (Meshy also accepts a data URI here).' },
              image_base64: { type: 'string', description: 'Image mode (Meshy only): raw base64 image data, or a data:image/...;base64,... URI.' },
              provider: { type: 'string', description: 'meshy (default) or tripo' },
              texture: { type: 'boolean', description: 'Textured model (default true). Meshy text mode with texture:false stops after the mesh-only preview draft.' },
              target_size: { type: 'number', description: 'Longest side in metres after import normalisation; default 1.0' },
              target_polycount: { type: 'number', description: 'Meshy target polycount, 100-300000, default 30000' },
              timeout_seconds: { type: 'number', description: 'Poll budget in seconds; default 600. A timeout does NOT cancel the provider task — keep the task_id and poll again.' },
            },
            required: [],
          },
        },
        {
          name: 'retrieve_asset',
          description: 'FREE REAL-ASSET RETRIEVAL: try a real model before building from primitives. Searches Poly Haven (CC0, no key, direct downloads) by product or query and downloads the 1k glTF package into the asset cache. Known good: smartwatch -> Poly Haven \'digital_wrist_watch\' (vintage digital watch, CC0). Poly Pizza search needs the user\'s own POLY_PIZZA_API_KEY env var (its search endpoint returns HTTP 401 without a key since 2026-11-08) — without one the tool says so honestly and Poly Haven is searched instead. No account is ever created. Assets are never committed to the repo (binary files cannot go through snapshot-push). On success returns the glTF path + licence + source URL; import it with build_product (source \'retrieved\') or import_from_url. On failure it says exactly why — use build_product (procedural) instead of a wrong asset.',
          inputSchema: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Product with a known good asset, e.g. \'smartwatch\'' },
              query: { type: 'string', description: 'Free-text search, e.g. \'headphones\' (Poly Haven catalogue)' },
              source: { type: 'string', description: 'polyhaven (default) or poly_pizza (needs POLY_PIZZA_API_KEY)' },
              resolution: { type: 'string', description: 'Download resolution; default \'1k\'' },
            },
            required: [],
          },
        },
        {
          name: 'build_product',
          description: 'PROPER PRODUCT BUILD: build one of the catalogue products with real curves, not stacked primitives — headphones (arched band + padded cups), sneaker (lofted sole with toe spring + bezier laces through eyelets), perfume (bevelled glass, seated gold cap, NOIR label), smartwatch (bevelled case, real dial with markers + hands, curved strap). Source \'auto\' (default) prefers a retrieved real asset for products that have one (smartwatch -> Poly Haven CC0 digital watch) and falls back to the procedural builder with a note; \'procedural\' forces the builder; \'retrieved\' fails if no asset is available. Returns the saved .blend path, object names, bounding boxes and min z.',
          inputSchema: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Product to build: headphones, sneaker, perfume, smartwatch' },
              source: { type: 'string', description: 'auto (default), procedural, or retrieved' },
              target_size: { type: 'number', description: 'Retrieved assets only: longest side in metres after normalisation; default 0.22' },
            },
            required: ['product'],
          },
        },
        {
          name: 'add_detail',
          description: 'DETAIL HELPERS: apply one manufactured detail to a target object in a saved .blend (or the current build): ' + DETAIL_TYPES.map((d) => `${d.kind} (${d.description})`).join(' ') + ' Details are real geometry/modifiers, not descriptions — they run in Blender 4.2.0. Use after the base build, before the final render; combine several calls for a manufactured look (bevel + panel lines + screws + label).',
          inputSchema: {
            type: 'object',
            properties: {
              detail: { type: 'string', description: 'Detail kind: bevel, subdivision, panel_line, screw, bolt, seam, grille, label' },
              target: { type: 'string', description: 'Object name (substring match) to apply the detail to' },
              params: { type: 'object', description: 'Detail parameters (see the tool description for each kind)' },
              blend_path: { type: 'string', description: 'Optional .blend file to open first; without it the detail is applied to an empty scene and fails' },
            },
            required: ['detail', 'target'],
          },
        },
        {
          name: 'critique_model',
          description: 'VISION CRITIQUE LOOP: render 5 views of a saved .blend (front 3/4, side, back, top, close-up), run programmatic checks (PNG exists and decodes, every spec part present, min z >= 0, parts connected/grounded, dimensions vs spec), and return the views plus a structured critique prompt. HONEST LIMIT: this MCP cannot see images — YOU, the calling model, are the critic: look at the rendered PNGs and fill in the per-spec-item pass/fail, problem->fix pairs (concrete operations on named parts), 8-dimension scores and the dual Yes/No gate from the prompt template. Then apply fixes as LOCALISED EDITS (add_detail / execute_blender_code on the same build, never a rebuild), re-render, and verify per fix (applied / not applied / regressed). Max 3 auto-refine rounds; keep the best render + code and REVERT if a round makes things worse. refine_round tracks the round (1-3).',
          inputSchema: {
            type: 'object',
            properties: {
              blend_path: { type: 'string', description: 'Path to the .blend file to critique' },
              spec: { type: 'object', description: 'Optional scene spec {objects: [{name, size_m, material}]} — the contract the critique checks against' },
              output_path: { type: 'string', description: 'Render output prefix; defaults to <blend>_critique' },
              refine_round: { type: 'number', description: 'Auto-refine round number, 1-3 (default 1)' },
              engine: { type: 'string', description: 'Render engine for the critique views: EEVEE (default, fast) or CYCLES' },
            },
            required: ['blend_path'],
          },
        },
        {
          name: 'create_complex_model',
          description: 'CREATE: Build complex 3D models with internet search + detailed planning. Built-in templates only: temple/mandir, auto-rickshaw/vehicle, thali/food, haveli/palace/building, person/human/character. For anything else use execute_blender_code.',
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What to create' },
              customization: { type: 'string', description: 'Customize: colors, materials, scale' },
            },
            required: ['description'],
          },
        },
        {
          name: 'execute_blender_code',
          description: 'CODE: Run arbitrary Blender Python (bpy) code in a headless Blender and save the resulting scene. Use this for ANY model that is not one of the five built-in templates (temple/mandir, auto-rickshaw/vehicle, thali/food, haveli/palace/building, person/human/character). Write Z-up code: Z is height, ground is z = 0, all dimensions in metres, every part\'s lowest point at z >= 0. The script runs in a fresh empty scene; the result includes Blender\'s stdout/stderr and the output .blend path. Fix errors from the returned stderr and call again.',
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Blender Python code using bpy (imports bpy itself if needed)' },
            },
            required: ['code'],
          },
        },
        {
          name: 'modify_model',
          description: 'MODIFY: Change existing 3D model.',
          inputSchema: {
            type: 'object',
            properties: {
              existing_model: { type: 'string', description: 'Path to existing .blend file' },
              modifications: { type: 'string', description: 'Changes to apply' },
            },
            required: ['modifications'],
          },
        },
        {
          name: 'apply_texture',
          description: 'TEXTURE: Apply materials to 3D models.',
          inputSchema: {
            type: 'object',
            properties: {
              texture_type: { type: 'string', description: 'Texture type, or polyhaven:<slug> for a real Poly Haven texture' },
              object_name: { type: 'string', description: 'Object to apply to' },
              blend_path: { type: 'string', description: 'Optional .blend file to open first; without it the material is created but applied to nothing' },
            },
            required: ['texture_type'],
          },
        },
        {
          name: 'search_models',
          description: 'SEARCH: Search for 3D models.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to search for' },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_textures',
          description: 'SEARCH TEXTURES: Search for textures.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What texture to find' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_scene_info',
          description: 'Get current scene information',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'import_from_url',
          description: 'Import 3D model from URL',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to 3D model file' },
              name: { type: 'string', description: 'Model name' },
            },
            required: ['url'],
          },
        },
      ],
    };
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'research_model':
        return this.researchModel(args);

      case 'build_from_spec':
        return this.buildFromSpecTool(args);

      case 'render_model':
        return this.renderModel(args);

      case 'generate_3d':
        return this.generate3d(args);

      case 'retrieve_asset':
        return this.retrieveAssetTool(args);

      case 'build_product':
        return this.buildProduct(args);

      case 'add_detail':
        return this.addDetail(args);

      case 'critique_model':
        return this.critiqueModel(args);

      case 'search_models':
        return this.searchService.searchModels(args.query as string);

      case 'search_textures':
        const textureResults = await this.searchService.searchTextures(args.query as string);
        return { success: true, found: textureResults.length, results: textureResults };

      case 'create_complex_model':
        return this.createModel(args);

      case 'execute_blender_code':
        return this.executeBlenderCode(args);

      case 'modify_model':
        return this.modifyModel(args);

      case 'apply_texture':
        return this.applyTexture(args);

      case 'import_from_url':
        return this.importFromUrl(args);

      case 'get_scene_info':
        return this.getSceneInfo();

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  private async createModel(args: Record<string, unknown>): Promise<unknown> {
    const description = args.description as string;
    const customization = args.customization as string;

    this.logger.info(`Phase 1: Searching for ${description}`);
    const searchResults = await this.searchService.searchModels(description);

    this.logger.info(`Phase 2: Building model`);
    const script = generateModelScript(description, customization);
    if (!script) {
      return {
        success: false,
        description,
        customization,
        error: 'No built-in template matches this description. The built-in templates are: temple/mandir, auto-rickshaw/vehicle, thali/food, haveli/palace/building, person/human/character. For anything else, use the execute_blender_code tool with your own bpy code (Z-up, dimensions in metres, ground at z = 0), or use search_models and import_from_url to bring in an existing model.',
      };
    }
    const result = await this.modelBuilder.createMesh(script);

    return {
      success: result.success,
      description,
      customization,
      phases: {
        search: `Found ${searchResults.all_results.length} sources`,
        creation: result.success ? 'completed' : 'failed',
      },
      output: result.output || '',
      stdout: result.stdout || '',
      error: result.error || '',
    };
  }

  private async executeBlenderCode(args: Record<string, unknown>): Promise<unknown> {
    const code = (args.code as string) || '';
    if (!code.trim()) {
      return { success: false, error: 'No code supplied.' };
    }
    return this.modelBuilder.createMesh(code);
  }

  private async researchModel(args: Record<string, unknown>): Promise<unknown> {
    const query = (args.query as string) || '';
    if (!query.trim()) {
      return { success: false, error: 'No query supplied.' };
    }
    this.logger.info(`Researching model: ${query}`);
    const [modelResults, textureResults] = await Promise.all([
      this.searchService.searchModels(query),
      this.searchService.searchTextures(query),
    ]);
    const references = modelResults.all_results.slice(0, 8).map((r) => ({
      name: r.name,
      source: r.source,
      url: r.url,
    }));
    const textureReferences = textureResults.slice(0, 5).map((r) => ({
      name: r.name,
      source: r.source,
      url: r.url,
    }));

    // Prefer a real asset over primitives: a fitting Poly Haven /
    // Sketchfab / Poly Pizza asset is the recommended path.
    const assetCandidate = modelResults.all_results.find(
      (r) => r.source === 'poly_pizza' || r.source === 'sketchfab',
    ) ?? textureReferences.find((r) => r.source === 'poly_haven');
    const recommendedPath = assetCandidate
      ? {
          kind: 'import_asset',
          reason: 'A real asset beats modelling from primitives — import this first with import_from_url and check it against the spec before building anything by hand.',
          name: assetCandidate.name,
          source: assetCandidate.source,
          url: assetCandidate.url,
        }
      : {
          kind: 'model_from_primitives',
          reason: 'No fitting real asset was found in the search results, so build from a spec (research_model -> build_from_spec / execute_blender_code).',
        };

    // Reference image: route A (image-to-3D) needs a generation key,
    // route B (reference-as-spec) works without one.
    const referenceImage = (args.reference_image as string) || '';
    let reference: Record<string, unknown> | null = null;
    if (referenceImage) {
      const isUrl = /^https?:\/\//i.test(referenceImage);
      const exists = isUrl ? null : existsSync(referenceImage);
      const generationAvailable = Boolean(process.env.MESHY_API_KEY || process.env.TRIPO_API_KEY);
      reference = {
        input: referenceImage,
        kind: isUrl ? 'url' : 'local_path',
        exists,
        route: generationAvailable
          ? 'A (image-to-3D): a generation key is configured — call generate_3d with image_url / image_base64 to import a neural mesh, then critique it.'
          : 'B (reference-as-spec): no generation key is configured — extract the spec below FROM THE IMAGE (the calling model looks at it) and build procedurally; do not call generate_3d, it will report no key.',
        reference_spec_brief: {
          description: 'Look at the reference image and record: parts list with semantic names and parent/child relations; proportions as RATIOS (e.g. canopy width ~ 0.6x body width) and bounding-box fractions, not absolute guesses; palette as 3-5 dominant hex colours with which part each belongs to; per-part material feel (matte / glossy / metallic / transparent + roughness); and what the reference does NOT show (back, underside) flagged as "to be invented plausibly", so the critic does not penalise the builder for it. This spec becomes the builder brief AND the critic checklist (critique_model).',
          fields: ['parts', 'proportions_ratios', 'palette_hex', 'materials', 'unseen_sides'],
        },
        ...(isUrl ? {} : { warning: exists ? undefined : `Local file not found: ${referenceImage}. Check the path and call again.` }),
      };
    }

    return {
      success: true,
      query,
      references,
      texture_references: textureReferences,
      recommended_path: recommendedPath,
      ...(reference ? { reference_image: reference } : {}),
      part_breakdown_schema: {
        description: 'Break the subject into named parts with REAL dimensions (metres) before building. One entry per part.',
        objects: [
          {
            name: 'PartName',
            kind: 'cube | sphere | cylinder | cone | torus',
            size_m: [0.5, 0.5, 0.5],
            position_m: [0, 0, 0],
            rotation_deg: [0, 0, 0],
            material: 'wood | marble | metal | fabric | steel | glass | skin | sandstone | ...',
            attach: 'grounded | on_top_of:<ParentName> | centred_on:<ParentName>',
          },
        ],
      },
      spec_rules: [
        'position_m is the BOTTOM-CENTRE of the object; sizes in metres; Z is up; ground is z = 0.',
        'Every size must be > 0; every position.z must be >= 0.',
        'Bounding boxes must stay inside a 10 m work area (|x|, |y| <= 5, z <= 10).',
        'attach mates are solved from the parent bounding box, never guessed: on_top_of:<name> means the part sits on the parent and must touch it within 0.05 m.',
        'Use the references above for real proportions; do not invent dimensions.',
      ],
      next_step:
        'Produce a JSON scene spec in the schema above (from the references and real dimensions) and call build_from_spec with it. No code is written before this step.',
    };
  }

  private async buildFromSpecTool(args: Record<string, unknown>): Promise<unknown> {
    const spec = args.spec as unknown;
    if (spec === undefined || spec === null || spec === '') {
      return { success: false, error: 'No spec supplied. Call research_model first, then pass a scene spec object (or JSON string).' };
    }
    const { script, errors } = buildFromSpec(spec);
    if (!script) {
      return { success: false, errors, error: `Spec validation failed: ${errors.join('; ')}` };
    }
    const result = await this.modelBuilder.createMeshWithReport(script);
    return {
      success: result.success,
      output: result.output || '',
      objects: result.objects || [],
      scene_min: result.scene_min || [],
      scene_max: result.scene_max || [],
      min_z: result.min_z,
      stdout: result.stdout || '',
      error: result.error || '',
    };
  }

  /**
   * Download a Poly Haven studio HDRI (CC0 — licence verified at
   * polyhaven.com/license on 2026-11-07: all assets CC0, commercial use
   * OK, no attribution required, redistribution allowed). Returns the
   * local path, or null + reason on failure (caller falls back to the
   * world+sun setup and reports it — never a silent failure).
   */
  private async downloadPolyhavenHdri(slug: string): Promise<{ path: string | null; reason?: string }> {
    const hdriDir = join(this.config.paths.textureDir, 'hdri');
    if (!existsSync(hdriDir)) mkdirSync(hdriDir, { recursive: true });
    let files: Record<string, unknown>;
    try {
      const response = await fetch(`${POLYHAVEN_API}/files/${encodeURIComponent(slug)}`, {
        headers: { 'User-Agent': POLYHAVEN_USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { path: null, reason: `Poly Haven: no HDRI named '${slug}' (HTTP ${response.status}).` };
      files = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      return { path: null, reason: `Poly Haven API unreachable: ${error instanceof Error ? error.message : String(error)}.` };
    }
    // /files/<slug> nests resolutions under a key like "hdri": pick a 1k
    // .hdr first, then 2k .hdr, then any .exr. Shape is defensive: any
    // nested {url} ending in .hdr/.exr qualifies.
    const candidates: Array<{ url: string; score: number }> = [];
    const walk = (node: unknown, depth: number, resKey: string): void => {
      if (!node || typeof node !== 'object' || depth > 4) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).url === 'string') {
          const url = (value as Record<string, unknown>).url as string;
          const isHdr = url.toLowerCase().includes('.hdr');
          const isExr = url.toLowerCase().includes('.exr');
          if (isHdr || isExr) {
            // Prefer 1k, then 2k, then larger; .hdr over .exr.
            const resScore = resKey === '1k' ? 0 : resKey === '2k' ? 1 : resKey === '4k' ? 2 : resKey === '8k' ? 3 : 4;
            candidates.push({ url, score: resScore + (isHdr ? 0 : 10) });
          }
        } else {
          walk(value, depth + 1, /^\d+k$/.test(key) ? key : resKey);
        }
      }
    };
    walk(files, 0, '');
    if (candidates.length === 0) return { path: null, reason: `Poly Haven: no .hdr/.exr file found for HDRI '${slug}'.` };
    candidates.sort((a, b) => a.score - b.score);
    const url = candidates[0].url;
    const ext = url.toLowerCase().includes('.hdr') ? 'hdr' : 'exr';
    const localPath = join(hdriDir, `${slug}.${ext}`);
    if (existsSync(localPath)) return { path: localPath };
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': POLYHAVEN_USER_AGENT },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) return { path: null, reason: `Poly Haven HDRI download failed: HTTP ${response.status}.` };
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 100 * 1024 * 1024) return { path: null, reason: 'Poly Haven HDRI exceeds the 100 MB download cap.' };
      writeFileSync(localPath, data);
      return { path: localPath };
    } catch (error) {
      return { path: null, reason: `Poly Haven HDRI download failed: ${error instanceof Error ? error.message : String(error)}.` };
    }
  }

  private async renderModel(args: Record<string, unknown>): Promise<unknown> {
    const blendPath = (args.blend_path as string) || '';
    const outputPath = (args.output_path as string) || '';
    const views = Array.isArray(args.views) && args.views.length > 0
      ? (args.views as string[])
      : ['front', 'side', 'perspective'];
    if (!blendPath || !outputPath) {
      return { success: false, error: 'blend_path and output_path are required.' };
    }
    const options: RenderOptions = {};
    if (typeof args.engine === 'string') options.engine = args.engine as RenderOptions['engine'];
    if (typeof args.samples === 'number') options.samples = args.samples;
    if (typeof args.view_transform === 'string') options.view_transform = args.view_transform as RenderOptions['view_transform'];
    if (typeof args.lens === 'number') options.lens = args.lens;
    if (typeof args.fill_fraction === 'number') options.fill_fraction = args.fill_fraction;
    if (typeof args.transparent === 'boolean') options.transparent = args.transparent;
    if (typeof args.turntable_frames === 'number') options.turntable_frames = args.turntable_frames;
    if (Array.isArray(args.resolution) && args.resolution.length === 2) {
      options.resolution = [Number(args.resolution[0]), Number(args.resolution[1])];
    }
    let hdriFallback: string | undefined;
    const hdri = (args.hdri as string) || '';
    if (hdri.startsWith('polyhaven:')) {
      const slug = hdri.slice('polyhaven:'.length).trim();
      if (!slug) return { success: false, error: 'HDRI needs a slug: polyhaven:<slug>.' };
      const dl = await this.downloadPolyhavenHdri(slug);
      if (dl.path) {
        options.hdri_path = dl.path;
      } else {
        hdriFallback = dl.reason;
      }
    } else if (hdri) {
      if (!existsSync(hdri)) return { success: false, error: `HDRI file not found: ${hdri}` };
      options.hdri_path = hdri;
    }
    const result = await this.modelBuilder.renderModel(blendPath, outputPath, views, options);
    return { ...result, engine: options.engine ?? 'EEVEE', ...(hdriFallback ? { hdri_fallback: hdriFallback } : {}) };
  }

  private async generate3d(args: Record<string, unknown>): Promise<unknown> {
    const provider = ((args.provider as string) || 'meshy') as GenerateProvider;
    if (provider !== 'meshy' && provider !== 'tripo') {
      return { success: false, error: `Unknown provider '${provider}'. Available: meshy, tripo. (Hunyuan3D / Rodin are not implemented — see README.)` };
    }
    const mode = (args.image_url || args.image_base64) ? 'image' : 'text';
    if (mode === 'text' && !(args.prompt as string)?.trim()) {
      return { success: false, error: 'generate_3d text mode needs a prompt; image mode needs image_url or image_base64.' };
    }
    const opts: GenerateOptions = {
      provider,
      mode,
      prompt: (args.prompt as string) || undefined,
      image_url: (args.image_url as string) || undefined,
      image_base64: (args.image_base64 as string) || undefined,
      texture: typeof args.texture === 'boolean' ? args.texture : true,
      target_size: typeof args.target_size === 'number' ? args.target_size : 1.0,
      target_polycount: typeof args.target_polycount === 'number' ? args.target_polycount : undefined,
      timeout_seconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 600,
    };
    const glbName = `generated_${Date.now()}`;
    const result = await runGenerate3d(
      fetch as unknown as FetchFn,
      opts,
      { tempDir: this.config.paths.tempDir, glbName },
      (p, d) => writeFileSync(p, d),
    );
    if (!result.success || !result.glb_path) {
      return result; // no-key honest error, or a provider failure — nothing to import
    }
    // Import the downloaded GLB via the existing import path and
    // normalise: longest side -> target_size, origin at bottom, min z = 0.
    const name = glbName.replace(/[^A-Za-z0-9_-]/g, '_');
    const outputPath = join(this.config.paths.outputDir, `${name}.blend`);
    const script = buildImportScript(result.glb_path, IMPORT_OPERATORS.glb, outputPath, opts.target_size ?? 1.0);
    const imported = await this.modelBuilder.createMesh(script);
    return {
      ...result,
      output: imported.output || outputPath,
      import_success: imported.success,
      import_error: imported.error || '',
      note: 'Orientation/scale were verified in Blender on import (longest side = target_size, min z = 0). No provider states a GLB up-axis, so check the render before trusting the orientation.',
    };
  }

  private async retrieveAssetTool(args: Record<string, unknown>): Promise<unknown> {
    const cacheDir = join(this.config.paths.textureDir, 'retrieved_assets');
    mkdirSync(cacheDir, { recursive: true });
    const opts: RetrieveOptions = {
      product: (args.product as string) || undefined,
      query: (args.query as string) || undefined,
      source: (args.source as string) || 'polyhaven',
      resolution: (args.resolution as string) || '1k',
    };
    return retrieveAsset(
      opts,
      cacheDir,
      fetch as unknown as Parameters<typeof retrieveAsset>[2],
      (p, d) => writeFileSync(p, d),
      (p) => mkdirSync(p, { recursive: true }),
    );
  }

  private async buildProduct(args: Record<string, unknown>): Promise<unknown> {
    const product = ((args.product as string) || '').toLowerCase().trim();
    if (!PRODUCTS[product]) {
      return { success: false, error: `Unknown product '${product}'. Known products: ${Object.keys(PRODUCTS).sort().join(', ')}.` };
    }
    const source = ((args.source as string) || 'auto').toLowerCase().trim();
    if (source !== 'auto' && source !== 'procedural' && source !== 'retrieved') {
      return { success: false, error: `Unknown source '${source}'. Use auto, procedural or retrieved.` };
    }
    const targetSize = typeof args.target_size === 'number' ? args.target_size : 0.22;
    const info = PRODUCTS[product];

    if ((source === 'auto' || source === 'retrieved') && info.source === 'retrieved-preferred') {
      const retrieved = await this.retrieveAssetTool({ product }) as Record<string, unknown>;
      const asset = retrieved.asset as Record<string, unknown> | undefined;
      if (retrieved.success && asset?.gltf_path) {
        const script = getRetrievedProductScript(String(asset.gltf_path), targetSize);
        const result = await this.modelBuilder.createMeshWithReport(script) as unknown as Record<string, unknown>;
        return { ...result, product, source: 'retrieved', asset };
      }
      if (source === 'retrieved') {
        return { success: false, product, source: 'retrieved', error: String(retrieved.error || 'Retrieved asset unavailable.'), note: 'Call build_product with source \'procedural\' for the fallback builder.' };
      }
      const note = `Retrieved asset unavailable (${String(retrieved.error || 'unknown')}); fell back to the procedural builder.`;
      const [script, error] = getProductScript(product);
      if (!script) return { success: false, product, error };
      const result = await this.modelBuilder.createMeshWithReport(script) as unknown as Record<string, unknown>;
      return { ...result, product, source: 'procedural', note };
    }

    const [script, error] = getProductScript(product);
    if (!script) return { success: false, product, error };
    const result = await this.modelBuilder.createMeshWithReport(script) as unknown as Record<string, unknown>;
    return { ...result, product, source: 'procedural' };
  }

  private async addDetail(args: Record<string, unknown>): Promise<unknown> {
    const detail = (args.detail as string) || '';
    const target = (args.target as string) || '';
    const params = (args.params as Record<string, unknown>) || {};
    const blendPath = (args.blend_path as string) || '';
    if (!detail || !target) {
      return { success: false, error: 'add_detail needs detail and target.' };
    }
    let script: string;
    try {
      script = getDetailScript(detail, target, params);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const openLine = blendPath ? `import bpy\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(blendPath)})\n` : '';
    if (blendPath && !existsSync(blendPath)) {
      return { success: false, error: `Blend file not found: ${blendPath}` };
    }
    const result = await this.modelBuilder.createMesh(openLine + script);
    return { ...result, detail, target, params };
  }

  private async critiqueModel(args: Record<string, unknown>): Promise<unknown> {
    const blendPath = (args.blend_path as string) || '';
    if (!blendPath) return { success: false, error: 'blend_path is required.' };
    if (!existsSync(blendPath)) return { success: false, error: `Blend file not found: ${blendPath}` };
    const refineRound = Math.max(1, Math.min(MAX_REFINE_ROUNDS, Number(args.refine_round) || 1));
    const spec = args.spec ?? { objects: [] };
    const outputPrefix = ((args.output_path as string) || blendPath.replace(/\.blend$/i, '') + '_critique').replace(/\.(png|blend)$/i, '');
    const engine = (args.engine as string) === 'CYCLES' ? 'CYCLES' : 'EEVEE';

    // 1. Render the 5 critique views (front 3/4, side, back, top, close-up).
    const views = ['perspective', 'side', 'back', 'top', 'front'];
    const rendered = await this.modelBuilder.renderModel(blendPath, outputPrefix, views, { engine });
    if (!rendered.success) {
      return { success: false, error: `Critique render failed: ${rendered.error}`, stdout: rendered.stdout || '' };
    }

    // 2. Programmatic checks inside Blender (bounds, presence, dimensions, connectivity).
    const scriptPath = join(this.config.paths.tempDir, `critique_${Date.now()}.py`);
    writeFileSync(scriptPath, buildCritiqueScript(JSON.stringify(spec)));
    let checks: CritiqueCheck[] = [];
    let checkError = '';
    try {
      const result = await this.modelBuilder.runBlenderArgs(
        ['--background', blendPath, '--python', scriptPath],
        Math.max(this.config.blender.timeout, 120),
      );
      if (!result.success) {
        checkError = result.error || 'critique checks failed to run';
      } else {
        const parsed = parseCritiqueJson(result.stdout ?? '');
        checks = parsed?.checks ?? [];
        if (checks.length === 0) checkError = 'Blender ran but reported no critique checks.';
      }
    } finally {
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(scriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    // 3. PNG decode checks (host-side): a PNG that exists but does not
    //    decode is a failure, not a render.
    for (const r of rendered.renders ?? []) {
      const decodes = pngDecodes(r.path);
      checks.push({ check: `png_decodes:${r.view}`, passed: decodes, detail: decodes ? `${r.size_bytes} bytes, valid PNG` : 'PNG exists but does not decode' });
    }
    if (checkError) {
      checks.push({ check: 'programmatic_checks_ran', passed: false, detail: checkError });
    }

    const passed = checks.every((c) => c.passed);
    return {
      success: true,
      checks,
      passed,
      renders: rendered.renders,
      critique_prompt: buildCritiquePrompt(spec, checks),
      refine_round: refineRound,
      max_rounds: MAX_REFINE_ROUNDS,
      note: CRITIQUE_NOTE,
    };
  }

  private async modifyModel(args: Record<string, unknown>): Promise<ModelResult> {
    const existing = args.existing_model as string;
    const mods = (args.modifications as string || '').toLowerCase();

    let color = '';
    if (mods.includes('red')) color = '(0.8, 0.1, 0.1, 1)';
    else if (mods.includes('blue')) color = '(0.1, 0.3, 0.8, 1)';
    else if (mods.includes('green')) color = '(0.1, 0.7, 0.2, 1)';

    const scaleMod = mods.includes('bigger') || mods.includes('larger')
      ? 'obj.scale = (obj.scale.x * 1.5, obj.scale.y * 1.5, obj.scale.z * 1.5)' : '';
    const metallicMod = mods.includes('metallic') ? `
    for slot in obj.data.materials:
        if slot:
            slot.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
            slot.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.2
` : '';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${this.config.paths.outputDir}/modified_${timestamp}.blend`;

    const script = `
import bpy
existing = "${existing}"
if existing:
    try:
        bpy.ops.wm.open(filepath=existing)
    except:
        pass
modifications = "${mods}"
obj = bpy.context.active_object
if obj:
    ${color ? `
    mat = bpy.data.materials.new(name="ModifiedMat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = ${color}
    obj.data.materials.append(mat)
    ` : ''}
    ${scaleMod}
    ${metallicMod}
output = "${outputPath}"
bpy.ops.wm.save_mainfile(filepath=output)
`;

    return this.modelBuilder.createMesh(script);
  }

  private async applyTexture(args: Record<string, unknown>): Promise<ModelResult> {
    const texture = args.texture_type as string;
    const objectName = args.object_name as string;
    const blendPath = (args.blend_path as string) || '';
    if (blendPath && !existsSync(blendPath)) {
      return { success: false, error: `Blend file not found: ${blendPath}` };
    }
    // Without a .blend to open, Blender starts empty and the material
    // would be created but applied to nothing — so load the model
    // first when one is given.
    const openLine = blendPath ? `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(blendPath)})\n` : '';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${this.config.paths.outputDir}/textured_${timestamp}.blend`;

    // Poly Haven image texture: polyhaven:<slug>
    if (texture.startsWith('polyhaven:')) {
      const slug = texture.slice('polyhaven:'.length).trim();
      if (!slug) {
        return { success: false, error: 'Poly Haven texture needs a slug: polyhaven:<slug>.' };
      }
      let files: Record<string, unknown>;
      try {
        const response = await fetch(`${POLYHAVEN_API}/files/${encodeURIComponent(slug)}`, {
          headers: { 'User-Agent': POLYHAVEN_USER_AGENT },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          return { success: false, error: `Poly Haven: no texture named '${slug}' (HTTP ${response.status}). Check the slug on polyhaven.com/textures.` };
        }
        files = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Poly Haven API unreachable: ${message}. No fallback material was applied — check the network and try again.` };
      }
      let maps: PolyHavenMaps;
      try {
        maps = pickPolyhavenMaps(files);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      // Download the 1k maps (50 MB total cap).
      const texDir = join(this.config.paths.textureDir, slug);
      if (!existsSync(texDir)) mkdirSync(texDir, { recursive: true });
      const localMaps: PolyHavenMaps = {};
      let downloaded = 0;
      const maxBytes = 50 * 1024 * 1024;
      try {
        for (const [role, url] of Object.entries(maps)) {
          const response = await fetch(url, {
            headers: { 'User-Agent': POLYHAVEN_USER_AGENT },
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) {
            return { success: false, error: `Poly Haven download failed for the ${role} map: HTTP ${response.status}.` };
          }
          const data = Buffer.from(await response.arrayBuffer());
          downloaded += data.length;
          if (downloaded > maxBytes) {
            return { success: false, error: 'Poly Haven download exceeds the 50 MB limit.' };
          }
          const ext = url.split('.').pop()?.split('?')[0] ?? 'jpg';
          const localPath = join(texDir, `${slug}_${role}.${ext}`);
          writeFileSync(localPath, data);
          (localMaps as Record<string, string>)[role] = localPath;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Poly Haven download failed: ${message}. No fallback material was applied.` };
      }

      const matScript = buildPolyhavenMaterialScript(slug, localMaps, `PolyHaven_${slug}`);
      const script = `
import bpy, math
${openLine}${matScript}
target = ${JSON.stringify(objectName || '')}
targets = [obj for obj in bpy.data.objects if obj.type == "MESH" and (not target or target in obj.name)]
${getSmartUVScript()}
for obj in targets:
    obj.data.materials.append(mat)
output = ${JSON.stringify(outputPath)}
bpy.ops.wm.save_mainfile(filepath=output)
`;
      const result = await this.modelBuilder.createMesh(script);
      return {
        ...result,
        texture,
        polyhaven: { slug, url: `https://polyhaven.com/textures/${slug}`, licence: POLYHAVEN_LICENCE },
      };
    }

    // Procedural material (node tree, Generated coordinates — no UVs needed).
    const matScript = getMaterialScript(texture);
    const script = `
import bpy
${openLine}${matScript}
target = ${JSON.stringify(objectName || '')}
for obj in bpy.data.objects:
    if obj.type == "MESH":
        if not target or target in obj.name:
            obj.data.materials.append(mat)
output = ${JSON.stringify(outputPath)}
bpy.ops.wm.save_mainfile(filepath=output)
`;

    const result = await this.modelBuilder.createMesh(script);
    return { ...result, texture };
  }

  private async importFromUrl(args: Record<string, unknown>): Promise<unknown> {
    const url = (args.url as string) || '';
    const name = ((args.name as string) || 'imported').replace(/[^A-Za-z0-9_-]/g, '_');
    const targetSize = Number(args.target_size) || 1.0;

    if (!url) {
      return { success: false, error: 'No URL supplied.' };
    }

    const ext = url.split('.').pop()?.toLowerCase().split('?')[0] ?? 'glb';
    const format = SUPPORTED_IMPORT_FORMATS.includes(ext) ? ext : 'glb';
    const importOp = IMPORT_OPERATORS[format];

    const localPath = join(this.config.paths.tempDir, `${name}.${format}`);
    const outputPath = join(this.config.paths.outputDir, `${name}.blend`);
    const maxBytes = 100 * 1024 * 1024; // 100 MB download cap

    try {
      // Download the file (chunked, with a size cap)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok || !response.body) {
        return { success: false, error: `Download failed: HTTP ${response.status}` };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let downloaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.length;
        if (downloaded > maxBytes) {
          return { success: false, error: 'Download exceeds 100 MB limit' };
        }
        chunks.push(value);
      }
      const data = Buffer.concat(chunks);
      writeFileSync(localPath, data);

      // Import to Blender, then normalise: longest side -> targetSize,
      // origin at bottom centre, lowest point on the ground (z = 0).
      const script = buildImportScript(localPath, importOp, outputPath, targetSize);
      const result = await this.modelBuilder.createMesh(script);
      return { success: result.success, output: result.output || outputPath, stdout: result.stdout || '', error: result.error || '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Import failed: ${message}`);
      return { success: false, error: message };
    }
  }

  private async getSceneInfo(): Promise<ModelResult> {
    const script = `import bpy, json; objs = [{'name': o.name, 'type': o.type} for o in bpy.data.objects]; print(json.dumps({'objects': objs}))`;
    return this.modelBuilder.createMesh(script);
  }

  private async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const { method, params, id } = request;

    try {
      if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: this.config.name, version: this.config.version } } };
      }

      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: this.getToolsList() };
      }

      if (method === 'tools/call') {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments as Record<string, unknown>) || {};
        const result = await this.handleToolCall(toolName, toolArgs);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: null };
      }

      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Request failed: ${message}`);
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error', data: message } };
    }
  }

  async run(): Promise<void> {
    this.logger.info('Server running on stdio');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    let buffer = '';

    rl.on('line', async (line) => {
      buffer += line;
      try {
        const request = JSON.parse(buffer) as MCPRequest;
        buffer = '';

        // Handle batch requests
        if (Array.isArray(request)) {
          const responses = await Promise.all(request.map(req => this.handleRequest(req)));
          responses.forEach(response => {
            if (response) console.log(JSON.stringify(response));
          });
        } else {
          const response = await this.handleRequest(request);
          console.log(JSON.stringify(response));
        }
      } catch {
        // Not a complete JSON yet, wait for more data
      }
    });

    // Handle unhandled errors
    process.on('uncaughtException', (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
    });
  }
}

// Main entry point
const server = new BlenderMCPServer();
server.run().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});