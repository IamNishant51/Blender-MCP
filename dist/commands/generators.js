/**
 * Model script generators - Python scripts for Blender
 *
 * Conventions (v1.1.0): Blender is Z-up. Z is height, ground is z = 0.
 * All dimensions are in metres and every part's lowest point is at z >= 0.
 * The five templates below are the only built-in models; anything else must
 * go through `execute_blender_code` (see src/index.ts) — there is deliberately
 * no default template.
 */
export function generateTempleScript(custom = '') {
    let color = [0.95, 0.93, 0.9, 1];
    if (custom.toLowerCase().includes('red')) {
        color = [0.75, 0.25, 0.2, 1];
    }
    else if (custom.toLowerCase().includes('sandstone')) {
        color = [0.85, 0.75, 0.6, 1];
    }
    return `
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Adhishthana (Base) - 4 steps ascending in Z, top step at z = 0.6
for i in range(4):
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.075 + i * 0.15))
    base = bpy.context.active_object
    base.name = f"Adhisthana_{i}"
    base.scale = ((4.5 - i * 0.3) / 2, (3.5 - i * 0.2) / 2, 0.075)

# Garbhagriha (Main Sanctum) - 3.0 wide x 2.5 deep x 2.2 tall, standing on the steps
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.7))
garbha = bpy.context.active_object
garbha.name = "Garbhagriha"
garbha.scale = (1.5, 1.25, 1.1)

# Shikhara (Tower) - 5 tiers stacked in +Z above the sanctum (top z = 2.8), up to z = 6.8
for tier in range(5):
    radius = 1.8 - tier * 0.25
    bpy.ops.mesh.primitive_cone_add(location=(0, 0, 3.2 + tier * 0.8), vertices=16 + tier * 2)
    shikhara = bpy.context.active_object
    shikhara.name = f"ShikharaTier_{tier}"
    shikhara.scale = (radius, radius, 0.4)

# Stupi and Kalasha - finials on top of the tower
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 6.95), radius=0.15)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 7.2), radius=0.2)

# Mandapa (Pillared Hall) - platform in front of the sanctum (towards -Y)
bpy.ops.mesh.primitive_cube_add(location=(0, -3.5, 0.15))
bpy.context.active_object.name = "Mandapa"
bpy.context.active_object.scale = (1.5, 1.0, 0.15)

# Pillars - standing on the mandapa platform (z = 0.3) up to the roof (z = 2.8)
for x, y in [(-1.2, -3.0), (1.2, -3.0), (-1.2, -4.0), (1.2, -4.0)]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 1.55), depth=2.5, radius=0.15)

# Mandapa roof
bpy.ops.mesh.primitive_cube_add(location=(0, -3.5, 2.95))
bpy.context.active_object.name = "MandapaRoof"
bpy.context.active_object.scale = (1.5, 1.0, 0.15)

# Material
mat = bpy.data.materials.new(name="TempleMaterial")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(color)}
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.3
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.0

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

# Lighting
bpy.ops.object.light_add(type="SUN", location=(5, -8, 8))
bpy.context.active_object.data.energy = 3
bpy.ops.object.light_add(type="POINT", location=(-3, 3, 5))
bpy.context.active_object.data.energy = 200

print("Created Indian temple")
`;
}
export function generateRickshawScript(custom = '') {
    let color = [0.95, 0.7, 0.1, 1]; // Yellow
    if (custom.toLowerCase().includes('red')) {
        color = [0.8, 0.15, 0.1, 1];
    }
    else if (custom.toLowerCase().includes('blue')) {
        color = [0.1, 0.3, 0.8, 1];
    }
    return `
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Bajaj RE (research spec): 2.66 long (X) x 1.30 wide (Y) x 1.70 high (Z),
# wheelbase 2.00, ground clearance 0.20, 3 wheels (1 front, 2 rear), tyre Ø 0.42.
# Front is +X. All parts stand on the ground (z = 0).

# Floor / chassis pan - 2.30 x 1.15 x 0.06, bottom at z = 0.20 (ground clearance)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.23))
bpy.context.active_object.name = "FloorPan"
bpy.context.active_object.scale = (1.15, 0.575, 0.03)

# Wheels - 3 only, tyre Ø 0.42 (torus major 0.15 + minor 0.06), centres at z = 0.21.
# Torus ring lies in the XY plane by default; rotating 90 deg about X puts the
# ring in the XZ plane so the axle runs along Y and the wheel rolls along X.
for x, y in [(1.05, 0), (-0.95, 0.575), (-0.95, -0.575)]:
    bpy.ops.mesh.primitive_torus_add(location=(x, y, 0.21), major_radius=0.15, minor_radius=0.06)
    wheel = bpy.context.active_object
    wheel.name = "Wheel"
    wheel.rotation_euler = (pi / 2, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 0.21), radius=0.09, depth=0.13)
    hub = bpy.context.active_object
    hub.name = "WheelHub"
    hub.rotation_euler = (pi / 2, 0, 0)

# Mudguards - shallow angled panels arcing over each wheel (a full torus ring
# would dip below the ground); body colour
for x, y in [(1.05, 0), (-0.95, 0.575), (-0.95, -0.575)]:
    for dx, rot in [(-0.125, -0.38), (0.125, 0.38)]:
        bpy.ops.mesh.primitive_cube_add(location=(x + dx, y, 0.475))
        guard = bpy.context.active_object
        guard.name = "Mudguard"
        guard.scale = (0.15, 0.08, 0.015)
        guard.rotation_euler = (0, rot, 0)

# Front fork / steering column - Ø 0.08 x 0.75, raked back ~15 deg, z 0.35-1.10
bpy.ops.mesh.primitive_cylinder_add(location=(1.05, 0, 0.725), radius=0.04, depth=0.75)
bpy.context.active_object.name = "FrontFork"
bpy.context.active_object.rotation_euler = (0, -0.2618, 0)

# Handlebar - 0.55 wide, at z = 1.05
bpy.ops.mesh.primitive_cylinder_add(location=(0.95, 0, 1.05), radius=0.0175, depth=0.55)
bpy.context.active_object.name = "Handlebar"
bpy.context.active_object.rotation_euler = (pi / 2, 0, 0)

# Headlight - single round centre light, Ø 0.15 at the nose (x = 1.28, z = 0.85)
bpy.ops.mesh.primitive_cylinder_add(location=(1.28, 0, 0.85), radius=0.075, depth=0.10)
bpy.context.active_object.name = "Headlight"
bpy.context.active_object.rotation_euler = (0, pi / 2, 0)
bpy.ops.mesh.primitive_cylinder_add(location=(1.33, 0, 0.85), radius=0.06, depth=0.02)
bpy.context.active_object.name = "HeadlightLens"
bpy.context.active_object.rotation_euler = (0, pi / 2, 0)

# Front apron / nose panel - 0.35 x 0.55 x 0.55, z 0.35-0.90
bpy.ops.mesh.primitive_cube_add(location=(1.125, 0, 0.625))
bpy.context.active_object.name = "FrontApron"
bpy.context.active_object.scale = (0.175, 0.275, 0.275)

# Windshield - 0.95 wide x 0.45 high, tilted back ~20 deg, z 0.95-1.40
bpy.ops.mesh.primitive_cube_add(location=(0.80, 0, 1.175))
bpy.context.active_object.name = "Windshield"
bpy.context.active_object.scale = (0.01, 0.475, 0.225)
bpy.context.active_object.rotation_euler = (0, -0.349, 0)

# Driver seat - 0.45 x 0.45 x 0.10, seat top at z = 0.62
bpy.ops.mesh.primitive_cube_add(location=(0.45, 0, 0.57))
bpy.context.active_object.name = "DriverSeat"
bpy.context.active_object.scale = (0.225, 0.225, 0.05)

# Passenger bench - 0.55 deep x 1.05 wide x 0.12, seat top at z = 0.60
bpy.ops.mesh.primitive_cube_add(location=(-0.55, 0, 0.54))
bpy.context.active_object.name = "PassengerBench"
bpy.context.active_object.scale = (0.275, 0.525, 0.06)

# Body side panels - 1.30 long x 0.55 high, on both sides
for y in [0.60, -0.60]:
    bpy.ops.mesh.primitive_cube_add(location=(-0.35, y, 0.575))
    bpy.context.active_object.name = "BodySidePanel"
    bpy.context.active_object.scale = (0.65, 0.02, 0.275)

# Canopy / roof - LOW thin curved black sheet, 2.20 x 1.25, peaking at z = 1.70.
# It must NOT swallow the body: a thin sheet (< 0.2 m thick), not a dome.
# It runs the full length so it covers the windshield, and 4 pillars hold
# it up - so it reads as a roof, not a floating saucer.
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.64), radius=1.0)
bpy.context.active_object.name = "Canopy"
bpy.context.active_object.scale = (1.1, 0.625, 0.06)

# Canopy support pillars - 4 thin black posts from the body (z = 0.85)
# up to the canopy underside, so the roof is visibly held up, not floating.
for x, y in [(0.55, 0.48), (0.55, -0.48), (-0.7, 0.48), (-0.7, -0.48)]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 1.22), radius=0.02, depth=0.75)
    bpy.context.active_object.name = "CanopyPillar"

# Rear panel - 0.05 x 1.10 x 0.40, z 0.45-0.85
bpy.ops.mesh.primitive_cube_add(location=(-1.30, 0, 0.65))
bpy.context.active_object.name = "RearPanel"
bpy.context.active_object.scale = (0.025, 0.55, 0.20)

# Tail lights - small red lamps on the rear panel
for y in [0.45, -0.45]:
    bpy.ops.mesh.primitive_cube_add(location=(-1.33, y, 0.55))
    bpy.context.active_object.name = "TailLight"
    bpy.context.active_object.scale = (0.02, 0.06, 0.04)

# Materials - two-tone: yellow body + black lower, black vinyl seats, chrome, glass
mat_body = bpy.data.materials.new(name="AutoBody")
mat_body.use_nodes = True
mat_body.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(color)}
mat_body.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
mat_body.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.3

mat_black = bpy.data.materials.new(name="BlackVinyl")
mat_black.use_nodes = True
mat_black.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.05, 1)
mat_black.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

mat_chrome = bpy.data.materials.new(name="Chrome")
mat_chrome.use_nodes = True
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.15

mat_glass = bpy.data.materials.new(name="Glass")
mat_glass.use_nodes = True
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.9, 0.95, 1)
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Transmission Weight"].default_value = 0.9
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.05

mat_lens = bpy.data.materials.new(name="HeadlightLensMat")
mat_lens.use_nodes = True
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1.0, 0.95, 0.7, 1)
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (1.0, 0.9, 0.6, 1)
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.5

mat_red = bpy.data.materials.new(name="TailLightMat")
mat_red.use_nodes = True
mat_red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.05, 0.05, 1)
mat_red.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.8, 0.05, 0.05, 1)
mat_red.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.4

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    # Blender renames duplicates (Wheel.001, Mudguard.002, ...), so match on
    # the base name - otherwise only the first copy gets a material.
    base = obj.name.split(".")[0]
    if base in ("FrontApron", "BodySidePanel", "RearPanel", "Mudguard"):
        obj.data.materials.append(mat_body)
    elif base in ("FloorPan", "DriverSeat", "PassengerBench", "Canopy", "CanopyPillar", "FrontFork", "Wheel"):
        obj.data.materials.append(mat_black)
    elif obj.name in ("Handlebar", "Headlight", "WheelHub"):
        obj.data.materials.append(mat_chrome)
    elif obj.name == "Windshield":
        obj.data.materials.append(mat_glass)
    elif obj.name == "HeadlightLens":
        obj.data.materials.append(mat_lens)
    elif obj.name == "TailLight":
        obj.data.materials.append(mat_red)

bpy.ops.object.light_add(type="SUN", location=(3, -5, 4))
bpy.context.active_object.data.energy = 2

print("Created auto-rickshaw")
`;
}
export function generateThaliScript(_custom = '') {
    return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Steel plate - Ø 0.32, depth 0.022, sitting on the ground (research: GeM spec)
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.011), radius=0.16, depth=0.022)
plate = bpy.context.active_object
plate.name = "ThaliPlate"

