"""Configuration management for Blender MCP Server."""

import os
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class BlenderConfig:
    """Blender-specific configuration."""
    executable: str = "blender"
    timeout: int = 120
    background_mode: bool = True
    render_engine: str = "CYCLES"


@dataclass
class PathsConfig:
    """Directory paths configuration."""
    base_dir: Path = field(default_factory=lambda: Path.home() / "Desktop" / "BLENDER-MCP")
    temp_dir: Path = field(default_factory=lambda: Path.home() / "Desktop" / "BLENDER-MCP" / ".temp")
    output_dir: Path = field(default_factory=lambda: Path.home() / "Desktop" / "BLENDER-MCP" / "output")
    texture_dir: Path = field(default_factory=lambda: Path.home() / "Desktop" / "BLENDER-MCP" / "textures")
    log_dir: Path = field(default_factory=lambda: Path.home() / "Desktop" / "BLENDER-MCP" / "logs")

    def __post_init__(self):
        """Ensure all directories exist."""
        for path in [self.temp_dir, self.output_dir, self.texture_dir, self.log_dir]:
            path.mkdir(parents=True, exist_ok=True)


@dataclass
class SearchConfig:
    """Search API configuration."""
    sketchfab_limit: int = 5
    google_limit: int = 5
    poly_pizza_limit: int = 5
    timeout: int = 12
    cache_ttl: int = 300  # seconds


@dataclass
class ServerConfig:
    """Main server configuration."""
    name: str = "blender-copilot"
    version: str = "1.0.0"
    blender: BlenderConfig = field(default_factory=BlenderConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    search: SearchConfig = field(default_factory=SearchConfig)
    debug: bool = False


def get_config() -> ServerConfig:
    """Get server configuration from environment variables."""
    return ServerConfig(
        debug=os.environ.get("BLENDER_MCP_DEBUG", "false").lower() == "true",
        blender=BlenderConfig(
            executable=os.environ.get("BLENDER_EXECUTABLE", "blender"),
            timeout=int(os.environ.get("BLENDER_TIMEOUT", "120")),
        ),
        paths=PathsConfig(
            base_dir=Path(os.environ.get("BLENDER_MCP_DIR", Path.home() / "Desktop" / "BLENDER-MCP")),
        )
    )


# Global config instance
config = get_config()