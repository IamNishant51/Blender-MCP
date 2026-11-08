"""Fake-bpy executor + bounding-box checker for generated Blender scripts.

Runs generated template / import scripts WITHOUT Blender. A minimal fake
``bpy`` (and ``mathutils``) module records every primitive created, with its
location, scale and rotation, and computes world-space bounding boxes from
Blender's primitive defaults:

- cube: 2 x 2 x 2, centred on its location
- cone: radius1 (default 1) x radius1 x depth (default 2), centred
- UV sphere: radius r in every axis, centred
- cylinder: radius r x radius r x depth, along Z, centred
- torus: ring in the XY plane, outer radius major + minor, tube 2 * minor

Rotation is applied exactly (4x4 matrix), so a torus rotated 90 deg about Y
really does stand up as a wheel. This is what catches the old Y-up bug:
any part whose world bounding box dips below z = 0 fails the check.

Usage as a script::

    python3 tests/geometry.py <script.py>   # prints JSON bounding boxes

Usage from tests::

    from geometry import execute_script, scene_bounds
    objects = execute_script(script)
    lo, hi = scene_bounds(objects)
"""

import contextlib
import io
import json
import math
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Minimal vector / matrix math (enough for T @ R @ S transforms)
# ---------------------------------------------------------------------------

class Vector:
    """Mutable 3-vector with x/y/z attributes (mirrors mathutils.Vector)."""

    def __init__(self, seq):
        self._v = [float(v) for v in seq]

    @property
    def x(self):
        return self._v[0]

    @x.setter
    def x(self, value):
        self._v[0] = float(value)

    @property
    def y(self):
        return self._v[1]

    @y.setter
    def y(self, value):
        self._v[1] = float(value)

    @property
    def z(self):
        return self._v[2]

    @z.setter
    def z(self, value):
        self._v[2] = float(value)

    def __getitem__(self, index):
        return self._v[index]

    def __setitem__(self, index, value):
        self._v[index] = float(value)

    def __iter__(self):
        return iter(self._v)

    def __len__(self):
        return 3

    def __add__(self, other):
        return Vector((self[0] + other[0], self[1] + other[1], self[2] + other[2]))

    def __sub__(self, other):
        return Vector((self[0] - other[0], self[1] - other[1], self[2] - other[2]))

    def __mul__(self, scalar):
        return Vector((self[0] * scalar, self[1] * scalar, self[2] * scalar))

    __rmul__ = __mul__

    def __truediv__(self, scalar):
        return Vector((self[0] / scalar, self[1] / scalar, self[2] / scalar))

    def __repr__(self):
        return f"Vector({tuple(self._v)})"