# Rice mound - Ø 0.13 dome, H 0.05, centre of the plate
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 0.047), radius=0.065)
rice = bpy.context.active_object
rice.name = "RiceMound"
rice.scale = (1, 1, 0.3846)

# Katoris x4 - Ø 0.10 top, Ø 0.06 base, H 0.04, in a ring around the rice.
# Each has its own contents with a distinct colour.
katori_contents = [
    ((0.10, 0), "Dal", (0.85, 0.35, 0.05, 1)),
    ((0, 0.10), "Sabzi", (0.15, 0.45, 0.10, 1)),
    ((-0.10, 0), "Curd", (0.97, 0.97, 0.97, 1)),
    ((0, -0.10), "Kheer", (0.9, 0.8, 0.5, 1)),
]
for (x, y), food, food_color in katori_contents:
    bpy.ops.mesh.primitive_cone_add(location=(x, y, 0.042), radius1=0.03, radius2=0.05, depth=0.04, vertices=24)
    bpy.context.active_object.name = f"Katori_{food}"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 0.060), radius=0.046, depth=0.008)
    content = bpy.context.active_object
    content.name = food
    cmat = bpy.data.materials.new(name=f"{food}Mat")
    cmat.use_nodes = True
    cmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = food_color
    cmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
    content.data.materials.append(cmat)

