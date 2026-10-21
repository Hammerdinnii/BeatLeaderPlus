#!/usr/bin/env python3
"""Generate the test .saber files used by tests/unit/unity-saber.test.js.

A .saber file is a Unity asset bundle. This script writes small custom sabers the way Unity lays
them out, using UnityPy's database of Unity type trees so every object has exactly the fields a
real Unity build of that version writes. It then loads each file back with UnityPy and stores
what UnityPy decodes (meshes, textures, descriptor) as the expected result, so the JavaScript
reader is checked against an independent implementation.

    python3 -m pip install UnityPy==1.25.4
    python3 tests/tools/make_saber.py tests/fixtures

Each saber: a "_CustomSaber" root with a SaberDescriptor (name, author), "LeftSaber" and
"RightSaber" children with a blade and a handle (rotated, offset, two submeshes, two
materials), plus an inactive object and a disabled renderer that must not show up.
"""
import base64
import hashlib
import json
import lzma
import os
import struct
import sys

import lz4.block
import UnityPy
from PIL import Image
from UnityPy.helpers import Tpk, TypeTreeHelper
from UnityPy.helpers.MeshHelper import MeshHandler
from UnityPy.helpers.TypeTreeNode import TypeTreeNode
from UnityPy.helpers.UnityVersion import UnityVersion
from UnityPy.streams import EndianBinaryWriter

VARIANTS = [
    # name, Unity version, serialized file format, bundle format, compression, vertex data in .resS
    ("saber-unity2018.1-lzma", "2018.1.6f1", 17, 6, "lzma", False),
    ("saber-unity2019.4-lz4", "2019.4.28f1", 21, 7, "lz4", False),
    ("saber-unity2021.3-lz4-ress", "2021.3.16f1", 22, 7, "lz4", True),
]

NUMBERS = {
    "bool": False, "SInt8": 0, "UInt8": 0, "char": 0, "SInt16": 0, "short": 0, "UInt16": 0,
    "unsigned short": 0, "SInt32": 0, "int": 0, "UInt32": 0, "unsigned int": 0, "Type*": 0,
    "SInt64": 0, "long long": 0, "UInt64": 0, "unsigned long long": 0, "FileSize": 0,
    "float": 0.0, "double": 0.0,
}


def clone(n):
    """Type tree nodes are C-backed and can't be deep-copied; copy them field by field."""
    return TypeTreeNode(
        m_Level=n.m_Level, m_Type=n.m_Type, m_Name=n.m_Name, m_ByteSize=n.m_ByteSize, m_Version=n.m_Version,
        m_Children=[clone(c) for c in n.m_Children], m_TypeFlags=n.m_TypeFlags, m_VariableCount=n.m_VariableCount,
        m_Index=n.m_Index, m_MetaFlag=n.m_MetaFlag, m_RefTypeHash=n.m_RefTypeHash,
    )


def node_for(class_id, unity):
    node = clone(Tpk.get_typetree_node(class_id, UnityVersion.from_str(unity)))
    finish_node(node)
    return node


def finish_node(root):
    """Fill the per-node fields Unity writes that the type database leaves empty."""
    for index, n in enumerate(root.traverse()):
        n.m_Index = index
        n.m_TypeFlags = 1 if n.m_Type == "Array" else 0
        n.m_RefTypeHash = 0
        if n.m_MetaFlag is None:
            n.m_MetaFlag = 0


def child(node, *path):
    """Descend by field name; "[]" steps into an array's element type."""
    for name in path:
        if name == "[]":
            node = node.m_Children[0].m_Children[1]
        else:
            node = next(c for c in node.m_Children if c.m_Name == name)
    return node


def default(node):
    t = node.m_Type
    if t in NUMBERS:
        return NUMBERS[t]
    if t == "string":
        return ""
    if t == "TypelessData":
        return b""
    if t == "pair":
        return (default(node.m_Children[0]), default(node.m_Children[1]))
    if node.m_Children and node.m_Children[0].m_Type == "Array":
        return []
    return {c.m_Name: default(c) for c in node.m_Children}


