/**
 * Model script generators - Python scripts for Blender
 */

export function generateTempleScript(custom: string = ''): string {
  let color = [0.95, 0.93, 0.9, 1];
  if (custom.toLowerCase().includes('red')) {
    color = [0.75, 0.25, 0.2, 1];
  } else if (custom.toLowerCase().includes('sandstone')) {
    color = [0.85, 0.75, 0.6, 1];
  }

  return `
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Adhishthana (Base)
for i in range(4):
    bpy.ops.mesh.primitive_cube_add(location=(0, i*0.15, 0))
    base = bpy.context.active_object
    base.name = f"Adhisthana_{i}"
    base.scale = (4.5 - i*0.3, 0.15, 3.5 - i*0.2)

# Garbhagriha (Main Sanctum)
bpy.ops.mesh.primitive_cube_add(location=(0, 2.2, 0))
garbha = bpy.context.active_object
garbha.name = "Garbhagriha"
garbha.scale = (3, 2.5, 2.2)

# Shikhara (Tower)
for tier in range(5):
    radius = 1.8 - tier * 0.25
    height = 3.5 + tier * 0.8
    bpy.ops.mesh.primitive_cone_add(location=(0, height, 0), vertices=16+tier*2)
    shikhara = bpy.context.active_object
    shikhara.name = f"ShikharaTier_{tier}"
    shikhara.scale = (radius, 0.8 + tier * 0.3, radius)

# Stupi and Kalasha
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 8, 0), radius=0.15)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 8.3, 0), radius=0.2)

# Mandapa (Pillared Hall)
bpy.ops.mesh.primitive_cube_add(location=(0, 1.5, -3))
bpy.context.active_object.name = "Mandapa"

# Pillars
for x, z in [(-1.2, -2.5), (1.2, -2.5), (-1.2, -3.5), (1.2, -3.5)]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 2, z), depth=2.5, radius=0.15)

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
bpy.ops.object.light_add(type="SUN", location=(5, 8, 5))
bpy.context.active_object.data.energy = 3
bpy.ops.object.light_add(type="POINT", location=(-3, 5, 3))
bpy.context.active_object.data.energy = 200

print("Created Indian temple")
`;
}

export function generateRickshawScript(custom: string = ''): string {
  let color = [0.95, 0.7, 0.1, 1]; // Yellow
  if (custom.toLowerCase().includes('red')) {
    color = [0.8, 0.15, 0.1, 1];
  } else if (custom.toLowerCase().includes('blue')) {
    color = [0.1, 0.3, 0.8, 1];
  }

  return `
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Body
bpy.ops.mesh.primitive_cube_add(location=(0, 0.6, 0))
body = bpy.context.active_object
body.name = "BodyMain"
body.scale = (1.3, 0.7, 2.2)

# Cabin
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 1.2, -0.3), radius=0.7)
cabin = bpy.context.active_object
cabin.name = "Cabin"
cabin.scale = (1.15, 0.85, 1.6)

# Wheels
for x, z in [(-0.75, -0.4), (0.75, -0.4), (-0.6, 1), (0.6, 1)]:
    bpy.ops.mesh.primitive_torus_add(location=(x, 0.3, z), major_radius=0.38, minor_radius=0.12)
    wheel = bpy.context.active_object
    wheel.name = "Wheel"
    wheel.rotation_euler = (pi/2, 0, 0)

# Material
mat = bpy.data.materials.new(name="AutoBody")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(color)}
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.3

for obj in bpy.data.objects:
    if obj.type == "MESH" and "Body" in obj.name:
        obj.data.materials.append(mat)

bpy.ops.object.light_add(type="SUN", location=(3, 5, 3))
bpy.context.active_object.data.energy = 2

print("Created auto-rickshaw")
`;
}

export function generateThaliScript(_custom: string = ''): string {
  return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Plate
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0.15, 0), radius=1.3, depth=0.12)
plate = bpy.context.active_object
plate.name = "ThaliPlate"

# Rice mound
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0.35, 0), radius=0.45)
rice = bpy.context.active_object
rice.name = "RiceMound"
rice.scale = (1, 0.5, 1)

# Bowls
for x, z in [(0.5, 0.3), (-0.5, 0.3), (0, 0.5)]:
    bpy.ops.mesh.primitive_uv_sphere_add(location=(x, 0.3, z), radius=0.25)
    bpy.context.active_object.scale = (1, 0.6, 1)

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

export function generateBuildingScript(_custom: string = ''): string {
  return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Ground floor
bpy.ops.mesh.primitive_cube_add(location=(0, 1.5, 0))
bpy.context.active_object.name = "GroundFloor"
bpy.context.active_object.scale = (4, 2.5, 3)

# Second floor
bpy.ops.mesh.primitive_cube_add(location=(0, 4, 0))
bpy.context.active_object.name = "FirstFloor"
bpy.context.active_object.scale = (3.8, 2.5, 2.8)

# Roof
bpy.ops.mesh.primitive_cube_add(location=(0, 8, 0))
bpy.context.active_object.name = "MainRoof"
bpy.context.active_object.scale = (4.2, 0.4, 3.2)

# Chattris
for x in [-1.5, 0, 1.5]:
    for z in [-1, 1]:
        bpy.ops.mesh.primitive_cone_add(location=(x, 8.5, z), vertices=12)
        bpy.context.active_object.scale = (0.8, 1.2, 0.8)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(x, 9.2, z), radius=0.5)

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

export function generateCharacterScript(_custom: string = ''): string {
  return `
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Head
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 1.65, 0), radius=0.22)
bpy.context.active_object.name = "Head"

# Torso
bpy.ops.mesh.primitive_cube_add(location=(0, 1.1, 0))
bpy.context.active_object.name = "Torso"
bpy.context.active_object.scale = (0.45, 0.55, 0.22)

# Shoulders
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 1.25, 0), radius=0.25)
bpy.context.active_object.name = "Shoulders"
bpy.context.active_object.scale = (1, 0.4, 0.8)

# Arms
for x in [-0.45, 0.45]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0.95, 0), radius=0.08, depth=0.35)
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0.55, 0), radius=0.07, depth=0.35)

# Dhoti
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0.55, 0), radius=0.25, depth=0.8)
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

export function generateModelScript(description: string, customization: string): string {
  const desc = description.toLowerCase();

  if (desc.includes('temple') || desc.includes('mandir')) {
    return generateTempleScript(customization);
  } else if (desc.includes('auto') || desc.includes('rickshaw') || desc.includes('vehicle')) {
    return generateRickshawScript(customization);
  } else if (desc.includes('thali') || desc.includes('food')) {
    return generateThaliScript(customization);
  } else if (desc.includes('haveli') || desc.includes('palace') || desc.includes('building')) {
    return generateBuildingScript(customization);
  } else if (desc.includes('person') || desc.includes('human') || desc.includes('character')) {
    return generateCharacterScript(customization);
  } else {
    return generateTempleScript(customization); // Default to temple
  }
}