# Roti - Ø 0.16, folded in half, flat on the plate edge (diagonal gap)
bpy.ops.mesh.primitive_cylinder_add(location=(0.0707, -0.0707, 0.0235), radius=0.08, depth=0.003)
roti = bpy.context.active_object
roti.name = "Roti"
roti.scale = (1, 0.55, 1)

# Materials - bright polished steel, NOT flat grey; each food its own material
mat_steel = bpy.data.materials.new(name="PolishedSteel")
mat_steel.use_nodes = True
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1)
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.1

mat_rice = bpy.data.materials.new(name="Rice")
mat_rice.use_nodes = True
mat_rice.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.96, 0.96, 0.93, 1)
mat_rice.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4

mat_roti = bpy.data.materials.new(name="RotiMat")
mat_roti.use_nodes = True
mat_roti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.78, 0.58, 0.32, 1)
mat_roti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    if obj.name in ("ThaliPlate",) or obj.name.startswith("Katori_"):
        obj.data.materials.append(mat_steel)
    elif obj.name == "RiceMound":
        obj.data.materials.append(mat_rice)
    elif obj.name == "Roti":
        obj.data.materials.append(mat_roti)

print("Created Indian thali")
`;
}
export function generateBuildingScript(_custom = '') {
    return `
import bpy
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Haveli (research spec): 12 x 10 m footprint, plinth 0.5, two floors 3.2 each,
# flat roof + parapet (NO temple spire), rooms on all 4 sides of a central
# 4x4 open courtyard (chowk), visible from above. Two storeys only.