def merge(base, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            merge(base[k], v)
        else:
            base[k] = v
    return base


def pptr(path_id):
    return {"m_FileID": 0, "m_PathID": path_id}


def vec(x, y, z):
    return {"x": float(x), "y": float(y), "z": float(z)}


# ---------------------------------------------------------------------------- geometry


def box(x0, x1, y0, y1, z0, z1):
    """24 vertices (4 per face, so normals and UVs are per face) and 12 triangles."""
    faces = [
        ((1, 0, 0), [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)]),
        ((-1, 0, 0), [(x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)]),
        ((0, 1, 0), [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)]),
        ((0, -1, 0), [(x0, y0, z1), (x0, y0, z0), (x1, y0, z0), (x1, y0, z1)]),
        ((0, 0, 1), [(x1, y0, z1), (x1, y1, z1), (x0, y1, z1), (x0, y0, z1)]),
        ((0, 0, -1), [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)]),
    ]
    verts, normals, uvs, colors, tris = [], [], [], [], []
    for f, (n, quad) in enumerate(faces):
        base = len(verts)
        for k, v in enumerate(quad):
            verts.append(v)
            normals.append(n)
            uvs.append(((k in (1, 2)) * 1.0, (k in (2, 3)) * 0.5 + f / 12))
            colors.append((f / 5, 1 - f / 5, 0.5, 1.0))
        # Unity winds triangles clockwise when seen from the front.
        tris.append([base, base + 1, base + 2, base, base + 2, base + 3])
    return verts, normals, uvs, colors, tris


def half(x):
    return struct.pack("<e", x)


def mesh_object(node, name, geometry, submesh_faces, base_vertex_for_second, resource):
    verts, normals, uvs, colors, tris = geometry
    n = len(verts)
    stream0 = b"".join(struct.pack("<6f", *v, *nv) for v, nv in zip(verts, normals))
    stream1 = b"".join(bytes(int(round(c * 255)) for c in col) + half(u) + half(v) for col, (u, v) in zip(colors, uvs))
    pad = (-len(stream0)) % 16
    data = stream0 + bytes(pad) + stream1 + bytes((-len(stream1)) % 16)
    channels = [{"stream": 0, "offset": 0, "format": 0, "dimension": 0} for _ in range(14)]
    channels[0] = {"stream": 0, "offset": 0, "format": 0, "dimension": 3}  # position, float32
    channels[1] = {"stream": 0, "offset": 12, "format": 0, "dimension": 3}  # normal, float32
    channels[3] = {"stream": 1, "offset": 0, "format": 2, "dimension": 4}  # color, unorm8
    channels[4] = {"stream": 1, "offset": 4, "format": 1, "dimension": 2}  # uv0, float16

    index_bytes = b""
    submeshes = []
    for k, faces in enumerate(submesh_faces):
        idx = [i for f in faces for i in tris[f]]
        base_vertex = 0
        if k == 1 and base_vertex_for_second:
            base_vertex = min(idx)
            idx = [i - base_vertex for i in idx]
        submeshes.append({
            "firstByte": len(index_bytes), "indexCount": len(idx), "topology": 0, "baseVertex": base_vertex,
            "firstVertex": 0, "vertexCount": n,
            "localAABB": {"m_Center": vec(0, 0, 0), "m_Extent": vec(1, 1, 1)},
        })
        index_bytes += struct.pack("<%dH" % len(idx), *idx)

    obj = default(node)
    obj["m_Name"] = name
    obj["m_SubMeshes"] = [merge(default(child(node, "m_SubMeshes", "[]")), s) for s in submeshes]
    obj["m_IsReadable"] = True
    if "m_IndexFormat" in obj:
        obj["m_IndexFormat"] = 0
    obj["m_IndexBuffer"] = list(index_bytes)
    obj["m_VertexData"]["m_VertexCount"] = n
    obj["m_VertexData"]["m_Channels"] = channels
    if resource is not None:
        obj["m_VertexData"]["m_DataSize"] = b""
        obj["m_StreamData"] = {"offset": len(resource["data"]), "size": len(data), "path": resource["path"]}
        resource["data"] += data
    else:
        obj["m_VertexData"]["m_DataSize"] = data
    return obj