class Matrix:
    """4x4 row-major matrix."""

    def __init__(self, rows):
        self.rows = [[float(v) for v in row] for row in rows]

    @staticmethod
    def identity():
        return Matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])

    @staticmethod
    def translation(loc):
        m = Matrix.identity()
        m.rows[0][3], m.rows[1][3], m.rows[2][3] = loc[0], loc[1], loc[2]
        return m

    @staticmethod
    def scale(s):
        return Matrix([[s[0], 0, 0, 0], [0, s[1], 0, 0], [0, 0, s[2], 0], [0, 0, 0, 1]])

    @staticmethod
    def rotation_euler(rx, ry, rz):
        cx, sx = math.cos(rx), math.sin(rx)
        cy, sy = math.cos(ry), math.sin(ry)
        cz, sz = math.cos(rz), math.sin(rz)
        rot_x = Matrix([[1, 0, 0, 0], [0, cx, -sx, 0], [0, sx, cx, 0], [0, 0, 0, 1]])
        rot_y = Matrix([[cy, 0, sy, 0], [0, 1, 0, 0], [-sy, 0, cy, 0], [0, 0, 0, 1]])
        rot_z = Matrix([[cz, -sz, 0, 0], [sz, cz, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
        return rot_z @ rot_y @ rot_x

    def __matmul__(self, other):
        if isinstance(other, Matrix):
            out = [[0.0] * 4 for _ in range(4)]
            for i in range(4):
                for j in range(4):
                    out[i][j] = sum(self.rows[i][k] * other.rows[k][j] for k in range(4))
            return Matrix(out)
        if isinstance(other, Vector):
            x, y, z = other
            return Vector((
                self.rows[0][0] * x + self.rows[0][1] * y + self.rows[0][2] * z + self.rows[0][3],
                self.rows[1][0] * x + self.rows[1][1] * y + self.rows[1][2] * z + self.rows[1][3],
                self.rows[2][0] * x + self.rows[2][1] * y + self.rows[2][2] * z + self.rows[2][3],
            ))
        raise TypeError(f"Matrix @ {type(other)} not supported")


# ---------------------------------------------------------------------------
# Fake Blender objects
# ---------------------------------------------------------------------------

class _FakeSocket:
    def __init__(self):
        self.default_value = None


class _SocketDict(dict):
    """Dict of material inputs that auto-creates sockets on access."""

    def __missing__(self, key):
        socket = _FakeSocket()
        self[key] = socket
        return socket


class _FakeRampElement:
    def __init__(self, position=0.0, color=(1.0, 1.0, 1.0, 1.0)):
        self.position = position
        self.color = color


class _FakeRampElements(list):
    def new(self, position):
        el = _FakeRampElement(position)
        self.append(el)
        self.sort(key=lambda e: e.position)
        return el


class _FakeColorRamp:
    def __init__(self):
        self.elements = _FakeRampElements([_FakeRampElement(0.0), _FakeRampElement(1.0)])


class _FakeNode:
    def __init__(self):
        self.inputs = _SocketDict()
        self.outputs = _SocketDict()
        self.color_ramp = _FakeColorRamp()

    def __getitem__(self, key):
        return self.inputs.setdefault(key, _FakeSocket())


class _FakeLinks:
    def new(self, *args, **kwargs):
        return None


class _FakeNodeDict(dict):
    """Node dict that auto-creates nodes on access (incl. Material Output)."""

    def __missing__(self, key):
        node = _FakeNode()
        self[key] = node
        return node

    def new(self, node_type):
        node = _FakeNode()
        node.type = node_type
        return node


class _FakeNodeTree:
    def __init__(self):
        self.nodes = _FakeNodeDict({"Principled BSDF": _FakeNode()})
        self.links = _FakeLinks()


class _FakeMaterial:
    def __init__(self, name):
        self.name = name
        self.use_nodes = False
        self.node_tree = _FakeNodeTree()
        self._props = {}

    def __setitem__(self, key, value):
        self._props[key] = value

    def __getitem__(self, key):
        return self._props[key]


class _FakeImage:
    def __init__(self, path):
        self.filepath = path
        self.colorspace_settings = _FakeColorSpace()

    def pack(self):
        pass


class _FakeColorSpace:
    def __init__(self):
        self.name = "sRGB"


class _FakeImages:
    def load(self, path):
        return _FakeImage(path)


class _FakePolygon:
    def __init__(self):
        self.use_smooth = False


class _FakeMeshData:
    def __init__(self):
        self.materials = []
        # Fake polygons so generated smooth-shading code runs in the harness.
        self.polygons = [_FakePolygon() for _ in range(6)]


class _FakeLightData:
    def __init__(self):
        self.energy = 0


class _FakeModifier:
    def __init__(self, name, mtype):
        self.name = name
        self.type = mtype


class _FakeModifiers:
    """Minimal stand-in for obj.modifiers (bevel / subdivision helpers)."""

    def __init__(self):
        self._mods = []

    def new(self, name, type):
        mod = _FakeModifier(name, type)
        self._mods.append(mod)
        return mod


class FakeObject:
    """A created primitive, light or imported mesh."""

    def __init__(self, name, kind, base_dims, location=(0.0, 0.0, 0.0)):
        self.name = name
        self.type = kind
        self._base_dims = tuple(base_dims)
        self.location = Vector(location)
        self.scale = Vector((1.0, 1.0, 1.0))
        self.rotation_euler = (0.0, 0.0, 0.0)
        self.data = _FakeMeshData() if kind == "MESH" else _FakeLightData()
        self.modifiers = _FakeModifiers()
        self._selected = False

    def select_set(self, state):
        self._selected = bool(state)

    @property
    def matrix_world(self):
        return (
            Matrix.translation(self.location)
            @ Matrix.rotation_euler(*self.rotation_euler)
            @ Matrix.scale(self.scale)
        )

    @property
    def bound_box(self):
        """Local-space corners of the primitive, like bpy's bound_box."""
        dx, dy, dz = (d / 2.0 for d in self._base_dims)
        return [
            Vector((x, y, z))
            for x in (-dx, dx)
            for y in (-dy, dy)
            for z in (-dz, dz)
        ]

    def world_bounds(self):
        """(min, max) world-space bounding box as Vectors."""
        corners = [self.matrix_world @ c for c in self.bound_box]
        lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
        hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
        return lo, hi

    def __repr__(self):
        lo, hi = self.world_bounds()
        return f"<FakeObject {self.name} {self.type} min={tuple(round(v, 3) for v in lo)} max={tuple(round(v, 3) for v in hi)}>"


# ---------------------------------------------------------------------------
# Fake bpy
# ---------------------------------------------------------------------------

class _FakeMeshOps:
    def __init__(self, ctx):
        self._ctx = ctx

    def _add(self, name, dims, location):
        obj = FakeObject(name, "MESH", dims, location)
        self._ctx._objects.append(obj)
        self._ctx._active = obj
        self._ctx._selected = [obj]
        return obj

    def primitive_cube_add(self, location=(0, 0, 0), **_kw):
        return self._add("Cube", (2.0, 2.0, 2.0), location)

    def primitive_cone_add(self, location=(0, 0, 0), radius1=1.0, depth=2.0, **_kw):
        return self._add("Cone", (2 * radius1, 2 * radius1, depth), location)

    def primitive_uv_sphere_add(self, location=(0, 0, 0), radius=1.0, **_kw):
        return self._add("Sphere", (2 * radius, 2 * radius, 2 * radius), location)

    def primitive_cylinder_add(self, location=(0, 0, 0), radius=1.0, depth=2.0, **_kw):
        return self._add("Cylinder", (2 * radius, 2 * radius, depth), location)

    def primitive_torus_add(self, location=(0, 0, 0), major_radius=1.0, minor_radius=0.25, **_kw):
        outer = major_radius + minor_radius
        return self._add("Torus", (2 * outer, 2 * outer, 2 * minor_radius), location)

    def select_all(self, action="SELECT"):
        pass


class _FakeUvOps:
    def __init__(self, ctx):
        self._ctx = ctx

    def smart_project(self, angle_limit=1.1519, island_margin=0.02, **_kw):
        self._ctx.smart_uv_calls.append((angle_limit, island_margin))


class _FakeObjectOps:
    def __init__(self, ctx):
        self._ctx = ctx

    def select_all(self, action="SELECT"):
        if action == "SELECT":
            self._ctx._selected = list(self._ctx._objects)

    def delete(self, **_kw):
        for obj in self._ctx._selected:
            self._ctx._objects.remove(obj)
        self._ctx._selected = []
        self._ctx._active = None

    def light_add(self, type="POINT", location=(0, 0, 0), **_kw):
        obj = FakeObject(type, "LIGHT", (0.0, 0.0, 0.0), location)
        self._ctx._objects.append(obj)
        self._ctx._active = obj
        self._ctx._selected = [obj]
        return obj

    def mode_set(self, mode="OBJECT", **_kw):
        self._ctx.mode = mode


class _FakeWmOps:
    def __init__(self, ctx):
        self._ctx = ctx

    def save_mainfile(self, filepath="", **_kw):
        self._ctx.saved_path = filepath

    def open(self, filepath="", **_kw):
        return None


class _FakeImportOps:
    """Stand-ins for bpy.ops.import_scene / import_mesh.

    Each import creates one mesh with the bounds configured on the context
    (default: a 4 x 2 x 0.5 m box floating at z = 3 — deliberately too big
    and off the ground, so normalisation has something to fix).
    """

    def __init__(self, ctx, module):
        self._ctx = ctx
        self._module = module

    def _import(self, name, filepath="", **_kw):
        dims, loc = self._ctx.imported_bounds
        obj = FakeObject(name, "MESH", dims, loc)
        self._ctx._objects.append(obj)
        self._ctx._active = obj
        self._ctx._selected = [obj]
        return obj

    def __getattr__(self, op):
        return lambda filepath="", **kw: self._import(f"Imported_{self._module}_{op}", filepath, **kw)


class _FakeViewLayerObjects:
    def __init__(self):
        self.active = None


class _FakeViewLayer:
    def __init__(self):
        self.objects = _FakeViewLayerObjects()

    def update(self):
        pass


class _FakeContext:
    def __init__(self):
        self._objects = []
        self._active = None
        self._selected = []
        self.view_layer = _FakeViewLayer()
        self.mode = "OBJECT"
        self.smart_uv_calls = []
        # Bounds of the single mesh a fake import creates: (dims, location)
        self.imported_bounds = ((4.0, 2.0, 0.5), (0.0, 0.0, 3.0))
        self.saved_path = None

    @property
    def active_object(self):
        return self._active

    @active_object.setter
    def active_object(self, value):
        self._active = value

    @property
    def selected_objects(self):
        return self._selected


class _FakeData:
    def __init__(self, ctx):
        self._ctx = ctx
        self.materials = self._Materials()
        self.images = _FakeImages()

    @property
    def objects(self):
        return self._ctx._objects

    class _Materials:
        def new(self, name):
            return _FakeMaterial(name)

        def get(self, name, default=None):
            return default


class _FakeOps:
    def __init__(self, ctx):
        self.mesh = _FakeMeshOps(ctx)
        self.object = _FakeObjectOps(ctx)
        self.wm = _FakeWmOps(ctx)
        self.uv = _FakeUvOps(ctx)
        self.import_scene = _FakeImportOps(ctx, "scene")
        self.import_mesh = _FakeImportOps(ctx, "mesh")


class _FakeBpy:
    def __init__(self):
        self.context = _FakeContext()
        self.ops = _FakeOps(self.context)
        self.data = _FakeData(self.context)


class _FakeMathutils:
    Vector = Vector


# ---------------------------------------------------------------------------
# Execution + bounds
# ---------------------------------------------------------------------------

def execute_script(script: str, imported_bounds=((4.0, 2.0, 0.5), (0.0, 0.0, 3.0))):
    """Execute a generated Blender script against the fake bpy.

    Returns the list of mesh objects left in the scene. The fake context
    of the last run is kept on ``LAST_CONTEXT`` (smart_uv_calls, mode,
    saved_path) for tests that need it.
    """
    global LAST_CONTEXT
    fake_bpy = _FakeBpy()
    fake_bpy.context.imported_bounds = imported_bounds
    old_bpy = sys.modules.get("bpy")
    old_mathutils = sys.modules.get("mathutils")
    sys.modules["bpy"] = fake_bpy
    sys.modules["mathutils"] = _FakeMathutils()
    try:
        # Template scripts print() progress lines; swallow them so the
        # caller's stdout stays clean (the CLI prints only JSON).
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(script, "<generated>", "exec"), {"__name__": "__main__"})
    finally:
        if old_bpy is None:
            sys.modules.pop("bpy", None)
        else:
            sys.modules["bpy"] = old_bpy
        if old_mathutils is None:
            sys.modules.pop("mathutils", None)
        else:
            sys.modules["mathutils"] = old_mathutils
    LAST_CONTEXT = fake_bpy.context
    return [o for o in fake_bpy.context._objects if o.type == "MESH"]


#: Fake context of the most recent execute_script run (or None).
LAST_CONTEXT = None


def scene_bounds(objects):
    """(min, max) world-space bounds of all given objects."""
    los, his = zip(*[o.world_bounds() for o in objects])
    lo = Vector((min(v.x for v in los), min(v.y for v in los), min(v.z for v in los)))
    hi = Vector((max(v.x for v in his), max(v.y for v in his), max(v.z for v in his)))
    return lo, hi


def describe(objects):
    """JSON-friendly description of objects and scene bounds."""
    items = []
    for o in objects:
        lo, hi = o.world_bounds()
        items.append({
            "name": o.name,
            "min": [round(v, 4) for v in lo],
            "max": [round(v, 4) for v in hi],
            "size": [round(hi[i] - lo[i], 4) for i in range(3)],
        })
    lo, hi = scene_bounds(objects)
    return {
        "objects": items,
        "scene_min": [round(v, 4) for v in lo],
        "scene_max": [round(v, 4) for v in hi],
        "scene_size": [round(hi[i] - lo[i], 4) for i in range(3)],
    }


if __name__ == "__main__":
    script_path = Path(sys.argv[1])
    objects = execute_script(script_path.read_text())
    print(json.dumps(describe(objects), indent=2))
