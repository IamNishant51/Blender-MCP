"""AI text/image-to-3D generation (Blender-MCP 1.3.0) — ``generate_3d`` support.

Python mirror of src/commands/generate.ts. Providers (per
~/workspace/research_notes/blender-product-realism-20261107/notes/api-generation.md,
read from each provider's official API docs only):

- Meshy (first): POST /openapi/v2/text-to-3d (preview, then refine),
  POST /openapi/v1/image-to-3d (URL or base64 data URI, <= 20 MB).
  Poll GET <endpoint>/:id: PENDING -> IN_PROGRESS -> SUCCEEDED | FAILED |
  CANCELED. Download model_urls.glb — assets kept only 3 days. Auth:
  Bearer key from env var MESHY_API_KEY only, never baked into source.
  Textured model = 30 credits (20 preview + 10 refine); mesh-only draft
  = 5 credits. API needs a paid plan (Free plan is web-only, 402).
- Tripo (second): POST /v3/generation/text-to-model and
  POST /v3/generation/image-to-model, poll GET /v3/tasks/{task_id}
  (queued -> running -> success | failed | cancelled). Download
  output.model_url IMMEDIATELY inside the poll loop — the URL expires in
  5 minutes. Auth: Bearer key from TRIPO_API_KEY.

Hunyuan3D and Hyper3D Rodin are NOT implemented (README: future work).
No provider's docs state a GLB up-axis — every import is verified in
Blender on import, never assumed. No key configured -> the tool says so
honestly instead of failing silently.
"""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

MESHY_BASE_URL = "https://api.meshy.ai/openapi"
TRIPO_BASE_URL = "https://openapi.tripo3d.ai/v3"

MESHY_TERMINAL = ("SUCCEEDED", "FAILED", "CANCELED")
TRIPO_TERMINAL = ("success", "failed", "cancelled", "banned", "expired")


# ---------------------------------------------------------------------------
# Request builders (pure — no network, fully unit-testable)
# ---------------------------------------------------------------------------

def build_meshy_text_request(prompt, opts):
    if not prompt or len(prompt) > 800:
        raise ValueError("Meshy text-to-3D prompt is required and must be <= 800 characters.")
    return {
        "mode": "preview",
        "prompt": prompt,
        "ai_model": "latest",
        "target_polycount": opts.get("target_polycount", 30000),
        "target_formats": ["glb"],
        "auto_size": True,
        "origin_at": "bottom",
    }


def build_meshy_refine_request(preview_task_id, opts):
    return {
        "mode": "refine",
        "preview_task_id": preview_task_id,
        "enable_pbr": True,
        "texture_resolution": "2k",
        "target_formats": ["glb"],
        "auto_size": True,
        "origin_at": "bottom",
    }


def build_meshy_image_request(opts):
    image_url = opts.get("image_url")
    if not image_url and opts.get("image_base64"):
        b64 = opts["image_base64"]
        image_url = b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}"
    if not image_url:
        raise ValueError("Meshy image-to-3D needs image_url (public URL or data URI) or image_base64.")
    return {
        "image_url": image_url,
        "should_texture": opts.get("texture", True) is not False,
        "enable_pbr": True,
        "target_polycount": opts.get("target_polycount", 30000),
        "target_formats": ["glb"],
        "auto_size": True,
        "origin_at": "bottom",
    }


def build_tripo_text_request(prompt, opts):
    if not prompt or len(prompt) > 1024:
        raise ValueError("Tripo text-to-3D prompt is required and must be <= 1024 characters.")
    return {
        "prompt": prompt,
        "model": "v3.1-20260211",
        "texture": opts.get("texture", True) is not False,
        "pbr": True,
        "auto_size": True,
    }


def build_tripo_image_request(opts):
    if not opts.get("image_url"):
        raise ValueError("Tripo image-to-3D needs image_url (a public URL).")
    return {
        "input": opts["image_url"],
        "model": "v3.1-20260211",
        "texture": opts.get("texture", True) is not False,
        "pbr": True,
        "auto_size": True,
    }


def is_meshy_terminal(status):
    return status in MESHY_TERMINAL


def is_tripo_terminal(status):
    return status in TRIPO_TERMINAL


def extract_meshy_glb(task):
    urls = task.get("model_urls") or {}
    return urls.get("glb")


def extract_tripo_glb(task):
    output = task.get("output") or {}
    return output.get("model_url")


