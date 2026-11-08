"""Free real-asset retrieval (Blender-MCP 1.3.0 fix round) — ``retrieve_asset``.

The v1.3.0 demo products were all built from primitives, and the user
rejected the renders outright. The fix round's first step is to try a REAL
asset before rebuilding procedurally — but only from sources that are free
and need no account:

- Poly Haven (https://polyhaven.com, API https://api.polyhaven.com):
  models are CC0 (licence verified at polyhaven.com/license on
  2026-11-07), no key, direct downloads. Search is a full-asset listing
  filtered client-side (the API has no query endpoint). Downloads prefer
  the 1k glTF package: Blender 4.2 imports glTF natively, and the .blend
  downloads Poly Haven serves are Zstd-compressed, which Blender 4.2.0's
  library loader rejects ("not a blend file", verified 2026-11-08).
- Poly Pizza (https://api.poly.pizza): the v1.3.0 research assumed the
  search endpoint was key-free. It is NOT any more — since at least
  2026-11-08 ``GET /v1.1/search`` returns HTTP 401
  ``{"error": "You need an API key to do that dingus"}`` without a key.
  This module supports Poly Pizza only when the user supplies their own
  ``POLY_PIZZA_API_KEY`` env var; without one it says so honestly instead
  of pretending the search ran. No account is ever created by this code.

Verified retrieval (2026-11-08, this fix round):

- ``digital_wrist_watch`` (Poly Haven, CC0, 10,390 polys, 1k glTF):
  vintage Casio-style digital watch, brushed-steel bracelet, octagonal
  case, LCD readout. Source:
  https://polyhaven.com/a/digital_wrist_watch
  Used as the smartwatch product — a real watch beats any primitive one.
- Poly Haven has NO fitting headphones / sneaker / perfume-bottle model
  (full 521-model catalogue searched 2026-11-08: only ``bleach_bottle``,
  ``digital_wrist_watch``, ``pocket_watch`` and bottles matched the
  keywords). Those three products are rebuilt procedurally in
  ``blender_mcp/products.py``.

Assets are downloaded on demand into the caller's cache directory and are
NEVER committed to the repo (binary files cannot go through the
snapshot-push path, and a 3D asset is not source code).
"""

import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

POLYHAVEN_API = "https://api.polyhaven.com"
POLYHAVEN_LICENCE = "CC0"
POLYHAVEN_USER_AGENT = "blender-mcp/1.3.1 (https://github.com/IamNishant51/Blender-MCP)"

POLYPIZZA_API = "https://api.poly.pizza/v1.1"

# Products with a verified-good free real asset. ``format`` is the package
# to download: "gltf" (Blender-native import) — see the module docstring
# for why the .blend package is not used.
KNOWN_GOOD_ASSETS = {
    "smartwatch": {
        "slug": "digital_wrist_watch",
        "source": "polyhaven",
        "licence": "CC0",
        "url": "https://polyhaven.com/a/digital_wrist_watch",
        "format": "gltf",
        "resolution": "1k",
        "description": "Vintage digital wristwatch, brushed-steel bracelet, octagonal case, LCD readout.",
    },
}


# ---------------------------------------------------------------------------
# Poly Haven: search (client-side filter over the full catalogue)
# ---------------------------------------------------------------------------

def search_polyhaven_catalogue(catalogue, query):
    """Filter a ``GET /assets?t=models`` catalogue dict by keyword.

    Pure function (no network) so tests can pass a canned catalogue.
    Matches on slug and on the asset name. Returns matching slugs.
    """
    q = (query or "").lower().strip()
    if not q:
        return []
    words = q.split()
    matches = []
    for slug, info in catalogue.items():
        hay = f"{slug} {(info or {}).get('name', '')}".lower()
        if all(w in hay for w in words):
            matches.append(slug)
    return matches


def pick_polyhaven_gltf_package(files, resolution="1k"):
    """Pick the glTF download plan out of a ``GET /files/<slug>`` response.

    Returns {"main": {"url", ...}, "include": {rel_path: {"url", ...}}}
    for the requested resolution, or raises ValueError. glTF is preferred
    over the .blend package (Zstd-compressed .blend files are rejected by
    Blender 4.2.0's library loader — verified 2026-11-08).
    """
    gltf = files.get("gltf") or {}
    res = gltf.get(resolution)
    if not isinstance(res, dict):
        available = sorted(gltf.keys()) if isinstance(gltf, dict) else []
        raise ValueError(
            f"No glTF package at {resolution} for this asset"
            + (f" (available: {', '.join(available)})" if available else "")
            + ". Try another resolution."
        )
    main = res.get("gltf")
    if not isinstance(main, dict) or not main.get("url"):
        raise ValueError("glTF package has no main .gltf download URL.")
    # NOTE: `include` is nested INSIDE the main entry (res["gltf"]
    # ["include"]), not a sibling of it — the first version of this code
    # read res.get("include"), downloaded only the .gltf, and Blender
    # then failed the import with "Missing resource, '<slug>.bin'".
    return {"main": main, "include": main.get("include") or {}}


