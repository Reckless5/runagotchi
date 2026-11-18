"""
Runagotchi garden — Blender starter scene.

Builds the placeholder garden from the app (js/app.js → gardenRoom, index.html → .room)
as real 3D objects, with the same positions, sizes and camera, so you can replace the
placeholders with your own models.

Run it:  Blender → Scripting tab → Open this file → Run Script   (or: blender -b -P make_garden.py)
It clears the current scene first.

Units: 1 Blender metre = 100 px in the app. The app's screen is about 280 px wide (2.8 m).
Axes:  X = right, Y = away from the camera (the app's -z), Z = up. The ground is Z = 0.
"""
import math
import bpy
import bmesh

W = 2.8            # app screen width in metres (≈280 px)
PERSP = 4.2        # CSS perspective: 420 px → camera distance
EYE_H = 0.42 * W   # eye height above the ground: ground line at 80 % of the screen, eye at 38 %

# ---------------------------------------------------------------- helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    return s

def coll(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c

def mat(name, rgb, rough=0.8, emit=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*rgb, 1)
    return m

def hexrgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)  # sRGB → linear

def link(obj, c):
    for u in list(obj.users_collection):
        u.objects.unlink(obj)
    c.objects.link(obj)
    return obj

def web_pos(x_pct, z_px):
    """App position → Blender (x % of the screen, z px depth) → (X, Y)."""
    return ((x_pct - 50) / 100 * W, -z_px / 100)

def tag(obj, **props):
    for k, v in props.items():
        obj[k] = v
    return obj

def sphere(name, loc, scale, m, c, segs=32):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return link(o, c)

def cyl(name, loc, r, depth, m, c, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return link(o, c)

def empty(name, loc, c, size=0.3, kind='PLAIN_AXES'):
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = kind
    o.empty_display_size = size
    o.location = loc
    c.objects.link(o)
    return o

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    return o

def parent_keep(parent, children):
    """Parent without moving anything."""
    bpy.context.view_layer.update()
    for o in children:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()

def set_origin_to(obj, point):
    cur = bpy.context.scene.cursor.location.copy()
    bpy.context.scene.cursor.location = point
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.context.scene.cursor.location = cur

# ---------------------------------------------------------------- materials (colours from the app)
scene = reset()
M = {
    'grass_a': mat('Grass A', hexrgb('7dd05f')), 'grass_b': mat('Grass B', hexrgb('72c656')),
    'hill_far': mat('Hill far', hexrgb('9ad67e')), 'hill_near': mat('Hill near', hexrgb('7cc862')),
    'rock': mat('Cliff rock', hexrgb('b99a6b')), 'moss': mat('Moss', hexrgb('6dbb52')),
    'water': mat('Water', hexrgb('58b8f0'), rough=0.1), 'fall': mat('Waterfall', hexrgb('bfe9ff'), rough=0.2, emit=0.3),
    'stone': mat('Pond stones', hexrgb('d9cba4')), 'sand': mat('Path sand', hexrgb('e3d3a3')),
    'trunk': mat('Bark', hexrgb('8a6a46')), 'palm_leaf': mat('Palm leaves', hexrgb('36a14a')),
    'leaf1': mat('Tree leaves A', hexrgb('4fb35b')), 'leaf2': mat('Tree leaves B', hexrgb('45a852')), 'leaf3': mat('Tree leaves C', hexrgb('5cc067')),
    'red': mat('Fruit red', hexrgb('ff6b6b')), 'yellow': mat('Fruit yellow', hexrgb('ffd23f')), 'orange': mat('Fruit orange', hexrgb('ff8a3d')),
    'tuft': mat('Grass tuft', hexrgb('2f9a3e')), 'pink': mat('Flower pink', hexrgb('ff7eb6')), 'white': mat('Flower white', hexrgb('ffffff')),
    'centre': mat('Flower centre', hexrgb('ffe36b')),
    'sun': mat('Sun', hexrgb('fff3a6'), emit=4.0), 'cloud': mat('Cloud', hexrgb('ffffff'), rough=1.0, emit=0.4),
    'pet': mat('Pet body', hexrgb('ff8a50')), 'pet_dark': mat('Pet feet', hexrgb('b4532a')), 'ink': mat('Pet eyes', hexrgb('2b2a22'), rough=0.3),
    'band': mat('Pet headband', hexrgb('e8454d')),
}

root = scene.collection
C_ENV = coll('Environment')
C_PROPS = coll('Props')
C_PET = coll('Pet')
C_SKY = coll('Sky')
C_CAM = coll('Camera & light')

# ---------------------------------------------------------------- ground (app: .floor — 600 % wide, z −2200 … +400)
floor_w, y_far, y_near = 6 * W, 22.0, -4.0
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, (y_far + y_near) / 2, 0))
g = bpy.context.active_object
g.name = 'Ground'
g.scale = (floor_w, y_far - y_near, 1)
bpy.ops.object.transform_apply(scale=True)
# mowed stripes like the app (26 px wide) via a wave texture
gm = bpy.data.materials.new('Grass stripes')
gm.use_nodes = True
nt = gm.node_tree
bsdf = nt.nodes['Principled BSDF']
bsdf.inputs['Roughness'].default_value = 0.9
tc = nt.nodes.new('ShaderNodeTexCoord')
sep = nt.nodes.new('ShaderNodeSeparateXYZ')
mathn = nt.nodes.new('ShaderNodeMath'); mathn.operation = 'MULTIPLY'; mathn.inputs[1].default_value = 1 / 0.52
fr = nt.nodes.new('ShaderNodeMath'); fr.operation = 'FRACT'
gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = 0.5
mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
mix.inputs['A'].default_value = (*hexrgb('7dd05f'), 1)
mix.inputs['B'].default_value = (*hexrgb('72c656'), 1)
nt.links.new(tc.outputs['Object'], sep.inputs[0])
nt.links.new(sep.outputs['X'], mathn.inputs[0])
nt.links.new(mathn.outputs[0], fr.inputs[0])
nt.links.new(fr.outputs[0], gt.inputs[0])
nt.links.new(gt.outputs[0], mix.inputs['Factor'])
nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
gm.diffuse_color = (*hexrgb('7dd05f'), 1)
g.data.materials.append(gm)
link(g, C_ENV)
tag(g, app_note="index.html .room .floor — mowed stripes 26 px (0.26 m)")