def _box(name, loc, scale):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    return obj

def _cyl(name, loc, radius, depth):
    bpy.ops.mesh.primitive_cylinder_add(location=loc, radius=radius, depth=depth)
    obj = bpy.context.active_object
    obj.name = name
    return obj

# Plinth / base - 12 x 10 x 0.5, z 0-0.5 (darker sandstone)
_box("Plinth", (0, 0, 0.25), (6, 5, 0.25))

# Courtyard paving - 4 x 4 stone slab on the plinth, z 0.5-0.55
_box("CourtyardPaving", (0, 0, 0.525), (2, 2, 0.025))

# Floor wings - four blocks around the 4x4 courtyard void (x -2..2, y -2..2).
# Front/back wings: 12 x 3; left/right wings: 4 x 4.
for floor, z0 in [("GroundFloor", 0.5), ("FirstFloor", 3.7)]:
    zc = z0 + 1.6
    _box(f"{floor}_Front", (0, -3.5, zc), (6, 1.5, 1.6))
    _box(f"{floor}_Back", (0, 3.5, zc), (6, 1.5, 1.6))
    _box(f"{floor}_Left", (-4, 0, zc), (2, 2, 1.6))
    _box(f"{floor}_Right", (4, 0, zc), (2, 2, 1.6))

# Roof terrace slabs - one per wing (courtyard stays open to the sky), z 6.9-7.05
for name, loc, scale in [
    ("RoofSlab_Front", (0, -3.5, 6.975), (6, 1.5, 0.075)),
    ("RoofSlab_Back", (0, 3.5, 6.975), (6, 1.5, 0.075)),
    ("RoofSlab_Left", (-4, 0, 6.975), (2, 2, 0.075)),
    ("RoofSlab_Right", (4, 0, 6.975), (2, 2, 0.075)),
]:
    _box(name, loc, scale)

