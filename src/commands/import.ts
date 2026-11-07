/**
 * Import helpers - Blender script for importing a downloaded model file.
 */

// Blender import operator per format (STL lives under import_mesh, not import_scene)
export const IMPORT_OPERATORS: Record<string, string> = {
  glb: 'bpy.ops.import_scene.gltf',
  gltf: 'bpy.ops.import_scene.gltf',
  obj: 'bpy.ops.import_scene.obj',
  fbx: 'bpy.ops.import_scene.fbx',
  stl: 'bpy.ops.import_mesh.stl',
};

export const SUPPORTED_IMPORT_FORMATS = Object.keys(IMPORT_OPERATORS);

/**
 * Build the Blender script that imports a downloaded model file and
 * normalises it: longest side becomes targetSize (metres) and the lowest
 * point is moved onto the ground (z = 0). Kept as a separate function so
 * tests can verify it without downloading anything.
 */
export function buildImportScript(
  localPath: string,
  importOp: string,
  outputPath: string,
  targetSize: number,
): string {
  return `
import bpy
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

${importOp}(filepath=${JSON.stringify(localPath)})

meshes = [o for o in bpy.context.selected_objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("Import produced no mesh objects")

def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi

lo, hi = bounds(meshes)
size = hi - lo
longest = max(size.x, size.y, size.z)
if longest > 0:
    s = ${targetSize} / longest
    for o in meshes:
        o.scale = (o.scale.x * s, o.scale.y * s, o.scale.z * s)

bpy.context.view_layer.update()
lo, hi = bounds(meshes)
for o in meshes:
    o.location.z -= lo.z

bpy.ops.wm.save_mainfile(filepath=${JSON.stringify(outputPath)})
`;
}