# pond (app: on the floor, ≈0.67 × 1.1 m, centre X 1.01, Y 1.65)
px, py = 0.36 * W, 1.65
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.5, depth=0.04, location=(px, py, 0.0))
rim = bpy.context.active_object; rim.name = 'Pond rim'; rim.scale = (0.67 / 0.86, 1.1 / 0.86, 1)
rim.data.materials.append(M['stone']); link(rim, C_PROPS)
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.5, depth=0.04, location=(px, py, 0.01))
water = bpy.context.active_object; water.name = 'Pond water'; water.scale = (0.67, 1.1, 1)
water.data.materials.append(M['water']); link(water, C_PROPS)
pond = empty('Pond', (px, py, 0), C_PROPS, 0.5, 'PLAIN_AXES')
parent_keep(pond, (rim, water))
tag(pond, app_note="Pet drinks standing at X 0.42, Y 1.65 (ROAM_SPOTS.pond)")

# path (app: 0.27 m wide, Y −0.2 … 5)
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 2.4, 0.005))
path = bpy.context.active_object; path.name = 'Path'; path.scale = (0.27, 5.2, 1)
path.data.materials.append(M['sand']); link(path, C_PROPS)

# ---------------------------------------------------------------- hills (app: z −1100, 56 m wide, ~1.3 m high)
hills = []
for row, (yy, m, h) in enumerate(((11.6, M['hill_far'], 1.25), (11.0, M['hill_near'], 0.8))):
    n = 18
    for i in range(n):
        x = -28 + i * (56 / (n - 1)) + (row * 1.6)
        sx = 2.4 + (i * 37 % 7) * 0.25
        hills.append(sphere(f'hill', (x, yy, 0), (sx, 1.2, h + (i * 13 % 5) * 0.08), m, C_ENV, 24))
hill = join(hills, 'Hills (placeholder)')
tag(hill, app_note="index.html .bb.hills — z −1100 px → Y 11, 2000 % of the screen wide")

