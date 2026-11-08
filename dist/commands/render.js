/**
 * Product render pipeline (Blender-MCP 1.3.0) — `render_model` support.
 *
 * Builds the Blender script that applies the presentation preset and
 * renders PNGs, one per view:
 *
 * - Camera auto-framed on the bounding-box centre with margin, Track-To
 *   aimed; 50 mm default, 85 mm hero, 90-105 mm macro for small products.
 *   Framing is EXACT: per view the camera pulls back until the subject's
 *   binding axis fills `fill_fraction` (default 0.7) of the frame — the
 *   old `max_dim * 2.5 + 0.5` heuristic rendered the v1.3.0 watch at ~30%
 *   of the frame.
 * - 3-point + rim area-light rig derived from the product bounding box,
 *   intensities set by RATIO (key 1.0, fill 0.2-0.4x key, rim brightest
 *   in effect) — no canonical wattage exists in the Blender manual or the
 *   tutorials read, so none is invented; validate via the look loop
 * - Studio HDRI world lighting when an HDRI path is given (Poly Haven,
 *   CC0 — licence verified at polyhaven.com/license on 2026-11-07; the
 *   auto-download falls back to the world+sun setup when it fails),
 *   otherwise the v1.2.0 world light (0.35) + sun
 * - Ground plane at z = 0 (Cycles Shadow Catcher + Film Transparent for
 *   transparent-background product shots; EEVEE has no shadow catcher)
 * - Colour: Khronos PBR Neutral for catalogue shots, AgX for hero shots
 *   (Filmic is deprecated, superseded by AgX; never Standard for finals)
 * - Cycles: CPU (this VM has no GPU), 128-256 samples + OpenImageDenoise
 *   (Albedo + Normal passes); EEVEE for fast previews / turntable drafts
 * - Turntable: exactly 360 deg about Z at constant speed, camera orbiting
 *   at fixed elevation, lights fixed
 *
 * The script is run as `blender --background <blend> --python <script> --
 * <output_prefix> <view...>` and prints a RENDER_DONE_JSON line. The host
 * (ModelBuilder.renderModel) verifies every PNG exists on disk and is
 * non-empty before reporting success — a missing/empty PNG is a failure,
 * never success:true.
 */
