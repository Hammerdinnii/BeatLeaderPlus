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

extras-unity2021.3.saber adds what Unity builds at load time or keeps outside the bundle: a
stick using Unity's built-in Cylinder mesh and Default-Material, a mesh from an unknown external
file, TextMeshPro text with its font asset (SDF atlas, glyph and character tables), a legacy
TextMesh, a trail renderer, materials that are see-through, additive, cut out or (alpha 0)
solid, and a BC7 texture with a block in each mode.
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
EXTRAS = ("extras-unity2021.3", "2021.3.16f1", 22, 7, "lz4", False)

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


def pptr(path_id, file_id=0):
    return {"m_FileID": file_id, "m_PathID": path_id}


def vec(x, y, z):
    return {"x": float(x), "y": float(y), "z": float(z)}


# ---------------------------------------------------------------------------- hand-built type trees


def tnode(t, name, size=-1, meta=0, children=()):
    return TypeTreeNode(m_Level=0, m_Type=t, m_Name=name, m_ByteSize=size, m_Version=1, m_Children=list(children),
                        m_TypeFlags=0, m_VariableCount=0, m_Index=0, m_MetaFlag=meta, m_RefTypeHash=0)


def f32(name):
    return tnode("float", name, 4)


def i32(name):
    return tnode("int", name, 4)


def u32(name):
    return tnode("unsigned int", name, 4)


def boolean(name):
    return tnode("bool", name, 1, 0x4000)


def string_node(name):
    return tnode("string", name, -1, 0x8000, [tnode("Array", "Array", -1, 0x4001, [tnode("int", "size", 4, 1), tnode("char", "data", 1, 1)])])


def struct_node(t, name, children):
    sizes = [c.m_ByteSize for c in children]
    return tnode(t, name, sum(sizes) if all(x > 0 for x in sizes) else -1, 0, children)


def vector_node(name, item):
    item.m_Name = "data"
    return tnode("vector", name, -1, 0, [tnode("Array", "Array", -1, 0, [tnode("int", "size", 4), item])])


def pptr_node(name, target):
    return tnode("PPtr<%s>" % target, name, 12, 0, [tnode("int", "m_FileID", 4), tnode("SInt64", "m_PathID", 8)])


def set_levels(node, level=0):
    node.m_Level = level
    for c in node.m_Children:
        set_levels(c, level + 1)


def mono_node(unity, fields):
    """A MonoBehaviour type tree: Unity's own fields, then the script's."""
    node = node_for(114, unity)
    node.m_Children.extend(fields)
    set_levels(node)
    finish_node(node)
    return node


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


# A tiny TextMeshPro-style font: glyphs made of bars, stored as a signed distance field.
FONT_POINT_SIZE = 16
FONT_PADDING = 4
GLYPH = {"w": 10, "h": 14, "bx": 1, "by": 14, "adv": 12}
GLYPH_BARS = {
    "T": [(0, 10, 11.5, 14), (3.75, 6.25, 0, 14)],
    "I": [(3.75, 6.25, 0, 14)],
    "L": [(0, 2.5, 0, 14), (0, 10, 0, 2.5)],
    "E": [(0, 2.5, 0, 14), (0, 10, 11.5, 14), (0, 8, 5.75, 8.25), (0, 10, 0, 2.5)],
    "H": [(0, 2.5, 0, 14), (7.5, 10, 0, 14), (0, 10, 5.75, 8.25)],
    "+": [(0, 10, 5.75, 8.25), (3.75, 6.25, 2, 12)],
}
ATLAS_W, ATLAS_H = 128, 24


def glyph_rect(i):
    return {"m_X": 5 + 20 * i, "m_Y": 5, "m_Width": GLYPH["w"], "m_Height": GLYPH["h"]}


