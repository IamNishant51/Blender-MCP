/**
 * Presentation rendering (Blender-MCP 1.2.0) — `render_model` support.
 *
 * Builds the Blender script that applies the presentation preset and
 * renders EEVEE PNGs, one per view:
 *
 * - 50 mm camera, auto-framed on the bounding-box centre with margin
 * - 3-point area-light rig: key ~100 W at 2 m, fill at most half the key,
 *   rim behind — plus a sun and a world light
 * - ground plane at z = 0
 *
 * The script is run as `blender --background <blend> --python <script> --
 * <output_prefix> <view...>` and prints a RENDER_DONE_JSON line. The host
 * (ModelBuilder.renderModel) verifies every PNG exists on disk and is
 * non-empty before reporting success — a missing/empty PNG is a failure,
 * never success:true.
 */

export const RENDER_VIEWS = ['front', 'side', 'back', 'top', 'perspective'] as const;
export type RenderView = (typeof RENDER_VIEWS)[number];

export function buildRenderScript(views: string[]): string {
  const bad = views.filter((v) => !(RENDER_VIEWS as readonly string[]).includes(v));
  if (bad.length > 0) {
    throw new Error(`Unknown view(s): ${bad.join(', ')}. Allowed views: ${RENDER_VIEWS.join(', ')}`);
  }
  if (views.length === 0) {
    throw new Error('At least one view is required.');
  }
  return `
import bpy, sys, math, json
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
out_prefix = argv[0]
views = argv[1:]

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

# --- world light ---
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
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

# --- 3-point area-light rig (bl-mcp wattage table, dimmed for colour: ~100 W at 2 m) ---
# Only the key casts shadows: each shadow-casting light re-renders the
# scene for its shadow map, and on software GL (llvmpipe) that dominates
# render time. Fill/rim are shadowless by design; the sun + key still
# ground the subject. Standard 3-point practice.
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

_area("KeyLight", (1, -1, 1), 100)    # key: brightest, 15-45 deg to camera side
_area("FillLight", (-1, 1, 0.5), 40, shadow=False)  # fill: opposite side, under half the key
_area("RimLight", (0, 1.5, 1), 60, shadow=False)   # rim: behind the subject

# --- 50 mm camera, auto-framed on the bounding-box centre ---
cam_data = bpy.data.cameras.new("RenderCamera")
cam_data.lens = 50
cam = bpy.data.objects.new("RenderCamera", cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception:
    scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 960
scene.render.resolution_y = 720
scene.render.image_settings.file_format = 'PNG'
# Preview-grade TAA samples (default 64): halves accumulation cost on
# software GL with no visible difference at this size.
scene.eevee.taa_render_samples = 32

DIRECTIONS = {
    "front": (0, -1, 0.25),
    "side": (1, 0, 0.25),
    "back": (0, 1, 0.25),
    "top": (0, 0, 1),
    "perspective": (1, -1, 0.6),
}

# Distance: frame the longest side with margin (50 mm lens).
dist = max_dim * 1.8 + 0.5
rendered = []
for view in views:
    direction = Vector(DIRECTIONS[view]).normalized()
    cam.location = centre + direction * dist
    _aim(cam, centre)
    bpy.context.view_layer.update()
    path = f"{out_prefix}_{view}.png"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    rendered.append({"view": view, "path": path})

print("RENDER_DONE_JSON:" + json.dumps({"renders": rendered}))
`;
}