# Parapet - H 1.0 around the roof edge, z 6.9-7.9
_box("Parapet_Front", (0, -4.85, 7.4), (6, 0.15, 0.5))
_box("Parapet_Back", (0, 4.85, 7.4), (6, 0.15, 0.5))
_box("Parapet_Left", (-5.85, 0, 7.4), (0.15, 4.7, 0.5))
_box("Parapet_Right", (5.85, 0, 7.4), (0.15, 4.7, 0.5))

# Main entrance portal - arched, 2.4 wide x 4.5 high, front centre (y = -5)
_box("PortalJamb_Left", (-1.05, -5.0, 2.15), (0.25, 0.25, 1.65))
_box("PortalJamb_Right", (1.05, -5.0, 2.15), (0.25, 0.25, 1.65))
_box("Door_Left", (-0.575, -4.97, 2.15), (0.55, 0.05, 1.65))
_box("Door_Right", (0.575, -4.97, 2.15), (0.55, 0.05, 1.65))
# Pointed (cusped) arch: two segments meeting at the apex (0, -5.0, 5.0)
_box("PortalArch_Left", (-0.6, -5.0, 4.4), (0.85, 0.25, 0.2))
bpy.context.active_object.rotation_euler = (0, -pi / 4, 0)
_box("PortalArch_Right", (0.6, -5.0, 4.4), (0.85, 0.25, 0.2))
bpy.context.active_object.rotation_euler = (0, pi / 4, 0)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -5.0, 5.05), radius=0.12)
bpy.context.active_object.name = "PortalFinial"

# Arched windows - 0.9 wide x 1.8 high with cusped arch caps, front face.
# Ground floor sill z = 1.0, first floor sill z = 4.7.
for floor, zc in [("GF", 1.9), ("FF", 5.6)]:
    for i, x in enumerate([-4.5, -2.0, 2.0, 4.5]):
        _box(f"Window_{floor}_{i}", (x, -5.02, zc), (0.45, 0.05, 0.9))
        bpy.ops.mesh.primitive_uv_sphere_add(location=(x, -5.02, zc + 0.9), radius=1.0)
        cap = bpy.context.active_object
        cap.name = f"WindowArch_{floor}_{i}"
        cap.scale = (0.45, 0.06, 0.35)

# Fresco band - coloured painted band across the front between the floors
_box("FrescoBand", (0, -5.02, 4.35), (6, 0.05, 0.25))

# Jharokha balconies x2 - projecting ~1 m from the front face, first floor.
for sx in [3.0, -3.0]:
    _box(f"JharokhaSlab_{sx}", (sx, -5.5, 4.775), (0.6, 0.5, 0.075))
    for dx in [-0.4, 0.4]:
        _box(f"JharokhaCorbel_{sx}_{dx}", (sx + dx, -5.5, 4.45), (0.05, 0.05, 0.25))
    for dx in [-0.5, 0.5]:
        for dy in [-5.9, -5.1]:
            _cyl(f"JharokhaPillar_{sx}_{dx}_{dy}", (sx + dx, dy, 5.75), 0.04, 1.8)
    _box(f"JharokhaJali_{sx}", (sx, -5.95, 5.75), (0.6, 0.025, 0.6))
    bpy.ops.mesh.primitive_uv_sphere_add(location=(sx, -5.5, 6.65), radius=1.0)
    dome = bpy.context.active_object
    dome.name = f"JharokhaDome_{sx}"
    dome.scale = (0.6, 0.5, 0.35)

# Veranda columns - Ø 0.30, H 2.7, around the courtyard, both floors
for zc in [1.85, 5.05]:
    for x in [-2.2, 2.2]:
        for y in [-2.2, 2.2]:
            _cyl(f"VerandaColumn_{zc}_{x}_{y}", (x, y, zc), 0.15, 2.7)

# Chhatris x4 - domed pavilions on the roof corners, dome top ~9.0
for cx in [5, -5]:
    for cy in [4, -4]:
        _box(f"ChhatriBase_{cx}_{cy}", (cx, cy, 7.125), (0.75, 0.75, 0.075))
        for dx in [-0.6, 0.6]:
            for dy in [-0.6, 0.6]:
                _cyl(f"ChhatriPillar_{cx}_{cy}_{dx}_{dy}", (cx + dx, cy + dy, 7.8), 0.06, 1.2)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(cx, cy, 8.4), radius=1.0)
        dome = bpy.context.active_object
        dome.name = f"ChhatriDome_{cx}_{cy}"
        dome.scale = (0.7, 0.7, 0.5)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(cx, cy, 8.95), radius=0.08)
        bpy.context.active_object.name = f"ChhatriFinial_{cx}_{cy}"

