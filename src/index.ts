/**
 * Blender MCP Server - Main entry point
 * Connects AI assistants to Blender for 3D creation
 *
 * Simplified stdio implementation without external SDK dependency
 */

import { createLogger } from './utils/logger.js';
import { config, type ServerConfig } from './config/index.js';
import { SearchService } from './commands/search.js';
import { ModelBuilder, getMaterialScript, type ModelResult } from './commands/model.js';
import { generateModelScript } from './commands/generators.js';
import { buildImportScript, IMPORT_OPERATORS, SUPPORTED_IMPORT_FORMATS } from './commands/import.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

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
              texture_type: { type: 'string', description: 'Texture type' },
              object_name: { type: 'string', description: 'Object to apply to' },
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

    const matScript = getMaterialScript(texture);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${this.config.paths.outputDir}/textured_${timestamp}.blend`;

    const script = `
import bpy
${matScript}
target = "${objectName || ''}"
for obj in bpy.data.objects:
    if obj.type == "MESH":
        if not target or target in obj.name:
            obj.data.materials.append(mat)
output = "${outputPath}"
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