# ---------------------------------------------------------------------------- textures


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def dxt1_texture():
    """8×8 DXT1: four blocks, one of them in 3-color + transparent mode."""
    blocks = []
    specs = [((255, 0, 0), (0, 0, 255), 0x1B1B1B1B), ((0, 255, 0), (255, 255, 0), 0xE4E4E4E4),
             ((255, 255, 255), (0, 0, 0), 0x00FF00FF), ((30, 30, 30), (200, 100, 50), 0x3C3C3C3C)]
    for k, (c0, c1, bits) in enumerate(specs):
        a, b = rgb565(*c0), rgb565(*c1)
        if k == 3:
            a, b = min(a, b), max(a, b)  # c0 <= c1: 3 colors and transparent black
        elif a <= b:
            a, b = b, a
        blocks.append(struct.pack("<HHI", a, b, bits))
    return 8, 8, 10, b"".join(blocks)


def dxt5_texture():
    """4×4 DXT5 with an alpha gradient."""
    alpha_bits = 0
    for i in range(16):
        alpha_bits |= (i % 8) << (3 * i)
    alpha = struct.pack("<BB", 255, 16) + alpha_bits.to_bytes(6, "little")
    color = struct.pack("<HHI", rgb565(255, 128, 0), rgb565(0, 64, 255), 0x9C9C9C9C)
    return 4, 4, 12, alpha + color


def rgba32_texture():
    data = bytes(v for y in range(4) for x in range(4) for v in (x * 60, y * 60, 128, 255 - x * 40))
    return 4, 4, 4, data


def texture_object(node, name, spec):
    w, h, fmt, data = spec
    obj = default(node)
    merge(obj, {"m_Name": name, "m_Width": w, "m_Height": h, "m_CompleteImageSize": len(data), "m_TextureFormat": fmt,
                "m_IsReadable": True, "image data": data})
    for key, value in (("m_MipCount", 1), ("m_ImageCount", 1), ("m_TextureDimension", 2)):
        if key in obj:
            obj[key] = value
    return obj


# ---------------------------------------------------------------------------- serialized file


def write_serialized(unity, version, types, objects, script_types, cab_name):
    """types: [(class_id, node, script_index)], objects: [(path_id, type_index, bytes)]."""
    little = "<"
    meta = bytearray()
    header_size = 48 if version >= 22 else 20

    def put(fmt, *values):
        meta.extend(struct.pack(little + fmt, *values))

    def cstr(s):
        meta.extend(s.encode() + b"\0")

    def align4():
        while (header_size + len(meta)) % 4:
            meta.append(0)

    cstr(unity)
    put("i", 19)  # StandaloneWindows64
    put("?", True)  # type trees included
    put("i", len(types))
    for class_id, node, script_index in types:
        put("i", class_id)
        put("?", False)
        put("h", script_index)
        if class_id == 114:
            meta.extend(hashlib.md5(b"SaberDescriptor").digest())
        meta.extend(hashlib.md5(("type%d" % class_id).encode()).digest())
        w = EndianBinaryWriter(endian=little)
        node.dump_blob(w, version)
        meta.extend(w.bytes)
        if version >= 21:
            put("i", 0)  # type dependencies

    data = bytearray()
    entries = []
    for path_id, type_index, body in objects:
        while len(data) % 8:
            data.append(0)
        entries.append((path_id, len(data), len(body), type_index))
        data.extend(body)

    put("i", len(entries))
    for path_id, start, size, type_index in entries:
        align4()
        put("q", path_id)
        put("q" if version >= 22 else "I", start)
        put("I", size)
        put("i", type_index)
    put("i", len(script_types))
    for path_id in script_types:
        put("i", 0)
        align4()
        put("q", path_id)
    put("i", 0)  # externals
    if version >= 20:
        put("i", 0)  # ref types
    cstr("")  # user information

    data_offset = header_size + len(meta)
    data_offset += (-data_offset) % 16
    file_size = data_offset + len(data)
    if version >= 22:
        header = struct.pack(">IIII", 0, 0, version, 0) + bytes([0, 0, 0, 0]) + struct.pack(">Iqqq", len(meta), file_size, data_offset, 0)
    else:
        header = struct.pack(">IIII", len(meta), file_size, version, data_offset) + bytes([0, 0, 0, 0])
    assert len(header) == header_size
    out = header + bytes(meta)
    out += bytes(data_offset - len(out))
    return out + bytes(data)