# Materials - golden-yellow sandstone + darker plinth + dark teak doors + fresco band
mat_sand = bpy.data.materials.new(name="Sandstone")
mat_sand.use_nodes = True
mat_sand.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.72, 0.5, 1)
mat_sand.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_plinth = bpy.data.materials.new(name="PlinthStone")
mat_plinth.use_nodes = True
mat_plinth.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.6, 0.5, 0.35, 1)
mat_plinth.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_teak = bpy.data.materials.new(name="DarkTeak")
mat_teak.use_nodes = True
mat_teak.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.15, 0.08, 1)
mat_teak.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7

mat_dark = bpy.data.materials.new(name="WindowRecess")
mat_dark.use_nodes = True
mat_dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.12, 0.14, 1)
mat_dark.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_fresco = bpy.data.materials.new(name="Fresco")
mat_fresco.use_nodes = True
mat_fresco.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.7, 0.25, 0.15, 1)
mat_fresco.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

mat_brass = bpy.data.materials.new(name="Brass")
mat_brass.use_nodes = True
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.7, 0.3, 1)
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    if obj.name in ("Plinth",):
        obj.data.materials.append(mat_plinth)
    elif obj.name.startswith("Door_"):
        obj.data.materials.append(mat_teak)
    elif obj.name.startswith("Window_"):
        obj.data.materials.append(mat_dark)
    elif obj.name == "FrescoBand":
        obj.data.materials.append(mat_fresco)
    elif "Finial" in obj.name:
        obj.data.materials.append(mat_brass)
    else:
        obj.data.materials.append(mat_sand)

