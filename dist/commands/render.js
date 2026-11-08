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
 * - Cinematic style (v1.4.0, `style: 'cinematic'`): AgX + Look "AgX - Punchy",
 *   Cycles 512 samples + OIDN, 1920x1080, low-key 8:1 rig (warm key spot,
 *   teal rim 1.5-2x key light-linked to the hero, amber rim + accent),
 *   bounded Principled-Volume fog cube (density 0.01, anisotropy 0.5,
 *   noise-modulated), Mist pass, wet reflective floor, DoF f/5.6, and a
 *   compositor chain (Mist -> Glare Fog Glow -> teal-lift/warm-gain Color
 *   Balance -> S-curve -> vignette -> film grain). Environments:
 *   dark_studio (near-black world + wet floor), industrial_hall (hall box +
 *   columns + background glow planes + fog), neon (emissive strip cards +
 *   under-glow). Optional 1.7 m silhouette scale figure and render-time
 *   monumental hero scaling (`hero_scale_m` — labelled hero-scale, not
 *   real scale). All bpy property/enum names were smoke-tested in real
 *   Blender 4.2.0 before shipping (see research report §9): the AgX Look is
 *   "AgX - Punchy" (bare "Punchy" is wrong), Principled Coat/Anisotropic
 *   inputs are Title Case, light linking works via
 *   `Object.light_linking.receiver_collection`, and
 *   `scene.cycles.volume_sampling` does NOT exist in 4.2 (dropped).
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
    const style = options.style ?? 'studio';
    if (style !== 'studio' && style !== 'cinematic') {
        throw new Error(`Unknown style '${style}'. Allowed: studio, cinematic.`);
    }
    const environment = options.environment ?? 'dark_studio';
    if (environment !== 'dark_studio' && environment !== 'industrial_hall' && environment !== 'neon') {
        throw new Error(`Unknown environment '${environment}'. Allowed: dark_studio, industrial_hall, neon.`);
    }
    const scaleFigure = options.scale_figure ?? false;
    const heroScaleM = options.hero_scale_m;
    if (heroScaleM !== undefined && (heroScaleM < 0.05 || heroScaleM > 50)) {
        throw new Error('hero_scale_m must be between 0.05 and 50 m.');
    }
    const fogDensity = options.fog_density;
    if (fogDensity !== undefined && (fogDensity < 0.001 || fogDensity > 0.2)) {
        throw new Error('fog_density must be between 0.001 and 0.2 (0.01 is the cinematic default).');
    }
    // Python repr parity: integral floats print as "3.0" in Python but "3"
    // in JS — keep the generated scripts byte-identical across servers.
    const pyFloat = (n) => n === undefined ? 'None' : (Number.isInteger(n) ? `${n}.0` : String(n));
    const samples = options.samples ?? (style === 'cinematic' ? 512 : 128);
    if (samples < 1 || samples > 4096) {
        throw new Error('Cycles samples must be between 1 and 4096 (128-256 is the sane CPU range).');
    }
    const lens = options.lens ?? (style === 'cinematic' ? 85 : 50);
    if (lens < 1 || lens > 250) {
        throw new Error('Lens must be between 1 and 250 mm (50 default, 85 hero, 90-105 macro).');
    }
    const turntableFrames = options.turntable_frames ?? 0;
    if (turntableFrames < 0 || turntableFrames > 60) {
        throw new Error('turntable_frames must be between 0 and 60.');
    }
    const resolution = options.resolution ?? (style === 'cinematic' ? [1920, 1080] : (engine === 'CYCLES' ? [1280, 720] : [960, 720]));
    const viewTransform = options.view_transform ?? (style === 'cinematic' ? 'AgX' : '');
    const transparent = options.transparent ?? false;
    if (style === 'cinematic' && transparent) {
        throw new Error("style 'cinematic' needs a visible wet floor; it cannot be combined with transparent=true.");
    }
    const hdriPath = options.hdri_path ?? '';
    const fillFraction = options.fill_fraction ?? (style === 'cinematic' ? 0.4 : 0.7);
    if (fillFraction < 0.3 || fillFraction > 0.95) {
        throw new Error('fill_fraction must be between 0.3 and 0.95 (0.7 fills ~70% of the frame).');
    }
    return `
import bpy, sys, math, json
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
out_prefix = argv[0]
views = argv[1:]
ENGINE = ${JSON.stringify(engine)}
STYLE = ${JSON.stringify(style)}
ENVIRONMENT = ${JSON.stringify(environment)}
SCALE_FIGURE = ${scaleFigure ? 'True' : 'False'}
HERO_SCALE_M = ${pyFloat(heroScaleM)}
FOG_DENSITY = ${pyFloat(fogDensity)}
CINEMATIC = (STYLE == "cinematic")
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

# --- optional monumental scale (cinematic hero): scale the hero so its
#     longest side is HERO_SCALE_M, about the bottom-centre, min z stays 0.
#     The render is hero-scale, not real scale (research report §4.5).
#     Flat scenes only: models with parented parts are out of scope here.
if HERO_SCALE_M:
    _hs = HERO_SCALE_M / max_dim
    _bc = Vector((centre.x, centre.y, lo.z))
    for _o in meshes:
        _o.matrix_world = (Matrix.Translation(_bc)
                           @ Matrix.Diagonal(Vector((_hs, _hs, _hs, 1.0)))
                           @ Matrix.Translation(-_bc) @ _o.matrix_world)
    bpy.context.view_layer.update()
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
    print(f"HERO_SCALED:{max_dim:.4f}")

# --- hall dimensions (cinematic industrial_hall), derived from the hero ---
HALL_L = max(6.0, max_dim * 12)
HALL_W = max(5.0, max_dim * 8)
HALL_H = max(4.0, max_dim * 5)

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
# Cinematic: wet reflective floor (research §2.9/§3.4) — dark concrete,
# Noise -> ColorRamp -> Roughness (puddles 0.02, dry 0.6), wet darkening
# in the base colour, a little bump so reflections ripple. Generated
# coordinates: Noise scale 8 on the plane gives puddles metres across.
# Studio: the old flat grey, roughness 0.95.
# Cinematic floor is sized to the hero (max(8, 15x)), not 50 m: a huge
# wet floor mirrors the big softbox fill at grazing angles (Fresnel) as a
# giant grey blob brighter than the hero. A hero-sized floor keeps the
# reflection streak under the hero and lets the dark world own the rest.
_ground_size = HALL_L if (CINEMATIC and ENVIRONMENT == "industrial_hall") else (max(8.0, max_dim * 15) if CINEMATIC else 50)
bpy.ops.mesh.primitive_plane_add(size=_ground_size, location=(0, 0, 0))
ground = bpy.context.active_object
ground.name = "GroundPlane"
gmat = bpy.data.materials.new(name="GroundMat")
gmat.use_nodes = True
if CINEMATIC:
    _gnt = gmat.node_tree
    _gnodes = _gnt.nodes
    _glinks = _gnt.links
    _gbsdf = _gnodes["Principled BSDF"]
    _gbsdf.inputs["Metallic"].default_value = 0.0
    _gtex = _gnodes.new("ShaderNodeTexCoord")
    _gnoise = _gnodes.new("ShaderNodeTexNoise")
    _gnoise.inputs["Scale"].default_value = 8.0
    _gnoise.inputs["Detail"].default_value = 3.0
    _glinks.new(_gtex.outputs["Generated"], _gnoise.inputs["Vector"])
    # Puddle mask: black stops = standing water (roughness 0.02),
    # white stops = dry concrete (0.6). The gap between the stops is the
    # puddle edge softness. Never pure white dry roughness.
    _gramp = _gnodes.new("ShaderNodeValToRGB")
    _gramp.color_ramp.elements[0].position = 0.45
    _gramp.color_ramp.elements[0].color = (0.02, 0.02, 0.02, 1)
    _gramp.color_ramp.elements[1].position = 0.62
    _gramp.color_ramp.elements[1].color = (0.6, 0.6, 0.6, 1)
    _glinks.new(_gnoise.outputs["Fac"], _gramp.inputs["Fac"])
    _glinks.new(_gramp.outputs["Color"], _gbsdf.inputs["Roughness"])
    # Wet darkening: the same mask darkens the base colour in wet areas
    # (water fills surface irregularities, so wet reads darker, not just
    # shinier). Dry ~#1A1A1C is already dark; wet goes darker still.
    _gcramp = _gnodes.new("ShaderNodeValToRGB")
    _gcramp.color_ramp.elements[0].position = 0.45
    _gcramp.color_ramp.elements[0].color = (0.008, 0.008, 0.01, 1)
    _gcramp.color_ramp.elements[1].position = 0.62
    _gcramp.color_ramp.elements[1].color = (0.02, 0.02, 0.022, 1)
    _glinks.new(_gnoise.outputs["Fac"], _gcramp.inputs["Fac"])
    _glinks.new(_gcramp.outputs["Color"], _gbsdf.inputs["Base Color"])
    _gbump = _gnodes.new("ShaderNodeBump")
    _gbump.inputs["Strength"].default_value = 0.05
    _gbump.inputs["Distance"].default_value = 0.01
    _glinks.new(_gnoise.outputs["Fac"], _gbump.inputs["Height"])
    _glinks.new(_gbump.outputs["Normal"], _gbsdf.inputs["Normal"])
else:
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.55, 0.55, 1)
    gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
ground.data.materials.append(gmat)

# --- world light: studio HDRI when one is given, else the flat world ---
# Cinematic: near-black night world (0, 0, 0.01) at strength 0.1 — a bright
# studio HDRI is the enemy of a dark scene. With an HDRI, strength 0.2 and
# a Light Path split: the camera sees near-black, everything else still
# gets the HDRI to reflect (otherwise metal/glass renders black).
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
        bg.inputs["Strength"].default_value = 0.2 if CINEMATIC else 0.6
        if CINEMATIC:
            # Is Camera Ray -> mix near-black (camera) with the HDRI (rest).
            _lp = world.node_tree.nodes.new("ShaderNodeLightPath")
            _bg_black = world.node_tree.nodes.new("ShaderNodeBackground")
            _bg_black.inputs["Color"].default_value = (0.0, 0.0, 0.01, 1)
            _bg_black.inputs["Strength"].default_value = 0.1
            _mix = world.node_tree.nodes.new("ShaderNodeMixShader")
            world.node_tree.links.new(_lp.outputs["Is Camera Ray"], _mix.inputs["Fac"])
            world.node_tree.links.new(_bg_black.outputs["Background"], _mix.inputs[1])
            world.node_tree.links.new(bg.outputs["Background"], _mix.inputs[2])
            world.node_tree.links.new(_mix.outputs["Shader"],
                                     world.node_tree.nodes["World Output"].inputs["Surface"])
    else:
        bg.inputs["Color"].default_value = (0.0, 0.0, 0.01, 1) if CINEMATIC else (0.9, 0.9, 0.9, 1)
        bg.inputs["Strength"].default_value = 0.1 if CINEMATIC else 0.35
else:
    bg.inputs["Color"].default_value = (0.0, 0.0, 0.01, 1) if CINEMATIC else (0.9, 0.9, 0.9, 1)
    bg.inputs["Strength"].default_value = 0.1 if CINEMATIC else 0.35

def _aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

# --- sun (studio only: fills the shadows the area rig leaves) ---
# Cinematic has no sun: the dim fill + the 0.1 night world are what keep
# shadows readable instead of crushed — a sun would flatten the low-key rig.
if not CINEMATIC:
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

if CINEMATIC:
    # Low-key 8:1 rig (research §2.8): warm key spot high on the three-
    # quarter line (also the god-ray shaft through the fog cube), dim cool
    # fill at 1/8 of key (shadows stay deep but never pure black), teal rim
    # 2x key light-linked to the hero only, warm amber rim opposite, one
    # low warm accent practical. Light distance and power scale with the
    # hero: Cycles lights fall off with inverse square, so doubling the
    # distance needs 4x the power for the same effect — power is derived
    # from scene scale, never hardcoded watts.
    _rig_dist = max(2.0, max_dim * 3.0)
    _pow = (_rig_dist / 2.0) ** 2

    def _spot(name, offset, energy, color, size_rad=0.6, blend=0.4, shadow=True):
        loc = centre + Vector(offset).normalized() * _rig_dist
        bpy.ops.object.light_add(type='SPOT', location=loc)
        lamp = bpy.context.active_object
        lamp.name = name
        lamp.data.energy = energy
        lamp.data.color = color
        lamp.data.spot_size = size_rad
        lamp.data.spot_blend = blend
        lamp.data.use_shadow = shadow
        _aim(lamp, centre)
        return lamp

    def _area_cine(name, offset, energy, color, size_m, shadow=False):
        loc = centre + Vector(offset).normalized() * _rig_dist
        bpy.ops.object.light_add(type='AREA', location=loc)
        lamp = bpy.context.active_object
        lamp.name = name
        lamp.data.energy = energy
        lamp.data.color = color
        lamp.data.shape = 'DISK'
        lamp.data.size = size_m
        lamp.data.use_shadow = shadow
        _aim(lamp, centre)
        return lamp

    # Key: warm (~3200 K: linear RGB 1.0, 0.6, 0.35), high, 45 deg side.
    # Narrow cone (0.5 rad): a defined shaft, not a flood — a wide cone
    # lights the whole fog cube and washes the frame grey.
    _spot("CineKeySpot", (1, -1, 2.2), 100 * _pow, (1.0, 0.6, 0.35),
          size_rad=0.5, blend=0.4, shadow=True)
    # Fill: cool, opposite side, 1/8 of key — the 8:1 low-key ratio.
    # Small (max(0.2, max_dim)) and raised: a big low softbox close to
    # the floor mirrors in the wet floor as a giant grey blob brighter
    # than the hero (first look-loop render) — Fresnel at grazing angles
    # makes even a rough floor mirror a big close light. A small high
    # fill still lifts the shadow side but its floor reflection is a
    # tight patch mostly hidden behind the hero.
    _area_cine("CineFill", (-1, 1, 1.0), 12.5 * _pow, (0.75, 0.85, 1.0),
               size_m=max(0.2, max_dim * 1.0), shadow=False)
    # Rims: behind the hero, aimed at its back contour. Teal left, warm
    # amber right — the teal-orange pair. Brightest lights in effect.
    _rim_teal = _spot("CineRimTeal", (-1.5, 2.0, 1.2), 200 * _pow,
                      (0.3, 0.8, 1.0), size_rad=0.6, blend=0.4, shadow=False)
    _rim_amber = _spot("CineRimAmber", (1.5, 2.0, 1.0), 200 * _pow,
                       (1.0, 0.55, 0.25), size_rad=0.6, blend=0.4, shadow=False)
    # One low warm practical against the teal scene.
    bpy.ops.object.light_add(type='POINT',
                             location=centre + Vector((1.0, 1.2, 0.15)).normalized() * _rig_dist)
    _accent = bpy.context.active_object
    _accent.name = "CineAccent"
    _accent.data.energy = 10 * _pow
    _accent.data.color = (1.0, 0.55, 0.2)
    _accent.data.use_shadow = False
    # Light linking: the teal rim lights ONLY the hero, otherwise the
    # whole hall goes cyan. Verified in Blender 4.2.0 (research §9); if
    # the API ever changes, warn and continue unlinked — the render still
    # works, it just loses the isolation.
    try:
        _hero_coll = bpy.data.collections.new("CinematicHero")
        bpy.context.scene.collection.children.link(_hero_coll)
        for _o in meshes:
            _hero_coll.objects.link(_o)
        _rim_teal.light_linking.receiver_collection = _hero_coll
        _rim_amber.light_linking.receiver_collection = _hero_coll
    except Exception as _e:
        print(f"LIGHT_LINK_WARN: rim light linking skipped ({_e})")
else:
    _area("KeyLight", (1, -1, 1), 100, size_m=_rig_size)    # key: brightest, 15-45 deg to camera side
    _area("FillLight", (-1, 1, 0.5), 40, size_m=_rig_size, shadow=False)  # fill: opposite side, 20-40% of key
    _area("RimLight", (0, 1.5, 1), 60, size_m=_rig_size, shadow=False)   # rim: behind the subject, edge separation

# --- cinematic environment: hall / neon / fog / scale figure ---
# All dimensions derive from the hero bounding box (nothing is hardcoded
# in metres for a "typical" product — a 0.13 m can and a 3 m monument get
# different halls). The fog cube and figure are added AFTER _model_pts, so
# framing stays on the hero alone.
if CINEMATIC:
    def _dark_mat(name, color=(0.03, 0.03, 0.035, 1), rough=0.9):
        m = bpy.data.materials.new(name=name)
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
        m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = rough
        return m

    def _emissive_mat(name, color, strength):
        m = bpy.data.materials.new(name=name)
        m.use_nodes = True
        _b = m.node_tree.nodes["Principled BSDF"]
        _b.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
        _b.inputs["Emission Color"].default_value = (color[0], color[1], color[2], 1)
        _b.inputs["Emission Strength"].default_value = strength
        return m

    if ENVIRONMENT == "industrial_hall":
        # Hall as separate wall/floor/ceiling planes (each lit and graded
        # independently) + columns + dim background glow planes. The hall
        # is lit only by spill from the hero lights and the glow cards —
        # an evenly lit hall is a studio, not a location.
        _wall_mat = _dark_mat("HallWallMat")
        bpy.ops.mesh.primitive_plane_add(size=1, location=(centre.x, centre.y + HALL_W / 2, HALL_H / 2),
                                         rotation=(1.57079632679, 0, 0))
        _bw = bpy.context.active_object
        _bw.name = "HallBackWall"
        _bw.dimensions = (HALL_L, HALL_H, 0)
        _bw.data.materials.append(_wall_mat)
        for _sx in (-1, 1):
            bpy.ops.mesh.primitive_plane_add(size=1, location=(centre.x + _sx * HALL_L / 2, centre.y, HALL_H / 2),
                                             rotation=(0, 1.57079632679, 0))
            _sw = bpy.context.active_object
            _sw.name = "HallSideWall"
            _sw.dimensions = (HALL_H, HALL_W, 0)
            _sw.data.materials.append(_wall_mat)
        bpy.ops.mesh.primitive_plane_add(size=1, location=(centre.x, centre.y, HALL_H),
                                         rotation=(3.14159265359, 0, 0))
        _ceil = bpy.context.active_object
        _ceil.name = "HallCeiling"
        _ceil.dimensions = (HALL_L, HALL_W, 0)
        _ceil.data.materials.append(_wall_mat)
        # Columns: barely visible, catching slivers of rim light.
        _col_r = max(0.06, HALL_H * 0.02)
        for _cx in (-HALL_L * 0.32, HALL_L * 0.32):
            for _cy in (centre.y - HALL_W * 0.32, centre.y + HALL_W * 0.32):
                bpy.ops.mesh.primitive_cylinder_add(radius=_col_r, depth=HALL_H,
                                                    location=(_cx, _cy, HALL_H / 2))
                _col = bpy.context.active_object
                _col.name = "HallColumn"
                _col.data.materials.append(_wall_mat)
        # Background glow: distant windows / practicals, teal + warm.
        for _gx, _gcol, _gstr in ((-HALL_L * 0.22, (0.0, 0.8, 1.0), 0.3),
                                  (HALL_L * 0.22, (1.0, 0.55, 0.25), 0.2)):
            bpy.ops.mesh.primitive_plane_add(size=1,
                                             location=(centre.x + _gx, centre.y + HALL_W / 2 - 0.05, HALL_H * 0.55),
                                             rotation=(1.57079632679, 0, 0))
            _gp = bpy.context.active_object
            _gp.name = "HallGlow"
            _gp.dimensions = (HALL_L * 0.25, HALL_H * 0.35, 0)
            _gp.data.materials.append(_emissive_mat("HallGlowMat", _gcol, _gstr))

    if ENVIRONMENT == "neon":
        # Emissive strip cards just out of frame (teal left, amber right)
        # give the metal something coloured to reflect along the edge,
        # plus a cyan under-glow pool on the floor around the base.
        _strip_h = max_dim * 1.6
        for _sx, _scol in ((-1, (0.0, 0.85, 1.0)), (1, (1.0, 0.55, 0.25))):
            bpy.ops.mesh.primitive_cube_add(
                location=(centre.x + _sx * (size.x / 2 + max_dim * 0.4),
                          centre.y + size.y / 2 + max_dim * 0.3, _strip_h / 2))
            _strip = bpy.context.active_object
            _strip.name = "NeonStrip"
            _strip.dimensions = (0.06, 0.06, _strip_h)
            _strip.data.materials.append(_emissive_mat("NeonStripMat", _scol, 5.0))
        bpy.ops.mesh.primitive_cylinder_add(radius=max_dim * 0.7, depth=0.01,
                                            location=(centre.x, centre.y, 0.005))
        _ug = bpy.context.active_object
        _ug.name = "UnderGlow"
        _ug.data.materials.append(_emissive_mat("UnderGlowMat", (0.0, 0.85, 1.0), 2.0))

    # Fog cube: bounded Principled Volume, density 0.01 (the bottom of the
    # corroborated 0.01-0.05 range — 0.02 backlit by the key spot washed
    # the whole frame grey in the first look-loop render), anisotropy 0.5,
    # noise-modulated so the fog is patchy air, not a Photoshop gradient.
    # A bounded cube, not a world volume: you only pay for scattering
    # where the shafts are. Kept tight (2.5x hero) so the camera looks
    # through as little fog as possible in front of the hero.
    _fog_density = FOG_DENSITY if FOG_DENSITY is not None else 0.01
    bpy.ops.mesh.primitive_cube_add(size=1, location=(centre.x, centre.y, centre.z + max_dim * 0.5))
    _fog = bpy.context.active_object
    _fog.name = "FogCube"
    _fog.dimensions = (max_dim * 2.5, max_dim * 2.5, max_dim * 2.5)
    _fmat = bpy.data.materials.new(name="FogVolumeMat")
    _fmat.use_nodes = True
    _fnt = _fmat.node_tree
    _fnt.nodes.remove(_fnt.nodes["Principled BSDF"])
    _pv = _fnt.nodes.new("ShaderNodeVolumePrincipled")
    _pv.inputs["Anisotropy"].default_value = 0.5
    _pv.inputs["Color"].default_value = (0.75, 0.85, 0.9, 1)
    _ftex = _fnt.nodes.new("ShaderNodeTexCoord")
    _fnoise = _fnt.nodes.new("ShaderNodeTexNoise")
    _fnoise.inputs["Scale"].default_value = 3.0
    _fnoise.inputs["Detail"].default_value = 5.0
    _fnt.links.new(_ftex.outputs["Generated"], _fnoise.inputs["Vector"])
    _fmap = _fnt.nodes.new("ShaderNodeMapRange")
    _fmap.inputs["From Min"].default_value = 0.0
    _fmap.inputs["From Max"].default_value = 1.0
    _fmap.inputs["To Min"].default_value = 0.5
    _fmap.inputs["To Max"].default_value = 1.0
    _fnt.links.new(_fnoise.outputs["Fac"], _fmap.inputs["Value"])
    _fmul = _fnt.nodes.new("ShaderNodeMath")
    _fmul.operation = 'MULTIPLY'
    _fmul.inputs[1].default_value = _fog_density
    _fnt.links.new(_fmap.outputs["Result"], _fmul.inputs[0])
    _fnt.links.new(_fmul.outputs["Value"], _pv.inputs["Density"])
    _fnt.links.new(_pv.outputs["Volume"], _fnt.nodes["Material Output"].inputs["Volume"])
    _fog.data.materials.append(_fmat)

    if SCALE_FIGURE:
        # 1.7 m silhouette human at the hero's base, front-right, backlit
        # so only its rim is visible. Deliberately no face/fingers/clothing
        # detail: at render distance it is 30-60 px tall. Min z = 0.
        # The figure is linked into the CinematicHero collection so the
        # teal rim lights catch one edge of it — without that it renders
        # as an unreadable black blob (first look-loop render).
        _fig_mat = _dark_mat("ScaleFigureMat", color=(0.01, 0.01, 0.01, 1), rough=1.0)
        _fig_parts = []
        _fx = centre.x + size.x / 2 + max(0.25, max_dim * 0.25)
        _fy = centre.y - size.y / 2 - max(0.25, max_dim * 0.25)
        for _lx in (-0.09, 0.09):
            bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=0.8, location=(_fx + _lx, _fy, 0.4))
            _leg = bpy.context.active_object
            _leg.name = "ScaleFigure_Leg"
            _leg.data.materials.append(_fig_mat)
            _fig_parts.append(_leg)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.15, depth=0.75, location=(_fx, _fy, 1.15))
        _torso = bpy.context.active_object
        _torso.name = "ScaleFigure_Torso"
        _torso.data.materials.append(_fig_mat)
        _fig_parts.append(_torso)
        for _ax in (-0.2, 0.2):
            bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=0.65, location=(_fx + _ax, _fy, 1.15))
            _arm = bpy.context.active_object
            _arm.name = "ScaleFigure_Arm"
            _arm.data.materials.append(_fig_mat)
            _fig_parts.append(_arm)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.11, location=(_fx, _fy, 1.62))
        _head = bpy.context.active_object
        _head.name = "ScaleFigure_Head"
        _head.data.materials.append(_fig_mat)
        _fig_parts.append(_head)
        try:
            for _part in _fig_parts:
                _hero_coll.objects.link(_part)
        except NameError:
            pass

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
    if CINEMATIC:
        # Dark-scene light paths (research §2.11): Volume 2 (the 0 default
        # makes fog flat/dark), indirect clamp 3 (direct stays 0 — clamping
        # direct kills the highlights the Glare node needs), caustics off
        # (classic firefly source; the reference has none), Light Tree on.
        scene.cycles.max_bounces = 12
        scene.cycles.diffuse_bounces = 4
        scene.cycles.glossy_bounces = 4
        scene.cycles.transmission_bounces = 8
        scene.cycles.transparent_max_bounces = 8
        scene.cycles.volume_bounces = 2
        scene.cycles.sample_clamp_indirect = 3.0
        scene.cycles.use_light_tree = True
        scene.cycles.use_caustics_reflective = False
        scene.cycles.use_caustics_refractive = False
        scene.cycles.filter_glossy = 0.5
        scene.cycles.denoising_prefilter = 'ACCURATE'
else:
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except Exception:
        scene.render.engine = 'BLENDER_EEVEE'
    # Preview-grade TAA samples (default 64): halves accumulation cost on
    # software GL with no visible difference at this size.
    scene.eevee.taa_render_samples = 32

if CINEMATIC:
    # DoF: establishing f/5.6 (deep focus — hero + hall + scale figure all
    # readable; never f/1.4 for a scene whose point is scale). Focus
    # distance is set per view in _frame_camera (camera -> hero distance).
    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = 5.6
    cam_data.dof.aperture_blades = 6
    cam_data.dof.aperture_ratio = 1.0
    # Mist pass for distance haze in the compositor (Start/Depth set per
    # view in the render loop: Start = camera->hero, Depth = 2.5x that).
    bpy.context.view_layer.use_pass_mist = True
    world.mist_settings.falloff = 'QUADRATIC'

if VIEW_TRANSFORM:
    scene.view_settings.view_transform = VIEW_TRANSFORM
    # AgX Look enum names in Blender 4.2 are prefixed ("AgX - Punchy",
    # not "Punchy" — bare "Punchy" raises TypeError; verified in 4.2.0).
    scene.view_settings.look = 'AgX - Punchy' if (CINEMATIC and VIEW_TRANSFORM == 'AgX') else 'None'

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
    if CINEMATIC:
        cam_data.dof.focus_distance = dist
    return dist

# --- cinematic compositor: Mist -> Glare -> grade -> S-curve -> vignette -> grain ---
# Order matters: denoise happens in the render itself; grading before glow
# changes what blooms, so glow comes first and grain always last.
def _build_cinematic_compositor():
    scene.use_nodes = True
    nt = scene.node_tree
    rl = nt.nodes.get("Render Layers")
    comp = nt.nodes.get("Composite")
    if rl is None or comp is None:
        print("COMPOSITOR_WARN: no Render Layers/Composite node; skipping cinematic grade")
        return
    # Mist: distance haze, dark blue-grey fog colour (not white — night scene).
    mist_mix = nt.nodes.new("CompositorNodeMixRGB")
    mist_mix.blend_type = 'MIX'
    mist_mix.inputs[2].default_value = (0.05, 0.07, 0.09, 1)
    nt.links.new(rl.outputs["Mist"], mist_mix.inputs[0])
    nt.links.new(rl.outputs["Image"], mist_mix.inputs[1])
    # Glare Fog Glow: threshold 1.0 so only HDR highlights bloom (the dark
    # hall stays clean); size 7 (log scale: 9 = whole image — milky);
    # mix 0.0 (50% glow). Quality High for finals.
    glare = nt.nodes.new("CompositorNodeGlare")
    glare.glare_type = 'FOG_GLOW'
    glare.threshold = 1.0
    glare.size = 7
    glare.mix = 0.0
    glare.quality = 'HIGH'
    nt.links.new(mist_mix.outputs["Image"], glare.inputs["Image"])
    # Colour grade: Lift toward teal/cyan, Gain toward warm, Gamma near-neutral.
    grade = nt.nodes.new("CompositorNodeColorBalance")
    grade.correction_method = 'LIFT_GAMMA_GAIN'
    grade.lift = (0.96, 1.0, 1.05)
    grade.gamma = (1.0, 1.0, 1.02)
    grade.gain = (1.04, 1.0, 0.96)
    nt.links.new(glare.outputs["Image"], grade.inputs["Image"])
    # S-curve: gentle contrast, black point lifted to ~0.02 output — deep
    # shadows, never pure 0 (shadow detail survives the grade).
    curves = nt.nodes.new("CompositorNodeCurveRGB")
    _c = curves.mapping.curves[0]
    _c.points[0].location = (0.0, 0.02)
    _c.points.new(0.25, 0.22)
    _c.points.new(0.75, 0.78)
    curves.mapping.update()
    nt.links.new(grade.outputs["Image"], curves.inputs["Image"])
    # Saturation 1.05: teal/orange reads better slightly desaturated overall.
    sat = nt.nodes.new("CompositorNodeHueSat")
    sat.inputs["Saturation"].default_value = 1.05
    nt.links.new(curves.outputs["Image"], sat.inputs["Image"])
    # Vignette 0.2: radial gradient image (1.0 centre -> 0.8 corners),
    # multiplied in. Built as pixels, not an Ellipse Mask node: the mask
    # node's width/height are capped at 320 px in Blender 4.2, useless
    # for a full-frame vignette at 1920x1080. Built at the FULL render
    # resolution: the Mix node takes the smaller input's size, so a
    # 256x256 vignette shrank the whole compositor output to a centred
    # 256x256 square — the 2026-11-08 NISHANT hero lost its lid, glow
    # ring and base to this (the 960x540 diag only survived because the
    # whole can fit inside 256x256).
    _vw, _vh = RES_X, RES_Y
    _vig = bpy.data.images.new("CineVignette", _vw, _vh)
    _px = []
    for _yy in range(_vh):
        for _xx in range(_vw):
            _dx = (_xx - _vw / 2) / (_vw * 0.62)
            _dy = (_yy - _vh / 2) / (_vh * 0.62)
            _d = math.sqrt(_dx * _dx + _dy * _dy)
            _t = min(max((_d - 0.6) / 0.45, 0.0), 1.0)
            _v = 1.0 - 0.2 * _t * _t
            _px.extend((_v, _v, _v, 1.0))
    _vig.pixels = _px
    vig_img = nt.nodes.new("CompositorNodeImage")
    vig_img.image = _vig
    vig_mix = nt.nodes.new("CompositorNodeMixRGB")
    vig_mix.blend_type = 'MULTIPLY'
    vig_mix.inputs[0].default_value = 1.0
    nt.links.new(sat.outputs["Image"], vig_mix.inputs[1])
    nt.links.new(vig_img.outputs["Image"], vig_mix.inputs[2])
    # Film grain 0.03: a faint Clouds texture kills banding in dark
    # gradients (fog, vignette) in 8-bit PNG output.
    _grain_tex = bpy.data.textures.new("CineGrain", type='CLOUDS')
    _grain_tex.noise_scale = 0.25
    grain_tex = nt.nodes.new("CompositorNodeTexture")
    grain_tex.texture = _grain_tex
    grain_mix = nt.nodes.new("CompositorNodeMixRGB")
    grain_mix.blend_type = 'MIX'
    grain_mix.inputs[0].default_value = 0.03
    nt.links.new(vig_mix.outputs["Image"], grain_mix.inputs[1])
    nt.links.new(grain_tex.outputs["Color"], grain_mix.inputs[2])
    nt.links.new(grain_mix.outputs["Image"], comp.inputs["Image"])

if CINEMATIC:
    _build_cinematic_compositor()

rendered = []
for view in views:
    _dist = _frame_camera(DIRECTIONS[view], view)
    if CINEMATIC:
        # Mist: Start = camera->hero distance, Depth = 2.5x that — the
        # hero stays clear, the hall behind it dissolves.
        world.mist_settings.start = _dist
        world.mist_settings.depth = _dist * 2.5
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
        _tdist = _frame_camera(_dir, f"turntable_{_i:02d}")
        if CINEMATIC:
            world.mist_settings.start = _tdist
            world.mist_settings.depth = _tdist * 2.5
        path = f"{out_prefix}_turntable_{_i:02d}.png"
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        rendered.append({"view": f"turntable_{_i:02d}", "path": path})

print("RENDER_DONE_JSON:" + json.dumps({"renders": rendered}))
`;
}
//# sourceMappingURL=render.js.map