# cliff + waterfall (app: x 30 %, z −700, 1.7 m wide × 2.5 m tall)
cx, cy = web_pos(30, -700)
bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, 1.25))
cliff = bpy.context.active_object; cliff.name = 'Cliff'; cliff.scale = (1.5, 0.9, 2.5)
bev = cliff.modifiers.new('Bevel', 'BEVEL'); bev.width = 0.25; bev.segments = 4
cliff.data.materials.append(M['rock']); link(cliff, C_PROPS)
moss = sphere('Cliff moss', (cx, cy, 2.5), (0.85, 0.55, 0.2), M['moss'], C_PROPS)
bpy.ops.mesh.primitive_plane_add(size=1, location=(cx + 0.1, cy - 0.46, 1.25), rotation=(math.pi / 2, 0, 0))
fall = bpy.context.active_object; fall.name = 'Waterfall'; fall.scale = (0.3, 2.3, 1)
fall.data.materials.append(M['fall']); link(fall, C_PROPS)
parent_keep(cliff, (moss, fall))
set_origin_to(cliff, (cx, cy, 0))
tag(cliff, app_note="GARDEN.cliff — the waterfall is animated in the app (falling dashes)")

# ---------------------------------------------------------------- palms and tree
def palm(name, x_pct, z_px, height):
    X, Y = web_pos(x_pct, z_px)
    parts = []
    # trunk: a gently bent bezier with bevel
    cu = bpy.data.curves.new(name + ' trunk', 'CURVE'); cu.dimensions = '3D'
    sp = cu.splines.new('BEZIER'); sp.bezier_points.add(1)
    p0, p1 = sp.bezier_points
    p0.co = (X, Y, 0); p0.handle_left = (X, Y, -0.2); p0.handle_right = (X + 0.08 * height, Y, 0.4 * height)
    p1.co = (X - 0.05 * height, Y, height); p1.handle_left = (X + 0.06 * height, Y, 0.7 * height); p1.handle_right = (X - 0.1 * height, Y, 1.1 * height)
    cu.bevel_depth = 0.035 * height; cu.bevel_resolution = 3
    trunk = bpy.data.objects.new(name + ' trunk', cu); trunk.data.materials.append(M['trunk']); C_PROPS.objects.link(trunk)
    top = (X - 0.05 * height, Y, height)
    leaves = []
    for k in range(6):
        a = k / 6 * math.tau
        l = sphere(f'{name} leaf', (top[0] + math.cos(a) * 0.28 * height, top[1] + math.sin(a) * 0.28 * height, top[2] - 0.05 * height),
                   (0.32 * height, 0.07 * height, 0.03 * height), M['palm_leaf'], C_PROPS, 16)
        l.rotation_euler = (0, 0.35, a)
        leaves.append(l)
    for k, m in enumerate((M['yellow'], M['orange'])):
        leaves.append(sphere(f'{name} coconut', (top[0] + (k - 0.5) * 0.08 * height, top[1] - 0.04 * height, top[2] - 0.08 * height),
                             (0.05 * height,) * 3, m, C_PROPS, 12))
    crown = join(leaves, name + ' crown')
    pivot = empty(name, (X, Y, 0), C_PROPS, 0.3)
    parent_keep(pivot, (trunk, crown))
    return tag(pivot, app_note=f"GARDEN.palm at x {x_pct} %, z {z_px} px")

palm('Palm (near)', 4, -140, 1.7)
palm('Palm (far)', 75, -560, 0.67)
tag(empty('Spot: palm', (-0.30 * W, 1.10, 0), C_PROPS, 0.2, 'SINGLE_ARROW'), app_note="ROAM_SPOTS.palm — where the pet sniffs")

X, Y = web_pos(92, -230)
tree_parts = [cyl('Tree trunk', (X, Y, 0.3), 0.06, 0.6, M['trunk'], C_PROPS)]
tree_parts += [sphere('Tree leaves', (X, Y, 0.78), (0.34,) * 3, M['leaf1'], C_PROPS),
               sphere('Tree leaves', (X - 0.18, Y + 0.05, 0.62), (0.22,) * 3, M['leaf2'], C_PROPS),
               sphere('Tree leaves', (X + 0.2, Y - 0.02, 0.64), (0.22,) * 3, M['leaf3'], C_PROPS)]