# ---------------------------------------------------------------------------- bundle


def compress(data, kind):
    if kind == "lz4":
        return lz4.block.compress(data, mode="high_compression", compression=12, store_size=False), 3
    if kind == "lzma":
        alone = lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[{"id": lzma.FILTER_LZMA1, "lc": 3, "lp": 0, "pb": 2, "dict_size": 1 << 19}])
        return alone[:5] + alone[13:], 1
    return data, 0


def write_bundle(unity, bundle_format, kind, files):
    """files: [(path, bytes, flags)]"""
    payload = b"".join(f[1] for f in files)
    chunk = 1 << 17 if kind == "lz4" else max(1, len(payload))
    blocks = []
    for i in range(0, len(payload), chunk):
        part = payload[i:i + chunk]
        packed, flag = compress(part, kind)
        blocks.append((len(part), packed, flag))
    info = bytes(16) + struct.pack(">i", len(blocks))
    for size, packed, flag in blocks:
        info += struct.pack(">IIH", size, len(packed), flag)
    info += struct.pack(">i", len(files))
    offset = 0
    for path, data, flags in files:
        info += struct.pack(">qqI", offset, len(data), flags) + path.encode() + b"\0"
        offset += len(data)
    packed_info, info_flag = compress(info, "lz4")
    version = tuple(int(x) for x in unity.split("f")[0].split("."))
    new_flags = version >= (2021, 3, 2)
    flags = info_flag | 0x40 | (0x200 if new_flags else 0)

    head = b"UnityFS\0" + struct.pack(">I", bundle_format) + b"5.x.x\0" + unity.encode() + b"\0"
    rest_header = struct.pack(">qIII", 0, len(packed_info), len(info), flags)
    out = bytearray(head + rest_header)
    if bundle_format >= 7:
        out += bytes((-len(out)) % 16)
    out += packed_info
    if new_flags:
        out += bytes((-len(out)) % 16)
    for _, packed, _ in blocks:
        out += packed
    out[len(head):len(head) + 8] = struct.pack(">q", len(out))
    return bytes(out)


# ---------------------------------------------------------------------------- saber