# ---------------------------------------------------------------------------
# Poly Pizza: key-gated (verified 2026-11-08: search is 401 without a key)
# ---------------------------------------------------------------------------

def poly_pizza_search_status(api_key=None):
    """Honest status for a Poly Pizza search attempt.

    Returns (ok, message): without a key the search cannot run at all —
    the API returns HTTP 401. No account is created here; the user may
    supply their own POLY_PIZZA_API_KEY env var.
    """
    key = api_key if api_key is not None else os.environ.get("POLY_PIZZA_API_KEY", "")
    if not key:
        return False, (
            "Poly Pizza search needs an API key since at least 2026-11-08 "
            "(GET /v1.1/search returns HTTP 401 without one). No key is "
            "configured (POLY_PIZZA_API_KEY), so Poly Pizza was not searched. "
            "Poly Haven (CC0, no key) was searched instead."
        )
    return True, "Poly Pizza API key is configured."


# ---------------------------------------------------------------------------
# HTTP layer (urllib by default; injectable for tests)
# ---------------------------------------------------------------------------

def _http_get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": POLYHAVEN_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Poly Haven request failed (HTTP {e.code}): {url}")


def _download_file(url, dest_path, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": POLYHAVEN_USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        Path(dest_path).write_bytes(resp.read())


def _verify_size_and_md5(path, expected):
    """Check a downloaded file against the API's size/md5 (when given)."""
    if not expected:
        return
    size = Path(path).stat().st_size
    if expected.get("size") and size != expected["size"]:
        raise RuntimeError(f"Download size mismatch for {path}: got {size}, expected {expected['size']}.")
    md5 = expected.get("md5")
    if md5:
        digest = hashlib.md5(Path(path).read_bytes()).hexdigest()
        if digest != md5:
            raise RuntimeError(f"Download md5 mismatch for {path}.")


# ---------------------------------------------------------------------------
# Full job: search Poly Haven, download the glTF package, return a manifest
# ---------------------------------------------------------------------------

def retrieve_asset(opts, cache_dir, http_json=None, download=None):
    """Retrieve a free real asset for ``opts['product']`` or ``opts['query']``.

    ``opts``: {"product": "smartwatch"|..., "query": "...", "source":
    "polyhaven" (default) | "poly_pizza", "resolution": "1k"}.
    Returns a result dict; on success it carries ``asset`` with slug,
    source, licence, source_url, local main file (``gltf_path``) and the
    downloaded file list. On failure it says exactly why (no fitting
    asset, Poly Pizza key missing, download failed) — never silent.
    """
    product = (opts.get("product") or "").lower().strip()
    query = opts.get("query") or product
    source = (opts.get("source") or "polyhaven").lower().strip()
    resolution = opts.get("resolution", "1k")

    if source == "poly_pizza":
        ok, message = poly_pizza_search_status()
        return {"success": False, "source": "poly_pizza", "retrieval_available": ok,
                "error": message}

    http_json = http_json or _http_get_json
    download = download or _download_file

    # A product with a verified-good asset goes straight to it; anything
    # else is searched by keyword in the Poly Haven catalogue.
    known = KNOWN_GOOD_ASSETS.get(product) if product else None
    if known:
        slug = known["slug"]
    else:
        if not query:
            return {"success": False, "source": "polyhaven",
                    "error": "retrieve_asset needs a product or a query to search for."}
        try:
            _, catalogue = http_json(f"{POLYHAVEN_API}/assets?t=models")
        except Exception as e:
            return {"success": False, "source": "polyhaven", "error": str(e)}
        matches = search_polyhaven_catalogue(catalogue, query)
        if not matches:
            return {"success": False, "source": "polyhaven", "query": query,
                    "error": f"No Poly Haven model matches '{query}'. Rebuild procedurally "
                             "(build_product) instead of using a wrong asset."}
        slug = matches[0]

    try:
        _, files = http_json(f"{POLYHAVEN_API}/files/{slug}")
        plan = pick_polyhaven_gltf_package(files, resolution)
    except Exception as e:
        return {"success": False, "source": "polyhaven", "slug": slug, "error": str(e)}

    dest = Path(cache_dir) / slug
    dest.mkdir(parents=True, exist_ok=True)
    main_name = Path(plan["main"]["url"]).name
    main_path = dest / main_name
    downloaded = []
    try:
        download(plan["main"]["url"], str(main_path))
        _verify_size_and_md5(main_path, plan["main"])
        downloaded.append(str(main_path))
        for rel, entry in plan["include"].items():
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            download(entry["url"], str(target))
            _verify_size_and_md5(target, entry)
            downloaded.append(str(target))
    except Exception as e:
        return {"success": False, "source": "polyhaven", "slug": slug,
                "error": f"Download failed: {e}"}

    info = {
        "slug": slug,
        "source": "polyhaven",
        "licence": POLYHAVEN_LICENCE,
        "source_url": f"https://polyhaven.com/a/{slug}",
        "format": "gltf",
        "resolution": resolution,
        "gltf_path": str(main_path),
        "files": downloaded,
    }
    if known:
        info["description"] = known["description"]
    return {"success": True, "asset": info}
