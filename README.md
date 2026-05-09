<!--
  Blender MCP Server
  Connect AI assistants to Blender for 3D creation
-->
<h1 align="center">
  <br>
  <img src="https://raw.githubusercontent.com/IamNishant51/Blender-MCP/main/logo.png" alt="Blender MCP" width="120">
  <br>
  <br>
  Blender MCP Server
  <br>
</h1>

<p align="center">
  <strong>MCP server for controlling Blender via AI assistants</strong>
  <br>
  Claude Code | OpenCode | GitHub Copilot
</p>

---

## Overview

Blender MCP enables AI assistants to control Blender programmatically, allowing you to:

- Create complex 3D models with detailed planning and procedural generation
- Search the internet for 3D models and textures
- Apply materials and textures to objects
- Modify existing models
- Import and export 3D files

---

## Installation

```bash
# Install from npm
npm install -g blender-mcp

# Or use npx
npx blender-mcp
```

**Requirements:** Node.js 18+ and Blender installed

---

## Available Tools

| Tool | Description |
|------|-------------|
| `create_complex_model` | Build complex 3D models with internet search and detailed planning. Supports Indian themes: temples, vehicles, food, characters, buildings, and more. |
| `modify_model` | Modify existing 3D models - change colors, materials, scale, rotation, or apply effects. |
| `apply_texture` | Apply procedural materials to 3D objects (wood, marble, stone, metal, etc.). |
| `search_models` | Search the entire internet for 3D models across multiple sources. |
| `search_textures` | Search for free textures from online databases. |
| `get_scene_info` | Get information about the current Blender scene. |
| `import_from_url` | Import a 3D model directly from a URL. |

---

## Configuration

### Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "blender": {
      "command": "npx",
      "args": ["blender-mcp"]
    }
  }
}
```

### OpenCode

```json
{
  "blender": "npx blender-mcp"
}
```

### Other MCP Clients

```bash
npx blender-mcp
# or
npm install -g blender-mcp && blender-mcp
```

---

## Built-in Model Templates

The server includes procedural generation for various Indian-themed 3D models:

| Category | Description |
|----------|-------------|
| **Temples** | Detailed Indian temples with pillars, mandapa, shikhara, torana, and decorative elements |
| **Vehicles** | Auto-rickshaws (Tuk-Tuk) with wheels, cabin, headlights, and details |
| **Food** | Traditional Indian thali with plate, rice, curries, rotis, and accompaniments |
| **Buildings** | Haveli/Palace structures with multiple floors, jali windows, chattris, and courtyards |
| **Characters** | Human figures in traditional Indian attire (dhoti) |

### Material Library

Built-in procedural materials:

| Material | Variants |
|----------|----------|
| Marble | white, red, green |
| Metal | gold, copper, brass |
| Stone | stone, sandstone, terracotta |
| Wood | standard wood grain |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BLENDER_EXECUTABLE` | `blender` | Path to Blender executable |
| `BLENDER_TIMEOUT` | `120` | Timeout for Blender operations (seconds) |
| `BLENDER_MCP_DIR` | `~/Desktop/BLENDER-MCP` | Base directory for output files |
| `BLENDER_MCP_DEBUG` | `false` | Enable debug logging |

---

## Example Usage

Once connected to an AI assistant, you can create 3D scenes like:

1. "Create an Indian temple with red marble material"
2. "Build a traditional auto-rickshaw in yellow"
3. "Create a thali with rice and multiple curries"
4. "Add a marble texture to my model"
5. "Search for free 3D models of chairs"

---

## Architecture

```
+-----------+      MCP      +-------------+    subprocess   +---------+
| Claude/   |  <----------> | blender-mcp |  <-----------   | Blender |
| Copilot   |               |  (Node.js)  |  --background   |  --bg   |
+-----------+               +-------------+                 +---------+
```

The server runs Blender as a background subprocess and executes Python scripts using Blender's `bpy` API for each operation.

---

## Development

```bash
# Clone and install
npm install

# Build
npm run build

# Run
npm start
```

---

## License

MIT License