def build(unity, sf_version, bundle_format, kind, streamed):
    cab = "CAB-" + hashlib.md5(unity.encode()).hexdigest()
    resource = {"path": "archive:/%s/%s.resS" % (cab, cab), "data": b""} if streamed else None
    nodes = {cid: node_for(cid, unity) for cid in (1, 4, 21, 23, 28, 33, 43, 115, 142)}

    # MonoBehaviour with the SaberDescriptor fields appended after Unity's own.
    mb = node_for(114, unity)
    name_node = next(c for c in mb.m_Children if c.m_Name == "m_Name")
    script_node = next(c for c in mb.m_Children if c.m_Name == "m_Script")
    for field in ("SaberName", "AuthorName", "Description"):
        n = clone(name_node)
        n.m_Name = field
        mb.m_Children.append(n)
    cover = clone(script_node)
    cover.m_Name = "CoverImage"
    cover.m_Type = "PPtr<Texture2D>"
    mb.m_Children.append(cover)
    finish_node(mb)
    nodes[114] = mb

    objects = []  # (path_id, class_id, dict)
    next_id = [1]

    def add(class_id, value):
        pid = next_id[0]
        next_id[0] += 1
        objects.append([pid, class_id, value])
        return pid

    def obj(class_id, **fields):
        return merge(default(nodes[class_id]), fields)

    tex_dxt1 = add(28, texture_object(nodes[28], "BladeTex", dxt1_texture()))
    tex_dxt5 = add(28, texture_object(nodes[28], "HandleTex", dxt5_texture()))
    tex_rgba = add(28, texture_object(nodes[28], "AccentTex", rgba32_texture()))

    def material(name, color, tex, floats):
        return add(21, obj(21, m_Name=name, m_SavedProperties={
            "m_TexEnvs": [("_MainTex", {"m_Texture": pptr(tex), "m_Scale": {"x": 1.0, "y": 1.0}, "m_Offset": {"x": 0.0, "y": 0.0}})] if tex else [],
            "m_Floats": [(k, float(v)) for k, v in floats],
            "m_Colors": [("_Color", {"r": color[0], "g": color[1], "b": color[2], "a": color[3]})],
        }))

    mat_blade_l = material("BladeLeft", (1.0, 0.2, 0.2, 1.0), tex_dxt1, [("_CustomColors", 1), ("_Glow", 1)])
    mat_blade_r = material("BladeRight", (0.2, 0.2, 1.0, 1.0), tex_dxt1, [("_Glow", 0.8)])
    mat_handle = material("Handle", (0.3, 0.3, 0.35, 1.0), tex_dxt5, [("_CustomColors", 0), ("_Glow", 1)])
    mat_accent = material("Accent", (1.0, 1.0, 1.0, 0.5), tex_rgba, [])

    blade = box(-0.02, 0.02, -0.01, 0.03, 0.0, 1.0)
    handle = box(-0.03, 0.03, -0.015, 0.015, -0.2, 0.0)
    mesh_blade = add(43, mesh_object(nodes[43], "BladeMesh", blade, [range(6)], False, resource))
    mesh_handle = add(43, mesh_object(nodes[43], "HandleMesh", handle, [range(4), range(4, 6)], True, resource))

    def transform(go, father, pos=(0, 0, 0), rot=(0, 0, 0, 1), scale=(1, 1, 1)):
        return obj(4, m_GameObject=pptr(go), m_Father=pptr(father), m_LocalPosition=vec(*pos),
                   m_LocalRotation={"x": rot[0], "y": rot[1], "z": rot[2], "w": rot[3]}, m_LocalScale=vec(*scale), m_Children=[])

    def component_list(*ids):
        sample = child(nodes[1], "m_Component", "[]")
        if sample.m_Type == "pair":
            return [(4, pptr(i)) for i in ids]
        return [{"component": pptr(i)} for i in ids]

    def game_object(name, active=True):
        return add(1, obj(1, m_Name=name, m_IsActive=active, m_Component=[]))

    def entry(pid):
        return next(o for o in objects if o[0] == pid)

    def renderer(go, mats, enabled=True):
        return add(23, obj(23, m_GameObject=pptr(go), m_Enabled=enabled, m_Materials=[pptr(m) for m in mats]))

    script = add(115, obj(115, m_Name="SaberDescriptor", m_ClassName="SaberDescriptor", m_Namespace="CustomSaber", m_AssemblyName="CustomSaber.dll"))

    def node_object(name, father_t, mesh=None, mats=(), pos=(0, 0, 0), rot=(0, 0, 0, 1), scale=(1, 1, 1), active=True, enabled=True):
        go = game_object(name, active)
        t = add(4, transform(go, father_t, pos, rot, scale))
        comps = [t]
        if mesh:
            comps.append(add(33, obj(33, m_GameObject=pptr(go), m_Mesh=pptr(mesh))))
            comps.append(renderer(go, mats, enabled))
        entry(go)[2]["m_Component"] = component_list(*comps)
        if father_t:
            entry(father_t)[2]["m_Children"].append(pptr(t))
        return go, t

    root_go, root_t = node_object("_CustomSaber", 0)
    desc = add(114, merge(default(mb), {"m_GameObject": pptr(root_go), "m_Enabled": 1, "m_Script": pptr(script), "m_Name": "",
                                       "SaberName": "Test Saber ✦", "AuthorName": "BeatLeaderPlus tests", "Description": "", "CoverImage": pptr(0)}))
    entry(root_go)[2]["m_Component"] = component_list(root_t, desc)

    s45 = 0.7071067811865476
    _, left_t = node_object("LeftSaber", root_t, pos=(-0.25, 0.1, 0.0))  # root placement is ignored in game
    node_object("Blade", left_t, mesh_blade, [mat_blade_l])
    node_object("Handle", left_t, mesh_handle, [mat_handle, mat_accent], pos=(0, 0, -0.05), rot=(0, 0, s45, s45))
    node_object("EventGlow", left_t, mesh_blade, [mat_accent], active=False)

    _, right_t = node_object("RightSaber", root_t, pos=(0.25, 0.1, 0.0))
    node_object("Blade", right_t, mesh_blade, [mat_blade_r], scale=(1, 1, 1.1))
    node_object("HiddenHandle", right_t, mesh_handle, [mat_handle], enabled=False)

    preload = [pptr(o[0]) for o in objects]
    asset_info = merge(default(child(nodes[142], "m_Container", "[]").m_Children[1]), {"preloadIndex": 0, "preloadSize": len(preload), "asset": pptr(root_go)})
    add(142, obj(142, m_Name="testsaber", m_PreloadTable=preload, m_Container=[("assets/_customsaber.prefab", asset_info)], m_AssetBundleName="testsaber"))

    class_order = []
    for _, cid, _ in objects:
        if cid not in class_order:
            class_order.append(cid)
    types = [(cid, nodes[cid], 0 if cid == 114 else -1) for cid in class_order]
    serialized_objects = []
    for pid, cid, value in objects:
        w = EndianBinaryWriter(endian="<")
        TypeTreeHelper.write_typetree(value, nodes[cid], w)
        serialized_objects.append((pid, class_order.index(cid), w.bytes))
    cab_bytes = write_serialized(unity, sf_version, types, serialized_objects, [script], cab)
    files = [(cab, cab_bytes, 4)]
    if resource is not None:
        files.append((cab + ".resS", resource["data"], 0))
    return write_bundle(unity, bundle_format, kind, files)