# ---------------------------------------------------------------------------
# HTTP layer (urllib by default; injectable for tests)
# ---------------------------------------------------------------------------

def _http_json(method, url, api_key=None, body=None, timeout=60):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode())
        except Exception:
            detail = {}
        raise RuntimeError(f"Generation API request failed (HTTP {e.code}): {json.dumps(detail)[:300]}")


def _download(url, dest_path, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        Path(dest_path).write_bytes(resp.read())


def _post_json(http, url, api_key, body):
    status, data = http("POST", url, api_key, body)
    if status == 401:
        raise RuntimeError("Generation API rejected the key (HTTP 401). Check MESHY_API_KEY / TRIPO_API_KEY.")
    if status == 402:
        raise RuntimeError("Generation API: insufficient credits or Free plan (HTTP 402). Meshy API access needs a paid plan; the Free plan is web-only.")
    if status == 429:
        raise RuntimeError("Generation API rate-limited (HTTP 429). Wait and retry.")
    if status >= 400:
        raise RuntimeError(f"Generation API request failed (HTTP {status}): {json.dumps(data)[:300]}")
    return data


def _get_json(http, url, api_key):
    status, data = http("GET", url, api_key, None)
    if status >= 400:
        raise RuntimeError(f"Generation API poll failed (HTTP {status}): {json.dumps(data)[:300]}")
    return data


# ---------------------------------------------------------------------------
# Pollers
# ---------------------------------------------------------------------------

def poll_meshy_task(http, api_key, endpoint, task_id, opts):
    deadline = time.time() + opts.get("timeout_seconds", 600)
    interval = opts.get("poll_interval_seconds", 10)
    while True:
        task = _get_json(http, f"{MESHY_BASE_URL}{endpoint}/{task_id}", api_key)
        status = str(task.get("status", ""))
        if status == "SUCCEEDED":
            glb = extract_meshy_glb(task)
            if not glb:
                raise RuntimeError("Meshy task SUCCEEDED but returned no GLB URL (model_urls.glb missing).")
            return {"task": task, "glb_url": glb, "progress": 100}
        if status == "FAILED":
            err = task.get("task_error") or {}
            msg = err.get("message", "") if isinstance(err, dict) else ""
            raise RuntimeError(f"Meshy generation FAILED{': ' + msg if msg else ''}. Credits are refunded for FAILED tasks.")
        if status == "CANCELED":
            raise RuntimeError("Meshy generation was CANCELED.")
        if time.time() > deadline:
            raise RuntimeError(
                f"Meshy generation timed out after {opts.get('timeout_seconds', 600)}s "
                f"(task {task_id}, last status {status}). The task is NOT cancelled — keep the task ID "
                "and poll again later instead of paying for a second generation."
            )
        time.sleep(interval)


def poll_tripo_task(http, api_key, task_id, opts, download_fn):
    deadline = time.time() + opts.get("timeout_seconds", 600)
    interval = opts.get("poll_interval_seconds", 5)
    while True:
        task = _get_json(http, f"{TRIPO_BASE_URL}/tasks/{task_id}", api_key)
        status = str(task.get("status", ""))
        if status == "success":
            glb = extract_tripo_glb(task)
            if not glb:
                raise RuntimeError("Tripo task succeeded but returned no model URL (output.model_url missing).")
            # Download NOW: the URL expires in 5 minutes. Never store the URL as the asset.
            local_path = download_fn(glb)
            return {"task": task, "glb_url": local_path, "progress": 100}
        if status in ("failed", "cancelled", "banned", "expired"):
            raise RuntimeError(f"Tripo generation {status}: {task.get('error_message') or task.get('error_code') or 'no detail'}.")
        if time.time() > deadline:
            raise RuntimeError(
                f"Tripo generation timed out after {opts.get('timeout_seconds', 600)}s "
                f"(task {task_id}, last status {status}). Keep the task ID and poll again instead of paying for a second generation."
            )
        time.sleep(interval)


# ---------------------------------------------------------------------------
# Full job: submit -> poll -> download GLB. The caller imports the GLB via
# the existing import path and normalises it.
# ---------------------------------------------------------------------------

def run_generate_3d(opts, temp_dir, glb_name, http=None, download=None, api_key=None):
    """Run a generate_3d job. ``http`` / ``download`` are injectable for tests.

    Returns a result dict; on success it carries ``glb_path`` (local file).
    """
    provider = opts.get("provider", "meshy")
    mode = opts.get("mode", "text")
    env_var = "MESHY_API_KEY" if provider == "meshy" else "TRIPO_API_KEY"
    key = api_key if api_key is not None else os.environ.get(env_var, "")
    if not key:
        return {
            "success": False,
            "provider": provider,
            "mode": mode,
            "generation_available": False,
            "error": (
                f"No {env_var} is configured, so AI 3D generation is not available. "
                f"Set {env_var} to your own {'Meshy' if provider == 'meshy' else 'Tripo'} API key "
                "(a paid plan is required for API access — Meshy's Free plan is web-only) and call generate_3d again. "
                "Without a key the free local path still works: research_model -> build_from_spec / execute_blender_code -> render_model. "
                "No key is ever baked into source; keys come from environment variables only."
            ),
        }

    http = http or _http_json
    glb_path = str(Path(temp_dir) / f"{glb_name}.glb")

    def _dl(url):
        if download is not None:
            return download(url, glb_path)
        _download(url, glb_path)
        return glb_path

    try:
        if provider == "meshy":
            if mode == "text":
                created = _post_json(http, f"{MESHY_BASE_URL}/v2/text-to-3d", key, build_meshy_text_request(opts.get("prompt", ""), opts))
                preview_id = str(created.get("result", ""))
                if not preview_id:
                    raise RuntimeError("Meshy did not return a task ID (result field missing).")
                preview = poll_meshy_task(http, key, "/v2/text-to-3d", preview_id, opts)
                if opts.get("texture") is False:
                    _dl(preview["glb_url"])
                    return {"success": True, "provider": provider, "mode": mode, "task_id": preview_id,
                            "preview_task_id": preview_id, "glb_path": glb_path, "progress": 100,
                            "credits_note": "Meshy mesh-only preview: 20 credits (meshy-7.1) / 5 credits (meshy-6-lite). No texture step was run."}
                refined = _post_json(http, f"{MESHY_BASE_URL}/v2/text-to-3d", key, build_meshy_refine_request(preview_id, opts))
                refine_id = str(refined.get("result", ""))
                if not refine_id:
                    raise RuntimeError("Meshy refine did not return a task ID.")
                done = poll_meshy_task(http, key, "/v2/text-to-3d", refine_id, opts)
                _dl(done["glb_url"])
                return {"success": True, "provider": provider, "mode": mode, "task_id": refine_id,
                        "preview_task_id": preview_id, "glb_path": glb_path, "progress": 100,
                        "credits_note": "Meshy textured model: 20 preview + 10 refine = 30 credits (meshy-7.1, 2K textures)."}
            created = _post_json(http, f"{MESHY_BASE_URL}/v1/image-to-3d", key, build_meshy_image_request(opts))
            task_id = str(created.get("result", ""))
            if not task_id:
                raise RuntimeError("Meshy did not return a task ID (result field missing).")
            done = poll_meshy_task(http, key, "/v1/image-to-3d", task_id, opts)
            _dl(done["glb_url"])
            return {"success": True, "provider": provider, "mode": mode, "task_id": task_id,
                    "glb_path": glb_path, "progress": 100,
                    "credits_note": "Meshy image-to-3D textured model: 30 credits (meshy-7.1, 2K textures). Assets are kept only 3 days — the GLB is already downloaded locally."}

        # Tripo
        endpoint = "/generation/text-to-model" if mode == "text" else "/generation/image-to-model"
        body = build_tripo_text_request(opts.get("prompt", ""), opts) if mode == "text" else build_tripo_image_request(opts)
        created = _post_json(http, f"{TRIPO_BASE_URL}{endpoint}", key, body)
        task_id = str(created.get("task_id") or (created.get("data") or {}).get("task_id") or "")
        if not task_id:
            raise RuntimeError("Tripo did not return a task_id.")
        poll_tripo_task(http, key, task_id, opts, _dl)
        return {"success": True, "provider": provider, "mode": mode, "task_id": task_id,
                "glb_path": glb_path, "progress": 100,
                "credits_note": f"Tripo {'text' if mode == 'text' else 'image'}-to-3D textured model: "
                f"{'$0.20 (20 credits)' if mode == 'text' else '$0.30 (30 credits)'} at $0.01/credit. "
                "The GLB was downloaded immediately — its URL expires in 5 minutes."}
    except Exception as e:
        return {"success": False, "provider": provider, "mode": mode, "generation_available": True, "error": str(e)}
