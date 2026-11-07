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

# Body - 1.3 wide (X) x 2.2 long (Y) x 0.7 tall, bottom at z = 0.15
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.5))
body = bpy.context.active_object
body.name = "BodyMain"
body.scale = (0.65, 1.1, 0.35)

# Cabin - canopy above the body
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -0.2, 1.05), radius=0.7)
cabin = bpy.context.active_object
cabin.name = "Cabin"
cabin.scale = (1.15, 1.6, 0.75)

# Wheels - 3 wheels, outer radius 0.5, centres at z = 0.5 so they touch the ground.
# Torus ring lies in the XY plane by default; rotating 90 deg about Y puts the
# ring in the ZY plane so the axle runs along X and the wheel rolls along Y.
for x, y in [(-0.75, 0.9), (0.75, 0.9), (0, -1.0)]:
    bpy.ops.mesh.primitive_torus_add(location=(x, y, 0.5), major_radius=0.38, minor_radius=0.12)
    wheel = bpy.context.active_object
    wheel.name = "Wheel"
    wheel.rotation_euler = (0, pi / 2, 0)

# Material
mat = bpy.data.materials.new(name="AutoBody")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(color)}
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.3

for obj in bpy.data.objects:
    if obj.type == "MESH" and "Body" in obj.name:
        obj.data.materials.append(mat)

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

# Plate - 0.7 m across, 0.03 m thick, sitting on the ground
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.015), radius=0.35, depth=0.03)
plate = bpy.context.active_object
plate.name = "ThaliPlate"

# Rice mound - flattened in Z, sitting on the plate (top z = 0.03)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 0.09), radius=0.12)
rice = bpy.context.active_object
rice.name = "RiceMound"
rice.scale = (1, 1, 0.5)

# Bowls - flattened in Z, sitting on the plate
for x, y in [(0.18, 0.1), (-0.18, 0.1), (0, -0.18)]:
    bpy.ops.mesh.primitive_uv_sphere_add(location=(x, y, 0.08), radius=0.08)
    bpy.context.active_object.scale = (1, 1, 0.6)

# Material
mat = bpy.data.materials.new(name="Steel")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.85, 0.85, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.9
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.25

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

print("Created Indian thali")
`;
}
export function generateBuildingScript(_custom = '') {
    return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Ground floor - 8 wide (X) x 6 deep (Y) x 3 tall, standing on the ground
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.5))
bpy.context.active_object.name = "GroundFloor"
bpy.context.active_object.scale = (4, 3, 1.5)

# Second floor - 7.6 x 5.6 x 2.5, stacked on the ground floor (z = 3 to 5.5)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 4.25))
bpy.context.active_object.name = "FirstFloor"
bpy.context.active_object.scale = (3.8, 2.8, 1.25)

# Roof - slab on top of the second floor (z = 5.5 to 5.9)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 5.7))
bpy.context.active_object.name = "MainRoof"
bpy.context.active_object.scale = (4.2, 3.2, 0.2)

# Chattris - domed pavilions on the roof, cones rising in +Z with spheres on top
for x in [-3, 3]:
    for y in [-2.2, 2.2]:
        bpy.ops.mesh.primitive_cone_add(location=(x, y, 6.5), vertices=12)
        bpy.context.active_object.scale = (0.8, 0.8, 0.6)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(x, y, 7.35), radius=0.5)

# Material
mat = bpy.data.materials.new(name="HaveliWall")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.75, 0.5, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

print("Created haveli")
`;
}
export function generateCharacterScript(_custom = '') {
    return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Head - top of the figure at z = 1.87
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.65), radius=0.22)
bpy.context.active_object.name = "Head"

# Torso - 0.9 wide x 0.44 deep x 1.1 tall (z = 0.55 to 1.65)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.1))
bpy.context.active_object.name = "Torso"
bpy.context.active_object.scale = (0.45, 0.22, 0.55)

# Shoulders
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.25), radius=0.25)
bpy.context.active_object.name = "Shoulders"
bpy.context.active_object.scale = (1, 0.8, 0.4)

# Arms - cylinders along Z (upper at z = 0.95, lower at z = 0.55)
for x in [-0.45, 0.45]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.95), radius=0.08, depth=0.35)
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.55), radius=0.07, depth=0.35)

# Dhoti - from the ground (z = 0) to z = 1.1
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.55), radius=0.25, depth=1.1)
bpy.context.active_object.name = "Dhoti"

# Skin material
mat_skin = bpy.data.materials.new(name="Skin")
mat_skin.use_nodes = True
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.72, 0.62, 1)
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7

# Dhoti material
mat_dhoti = bpy.data.materials.new(name="Dhoti")
mat_dhoti.use_nodes = True
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.6, 0.2, 1)
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

for obj in bpy.data.objects:
    if obj.type == "MESH":
        if "Dhoti" in obj.name:
            obj.data.materials.append(mat_dhoti)
        else:
            obj.data.materials.append(mat_skin)

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