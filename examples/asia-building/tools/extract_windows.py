"""
Blender script: separate the build_01 mesh into per-window quads, compute the
world-space frame (center, normal, right, up, width, height) for each, and
write to windows.json.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python tools/extract_windows.py
"""
import bpy, bmesh, json
from mathutils import Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GLTF = ROOT / "models" / "asia_building" / "scene.gltf"
OUT  = ROOT / "models" / "asia_building" / "windows.json"

# Blender uses +Z up. Vectors / positions below are in Blender world space and
# get converted to glTF (+Y up, -Z forward, +X right) before emitting JSON.
WORLD_UP = Vector((0.0, 0.0, 1.0))

def blender_to_gltf(v):
    # Blender (x, y, z)  ->  glTF (x, z, -y)
    return [v[0], v[2], -v[1]]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(GLTF))

# Locate the build_01 mesh.
target = None
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH': continue
    if any(s.material and s.material.name.startswith('build_01') for s in obj.material_slots):
        target = obj
        break
if not target:
    raise SystemExit("no build_01 mesh found")
print(f"target: {target.name}  verts={len(target.data.vertices)}  faces={len(target.data.polygons)}")

# Apply world transform onto the mesh so post-separation we can read positions directly.
bpy.ops.object.select_all(action='DESELECT')
target.select_set(True)
bpy.context.view_layer.objects.active = target
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Separate by loose parts.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='LOOSE')
bpy.ops.object.mode_set(mode='OBJECT')

# Collect all resulting objects (every one shares the build_01 material).
parts = [obj for obj in bpy.context.scene.objects
         if obj.type == 'MESH'
         and any(s.material and s.material.name.startswith('build_01') for s in obj.material_slots)]
print(f"loose parts: {len(parts)}")

windows = []
for obj in parts:
    mesh = obj.data
    if len(mesh.polygons) < 1 or len(mesh.vertices) < 3:
        continue

    # Area-weighted average normal in world space.
    n_acc = Vector((0.0, 0.0, 0.0))
    for poly in mesh.polygons:
        n_acc += poly.normal * poly.area
    if n_acc.length < 1e-8:
        continue
    normal = n_acc.normalized()

    # Build an orthonormal right/up frame perpendicular to the normal,
    # preferring world-up so windows have a sensible vertical axis.
    up_seed = WORLD_UP if abs(normal.dot(WORLD_UP)) < 0.95 else Vector((1.0, 0.0, 0.0))
    right = up_seed.cross(normal).normalized()
    up    = normal.cross(right).normalized()

    # Project verts into (right, up) and find the centered AABB on the wall plane.
    verts = [v.co for v in mesh.vertices]
    rs = [v.dot(right) for v in verts]
    us = [v.dot(up)    for v in verts]
    r_min, r_max = min(rs), max(rs)
    u_min, u_max = min(us), max(us)
    center_r = 0.5 * (r_min + r_max)
    center_u = 0.5 * (u_min + u_max)

    # Center in world: project a vert onto the plane, then offset to AABB center.
    v0 = verts[0]
    n_offset = v0.dot(normal)  # planar offset along normal (should be ~constant for a flat quad)
    center = right * center_r + up * center_u + normal * n_offset

    width  = r_max - r_min
    height = u_max - u_min
    if width < 1e-4 or height < 1e-4:
        continue

    windows.append({
        "center": [round(c, 5) for c in blender_to_gltf(center)],
        "normal": [round(c, 5) for c in blender_to_gltf(normal)],
        "right":  [round(c, 5) for c in blender_to_gltf(right)],
        "up":     [round(c, 5) for c in blender_to_gltf(up)],
        "width":  round(width, 5),
        "height": round(height, 5),
    })

# Sort by (height descending, y position) for stable order.
windows.sort(key=lambda w: (-w["center"][1], w["center"][0], w["center"][2]))

OUT.write_text(json.dumps({"windows": windows}, indent=2))
print(f"wrote {OUT}  ({len(windows)} windows)")

# Quick stats so we can spot outliers.
ws = [w["width"]  for w in windows]
hs = [w["height"] for w in windows]
print(f"width  min={min(ws):.3f} max={max(ws):.3f} mean={sum(ws)/len(ws):.3f}")
print(f"height min={min(hs):.3f} max={max(hs):.3f} mean={sum(hs)/len(hs):.3f}")