export const RENDER_VIEWS = ['front', 'side', 'back', 'top', 'perspective'];
export function buildRenderScript(views, options = {}) {
    const bad = views.filter((v) => !RENDER_VIEWS.includes(v));
    if (bad.length > 0) {
        throw new Error(`Unknown view(s): ${bad.join(', ')}. Allowed views: ${RENDER_VIEWS.join(', ')}`);
    }
    if (views.length === 0) {
        throw new Error('At least one view is required.');
    }
    const engine = options.engine ?? 'EEVEE';
    if (engine !== 'EEVEE' && engine !== 'CYCLES') {
        throw new Error(`Unknown engine '${engine}'. Allowed: EEVEE, CYCLES.`);
    }
    const samples = options.samples ?? 128;
    if (samples < 1 || samples > 4096) {
        throw new Error('Cycles samples must be between 1 and 4096 (128-256 is the sane CPU range).');
    }
    const lens = options.lens ?? 50;
    if (lens < 1 || lens > 250) {
        throw new Error('Lens must be between 1 and 250 mm (50 default, 85 hero, 90-105 macro).');
    }
    const turntableFrames = options.turntable_frames ?? 0;
    if (turntableFrames < 0 || turntableFrames > 60) {
        throw new Error('turntable_frames must be between 0 and 60.');
    }
    const resolution = options.resolution ?? (engine === 'CYCLES' ? [1280, 720] : [960, 720]);
    const viewTransform = options.view_transform ?? '';
    const transparent = options.transparent ?? false;
    const hdriPath = options.hdri_path ?? '';
    const fillFraction = options.fill_fraction ?? 0.7;
    if (fillFraction < 0.3 || fillFraction > 0.95) {
        throw new Error('fill_fraction must be between 0.3 and 0.95 (0.7 fills ~70% of the frame).');
    }
    return `
import bpy, sys, math, json
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
out_prefix = argv[0]
views = argv[1:]
ENGINE = ${JSON.stringify(engine)}
SAMPLES = ${samples}
LENS = ${lens}
TRANSPARENT = ${transparent ? 'True' : 'False'}
TURNTABLE_FRAMES = ${turntableFrames}
RES_X, RES_Y = ${resolution[0]}, ${resolution[1]}
VIEW_TRANSFORM = ${JSON.stringify(viewTransform)}
HDRI_PATH = ${JSON.stringify(hdriPath)}
FILL_FRACTION = ${fillFraction}

# --- scene bounds of the model (before adding the ground plane) ---
bpy.context.view_layer.update()  # flush scale/location edits into matrix_world
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("render_model: no mesh objects in the scene")
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for o in meshes:
    for corner in o.bound_box:
        w = o.matrix_world @ Vector(corner)
        lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
        hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
centre = (lo + hi) / 2
size = hi - lo
max_dim = max(size.x, size.y, size.z)

# --- silhouette points for exact framing (see _frame_camera) ---
# The model's mesh vertices (stride-sampled, capped ~20k), in world space.
# The AABB corners overestimate the silhouette — the v1.3.0 headphones'
# corners span 66% of the frame while the visible model spans 58% — so
# framing from corners alone undershoots the fill. Vertices are exact.
_model_pts = []
for _o in meshes:
    _mw = _o.matrix_world
    _verts = _o.data.vertices
    # NOTE: bpy_prop_collection has no slicing (verts[::step] raises
    # TypeError) — stride by index instead.
    _step = max(1, len(_verts) // 20000)
    for _i in range(0, len(_verts), _step):
        _model_pts.append(_mw @ _verts[_i].co)

# --- remove any existing cameras / lights (the preset owns them) ---
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(o, do_unlink=True)

# --- ground plane at z = 0 ---
bpy.ops.mesh.primitive_plane_add(size=50, location=(0, 0, 0))
ground = bpy.context.active_object
ground.name = "GroundPlane"
gmat = bpy.data.materials.new(name="GroundMat")
gmat.use_nodes = True
gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.55, 0.55, 1)
gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
ground.data.materials.append(gmat)

# --- world light: studio HDRI when one is given, else the flat world ---
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
if HDRI_PATH:
    import os
    if os.path.exists(HDRI_PATH):
        env = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(HDRI_PATH)
        mapping = world.node_tree.nodes.new("ShaderNodeMapping")
        texcoord = world.node_tree.nodes.new("ShaderNodeTexCoord")
        world.node_tree.links.new(texcoord.outputs["Generated"], mapping.inputs["Vector"])
        world.node_tree.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        world.node_tree.links.new(env.outputs["Color"], bg.inputs["Color"])
        # Rotate so the brightest area sits 30-60 deg to the side of camera.
        mapping.inputs["Rotation"].default_value[2] = 0.6
        # Do not run HDRI and the light rig both at full strength.
        bg.inputs["Strength"].default_value = 0.6
    else:
        bg.inputs["Color"].default_value = (0.9, 0.9, 0.9, 1)
        bg.inputs["Strength"].default_value = 0.35
else:
    bg.inputs["Color"].default_value = (0.9, 0.9, 0.9, 1)
    bg.inputs["Strength"].default_value = 0.35

def _aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

# --- sun (fills the shadows the area rig leaves) ---
bpy.ops.object.light_add(type='SUN', location=(centre.x + 5, centre.y - 8, centre.z + 8))
sun = bpy.context.active_object
sun.data.energy = 1.5
_aim(sun, centre)

# --- 3-point + rim area-light rig (intensities by ratio, not absolute watts:
#     no canonical product-rig wattage exists in the manual — the rig is
#     derived from the product bounding box and validated via the look loop).
#     Only the key casts shadows: each shadow-casting light re-renders the
#     scene for its shadow map, and on software GL (llvmpipe) that dominates
#     render time. Fill/rim are shadowless by design; the sun + key still
#     ground the subject. Light size scales with the product (softbox rule:
#     bigger = softer shadows + broader reflections in chrome/glass).
def _area(name, offset, energy, size_m=1.5, shadow=True):
    loc = centre + Vector(offset).normalized() * 2.0
    bpy.ops.object.light_add(type='AREA', location=loc)
    lamp = bpy.context.active_object
    lamp.name = name
    lamp.data.energy = energy
    lamp.data.shape = 'DISK'
    lamp.data.size = size_m
    lamp.data.use_shadow = shadow
    _aim(lamp, centre)
    return lamp

_rig_size = max(0.5, max_dim * 1.5)
_area("KeyLight", (1, -1, 1), 100, size_m=_rig_size)    # key: brightest, 15-45 deg to camera side
_area("FillLight", (-1, 1, 0.5), 40, size_m=_rig_size, shadow=False)  # fill: opposite side, 20-40% of key
_area("RimLight", (0, 1.5, 1), 60, size_m=_rig_size, shadow=False)   # rim: behind the subject, edge separation

# --- camera, auto-framed on the bounding-box centre ---
cam_data = bpy.data.cameras.new("RenderCamera")
cam_data.lens = LENS
cam = bpy.data.objects.new("RenderCamera", cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

scene = bpy.context.scene
if ENGINE == 'CYCLES':
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'  # this VM has no GPU
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'  # CPU denoiser, safe default
    scene.cycles.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
else:
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except Exception:
        scene.render.engine = 'BLENDER_EEVEE'
    # Preview-grade TAA samples (default 64): halves accumulation cost on
    # software GL with no visible difference at this size.
    scene.eevee.taa_render_samples = 32

if VIEW_TRANSFORM:
    scene.view_settings.view_transform = VIEW_TRANSFORM
    scene.view_settings.look = 'None'

scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.image_settings.file_format = 'PNG'
if TRANSPARENT:
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = 'RGBA'
    if ENGINE == 'CYCLES':
        # Cycles-only Shadow Catcher: the plane is invisible, only its shadow remains.
        ground.is_shadow_catcher = True
    else:
        # EEVEE has no shadow catcher: hide the ground, no contact shadow.
        ground.hide_render = True

DIRECTIONS = {
    "front": (0, -1, 0.25),
    "side": (1, 0, 0.25),
    "back": (0, 1, 0.25),
    "top": (0, 0, 1),
    "perspective": (1, -1, 0.6),
}

# Distance: EXACT fill-based framing (v1.3.0 fix). The old heuristic
# (2.5x the longest side + 0.5) framed by the longest side with a huge
# margin: a 0.28 m watch at 50 mm filled ~30% of the frame and the
# v1.3.0 demo watch rendered tiny. Instead, per view: place the camera,
# aim it, transform the model's silhouette points into camera space, and
# rescale the distance until the binding axis fills FILL_FRACTION of the
# frame. The rescale is SIGNED and iterated twice: the first version of
# this fix only ever pulled the camera BACK, so a view whose trial
# distance already fit the subject (the watch side view, looking down
# the 0.22 m strap) stayed at 39% fill forever. The factor is the
# current max frame fraction over the target: factor > 1 moves back,
# factor < 1 moves closer; two iterations converge despite points
# sitting at different depths. Two things the first version also got
# wrong, both measured with world_to_camera_view on the fixed
# headphones (2026-11-08): (1) the lens angles must come from the
# camera itself (cam_data.angle_x/angle_y): with sensor_fit AUTO the
# vertical angle is the full 24 mm sensor height (tan_v = 0.24 at
# 50 mm), NOT 36 mm * aspect (0.2025) — assuming the latter undershot
# the fill; (2) the bound must use mesh vertices, not AABB corners:
# the corners span 66% of the frame while the visible model spans 58%.
# The binding axis then fills exactly fill_fraction (0.7 default) of
# VISIBLE model; nothing is cropped, nothing is tiny. The ground plane
# is excluded — only the model.
def _frame_camera(direction, label):
    direction = Vector(direction).normalized()
    dist = max_dim * 1.2 + 0.1  # trial distance; the rescale solves the rest
    for _attempt in range(2):
        cam.location = centre + direction * dist
        _aim(cam, centre)
        bpy.context.view_layer.update()
        _tan_h = math.tan(cam_data.angle_x / 2)
        _tan_v = math.tan(cam_data.angle_y / 2)
        inv = cam.matrix_world.inverted()
        factor = 0.0
        for pt in _model_pts:
            cx, cy, cz = inv @ pt
            depth = -cz
            if depth <= 0.01:
                continue
            factor = max(factor,
                         abs(cx) / (FILL_FRACTION * _tan_h * depth),
                         abs(cy) / (FILL_FRACTION * _tan_v * depth))
        if factor <= 0:
            break
        # Clamp per-iteration change so a stray vertex can't fling the camera.
        factor = min(max(factor, 0.5), 3.0)
        dist *= factor
        if abs(factor - 1.0) < 0.02:
            break
    cam.location = centre + direction * dist
    _aim(cam, centre)
    bpy.context.view_layer.update()
    print(f"CAMERA_DIST:{label}:{dist:.4f}")
    return dist

rendered = []
for view in views:
    _frame_camera(DIRECTIONS[view], view)
    path = f"{out_prefix}_{view}.png"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    rendered.append({"view": view, "path": path})

# Turntable: exactly 360 deg about Z, camera orbiting at fixed elevation,
# lights fixed. Frame i is at azimuth i * 360 / N (frame N would duplicate
# frame 0, so it is not rendered — the loop closes cleanly).
if TURNTABLE_FRAMES > 0:
    import math as _math
    for _i in range(TURNTABLE_FRAMES):
        _az = 2 * _math.pi * _i / TURNTABLE_FRAMES
        _dir = Vector((_math.cos(_az) * 1.0, _math.sin(_az) * -1.0, 0.6))
        _frame_camera(_dir, f"turntable_{_i:02d}")
        path = f"{out_prefix}_turntable_{_i:02d}.png"
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        rendered.append({"view": f"turntable_{_i:02d}", "path": path})

print("RENDER_DONE_JSON:" + json.dumps({"renders": rendered}))
`;
}
//# sourceMappingURL=render.js.map