# ---------------------------------------------------------------------------- reference data from UnityPy


def reference(data):
    env = UnityPy.load(data)
    ref = {"meshes": {}, "textures": {}, "materials": {}, "descriptor": None}
    for obj in env.objects:
        tree = obj.parse_as_dict()  # every object must parse
        if obj.type.name == "Mesh":
            mesh = obj.parse_as_object()
            h = MeshHandler(mesh)
            h.process()
            ref["meshes"][tree["m_Name"]] = {
                "vertexCount": h.m_VertexCount,
                "positions": [c for v in h.m_Vertices for c in v],
                "normals": [c for v in h.m_Normals for c in v[:3]],
                "uvs": [c for v in h.m_UV0 for c in v],
                "colors": [c for v in h.m_Colors for c in v],
                "submeshes": [[i for tri in sub for i in tri] for sub in h.get_triangles()],
                # Unity adds baseVertex to every index of a submesh; get_triangles() leaves it out.
                "baseVertex": [sm.get("baseVertex", 0) for sm in tree["m_SubMeshes"]],
            }
        elif obj.type.name == "Texture2D":
            # UnityPy flips images to top-down; flip back to Unity's bottom-up row order.
            img = obj.parse_as_object().image.convert("RGBA").transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            ref["textures"][tree["m_Name"]] = {"width": img.width, "height": img.height, "rgba": base64.b64encode(img.tobytes()).decode()}
        elif obj.type.name == "Material":
            props = tree["m_SavedProperties"]
            ref["materials"][tree["m_Name"]] = {"floats": dict(props["m_Floats"]), "colors": dict(props["m_Colors"])}
        elif obj.type.name == "MonoBehaviour" and "SaberName" in tree:
            ref["descriptor"] = {"name": tree["SaberName"], "author": tree["AuthorName"]}
    return ref


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, unity, sf_version, bundle_format, kind, streamed in VARIANTS:
        data = build(unity, sf_version, bundle_format, kind, streamed)
        with open(os.path.join(out_dir, name + ".saber"), "wb") as f:
            f.write(data)
        ref = reference(data)
        ref["unity"] = unity
        with open(os.path.join(out_dir, name + ".expected.json"), "w") as f:
            json.dump(ref, f, indent=1)
        print("%-30s %6d bytes  meshes=%s textures=%s descriptor=%s" % (name, len(data), sorted(ref["meshes"]), sorted(ref["textures"]), ref["descriptor"]))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "fixtures"))