for dx, dz, m in ((-0.12, 0.84, M['red']), (0.14, 0.92, M['yellow']), (0.06, 0.6, M['red'])):
    tree_parts.append(sphere('Fruit', (X + dx, Y - 0.3, dz), (0.06,) * 3, m, C_PROPS, 12))
tree = join(tree_parts, 'Fruit tree')
set_origin_to(tree, (X, Y, 0))
tag(tree, app_note="GARDEN.tree at x 92 %, z −230 px")
tag(empty('Spot: tree', (0.28 * W, 2.05, 0), C_PROPS, 0.2, 'SINGLE_ARROW'), app_note="ROAM_SPOTS.tree — where the pet snacks")

def tuft(name, x_pct, z_px, flower, size):
    X, Y = web_pos(x_pct, z_px)
    parts = []
    for k, (dx, h) in enumerate(((-0.12, 0.35), (0.0, 0.5), (0.12, 0.3))):
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.06, depth=h, location=(X + dx * size, Y, h / 2))
        o = bpy.context.active_object; o.rotation_euler = (0, dx * 1.6, 0); o.data.materials.append(M['tuft']); link(o, C_PROPS); parts.append(o)
    parts.append(sphere('petal', (X - 0.1 * size, Y - 0.05, 0.32), (0.06, 0.06, 0.02), flower, C_PROPS, 12))
    parts.append(sphere('centre', (X - 0.1 * size, Y - 0.07, 0.33), (0.025,) * 3, M['centre'], C_PROPS, 8))
    o = join(parts, name); set_origin_to(o, (X, Y, 0))
    return tag(o, app_note=f"GARDEN.tuft at x {x_pct} %, z {z_px} px (in front of the pet)")

tuft('Flowers (left)', 4, 70, M['pink'], 1.0)
tuft('Flowers (right)', 97, 90, M['white'], 1.0)

# ---------------------------------------------------------------- sky things
X, Y = web_pos(68, -1100)
sun = sphere('Sun', (X, Y, 3.3), (0.25,) * 3, M['sun'], C_SKY)
for name, x_pct, z, top, w in (('Cloud A', 30, -1000, 3.2, 1.1), ('Cloud B', 88, -800, 2.5, 0.85)):
    X, Y = web_pos(x_pct, z)
    parts = [sphere(name, (X, Y, top), (0.42 * w, 0.2 * w, 0.15 * w), M['cloud'], C_SKY, 16),
             sphere(name, (X + 0.15 * w, Y, top + 0.1 * w), (0.25 * w, 0.18 * w, 0.17 * w), M['cloud'], C_SKY, 16),
             sphere(name, (X - 0.2 * w, Y, top + 0.04 * w), (0.18 * w, 0.15 * w, 0.13 * w), M['cloud'], C_SKY, 16)]
    join(parts, name)

world = bpy.data.worlds.new('Sky (day)')
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes['Background']
grad_tc = wn.nodes.new('ShaderNodeTexCoord')
sepw = wn.nodes.new('ShaderNodeSeparateXYZ')
ramp = wn.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = 0.0; ramp.color_ramp.elements[0].color = (*hexrgb('dff5ff'), 1)
ramp.color_ramp.elements[1].position = 0.35; ramp.color_ramp.elements[1].color = (*hexrgb('7fcaff'), 1)
wn.links.new(grad_tc.outputs['Generated'], sepw.inputs[0])
wn.links.new(sepw.outputs['Z'], ramp.inputs['Fac'])
wn.links.new(ramp.outputs['Color'], bg.inputs['Color'])
bg.inputs['Strength'].default_value = 1.0
# Note: Generated Z of the world goes 0.5 (horizon) → 1 (up); the ramp is set so the horizon is pale.
ramp.color_ramp.elements[0].position = 0.5; ramp.color_ramp.elements[1].position = 0.75