def sdf_atlas():
    """Alpha8, rows bottom-up: 0.5 on each glyph's edge, ±(padding + 1) pixels → 0…1."""
    spread = FONT_PADDING + 1
    data = bytearray(ATLAS_W * ATLAS_H)
    for i, bars in enumerate(GLYPH_BARS.values()):
        r = glyph_rect(i)
        for y in range(ATLAS_H):
            for x in range(r["m_X"] - spread, r["m_X"] + r["m_Width"] + spread):
                px, py = x + 0.5 - r["m_X"], y + 0.5 - r["m_Y"]
                d = min(box_distance(px, py, b) for b in bars)
                data[y * ATLAS_W + x] = max(data[y * ATLAS_W + x], int(round(max(0.0, min(1.0, 0.5 - d / (2 * spread))) * 255)))
    return ATLAS_W, ATLAS_H, 1, bytes(data)


def box_distance(px, py, bar):
    """Signed distance to a box (negative inside)."""
    x0, x1, y0, y1 = bar
    qx = abs(px - (x0 + x1) / 2) - (x1 - x0) / 2
    qy = abs(py - (y0 + y1) / 2) - (y1 - y0) / 2
    return (max(qx, 0) ** 2 + max(qy, 0) ** 2) ** 0.5 + min(max(qx, qy), 0)


def bc7_texture():
    """16×8 BC7: one block in each of the 8 modes, the other bits arbitrary (any bits are valid)."""
    blocks = b""
    for mode in range(8):
        v = int.from_bytes(hashlib.md5(b"bc7-%d" % mode).digest(), "little")
        v = (v & ~((1 << (mode + 1)) - 1)) | (1 << mode)  # mode m: m zero bits, then a one
        blocks += v.to_bytes(16, "little")
    return 16, 8, 25, blocks


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


def write_serialized(unity, version, types, objects, script_types, cab_name, externals=()):
    """types: [(class_id, node, script_index, script_name)], objects: [(path_id, type_index, bytes)]."""
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
    for class_id, node, script_index, script_name in types:
        put("i", class_id)
        put("?", False)
        put("h", script_index)
        if class_id == 114:
            meta.extend(hashlib.md5(script_name.encode()).digest())
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
    put("i", len(externals))
    for path in externals:
        cstr("")
        meta.extend(bytes(16))  # GUID
        put("i", 0)  # type
        cstr(path)
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


