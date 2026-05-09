"""Blender MCP - Connect AI assistants to Blender for 3D creation."""

__version__ = "1.0.0"
__author__ = "Blender MCP Team"
__description__ = "MCP server for controlling Blender via AI assistants"

from blender_mcp.server import BlenderMCPServer, main

__all__ = ["BlenderMCPServer", "main", "__version__"]