# ---------------------------------------------------------------- pet placeholder (app: petSVG, "grown" size; baby = 72 %, kid = 86 %)
pet_root = empty('Pet', (0, 0, 0), C_PET, 0.5, 'PLAIN_AXES')
body = sphere('Pet body', (0, 0, 0.62), (0.62, 0.52, 0.55), M['pet'], C_PET)
feet = [sphere('Pet foot L', (-0.24, -0.05, 0.07), (0.15, 0.13, 0.07), M['pet_dark'], C_PET, 16),
        sphere('Pet foot R', (0.24, -0.05, 0.07), (0.15, 0.13, 0.07), M['pet_dark'], C_PET, 16)]
eyes = [sphere('Pet eye L', (-0.16, -0.47, 0.72), (0.06, 0.04, 0.07), M['ink'], C_PET, 16),
        sphere('Pet eye R', (0.16, -0.47, 0.72), (0.06, 0.04, 0.07), M['ink'], C_PET, 16)]
bpy.ops.mesh.primitive_torus_add(major_radius=0.53, minor_radius=0.05, location=(0, 0, 0.9))
band = bpy.context.active_object; band.name = 'Pet headband'; band.scale = (1.0, 0.85, 1.0)
band.data.materials.append(M['band']); link(band, C_PET)
parent_keep(pet_root, [body, band] + feet + eyes)
tag(pet_root, app_note="Pet origin = feet on the ground. The pet roams around this spot; the camera follows it. "
                       "In the app the pet can be a blob, bean, … with patterns and accessories — this is just a stand-in.")

# ---------------------------------------------------------------- camera rig (app: perspective 420 px, eye at 38 %, ground line at 80 %)
rig = empty('Camera rig (follows pet)', (0, 0, 0), C_CAM, 0.4, 'SPHERE')
cam_data = bpy.data.cameras.new('Camera')
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.lens_unit = 'FOV'
cam_data.angle = 2 * math.atan((W / 2) / PERSP)      # ≈ 36.9° — same as the app
cam_data.clip_start = 0.05; cam_data.clip_end = 200
cam = bpy.data.objects.new('Camera', cam_data)
cam.location = (0, -PERSP, EYE_H)
cam.rotation_euler = (math.pi / 2, 0, 0)               # looks straight ahead, horizon at 38 % from the top
C_CAM.objects.link(cam)
cam.parent = rig
scene.camera = cam
tag(rig, app_note="Tilt in the app = rotate this rig: X ±6°, Z ±11°. It also moves with the pet (camera locked on the pet).")

# demo: a gentle orbit like the idle sway, frames 1–240
scene.frame_start, scene.frame_end = 1, 240
for f, rz, rx in ((1, -8, 2), (60, 0, -3), (120, 8, 2), (180, 0, -3), (240, -8, 2)):
    rig.rotation_euler = (math.radians(rx), 0, math.radians(rz))
    rig.keyframe_insert('rotation_euler', frame=f)

sunlight = bpy.data.lights.new('Sun light', 'SUN'); sunlight.energy = 3.0; sunlight.angle = math.radians(8)
sl = bpy.data.objects.new('Sun light', sunlight); sl.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
C_CAM.objects.link(sl)

# ---------------------------------------------------------------- render + notes
scene.render.resolution_x = scene.render.resolution_y = 1024
scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items.keys() else 'BLENDER_EEVEE'
scene.view_settings.view_transform = 'Standard'

notes = bpy.data.texts.new('README — Runagotchi garden')
notes.write(__doc__ + """
What's what
- Collections: Environment (ground, hills), Props (pond, path, cliff, palms, tree, flowers), Sky, Pet, Camera & light.
- Every placeholder has a custom property "app_note" (Object properties → Custom Properties) saying where it comes from in the app.
- Empties named "Spot: …" are where the pet walks to (ROAM_SPOTS in js/app.js). The pet's home is the world origin.
- Camera rig: the app's tilt rotates this rig (X ±6°, Z ±11°); the demo animation sways it like the idle camera.

Getting your models into the app
- Keep the same scale (1 m = 100 px), the ground at Z = 0, and the pet's origin between its feet.
- Export with File → Export → glTF 2.0 (.glb). Tell Claude which objects to use; the app can then load them
  (that needs switching the garden from flat SVG layers to a small WebGL viewer such as three.js).
""")
if bpy.app.background:
    import sys
    out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/tmp/runagotchi_garden.blend'
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print('saved', out)