print("Created haveli")
`;
}
export function generateCharacterScript(_custom = '') {
    return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Adult male in dhoti/kurta (research spec): H = 1.75 m, 7.5 heads.
# Landmarks: crown 1.75, chin 1.52, shoulder 1.45, elbow 1.09, hip 0.90,
# fingertips 0.65 (mid-thigh), knee 0.53, ankle 0.08. Faces -Y.
# Torso is NARROWER than the shoulders - no big white box.

# Head - H 0.23, W 0.16, D 0.19, z 1.52-1.75 (clearly visible on top)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.635), radius=1.0)
head = bpy.context.active_object
head.name = "Head"
head.scale = (0.08, 0.095, 0.115)

# Hair cap - black, on top/back of the head
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -0.005, 1.70), radius=1.0)
hair = bpy.context.active_object
hair.name = "Hair"
hair.scale = (0.082, 0.097, 0.055)

# Eyes - dark, on the face (-Y side), big enough to see and sitting
# proud of the head surface (head half-depth 0.095 at z = 1.66)
for x in [-0.035, 0.035]:
    bpy.ops.mesh.primitive_uv_sphere_add(location=(x, -0.093, 1.66), radius=0.016)
    bpy.context.active_object.name = "Eye"

# Neck - Ø 0.11, H 0.10, z 1.42-1.52
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 1.47), radius=0.055, depth=0.10)
bpy.context.active_object.name = "Neck"

# Torso with kurta - shoulders 0.46 wide, chest 0.42, z 0.85-1.45 (cream)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.15))
bpy.context.active_object.name = "Torso"
bpy.context.active_object.scale = (0.21, 0.11, 0.30)

# Shoulders - 0.46 wide, wider than the torso
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.43), radius=1.0)
bpy.context.active_object.name = "Shoulders"
bpy.context.active_object.scale = (0.23, 0.11, 0.06)

# Kurta skirt - flares slightly, hem at the knee (z = 0.70)
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.85), radius=0.22, depth=0.30)
bpy.context.active_object.name = "KurtaSkirt"

# Arms - upper arm shoulder 1.45 -> elbow 1.09, forearm -> wrist 0.79,
# hands skin, fingertips reaching mid-thigh (z = 0.65)
for x in [-0.26, 0.26]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 1.27), radius=0.045, depth=0.36)
    bpy.context.active_object.name = "UpperArm"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.94), radius=0.035, depth=0.30)
    bpy.context.active_object.name = "Forearm"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.72), radius=0.035, depth=0.14)
    bpy.context.active_object.name = "Hand"

# Dhoti - white with gold border, waist z 0.95 to ankle hem z 0.02
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.485), radius=0.19, depth=0.93)
bpy.context.active_object.name = "Dhoti"
bpy.ops.mesh.primitive_torus_add(location=(0, 0, 0.05), major_radius=0.19, minor_radius=0.012)
bpy.context.active_object.name = "DhotiBorder"

# Legs underneath the dhoti - hip 0.90 -> ankle 0.08
for x in [-0.09, 0.09]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.49), radius=0.06, depth=0.82)
    bpy.context.active_object.name = "Leg"

# Feet / sandals on the ground, pointing forward (-Y)
for x in [-0.09, 0.09]:
    bpy.ops.mesh.primitive_cube_add(location=(x, -0.06, 0.015))
    bpy.context.active_object.name = "Foot"
    bpy.context.active_object.scale = (0.045, 0.135, 0.015)

# Materials - skin, kurta and dhoti in DISTINCT tones
mat_skin = bpy.data.materials.new(name="Skin")
mat_skin.use_nodes = True
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.45, 0.28, 0.18, 1)
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6

mat_kurta = bpy.data.materials.new(name="Kurta")
mat_kurta.use_nodes = True
# Torso with kurta - saffron, clearly distinct from the white dhoti
mat_kurta.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.45, 0.10, 1)
mat_kurta.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_dhoti = bpy.data.materials.new(name="DhotiMat")
mat_dhoti.use_nodes = True
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.97, 0.96, 0.92, 1)
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_gold = bpy.data.materials.new(name="GoldBorder")
mat_gold.use_nodes = True
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.65, 0.2, 1)
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.8
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35

mat_hair = bpy.data.materials.new(name="HairMat")
mat_hair.use_nodes = True
mat_hair.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.04, 0.03, 1)
mat_hair.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6

mat_leather = bpy.data.materials.new(name="Leather")
mat_leather.use_nodes = True
mat_leather.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.25, 0.12, 1)
mat_leather.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    # Blender renames duplicates (Eye.001, Hand.001, ...), so match on the
    # base name - otherwise only the first copy gets a material.
    base = obj.name.split(".")[0]
    if base in ("Head", "Neck", "Hand", "Leg"):
        obj.data.materials.append(mat_skin)
    elif base in ("Torso", "Shoulders", "KurtaSkirt", "UpperArm", "Forearm"):
        obj.data.materials.append(mat_kurta)
    elif base == "Dhoti":
        obj.data.materials.append(mat_dhoti)
    elif base == "DhotiBorder":
        obj.data.materials.append(mat_gold)
    elif base in ("Hair", "Eye"):
        obj.data.materials.append(mat_hair)
    elif base == "Foot":
        obj.data.materials.append(mat_leather)

print("Created Indian character")
`;
}
/** Which built-in template (if any) matches a description. Returns null for no match. */
export function matchTemplate(description) {
    const desc = description.toLowerCase();
    if (desc.includes('temple') || desc.includes('mandir')) {
        return 'temple';
    }
    else if (desc.includes('auto') || desc.includes('rickshaw') || desc.includes('vehicle')) {
        return 'rickshaw';
    }
    else if (desc.includes('thali') || desc.includes('food')) {
        return 'thali';
    }
    else if (desc.includes('haveli') || desc.includes('palace') || desc.includes('building')) {
        return 'building';
    }
    else if (desc.includes('person') || desc.includes('human') || desc.includes('character')) {
        return 'character';
    }
    return null;
}
export function generateModelScript(description, customization) {
    switch (matchTemplate(description)) {
        case 'temple':
            return generateTempleScript(customization);
        case 'rickshaw':
            return generateRickshawScript(customization);
        case 'thali':
            return generateThaliScript(customization);
        case 'building':
            return generateBuildingScript(customization);
        case 'character':
            return generateCharacterScript(customization);
        default:
            // No template matched: deliberately return an empty script. Callers
            // must treat this as "no template matched" and guide the LLM to
            // execute_blender_code instead of silently building a temple.
            return '';
    }
}
//# sourceMappingURL=generators.js.map