def build(unity, sf_version, bundle_format, kind, streamed, extras=False):
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

    objects = []  # (path_id, type key, dict); the type key is the class ID or a script's name
    type_info = {}  # type key → (class ID, node, script index, script name) for MonoBehaviours
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

    def material(name, color, tex, floats, **extra):
        return add(21, obj(21, m_Name=name, m_SavedProperties={
            "m_TexEnvs": [("_MainTex", {"m_Texture": pptr(tex), "m_Scale": {"x": 1.0, "y": 1.0}, "m_Offset": {"x": 0.0, "y": 0.0}})] if tex else [],
            "m_Floats": [(k, float(v)) for k, v in floats],
            "m_Colors": [("_Color", {"r": color[0], "g": color[1], "b": color[2], "a": color[3]})],
        }, **extra))

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

    def ref(x):
        return x if isinstance(x, dict) else pptr(x)

    def renderer(go, mats, enabled=True):
        return add(23, obj(23, m_GameObject=pptr(go), m_Enabled=enabled, m_Materials=[ref(m) for m in mats]))

    script = add(115, obj(115, m_Name="SaberDescriptor", m_ClassName="SaberDescriptor", m_Namespace="CustomSaber", m_AssemblyName="CustomSaber.dll"))

    def node_object(name, father_t, mesh=None, mats=(), pos=(0, 0, 0), rot=(0, 0, 0, 1), scale=(1, 1, 1), active=True, enabled=True):
        go = game_object(name, active)
        t = add(4, transform(go, father_t, pos, rot, scale))
        comps = [t]
        if mesh:
            comps.append(add(33, obj(33, m_GameObject=pptr(go), m_Mesh=ref(mesh))))
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

    script_types = [script]
    externals = []
    if extras:
        externals = ["library/unity default resources", "resources/unity_builtin_extra", "archive:/CAB-other/CAB-other"]
        for cid in (96, 102, 224):
            nodes[cid] = node_for(cid, unity)
        # Unity's built-in Cylinder with its Default-Material, and a mesh from a file that isn't here.
        node_object("Stick", left_t, pptr(10206, 1), [pptr(10303, 2)], pos=(0, 0, -0.1), scale=(0.03, 0.1, 0.03))
        node_object("Mystery", left_t, pptr(777, 3), [mat_accent])

        # TextMeshPro: font asset (SDF atlas + tables), its material, and a 3D text object.
        def script_type(key, name):
            pid = add(115, obj(115, m_Name=name, m_ClassName=name, m_Namespace="TMPro", m_AssemblyName="Unity.TextMeshPro.dll"))
            script_types.append(pid)
            return pid

        def color_node(name):
            return struct_node("ColorRGBA", name, [f32("r"), f32("g"), f32("b"), f32("a")])

        font_script = script_type("tmp_font", "TMP_FontAsset")
        text_script = script_type("tmp_text", "TextMeshPro")
        type_info["tmp_font"] = (114, mono_node(unity, [
            struct_node("FaceInfo", "m_FaceInfo", [string_node("m_FamilyName"), f32("m_PointSize"), f32("m_Scale"), f32("m_LineHeight"), f32("m_AscentLine"),
                                                    f32("m_CapLine"), f32("m_MeanLine"), f32("m_Baseline"), f32("m_DescentLine")]),
            vector_node("m_GlyphTable", struct_node("Glyph", "data", [
                u32("m_Index"),
                struct_node("GlyphMetrics", "m_Metrics", [f32("m_Width"), f32("m_Height"), f32("m_HorizontalBearingX"), f32("m_HorizontalBearingY"), f32("m_HorizontalAdvance")]),
                struct_node("GlyphRect", "m_GlyphRect", [i32("m_X"), i32("m_Y"), i32("m_Width"), i32("m_Height")]),
                f32("m_Scale"), i32("m_AtlasIndex")])),
            vector_node("m_CharacterTable", struct_node("TMP_Character", "data", [i32("m_ElementType"), u32("m_Unicode"), u32("m_GlyphIndex"), f32("m_Scale")])),
            vector_node("m_AtlasTextures", pptr_node("data", "Texture2D")),
            i32("m_AtlasWidth"), i32("m_AtlasHeight"), i32("m_AtlasPadding"),
            pptr_node("material", "Material"),
            f32("normalSpacingOffset"), f32("boldSpacing"),
        ]), 1, "TMP_FontAsset")
        type_info["tmp_text"] = (114, mono_node(unity, [
            string_node("m_text"), pptr_node("m_fontAsset", "TMP_FontAsset"), pptr_node("m_sharedMaterial", "Material"),
            color_node("m_fontColor"), f32("m_fontSize"), i32("m_fontStyle"),
            i32("m_HorizontalAlignment"), i32("m_VerticalAlignment"), i32("m_textAlignment"),
            f32("m_characterSpacing"), f32("m_wordSpacing"), f32("m_lineSpacing"),
            boolean("m_enableWordWrapping"), boolean("m_isRichText"), boolean("m_parseCtrlCharacters"), boolean("m_isOrthographic"),
            struct_node("Vector4f", "m_margin", [f32("x"), f32("y"), f32("z"), f32("w")]),
        ]), 2, "TextMeshPro")

        atlas = add(28, texture_object(nodes[28], "TestFont Atlas", sdf_atlas()))
        rgba = lambda c: {"r": c[0], "g": c[1], "b": c[2], "a": c[3]}
        tmp_mat = add(21, obj(21, m_Name="TestFont Material", m_SavedProperties={
            "m_TexEnvs": [("_MainTex", {"m_Texture": pptr(atlas), "m_Scale": {"x": 1.0, "y": 1.0}, "m_Offset": {"x": 0.0, "y": 0.0}})],
            "m_Floats": [("_OutlineWidth", 0.1), ("_FaceDilate", 0.0), ("_ScaleRatioA", 0.8), ("_WeightNormal", 0.0), ("_WeightBold", 0.5), ("_GradientScale", 5.0)],
            "m_Colors": [("_FaceColor", rgba((1.0, 1.0, 1.0, 1.0))), ("_OutlineColor", rgba((0.0, 0.0, 0.0, 1.0)))],
        }))
        glyphs = [{"m_Index": i + 1, "m_Metrics": {"m_Width": GLYPH["w"], "m_Height": GLYPH["h"], "m_HorizontalBearingX": GLYPH["bx"], "m_HorizontalBearingY": GLYPH["by"],
                                                  "m_HorizontalAdvance": GLYPH["adv"]}, "m_GlyphRect": glyph_rect(i), "m_Scale": 1.0, "m_AtlasIndex": 0}
                  for i in range(len(GLYPH_BARS))]
        space = len(GLYPH_BARS) + 1
        glyphs.append({"m_Index": space, "m_Metrics": {"m_Width": 0, "m_Height": 0, "m_HorizontalBearingX": 0, "m_HorizontalBearingY": 0, "m_HorizontalAdvance": 6},
                       "m_GlyphRect": {"m_X": 0, "m_Y": 0, "m_Width": 0, "m_Height": 0}, "m_Scale": 1.0, "m_AtlasIndex": 0})
        characters = [{"m_ElementType": 1, "m_Unicode": ord(ch), "m_GlyphIndex": i + 1, "m_Scale": 1.0} for i, ch in enumerate(GLYPH_BARS)]
        characters.append({"m_ElementType": 1, "m_Unicode": 32, "m_GlyphIndex": space, "m_Scale": 1.0})
        font = add("tmp_font", merge(default(type_info["tmp_font"][1]), {
            "m_Enabled": 1, "m_Script": pptr(font_script), "m_Name": "TestFont SDF",
            "m_FaceInfo": {"m_FamilyName": "Test", "m_PointSize": float(FONT_POINT_SIZE), "m_Scale": 1.0, "m_LineHeight": 20.0, "m_AscentLine": 15.0,
                           "m_CapLine": 14.0, "m_MeanLine": 10.0, "m_Baseline": 0.0, "m_DescentLine": -5.0},
            "m_GlyphTable": glyphs, "m_CharacterTable": characters, "m_AtlasTextures": [pptr(atlas)],
            "m_AtlasWidth": ATLAS_W, "m_AtlasHeight": ATLAS_H, "m_AtlasPadding": FONT_PADDING, "material": pptr(tmp_mat),
            "normalSpacingOffset": 0.0, "boldSpacing": 7.0,
        }))

        label_go = game_object("Label")
        label_t = add(224, obj(224, m_GameObject=pptr(label_go), m_Father=pptr(left_t), m_LocalPosition=vec(0, 0.05, 0.3),
                               m_LocalRotation={"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}, m_LocalScale=vec(1, 1, 1), m_Children=[],
                               m_AnchorMin={"x": 0.5, "y": 0.5}, m_AnchorMax={"x": 0.5, "y": 0.5}, m_AnchoredPosition={"x": 0.0, "y": 0.05},
                               m_SizeDelta={"x": 2.0, "y": 0.5}, m_Pivot={"x": 0.5, "y": 0.5}))
        entry(left_t)[2]["m_Children"].append(pptr(label_t))
        label_text = add("tmp_text", merge(default(type_info["tmp_text"][1]), {
            "m_GameObject": pptr(label_go), "m_Enabled": 1, "m_Script": pptr(text_script),
            # A color tag, a "\n" typed as two characters (TextMeshPro turns it into a line break)
            # and a character the font doesn't have.
            "m_text": "TILE<color=#FF8000>+</color>\\nHI!", "m_fontAsset": pptr(font), "m_sharedMaterial": pptr(tmp_mat),
            "m_fontColor": rgba((1.0, 1.0, 1.0, 1.0)), "m_fontSize": 2.0, "m_fontStyle": 0,
            "m_HorizontalAlignment": 2, "m_VerticalAlignment": 512, "m_textAlignment": 65535,
            "m_enableWordWrapping": False, "m_isRichText": True, "m_parseCtrlCharacters": True, "m_isOrthographic": False,
        }))
        entry(label_go)[2]["m_Component"] = component_list(label_t, add(33, obj(33, m_GameObject=pptr(label_go), m_Mesh=pptr(0))),
                                                          renderer(label_go, [tmp_mat]), label_text)

        # Legacy TextMesh (yellow, bold, centered) and a trail renderer on the right saber.
        old_go, old_t = node_object("OldText", right_t, pos=(0, 0, -0.1))
        old_text = add(102, obj(102, m_GameObject=pptr(old_go), m_Text="BL+", m_CharacterSize=0.1, m_LineSpacing=1.0, m_Anchor=4, m_Alignment=1,
                                m_FontSize=20, m_FontStyle=1, m_RichText=True, m_Color={"rgba": 0xFF00FFFF}))
        entry(old_go)[2]["m_Component"] = component_list(old_t, renderer(old_go, []), old_text)
        trail_go, trail_t = node_object("Trail", right_t)
        entry(trail_go)[2]["m_Component"] = component_list(trail_t, add(96, obj(96, m_GameObject=pptr(trail_go), m_Enabled=True)))

        # How parts are drawn: color alpha 0 (no glow in the game) stays solid; the render queue,
        # render type and blend factors make parts see-through, additive or cut out.
        glass = material("Glass", (0.6, 0.8, 1.0, 0.35), 0, [], m_CustomRenderQueue=3000)
        shine = material("Shine", (1.0, 0.9, 0.5, 0.5), 0, [("_SrcBlend", 5), ("_DstBlend", 1)])
        leaf = material("Leaf", (0.3, 1.0, 0.3, 1.0), tex_dxt5, [("_Cutoff", 0.3)], stringTagMap=[("RenderType", "TransparentCutout")])
        tex_bc7 = add(28, texture_object(nodes[28], "BC7Tex", bc7_texture()))
        grip = material("DarkGrip", (0.1, 0.1, 0.12, 0.0), tex_bc7, [("_Glow", 0)])
        node_object("Grip", right_t, pptr(10202, 1), [grip], pos=(0, 0, -0.1), scale=(0.035, 0.035, 0.2))
        node_object("Glass", right_t, pptr(10210, 1), [glass], pos=(0, 0.05, 0.5), scale=(0.1, 0.2, 1))
        node_object("Shine", right_t, pptr(10207, 1), [shine], pos=(0, 0, 1.0), scale=(0.06, 0.06, 0.06))
        node_object("Leaf", right_t, pptr(10208, 1), [leaf], pos=(0.05, 0, 0.2), scale=(0.02, 0.05, 0.02))

    preload = [pptr(o[0]) for o in objects]
    asset_info = merge(default(child(nodes[142], "m_Container", "[]").m_Children[1]), {"preloadIndex": 0, "preloadSize": len(preload), "asset": pptr(root_go)})
    add(142, obj(142, m_Name="testsaber", m_PreloadTable=preload, m_Container=[("assets/_customsaber.prefab", asset_info)], m_AssetBundleName="testsaber"))

    for cid in nodes:
        type_info.setdefault(cid, (cid, nodes[cid], 0 if cid == 114 else -1, "SaberDescriptor"))
    type_order = []
    for _, key, _ in objects:
        if key not in type_order:
            type_order.append(key)
    types = [type_info[key] for key in type_order]
    serialized_objects = []
    for pid, key, value in objects:
        w = EndianBinaryWriter(endian="<")
        TypeTreeHelper.write_typetree(value, type_info[key][1], w)
        serialized_objects.append((pid, type_order.index(key), w.bytes))
    cab_bytes = write_serialized(unity, sf_version, types, serialized_objects, script_types, cab, externals)
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
    for name, unity, sf_version, bundle_format, kind, streamed in VARIANTS + [EXTRAS]:
        data = build(unity, sf_version, bundle_format, kind, streamed, extras=name == EXTRAS[0])
        with open(os.path.join(out_dir, name + ".saber"), "wb") as f:
            f.write(data)
        ref = reference(data)
        ref["unity"] = unity
        with open(os.path.join(out_dir, name + ".expected.json"), "w") as f:
            json.dump(ref, f, indent=1)
        print("%-30s %6d bytes  meshes=%s textures=%s descriptor=%s" % (name, len(data), sorted(ref["meshes"]), sorted(ref["textures"]), ref["descriptor"]))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "fixtures"))
