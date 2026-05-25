"""
Blender script: count loose parts in the build_01 mesh and report basic
geometry stats (face count, planarity, normal distribution). Run via:

  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/inspect_build01.py
"""
import bpy, bmesh
from mathutils import Vector
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
GLTF = ROOT / "models" / "asia_building" / "scene.gltf"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(GLTF))

# Find the object whose material is build_01.
target = None
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH': continue
    names = [s.material.name for s in obj.material_slots if s.material]
    if any(n.startswith('build_01') for n in names):
        target = obj
        break

if not target:
    raise SystemExit("no mesh with material build_01 found")

print(f"\n=== target mesh: {target.name} ===")
print(f"  vertices: {len(target.data.vertices)}")
print(f"  polygons: {len(target.data.polygons)}")
print(f"  edges:    {len(target.data.edges)}")

# Count connected components without actually splitting (use bmesh).
bm = bmesh.new()
bm.from_mesh(target.data)
bm.verts.ensure_lookup_table()
bm.faces.ensure_lookup_table()

# DFS over faces sharing edges to find connected components.
visited = [False] * len(bm.faces)
components = []
for start in range(len(bm.faces)):
    if visited[start]:
        continue
    stack = [start]
    comp = []
    while stack:
        i = stack.pop()
        if visited[i]:
            continue
        visited[i] = True
        f = bm.faces[i]
        comp.append(i)
        for e in f.edges:
            for nf in e.link_faces:
                if not visited[nf.index]:
                    stack.append(nf.index)
    components.append(comp)

bm.free()

print(f"\nconnected components: {len(components)}")

# Distribution of component face counts.
sizes = sorted([len(c) for c in components], reverse=True)
print(f"  largest 10:  {sizes[:10]}")
print(f"  smallest 10: {sizes[-10:]}")

# Histogram bucket
buckets = Counter()
for s in sizes:
    if s <= 4:       buckets['1-4 (single quad-ish)'] += 1
    elif s <= 12:    buckets['5-12 (small)'] += 1
    elif s <= 50:    buckets['13-50 (medium)'] += 1
    elif s <= 200:   buckets['51-200 (large)'] += 1
    else:            buckets['200+ (huge)'] += 1
for k, v in buckets.items():
    print(f"  {k}: {v}")
