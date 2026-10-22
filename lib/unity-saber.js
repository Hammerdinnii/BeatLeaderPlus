/*
 * BeatLeaderPlus – reader for Beat Saber custom saber files (.saber).
 *
 * A .saber file is a Unity asset bundle holding a prefab: a root GameObject with "LeftSaber" and
 * "RightSaber" children, each made of mesh renderers. This reader understands just enough of
 * Unity's formats to rebuild those meshes outside Unity:
 *
 *   bundle      UnityFS container, blocks stored raw, LZ4/LZ4HC or LZMA compressed
 *   assets      Unity serialized files (format 17–22, Unity 2018–2022), read through the type
 *               trees the bundle carries, so field layouts never have to be hard-coded
 *   objects     GameObject, Transform, MeshFilter, MeshRenderer, SkinnedMeshRenderer, Mesh,
 *               Material, Texture2D, and the saber's descriptor (name, author); Unity's built-in
 *               primitives (Cube, Cylinder, …), which a bundle only points to, are rebuilt
 *   text        TextMeshPro (glyphs from its font asset's SDF atlas), legacy TextMesh and UI Text
 *               (drawn with a plain font where OffscreenCanvas exists)
 *   textures    RGBA/RGB/Alpha8/565/4444 and DXT1/DXT5/BC4/BC5/BC7; other formats fall back to the
 *               material color and are listed in `warnings`
 *
 * read(arrayBuffer) returns plain arrays ready for three.js, already placed in the space of the
 * replayer's .saberContainer (blade from the hilt towards -Y):
 *
 *   {name, author, warnings, materials, textures,
 *    left: {parts: [{positions, normals, uvs, colors, indices, groups: [{start, count, material}]}]},
 *    right: {…}}
 *
 * A part with `text: true` is TextMeshPro text: its material has `text` (distance field edge,
 * outline) and its vertex colors carry the text color.
 *
 * Everything here is plain JavaScript with no DOM access, so it also runs in Node for tests
 * (where text that needs drawing is skipped with a warning).
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.unitySaber) return;

	/* ------------------------------------------------------------------ binary reader */

	const utf8 = new TextDecoder('utf-8');

	class Reader {
		constructor(bytes, little) {
			this.bytes = bytes;
			this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			this.pos = 0;
			this.little = !!little;
		}
		need(n) {
			if (this.pos + n > this.bytes.length) throw new Error('Unexpected end of data');
		}
		u8() {
			this.need(1);
			return this.bytes[this.pos++];
		}
		i8() {
			this.need(1);
			return this.view.getInt8(this.pos++);
		}
		bool() {
			return this.u8() !== 0;
		}
		u16() {
			this.need(2);
			const v = this.view.getUint16(this.pos, this.little);
			this.pos += 2;
			return v;
		}
		i16() {
			this.need(2);
			const v = this.view.getInt16(this.pos, this.little);
			this.pos += 2;
			return v;
		}
		u32() {
			this.need(4);
			const v = this.view.getUint32(this.pos, this.little);
			this.pos += 4;
			return v;
		}
		i32() {
			this.need(4);
			const v = this.view.getInt32(this.pos, this.little);
			this.pos += 4;
			return v;
		}
		/** 64-bit integers as Numbers (path IDs and offsets stay well inside 2^53 in practice). */
		i64() {
			this.need(8);
			const lo = this.view.getUint32(this.pos + (this.little ? 0 : 4), this.little);
			const hi = this.view.getInt32(this.pos + (this.little ? 4 : 0), this.little);
			this.pos += 8;
			return hi * 4294967296 + lo;
		}
		u64() {
			this.need(8);
			const lo = this.view.getUint32(this.pos + (this.little ? 0 : 4), this.little);
			const hi = this.view.getUint32(this.pos + (this.little ? 4 : 0), this.little);
			this.pos += 8;
			return hi * 4294967296 + lo;
		}
		f32() {
			this.need(4);
			const v = this.view.getFloat32(this.pos, this.little);
			this.pos += 4;
			return v;
		}
		f64() {
			this.need(8);
			const v = this.view.getFloat64(this.pos, this.little);
			this.pos += 8;
			return v;
		}
		bytesView(n) {
			if (n < 0) throw new Error('Negative length');
			this.need(n);
			const v = this.bytes.subarray(this.pos, this.pos + n);
			this.pos += n;
			return v;
		}
		cstr() {
			let end = this.pos;
			while (end < this.bytes.length && this.bytes[end] !== 0) end++;
			if (end >= this.bytes.length) throw new Error('Unterminated string');
			const s = utf8.decode(this.bytes.subarray(this.pos, end));
			this.pos = end + 1;
			return s;
		}
		align(n) {
			const r = this.pos % n;
			if (r) this.pos += n - r;
		}
	}

	/* ------------------------------------------------------------------ LZ4 (block format) */

	function lz4(src, outSize) {
		const out = new Uint8Array(outSize);
		let i = 0;
		let o = 0;
		while (i < src.length) {
			const token = src[i++];
			let lit = token >> 4;
			if (lit === 15) {
				let b;
				do {
					b = src[i++];
					lit += b;
				} while (b === 255 && i < src.length);
			}
			if (o + lit > outSize || i + lit > src.length) throw new Error('Corrupt LZ4 data');
			out.set(src.subarray(i, i + lit), o);
			i += lit;
			o += lit;
			if (i >= src.length) break; // the last sequence has literals only
			const offset = src[i] | (src[i + 1] << 8);
			i += 2;
			let len = token & 15;
			if (len === 15) {
				let b;
				do {
					b = src[i++];
					len += b;
				} while (b === 255 && i < src.length);
			}
			len += 4;
			let from = o - offset;
			if (!offset || from < 0 || o + len > outSize) throw new Error('Corrupt LZ4 data');
			while (len--) out[o++] = out[from++]; // may overlap: copy byte by byte
		}
		if (o !== outSize) throw new Error('LZ4 data is shorter than expected');
		return out;
	}

	/* ------------------------------------------------------------------ LZMA (raw stream with 5-byte properties) */

	// Follows the LZMA reference decoder (LzmaSpec.cpp, public domain). Range coder values stay in
	// 0…2^32 and use plain arithmetic instead of bit operators, which are signed in JavaScript.
	function lzma(src, outSize) {
		if (src.length < 5) throw new Error('Corrupt LZMA data');
		let d = src[0];
		if (d >= 9 * 5 * 5) throw new Error('Corrupt LZMA properties');
		const lc = d % 9;
		d = (d / 9) | 0;
		const lp = d % 5;
		const pb = (d / 5) | 0;
		const out = new Uint8Array(outSize);
		let op = 0;

		let ip = 5;
		let range = 0xffffffff;
		let code = 0;
		if (src[ip++] !== 0) throw new Error('Corrupt LZMA data');
		for (let k = 0; k < 4; k++) code = code * 256 + src[ip++];

		const prob = n => new Uint16Array(n).fill(1024);
		const bit = (p, i) => {
			const v = p[i];
			const bound = (range >>> 11) * v;
			let b;
			if (code < bound) {
				range = bound;
				p[i] = v + ((2048 - v) >>> 5);
				b = 0;
			} else {
				range -= bound;
				code -= bound;
				p[i] = v - (v >>> 5);
				b = 1;
			}
			if (range < 16777216) {
				range *= 256;
				code = code * 256 + (src[ip++] | 0);
			}
			return b;
		};
		const tree = (p, base, numBits) => {
			let m = 1;
			for (let k = 0; k < numBits; k++) m = (m << 1) + bit(p, base + m);
			return m - (1 << numBits);
		};
		const reverse = (p, base, numBits) => {
			let m = 1;
			let sym = 0;
			for (let k = 0; k < numBits; k++) {
				const b = bit(p, base + m);
				m = (m << 1) + b;
				sym |= b << k;
			}
			return sym;
		};
		const direct = numBits => {
			let res = 0;
			for (let k = 0; k < numBits; k++) {
				range = Math.floor(range / 2);
				let b = 0;
				if (code >= range) {
					code -= range;
					b = 1;
				}
				if (range < 16777216) {
					range *= 256;
					code = code * 256 + (src[ip++] | 0);
				}
				res = res * 2 + b;
			}
			return res;
		};
		const lenCoder = () => ({choice: prob(2), low: prob(16 << 3), mid: prob(16 << 3), high: prob(256)});
		const decodeLen = (c, posState) => {
			if (!bit(c.choice, 0)) return tree(c.low, posState << 3, 3);
			if (!bit(c.choice, 1)) return 8 + tree(c.mid, posState << 3, 3);
			return 16 + tree(c.high, 0, 8);
		};

		const literal = prob(0x300 << (lc + lp));
		const isMatch = prob(12 << 4);
		const isRep = prob(12);
		const isRepG0 = prob(12);
		const isRepG1 = prob(12);
		const isRepG2 = prob(12);
		const isRep0Long = prob(12 << 4);
		const posSlot = prob(4 << 6);
		const posDecoders = prob(1 + 114);
		const align = prob(16);
		const lenDec = lenCoder();
		const repLenDec = lenCoder();
		const pbMask = (1 << pb) - 1;
		const lpMask = (1 << lp) - 1;
		let state = 0;
		let rep0 = 0;
		let rep1 = 0;
		let rep2 = 0;
		let rep3 = 0;

		while (op < outSize) {
			const posState = op & pbMask;
			if (!bit(isMatch, (state << 4) + posState)) {
				const prev = op > 0 ? out[op - 1] : 0;
				const base = 0x300 * (((op & lpMask) << lc) + (prev >> (8 - lc)));
				let sym = 1;
				if (state >= 7) {
					let matchByte = out[op - rep0 - 1];
					do {
						const matchBit = (matchByte >> 7) & 1;
						matchByte <<= 1;
						const b = bit(literal, base + ((1 + matchBit) << 8) + sym);
						sym = (sym << 1) | b;
						if (matchBit !== b) break;
					} while (sym < 0x100);
				}
				while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
				out[op++] = sym & 0xff;
				state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
				continue;
			}
			let len;
			if (bit(isRep, state)) {
				if (op === 0) throw new Error('Corrupt LZMA data');
				if (!bit(isRepG0, state)) {
					if (!bit(isRep0Long, (state << 4) + posState)) {
						state = state < 7 ? 9 : 11;
						out[op] = out[op - rep0 - 1];
						op++;
						continue;
					}
				} else {
					let dist;
					if (!bit(isRepG1, state)) dist = rep1;
					else {
						if (!bit(isRepG2, state)) dist = rep2;
						else {
							dist = rep3;
							rep3 = rep2;
						}
						rep2 = rep1;
					}
					rep1 = rep0;
					rep0 = dist;
				}
				len = decodeLen(repLenDec, posState);
				state = state < 7 ? 8 : 11;
			} else {
				rep3 = rep2;
				rep2 = rep1;
				rep1 = rep0;
				len = decodeLen(lenDec, posState);
				state = state < 7 ? 7 : 10;
				const slot = tree(posSlot, Math.min(len, 3) << 6, 6);
				if (slot < 4) rep0 = slot;
				else {
					const numDirect = (slot >> 1) - 1;
					let dist = (2 | (slot & 1)) * 2 ** numDirect;
					if (slot < 14) dist += reverse(posDecoders, dist - slot, numDirect);
					else dist += direct(numDirect - 4) * 16 + reverse(align, 0, 4);
					rep0 = dist;
				}
				if (rep0 === 0xffffffff) break; // end marker
				if (rep0 >= op) throw new Error('Corrupt LZMA data');
			}
			len += 2;
			if (op + len > outSize) len = outSize - op;
			let from = op - rep0 - 1;
			while (len--) out[op++] = out[from++];
		}
		if (op !== outSize) throw new Error('LZMA data is shorter than expected');
		return out;
	}

	function decompress(data, size, flags) {
		switch (flags & 0x3f) {
			case 0:
				return data;
			case 1:
				return lzma(data, size);
			case 2:
			case 3:
				return lz4(data, size);
			default:
				throw new Error('Unsupported compression type ' + (flags & 0x3f));
		}
	}

	/* ------------------------------------------------------------------ UnityFS bundle */

	function parseVersion(s) {
		const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
	}
	const versionAtLeast = (v, w) => v[0] !== w[0] ? v[0] > w[0] : v[1] !== w[1] ? v[1] > w[1] : v[2] >= w[2];

	/** Returns the files inside a UnityFS bundle: [{path, flags, data: Uint8Array}]. */
	function readBundle(bytes) {
		const head = utf8.decode(bytes.subarray(0, 8));
		if (head.startsWith('PK')) throw new Error('This is a .zip archive: unzip it and use the .saber inside');
		if (!head.startsWith('Unity')) throw new Error('Not a Unity asset bundle');
		const r = new Reader(bytes, false);
		const signature = r.cstr();
		if (signature !== 'UnityFS') throw new Error(signature.startsWith('Unity') ? 'Unsupported bundle type ' + signature : 'Not a Unity asset bundle');
		const format = r.u32();
		r.cstr(); // player version, e.g. "5.x.x"
		const engine = parseVersion(r.cstr());
		r.i64(); // total size
		const infoCompressed = r.u32();
		const infoSize = r.u32();
		const flags = r.u32();
		// Archive flags were renumbered when padding was added (2020.3.34, 2021.3.2, 2022.1.1).
		const newFlags = versionAtLeast(engine, [2022, 1, 1]) || (engine[0] === 2021 && versionAtLeast(engine, [2021, 3, 2])) || (engine[0] === 2020 && versionAtLeast(engine, [2020, 3, 34]));
		if (newFlags ? flags & 0x400 : flags & 0x200) throw new Error('Encrypted asset bundles are not supported');
		if (format >= 7 || (engine[0] === 2019 && versionAtLeast(engine, [2019, 4, 15]))) r.align(16);

		let infoBytes;
		if (flags & 0x80) {
			infoBytes = bytes.subarray(bytes.length - infoCompressed, bytes.length);
		} else {
			infoBytes = r.bytesView(infoCompressed);
		}
		const info = new Reader(decompress(infoBytes, infoSize, flags), false);
		info.pos += 16; // hash of the uncompressed data
		const blocks = [];
		for (let i = info.i32(); i > 0; i--) blocks.push({size: info.u32(), compressed: info.u32(), flags: info.u16()});
		const nodes = [];
		for (let i = info.i32(); i > 0; i--) nodes.push({offset: info.i64(), size: info.i64(), flags: info.u32(), path: info.cstr()});
		if (newFlags && flags & 0x200) r.align(16);

		const total = blocks.reduce((n, b) => n + b.size, 0);
		const data = new Uint8Array(total);
		let o = 0;
		for (const b of blocks) {
			data.set(decompress(r.bytesView(b.compressed), b.size, b.flags), o);
			o += b.size;
		}
		return {engine, files: nodes.map(n => ({path: n.path, flags: n.flags, data: data.subarray(n.offset, n.offset + n.size)}))};
	}

	/* ------------------------------------------------------------------ serialized files and type trees */

	// Unity's built-in type tree string table (offsets with the high bit set index into it).
	const COMMON_STRINGS = (() => {
		const list = [
			'AABB', 'AnimationClip', 'AnimationCurve', 'AnimationState', 'Array', 'Base', 'BitField', 'bitset', 'bool', 'char', 'ColorRGBA',
			'Component', 'data', 'deque', 'double', 'dynamic_array', 'FastPropertyName', 'first', 'float', 'Font', 'GameObject', 'Generic Mono',
			'GradientNEW', 'GUID', 'GUIStyle', 'int', 'list', 'long long', 'map', 'Matrix4x4f', 'MdFour', 'MonoBehaviour', 'MonoScript',
			'm_ByteSize', 'm_Curve', 'm_EditorClassIdentifier', 'm_EditorHideFlags', 'm_Enabled', 'm_ExtensionPtr', 'm_GameObject', 'm_Index',
			'm_IsArray', 'm_IsStatic', 'm_MetaFlag', 'm_Name', 'm_ObjectHideFlags', 'm_PrefabInternal', 'm_PrefabParentObject', 'm_Script',
			'm_StaticEditorFlags', 'm_Type', 'm_Version', 'Object', 'pair', 'PPtr<Component>', 'PPtr<GameObject>', 'PPtr<Material>',
			'PPtr<MonoBehaviour>', 'PPtr<MonoScript>', 'PPtr<Object>', 'PPtr<Prefab>', 'PPtr<Sprite>', 'PPtr<TextAsset>', 'PPtr<Texture>',
			'PPtr<Texture2D>', 'PPtr<Transform>', 'Prefab', 'Quaternionf', 'Rectf', 'RectInt', 'RectOffset', 'second', 'set', 'short', 'size',
			'SInt16', 'SInt32', 'SInt64', 'SInt8', 'staticvector', 'string', 'TextAsset', 'TextMesh', 'Texture', 'Texture2D', 'Transform',
			'TypelessData', 'UInt16', 'UInt32', 'UInt64', 'UInt8', 'unsigned int', 'unsigned long long', 'unsigned short', 'vector', 'Vector2f',
			'Vector3f', 'Vector4f', 'm_ScriptingClassIdentifier', 'Gradient', 'Type*', 'int2_storage', 'int3_storage', 'BoundsInt',
			'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'FileSize', 'Hash128', 'RenderingLayerMask', 'fixed_array',
			'EntityId', 'LoadableObjectId', 'LoadableSceneId',
		];
		const map = new Map();
		let offset = 0;
		for (const s of list) {
			map.set(offset, s);
			offset += new TextEncoder().encode(s).length + 1;
		}
		return map;
	})();

	function readTypeTreeBlob(r, version) {
		const count = r.i32();
		const stringSize = r.i32();
		const raw = [];
		for (let i = 0; i < count; i++) {
			const n = {version: r.u16(), level: r.u8(), flags: r.u8(), typeOffset: r.u32(), nameOffset: r.u32(), size: r.i32(), index: r.i32(), meta: r.i32()};
			if (version >= 19) r.pos += 8; // ref type hash
			raw.push(n);
		}
		const strings = r.bytesView(stringSize);
		const str = offset => {
			if (offset & 0x80000000) return COMMON_STRINGS.get(offset & 0x7fffffff) || '?';
			let end = offset;
			while (end < strings.length && strings[end]) end++;
			return utf8.decode(strings.subarray(offset, end));
		};
		// Turn the flat, depth-annotated list into a tree.
		const stack = [];
		let rootNode = null;
		for (const n of raw) {
			const node = {type: str(n.typeOffset), name: str(n.nameOffset), size: n.size, meta: n.meta, isArray: !!(n.flags & 1), children: []};
			while (stack.length > n.level) stack.pop();
			if (stack.length) stack[stack.length - 1].children.push(node);
			else rootNode = node;
			stack.push(node);
		}
		return rootNode;
	}

	function readSerializedType(r, version, typeTree, isRef) {
		const t = {classID: r.i32(), scriptTypeIndex: -1, node: null};
		if (version >= 16) r.bool(); // stripped
		if (version >= 17) t.scriptTypeIndex = r.i16();
		if (version >= 13) {
			if ((isRef && t.scriptTypeIndex >= 0) || (version < 16 && t.classID < 0) || (version >= 16 && t.classID === 114)) r.pos += 16; // script ID
			r.pos += 16; // old type hash
		}
		if (typeTree) {
			if (version >= 23) {
				r.pos += 16; // type tree content hash
				const size = r.i32();
				const blob = new Reader(r.bytesView(size), r.little);
				t.node = readTypeTreeBlob(blob, version);
			} else if (version >= 12 || version === 10) {
				t.node = readTypeTreeBlob(r, version);
			} else {
				throw new Error('This .saber was made with a Unity version that is too old (serialized file format ' + version + ')');
			}
			if (version >= 21) {
				if (isRef) {
					r.cstr();
					r.cstr();
					r.cstr();
				} else {
					const dependencies = r.i32(); // read first: `r.pos += 4 * r.i32()` would lose its 4 bytes
					r.pos += 4 * dependencies;
				}
			}
		}
		return t;
	}

	function readSerializedFile(bytes) {
		const h = new Reader(bytes, false); // header fields are big-endian
		let metadataSize = h.u32();
		let fileSize = h.u32();
		const version = h.u32();
		let dataOffset = h.u32();
		if (version < 17 || version > 23) throw new Error('Unsupported Unity serialized file format ' + version);
		const big = h.bool();
		h.pos += 3;
		if (version >= 22) {
			metadataSize = h.u32();
			fileSize = h.i64();
			dataOffset = h.i64();
			h.pos += 8;
		}
		const r = new Reader(bytes, !big);
		r.pos = h.pos;
		const unityVersion = r.cstr();
		r.i32(); // build target
		const typeTree = r.bool();
		const types = [];
		for (let i = r.i32(); i > 0; i--) types.push(readSerializedType(r, version, typeTree, false));
		const objects = new Map();
		for (let i = r.i32(); i > 0; i--) {
			r.align(4);
			const pathID = r.i64();
			const start = (version >= 22 ? r.i64() : r.u32()) + dataOffset;
			const size = r.u32();
			const type = types[r.i32()];
			objects.set(pathID, {pathID, start, size, type, classID: type ? type.classID : -1});
		}
		// The files that PPtrs with m_FileID n point into (externals[n - 1]), e.g. Unity's built-in
		// "library/unity default resources" for its Cube and Cylinder meshes.
		const externals = [];
		try {
			for (let i = r.i32(); i > 0; i--) {
				r.i32(); // script type: file index
				r.align(4);
				r.i64(); // and path ID
			}
			for (let i = r.i32(); i > 0; i--) {
				r.cstr();
				r.pos += 20; // GUID and type
				externals.push(r.cstr());
			}
		} catch (e) {
			externals.length = 0; // only used to recognise built-in meshes
		}
		return {version, unityVersion: parseVersion(unityVersion), typeTree, bytes, little: !big, objects, externals, fileSize, metadataSize};
	}

	const NUMBER_READERS = {
		bool: r => r.bool(),
		SInt8: r => r.i8(),
		UInt8: r => r.u8(),
		char: r => r.u8(),
		SInt16: r => r.i16(),
		short: r => r.i16(),
		UInt16: r => r.u16(),
		'unsigned short': r => r.u16(),
		SInt32: r => r.i32(),
		int: r => r.i32(),
		UInt32: r => r.u32(),
		'unsigned int': r => r.u32(),
		'Type*': r => r.u32(),
		SInt64: r => r.i64(),
		'long long': r => r.i64(),
		UInt64: r => r.u64(),
		'unsigned long long': r => r.u64(),
		FileSize: r => r.u64(),
		float: r => r.f32(),
		double: r => r.f64(),
	};
	const BYTE_TYPES = new Set(['UInt8', 'SInt8', 'char']);
	const aligned = node => (node.meta & 0x4000) !== 0;

	/** Read one value described by a type tree node. Byte arrays come back as Uint8Array views. */
	function readNode(r, node) {
		let value;
		const num = NUMBER_READERS[node.type];
		if (num) value = num(r);
		else if (node.type === 'string') {
			value = utf8.decode(r.bytesView(r.i32()));
			r.align(4);
		} else if (node.type === 'TypelessData') {
			value = r.bytesView(r.i32());
		} else if (node.type === 'pair') {
			value = [readNode(r, node.children[0]), readNode(r, node.children[1])];
		} else if (node.children.length === 1 && (node.children[0].isArray || node.children[0].type === 'Array')) {
			const array = node.children[0];
			const count = r.i32();
			if (count < 0 || count > r.bytes.length) throw new Error('Corrupt array length');
			const item = array.children[1];
			if (BYTE_TYPES.has(item.type) && !item.children.length) value = r.bytesView(count);
			else {
				value = new Array(count);
				for (let i = 0; i < count; i++) value[i] = readNode(r, item);
			}
			if (aligned(array)) r.align(4);
		} else {
			value = {};
			for (const child of node.children) value[child.name] = readNode(r, child);
		}
		if (aligned(node)) r.align(4);
		return value;
	}

	/* ------------------------------------------------------------------ assets */

	class Assets {
		constructor(bytes) {
			const bundle = readBundle(bytes);
			this.engine = bundle.engine;
			this.files = bundle.files;
			this.serialized = [];
			let firstError = null;
			for (const f of bundle.files) {
				if (/\.(resS|resource)$/i.test(f.path)) continue;
				try {
					this.serialized.push(readSerializedFile(f.data));
				} catch (e) {
					firstError = firstError || e;
				}
			}
			if (!this.serialized.length) throw firstError || new Error('No assets found in this .saber');
			this.file = this.serialized[0];
			if (!this.file.typeTree) throw new Error('This .saber has no type information (built with "Disable Write TypeTree"), so it cannot be read');
			this.cache = new Map();
		}
		/** All objects of a Unity class ID. */
		ofClass(classID) {
			return Array.from(this.file.objects.values()).filter(o => o.classID === classID);
		}
		read(pathID) {
			if (!pathID) return null;
			if (this.cache.has(pathID)) return this.cache.get(pathID);
			const o = this.file.objects.get(pathID);
			if (!o || !o.type || !o.type.node) return null;
			const r = new Reader(this.file.bytes, this.file.little);
			r.bytes = this.file.bytes.subarray(0, o.start + o.size);
			r.view = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
			r.pos = o.start;
			const value = readNode(r, o.type.node);
			value.__classID = o.classID;
			value.__pathID = pathID;
			this.cache.set(pathID, value);
			return value;
		}
		/** Follow a PPtr within this file (references into other files are ignored). */
		ref(pptr) {
			return pptr && pptr.m_FileID === 0 ? this.read(pptr.m_PathID) : null;
		}
		/** Path of the file a PPtr with this m_FileID points into ('' when unknown). */
		external(fileID) {
			return String((this.file.externals || [])[fileID - 1] || '');
		}
		/** Bytes from a streamed resource (.resS) inside the bundle. */
		resource(stream) {
			if (!stream || !stream.path || !stream.size) return null;
			const name = String(stream.path).split('/').pop();
			const f = this.files.find(x => x.path === name || x.path.split('/').pop() === name);
			return f ? f.data.subarray(stream.offset, stream.offset + stream.size) : null;
		}
	}

	/* ------------------------------------------------------------------ meshes */

	// Unity ≥ 2019 VertexFormat; older versions use VertexChannelFormat, mapped onto it.
	const FORMAT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];
	const OLD_FORMAT = [0, 1, 2, 6, 10]; // Float, Float16, Color, Byte, UInt32

	function half(h) {
		const s = h & 0x8000 ? -1 : 1;
		const e = (h >> 10) & 0x1f;
		const f = h & 0x3ff;
		if (e === 0) return s * f * 2 ** -24;
		if (e === 31) return f ? NaN : s * Infinity;
		return s * (1 + f / 1024) * 2 ** (e - 15);
	}

	function readComponent(view, at, format) {
		switch (format) {
			case 0:
				return view.getFloat32(at, true);
			case 1:
				return half(view.getUint16(at, true));
			case 2:
				return view.getUint8(at) / 255;
			case 3:
				return Math.max(view.getInt8(at) / 127, -1);
			case 4:
				return view.getUint16(at, true) / 65535;
			case 5:
				return Math.max(view.getInt16(at, true) / 32767, -1);
			case 6:
				return view.getUint8(at);
			case 7:
				return view.getInt8(at);
			case 8:
				return view.getUint16(at, true);
			case 9:
				return view.getInt16(at, true);
			case 10:
				return view.getUint32(at, true);
			case 11:
				return view.getInt32(at, true);
			default:
				return 0;
		}
	}

	/** Unity's PackedBitVector (used by compressed meshes). */
	function unpackBits(v, asFloat) {
		const n = v.m_NumItems >>> 0;
		const bitSize = v.m_BitSize || 0;
		const data = v.m_Data || new Uint8Array(0);
		const out = asFloat ? new Float32Array(n) : new Uint32Array(n);
		const maxValue = bitSize ? 2 ** bitSize - 1 : 1;
		let index = 0;
		let bitPos = 0;
		for (let i = 0; i < n; i++) {
			let bits = 0;
			let x = 0;
			while (bits < bitSize) {
				x += ((data[index] >> bitPos) & ((1 << Math.min(bitSize - bits, 8 - bitPos)) - 1)) * 2 ** bits;
				const num = Math.min(bitSize - bits, 8 - bitPos);
				bitPos += num;
				bits += num;
				if (bitPos === 8) {
					index++;
					bitPos = 0;
				}
			}
			out[i] = asFloat ? (x / maxValue) * v.m_Range + v.m_Start : x;
		}
		return out;
	}

	function decodeCompressedMesh(mesh) {
		const c = mesh.m_CompressedMesh;
		if (!c || !c.m_Vertices || !c.m_Vertices.m_NumItems) return null;
		const positions = unpackBits(c.m_Vertices, true);
		const count = positions.length / 3;
		let uvs = null;
		if (c.m_UV && c.m_UV.m_NumItems >= count * 2) uvs = unpackBits(c.m_UV, true).subarray(0, count * 2);
		let normals = null;
		if (c.m_Normals && c.m_Normals.m_NumItems === count * 2) {
			const xy = unpackBits(c.m_Normals, true);
			const signs = c.m_NormalSigns && c.m_NormalSigns.m_NumItems ? unpackBits(c.m_NormalSigns, false) : null;
			normals = new Float32Array(count * 3);
			for (let i = 0; i < count; i++) {
				const x = xy[i * 2];
				const y = xy[i * 2 + 1];
				const zz = 1 - x * x - y * y;
				const z = zz > 0 ? Math.sqrt(zz) : 0;
				normals.set([x, y, signs && !signs[i] ? -z : z], i * 3);
			}
		}
		const triangles = c.m_Triangles && c.m_Triangles.m_NumItems ? unpackBits(c.m_Triangles, false) : null;
		return {positions, normals, uvs, colors: null, triangles, vertexCount: count};
	}

	function decodeMesh(assets, mesh, warnings) {
		const name = mesh.m_Name || 'mesh';
		const v = assets.file.unityVersion;
		const vd = mesh.m_VertexData || {};
		let vertexCount = vd.m_VertexCount >>> 0;
		let data = vd.m_DataSize instanceof Uint8Array ? vd.m_DataSize : null;
		if ((!data || !data.length) && mesh.m_StreamData) data = assets.resource(mesh.m_StreamData);
		const out = {positions: null, normals: null, uvs: null, colors: null};

		if (vertexCount && data && data.length) {
			const channels = vd.m_Channels || [];
			const modern = v[0] >= 2018;
			// Channel slots: Unity 2018+ has 14 (position, normal, tangent, color, uv0–7, weights,
			// indices); earlier versions 8 (position, normal, color, uv0–3, tangent).
			const slot = modern ? {position: 0, normal: 1, color: 3, uv: 4} : {position: 0, normal: 1, color: 2, uv: 3};
			const formatOf = ch => (v[0] >= 2019 ? ch.format : OLD_FORMAT[ch.format] !== undefined ? OLD_FORMAT[ch.format] : 0);
			const streams = [];
			let offset = 0;
			const streamCount = channels.reduce((n, ch) => Math.max(n, (ch.stream || 0) + 1), 1);
			for (let s = 0; s < streamCount; s++) {
				let stride = 0;
				channels.forEach(ch => {
					if (ch.stream === s && ch.dimension & 0xf) stride += (ch.dimension & 0xf) * FORMAT_SIZE[formatOf(ch)];
				});
				streams.push({offset, stride});
				offset += vertexCount * stride;
				offset = (offset + 15) & ~15;
			}
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
			const read = (index, take) => {
				const ch = channels[index];
				const dim = ch ? ch.dimension & 0xf : 0;
				if (!dim) return null;
				const fmt = formatOf(ch);
				const size = FORMAT_SIZE[fmt];
				const st = streams[ch.stream];
				const result = new Float32Array(vertexCount * take);
				for (let i = 0; i < vertexCount; i++) {
					const base = st.offset + i * st.stride + ch.offset;
					for (let k = 0; k < take; k++) {
						const at = base + k * size;
						result[i * take + k] = k < dim && at + size <= data.length ? readComponent(view, at, fmt) : k === 3 ? 1 : 0;
					}
				}
				return result;
			};
			out.positions = read(slot.position, 3);
			out.normals = read(slot.normal, 3);
			out.colors = read(slot.color, 4);
			out.uvs = read(slot.uv, 2);
		} else {
			const c = decodeCompressedMesh(mesh);
			if (c) {
				Object.assign(out, c);
				vertexCount = c.vertexCount;
			}
		}
		if (!out.positions || !vertexCount) {
			warnings.push('Mesh "' + name + '" has no readable vertices');
			return null;
		}

		// Indices per submesh.
		let indexSource = null;
		const ib = mesh.m_IndexBuffer;
		if (ib instanceof Uint8Array && ib.length) {
			const wide = mesh.m_IndexFormat === 1;
			const iv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
			const n = ib.length / (wide ? 4 : 2);
			indexSource = new Uint32Array(n);
			for (let i = 0; i < n; i++) indexSource[i] = wide ? iv.getUint32(i * 4, true) : iv.getUint16(i * 2, true);
		} else if (out.triangles) indexSource = out.triangles;
		const wideIndex = mesh.m_IndexFormat === 1;
		const submeshes = [];
		for (const sm of mesh.m_SubMeshes || []) {
			const topology = sm.topology || 0;
			if (topology !== 0) {
				warnings.push('Mesh "' + name + '" has a non-triangle submesh, skipped');
				continue;
			}
			const first = indexSource === out.triangles ? sm.firstByte / 2 : sm.firstByte / (wideIndex ? 4 : 2);
			const count = sm.indexCount >>> 0;
			if (!indexSource || first + count > indexSource.length) {
				warnings.push('Mesh "' + name + '" has a submesh outside its index buffer');
				continue;
			}
			const base = sm.baseVertex || 0;
			const tri = new Uint32Array(count);
			for (let i = 0; i < count; i++) tri[i] = indexSource[first + i] + base;
			submeshes.push(tri);
		}
		if (!submeshes.length) {
			warnings.push('Mesh "' + name + '" has no triangles');
			return null;
		}
		return {name, vertexCount, positions: out.positions, normals: out.normals, uvs: out.uvs, colors: out.colors, submeshes};
	}

	/* ------------------------------------------------------------------ Unity's built-in meshes */

	// Meshes a saber can use without carrying them: Unity's primitives, which live in its
	// "unity default resources" file under these fixed path IDs. Rebuilt here at Unity's sizes.
	const BUILTIN_MESHES = {10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad'};
	const BUILTIN_FILE = /unity default resources/i;

	function primitive(kind) {
		const pos = [];
		const nor = [];
		const uv = [];
		const idx = [];
		const vertex = (x, y, z, nx, ny, nz, u, v) => {
			pos.push(x, y, z);
			nor.push(nx, ny, nz);
			uv.push(u, v);
			return pos.length / 3 - 1;
		};
		const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
		// Rings around Y through `profile` ([radius, y, normal radius, normal y, v]).
		const lathe = (profile, segments) => {
			const first = pos.length / 3;
			for (const [r, y, nr, ny, v] of profile) {
				for (let s = 0; s <= segments; s++) {
					const a = (s / segments) * Math.PI * 2;
					vertex(r * Math.cos(a), y, r * Math.sin(a), nr * Math.cos(a), ny, nr * Math.sin(a), s / segments, v);
				}
			}
			for (let k = 0; k + 1 < profile.length; k++) {
				for (let s = 0; s < segments; s++) {
					const a = first + k * (segments + 1) + s;
					const b = a + segments + 1;
					quad(a, b, b + 1, a + 1);
				}
			}
		};
		const disc = (y, ny, r, segments) => {
			const center = vertex(0, y, 0, 0, ny, 0, 0.5, 0.5);
			const first = pos.length / 3;
			for (let s = 0; s <= segments; s++) {
				const a = (s / segments) * Math.PI * 2;
				vertex(r * Math.cos(a), y, r * Math.sin(a), 0, ny, 0, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
			}
			for (let s = 0; s < segments; s++) idx.push(center, first + s, first + s + 1);
		};
		// Half spheres for the sphere and the capsule: latitude from `from` to `to` (radians).
		const sphereProfile = (r, cy, from, to, steps, v0, v1) => {
			const out = [];
			for (let i = 0; i <= steps; i++) {
				const t = from + ((to - from) * i) / steps;
				out.push([r * Math.cos(t), cy + r * Math.sin(t), Math.cos(t), Math.sin(t), v0 + ((v1 - v0) * i) / steps]);
			}
			return out;
		};
		if (kind === 'Cube') {
			const faces = [
				[[1, 0, 0], [0, 0, -1], [0, 1, 0]],
				[[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
				[[0, 1, 0], [1, 0, 0], [0, 0, -1]],
				[[0, -1, 0], [1, 0, 0], [0, 0, 1]],
				[[0, 0, 1], [1, 0, 0], [0, 1, 0]],
				[[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
			];
			for (const [n, u, w] of faces) {
				const corner = (a, b) => vertex(0.5 * (n[0] + a * u[0] + b * w[0]), 0.5 * (n[1] + a * u[1] + b * w[1]), 0.5 * (n[2] + a * u[2] + b * w[2]), n[0], n[1], n[2], (a + 1) / 2, (b + 1) / 2);
				quad(corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1));
			}
		} else if (kind === 'Cylinder') {
			lathe([[0.5, -1, 1, 0, 0], [0.5, 1, 1, 0, 1]], 24);
			disc(1, 1, 0.5, 24);
			disc(-1, -1, 0.5, 24);
		} else if (kind === 'Sphere') {
			lathe(sphereProfile(0.5, 0, -Math.PI / 2, Math.PI / 2, 16, 0, 1), 24);
		} else if (kind === 'Capsule') {
			lathe(sphereProfile(0.5, -0.5, -Math.PI / 2, 0, 8, 0, 0.25).concat(sphereProfile(0.5, 0.5, 0, Math.PI / 2, 8, 0.75, 1)), 24);
		} else if (kind === 'Plane') {
			for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) vertex(5 - i, 0, 5 - j, 0, 1, 0, i / 10, j / 10);
			for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) quad(j * 11 + i, (j + 1) * 11 + i, (j + 1) * 11 + i + 1, j * 11 + i + 1);
		} else {
			// Quad: 1×1, facing -Z (towards a camera in front of it).
			quad(vertex(-0.5, -0.5, 0, 0, 0, -1, 0, 0), vertex(-0.5, 0.5, 0, 0, 0, -1, 0, 1), vertex(0.5, 0.5, 0, 0, 0, -1, 1, 1), vertex(0.5, -0.5, 0, 0, 0, -1, 1, 0));
		}
		// Like Unity's own data: each triangle's cross(b - a, c - a) points along its normals.
		for (let i = 0; i < idx.length; i += 3) {
			const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
			const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
			const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
			const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
			let dot = 0;
			for (const v of [a, b, c]) dot += cross[0] * nor[v] + cross[1] * nor[v + 1] + cross[2] * nor[v + 2];
			if (dot < 0) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
		}
		return {name: kind, vertexCount: pos.length / 3, positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), colors: null, submeshes: [Uint32Array.from(idx)]};
	}

	/* ------------------------------------------------------------------ textures */

	function rgb565(c) {
		return [((((c >> 11) & 31) * 255 + 15) / 31) | 0, ((((c >> 5) & 63) * 255 + 31) / 63) | 0, (((c & 31) * 255 + 15) / 31) | 0];
	}

	const palette = new Uint8Array(16); // 4 colors × RGBA, reused for every block
	function setColor(at, c) {
		palette[at] = ((((c >> 11) & 31) * 255 + 15) / 31) | 0;
		palette[at + 1] = ((((c >> 5) & 63) * 255 + 31) / 63) | 0;
		palette[at + 2] = (((c & 31) * 255 + 15) / 31) | 0;
		palette[at + 3] = 255;
	}

	/** DXT1/DXT5 color block. In DXT1, c0 <= c1 selects 3 colors plus transparent black. */
	function decodeColorBlock(src, at, out, w, h, bx, by, dxt1) {
		const c0 = src[at] | (src[at + 1] << 8);
		const c1 = src[at + 2] | (src[at + 3] << 8);
		setColor(0, c0);
		setColor(4, c1);
		if (c0 > c1 || !dxt1) {
			for (let k = 0; k < 3; k++) {
				palette[8 + k] = ((2 * palette[k] + palette[4 + k]) / 3) | 0;
				palette[12 + k] = ((palette[k] + 2 * palette[4 + k]) / 3) | 0;
			}
			palette[11] = palette[15] = 255;
		} else {
			for (let k = 0; k < 3; k++) {
				palette[8 + k] = ((palette[k] + palette[4 + k]) / 2) | 0;
				palette[12 + k] = 0;
			}
			palette[11] = 255;
			palette[15] = 0;
		}
		const bits = (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0;
		for (let i = 0; i < 16; i++) {
			const x = bx + (i & 3);
			const y = by + (i >> 2);
			if (x >= w || y >= h) continue;
			const q = ((bits >>> (2 * i)) & 3) * 4;
			const p = (y * w + x) * 4;
			out[p] = palette[q];
			out[p + 1] = palette[q + 1];
			out[p + 2] = palette[q + 2];
			if (dxt1) out[p + 3] = palette[q + 3];
		}
	}

	const levels = new Uint8Array(8);
	/** BC4-style 8-byte block (DXT5 alpha, BC4, BC5): two endpoints and 3-bit indices. */
	function decodeAlphaBlock(src, at, out, w, h, bx, by, channel) {
		const a0 = src[at];
		const a1 = src[at + 1];
		levels[0] = a0;
		levels[1] = a1;
		if (a0 > a1) {
			for (let i = 1; i < 7; i++) levels[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
		} else {
			for (let i = 1; i < 5; i++) levels[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
			levels[6] = 0;
			levels[7] = 255;
		}
		// 48 bits of indices, read as two 24-bit halves of 8 indices each.
		for (let half = 0; half < 2; half++) {
			const o = at + 2 + half * 3;
			let bits = src[o] | (src[o + 1] << 8) | (src[o + 2] << 16);
			for (let j = 0; j < 8; j++) {
				const i = half * 8 + j;
				const x = bx + (i & 3);
				const y = by + (i >> 2);
				if (x < w && y < h) out[(y * w + x) * 4 + channel] = levels[bits & 7];
				bits >>= 3;
			}
		}
	}

	/* ------------------------------------------------------------------ BC7 */

	// BPTC partitions: which subset each of a block's 16 texels belongs to, for the 64 two- and
	// three-subset shapes, and each shape's anchor texels (their index has one bit less).
	const BC7_P2 = (
		'0011001100110011 0001000100010001 0111011101110111 0001001100110111 0000000100010011 0011011101111111 ' +
		'0001001101111111 0000000100110111 0000000000010011 0011011111111111 0000000101111111 0000000000010111 ' +
		'0001011111111111 0000000011111111 0000111111111111 0000000000001111 0000100011101111 0111000100000000 ' +
		'0000000010001110 0111001100010000 0011000100000000 0000100011001110 0000000010001100 0111001100110001 ' +
		'0011000100010000 0000100010001100 0110011001100110 0011011001101100 0001011111101000 0000111111110000 ' +
		'0111000110001110 0011100110011100 0101010101010101 0000111100001111 0101101001011010 0011001111001100 ' +
		'0011110000111100 0101010110101010 0110100101101001 0101101010100101 0111001111001110 0001001111001000 ' +
		'0011001001001100 0011101111011100 0110100110010110 0011110011000011 0110011010011001 0000011001100000 ' +
		'0100111001000000 0010011100100000 0000001001110010 0000010011100100 0110110010010011 0011011011001001 ' +
		'0110001110011100 0011100111000110 0110110011001001 0110001100111001 0111111010000001 0001100011100111 ' +
		'0000111100110011 0011001111110000 0010001011101110 0100010001110111'
	).split(' ');
	const BC7_P3 = (
		'0011001102212222 0001001122112221 0000200122112211 0222002200110111 0000000011221122 0011001100220022 ' +
		'0022002211111111 0011001122112211 0000000011112222 0000111111112222 0000111122222222 0012001200120012 ' +
		'0112011201120112 0122012201220122 0011011211221222 0011200122002220 0001001101121122 0111001120012200 ' +
		'0000112211221122 0022002200221111 0111011102220222 0001000122212221 0000001101220122 0000110022102210 ' +
		'0122012200110000 0012001211222222 0110122112210110 0000011012211221 0022110211020022 0110011020022222 ' +
		'0011012201220011 0000200022112221 0000000211221222 0222002200120011 0011001200220222 0120012001200120 ' +
		'0000111122220000 0120120120120120 0120201212010120 0011220011220011 0011112222000011 0101010122222222 ' +
		'0000000021212121 0022112200221122 0022001100220011 0220122102201221 0101222222220101 0000212121212121 ' +
		'0101010101012222 0222011102220111 0002111200021112 0000211221122112 0222011101110222 0002111211120002 ' +
		'0110011001102222 0000000021122112 0110011022222222 0022001100110022 0022112211220022 0000000000002112 ' +
		'0002000100020001 0222122202221222 0101222222222222 0111201122012220'
	).split(' ');
	const BC7_A2 = [
		15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
		15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
	];
	const BC7_A3A = [
		3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
		8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
	];
	const BC7_A3B = [
		15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
		15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
	];

	// Per mode: subsets, partition bits, rotation bits, index selection bit, color bits, alpha bits,
	// p-bits per endpoint, p-bits per subset, index bits, second index bits.
	const BC7_MODES = [
		[3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
		[2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
		[3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
		[2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
		[1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
		[1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
		[1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
		[2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
	];
	const BC7_WEIGHTS = {2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64], 4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]};

	/** One 16-byte BC7 block into `out` (RGBA, w × h) at block position bx, by. */
	function decodeBC7Block(src, at, out, w, h, bx, by) {
		let pos = 0;
		const bits = n => {
			let v = 0;
			for (let i = 0; i < n; i++, pos++) v |= ((src[at + (pos >> 3)] >> (pos & 7)) & 1) << i;
			return v;
		};
		let mode = 0;
		while (mode < 8 && !bits(1)) mode++;
		const texels = [];
		if (mode === 8) {
			for (let i = 0; i < 16; i++) texels.push([0, 0, 0, 0]); // reserved: transparent black
		} else {
			const [subsets, partBits, rotBits, selBits, colorBits, alphaBits, endpointP, sharedP, indexBits, index2Bits] = BC7_MODES[mode];
			const partition = bits(partBits);
			const rotation = bits(rotBits);
			const selection = bits(selBits);
			const n = subsets * 2;
			const ep = [];
			for (let e = 0; e < n; e++) ep.push([0, 0, 0, 255]);
			for (let c = 0; c < 3; c++) for (let e = 0; e < n; e++) ep[e][c] = bits(colorBits);
			if (alphaBits) for (let e = 0; e < n; e++) ep[e][3] = bits(alphaBits);
			const p = new Array(n).fill(-1);
			if (endpointP) for (let e = 0; e < n; e++) p[e] = bits(1);
			if (sharedP) {
				for (let s = 0; s < subsets; s++) p[s * 2] = p[s * 2 + 1] = bits(1);
			}
			// Unquantize: append the p-bit, then repeat the top bits to fill 8.
			const expand = (v, b) => {
				const x = v << (8 - b);
				return x | (x >> b);
			};
			for (let e = 0; e < n; e++) {
				for (let c = 0; c < 4; c++) {
					if (c === 3 && !alphaBits) continue;
					const b = c === 3 ? alphaBits : colorBits;
					ep[e][c] = p[e] >= 0 ? expand((ep[e][c] << 1) | p[e], b + 1) : expand(ep[e][c], b);
				}
			}
			const shape = subsets === 2 ? BC7_P2[partition] : subsets === 3 ? BC7_P3[partition] : null;
			const subsetOf = i => (shape ? shape.charCodeAt(i) - 48 : 0);
			const anchor = i => i === 0 || (subsets === 2 && i === BC7_A2[partition]) || (subsets === 3 && (i === BC7_A3A[partition] || i === BC7_A3B[partition]));
			const index = [];
			for (let i = 0; i < 16; i++) index.push(bits(anchor(i) ? indexBits - 1 : indexBits));
			const index2 = [];
			if (index2Bits) for (let i = 0; i < 16; i++) index2.push(bits(i === 0 ? index2Bits - 1 : index2Bits));
			const mix = (a, b, weight) => ((64 - weight) * a + weight * b + 32) >> 6;
			for (let i = 0; i < 16; i++) {
				const s = subsetOf(i);
				const e0 = ep[s * 2];
				const e1 = ep[s * 2 + 1];
				// Modes 4 and 5 index color and alpha separately; mode 4 can swap which uses which.
				let cw;
				let aw;
				if (!index2Bits) cw = aw = BC7_WEIGHTS[indexBits][index[i]];
				else if (selection) {
					cw = BC7_WEIGHTS[index2Bits][index2[i]];
					aw = BC7_WEIGHTS[indexBits][index[i]];
				} else {
					cw = BC7_WEIGHTS[indexBits][index[i]];
					aw = BC7_WEIGHTS[index2Bits][index2[i]];
				}
				const t = [mix(e0[0], e1[0], cw), mix(e0[1], e1[1], cw), mix(e0[2], e1[2], cw), mix(e0[3], e1[3], aw)];
				if (rotation) [t[3], t[rotation - 1]] = [t[rotation - 1], t[3]];
				texels.push(t);
			}
		}
		for (let i = 0; i < 16; i++) {
			const x = bx + (i & 3);
			const y = by + (i >> 2);
			if (x < w && y < h) out.set(texels[i], (y * w + x) * 4);
		}
	}

	const TEXTURE_FORMATS = {
		1: {name: 'Alpha8', bpp: 1},
		2: {name: 'ARGB4444', bpp: 2},
		3: {name: 'RGB24', bpp: 3},
		4: {name: 'RGBA32', bpp: 4},
		5: {name: 'ARGB32', bpp: 4},
		7: {name: 'RGB565', bpp: 2},
		10: {name: 'DXT1', block: 8},
		12: {name: 'DXT5', block: 16},
		13: {name: 'RGBA4444', bpp: 2},
		14: {name: 'BGRA32', bpp: 4},
		25: {name: 'BC7', block: 16},
		26: {name: 'BC4', block: 8},
		27: {name: 'BC5', block: 16},
		62: {name: 'RG16', bpp: 2},
		63: {name: 'R8', bpp: 1},
	};

	function decodeTexture(assets, tex, warnings) {
		const name = tex.m_Name || 'texture';
		const w = tex.m_Width | 0;
		const h = tex.m_Height | 0;
		const format = TEXTURE_FORMATS[tex.m_TextureFormat];
		if (!format) {
			warnings.push('Texture "' + name + '" uses an unsupported format (' + tex.m_TextureFormat + '); its material color is used instead');
			return null;
		}
		let src = tex['image data'];
		if (!(src instanceof Uint8Array) || !src.length) src = assets.resource(tex.m_StreamData);
		const need = format.block ? Math.ceil(w / 4) * Math.ceil(h / 4) * format.block : w * h * format.bpp;
		if (!w || !h || !src || src.length < need) {
			warnings.push('Texture "' + name + '" has no readable image data');
			return null;
		}
		const out = new Uint8Array(w * h * 4);
		if (format.block) {
			const bw = Math.ceil(w / 4);
			for (let i = 0; i < bw * Math.ceil(h / 4); i++) {
				const bx = (i % bw) * 4;
				const by = Math.floor(i / bw) * 4;
				const at = i * format.block;
				if (format.name === 'BC7') decodeBC7Block(src, at, out, w, h, bx, by);
				else if (format.name === 'DXT1') decodeColorBlock(src, at, out, w, h, bx, by, true);
				else if (format.name === 'DXT5') {
					decodeAlphaBlock(src, at, out, w, h, bx, by, 3);
					decodeColorBlock(src, at + 8, out, w, h, bx, by, false);
				} else if (format.name === 'BC4') {
					decodeAlphaBlock(src, at, out, w, h, bx, by, 0);
				} else {
					decodeAlphaBlock(src, at, out, w, h, bx, by, 0);
					decodeAlphaBlock(src, at + 8, out, w, h, bx, by, 1);
				}
			}
			if (format.name === 'BC4' || format.name === 'BC5') {
				for (let p = 0; p < w * h; p++) {
					if (format.name === 'BC4') out[p * 4 + 1] = out[p * 4 + 2] = out[p * 4];
					out[p * 4 + 3] = 255;
				}
			}
		} else {
			for (let p = 0; p < w * h; p++) {
				const o = p * 4;
				const s = p * format.bpp;
				switch (format.name) {
					case 'Alpha8':
						out.set([255, 255, 255, src[s]], o);
						break;
					case 'R8':
						out.set([src[s], src[s], src[s], 255], o);
						break;
					case 'RG16':
						out.set([src[s], src[s + 1], 0, 255], o);
						break;
					case 'RGB24':
						out.set([src[s], src[s + 1], src[s + 2], 255], o);
						break;
					case 'RGBA32':
						out.set([src[s], src[s + 1], src[s + 2], src[s + 3]], o);
						break;
					case 'ARGB32':
						out.set([src[s + 1], src[s + 2], src[s + 3], src[s]], o);
						break;
					case 'BGRA32':
						out.set([src[s + 2], src[s + 1], src[s], src[s + 3]], o);
						break;
					case 'RGB565': {
						const c = rgb565(src[s] | (src[s + 1] << 8));
						out.set([c[0], c[1], c[2], 255], o);
						break;
					}
					case 'ARGB4444':
					case 'RGBA4444': {
						const v = src[s] | (src[s + 1] << 8);
						const n = [(v >> 12) & 15, (v >> 8) & 15, (v >> 4) & 15, v & 15].map(x => x * 17);
						out.set(format.name === 'ARGB4444' ? [n[1], n[2], n[3], n[0]] : n, o);
						break;
					}
				}
			}
		}
		return {name, width: w, height: h, data: out};
	}

	/* ------------------------------------------------------------------ materials */

	const COLOR_PROPS = ['_Color', '_TintColor', '_MainColor', '_BaseColor', '_Colour'];
	const TEXTURE_PROPS = ['_MainTex', '_BaseMap', '_MainTexture', '_Tex', '_Texture'];

	function propertyMap(list) {
		const map = new Map();
		for (const entry of list || []) {
			if (!Array.isArray(entry)) continue;
			const key = typeof entry[0] === 'string' ? entry[0] : entry[0] && entry[0].name;
			if (key) map.set(key, entry[1]);
		}
		return map;
	}

	const QUEUES = {background: 1000, geometry: 2000, alphatest: 2450, transparent: 3000, overlay: 4000};
	const queueOf = tag => {
		const m = /^\s*([a-z]+)\s*([+-]\s*\d+)?/i.exec(String(tag || ''));
		return m && QUEUES[m[1].toLowerCase()] ? QUEUES[m[1].toLowerCase()] + (m[2] ? parseInt(m[2].replace(/\s/g, ''), 10) : 0) : -1;
	};

	/** Name, tags and blend factors of a Shader in the bundle (null for built-in ones). */
	function readShader(assets, pptr) {
		const sh = assets.ref(pptr);
		if (!sh || sh.__classID !== 48) return null;
		const form = sh.m_ParsedForm;
		if (!form) return {name: String(sh.m_Name || ''), tags: new Map(), blend: null};
		const sub = (form.m_SubShaders || [])[0];
		const tags = new Map(((sub && sub.m_Tags && sub.m_Tags.tags) || []).filter(Array.isArray));
		const pass = sub && (sub.m_Passes || []).find(p => p && p.m_State && !p.m_Type);
		const state = pass && pass.m_State;
		const rt = state && (state.rtBlend0 || (Array.isArray(state.rtBlend) && state.rtBlend[0]));
		return {name: String(form.m_Name || sh.m_Name || ''), tags, blend: rt ? {src: rt.srcBlend, dst: rt.destBlend} : null};
	}

	/**
	 * How a material is drawn: 'opaque', 'cutout', 'blend' or 'additive'. A color's alpha alone
	 * says nothing: Beat Saber's saber shaders use it for how much a part glows, and saber makers
	 * set it to 0 on parts that shouldn't glow. Only the render queue, the render type and the
	 * blend factors (the shader's, or the Standard shader's _SrcBlend / _DstBlend) make a part
	 * see-through.
	 */
	function blendMode(mat, floats, shader) {
		// A shader's blend factor is a number, or the name of a material property holding it.
		const factor = (v, prop) => {
			if (v && typeof v === 'object') return v.name && floats.has(v.name) ? floats.get(v.name) : v.val;
			return floats.has(prop) ? floats.get(prop) : null;
		};
		const src = factor(shader && shader.blend && shader.blend.src, '_SrcBlend');
		const dst = factor(shader && shader.blend && shader.blend.dst, '_DstBlend');
		let queue = Number(mat.m_CustomRenderQueue);
		if (!(queue >= 0)) queue = shader ? queueOf(shader.tags.get('Queue')) : -1;
		const tagMap = new Map((mat.stringTagMap || []).filter(Array.isArray));
		const type = String(tagMap.get('RenderType') || (shader && shader.tags.get('RenderType')) || '');
		const mode = floats.get('_Mode'); // Standard shader: 0 opaque, 1 cutout, 2 fade, 3 transparent
		if (dst === 1 && src != null && src !== 0) return 'additive'; // One / SrcAlpha + One
		if (/cutout/i.test(type) || mode === 1 || (queue >= 2450 && queue < 3000)) return 'cutout';
		if (queue >= 3000 || /transparent|fade/i.test(type) || mode === 2 || mode === 3 || dst === 6 || dst === 10) return 'blend';
		return 'opaque';
	}

	function readMaterial(assets, mat, textureIndex, shaderOf) {
		const props = mat.m_SavedProperties || {};
		const colors = propertyMap(props.m_Colors);
		const floats = propertyMap(props.m_Floats);
		const texEnvs = propertyMap(props.m_TexEnvs);
		let color = [1, 1, 1, 1];
		for (const k of COLOR_PROPS) {
			const c = colors.get(k);
			if (c) {
				color = [c.r, c.g, c.b, c.a];
				break;
			}
		}
		let texture = -1;
		let repeat = [1, 1];
		let offset = [0, 0];
		for (const k of TEXTURE_PROPS) {
			const env = texEnvs.get(k);
			if (env && env.m_Texture && env.m_Texture.m_PathID) {
				texture = textureIndex(env.m_Texture);
				if (env.m_Scale) repeat = [env.m_Scale.x, env.m_Scale.y];
				if (env.m_Offset) offset = [env.m_Offset.x, env.m_Offset.y];
				break;
			}
		}
		// Custom saber convention: "_CustomColors" decides; without it, glowing materials
		// ("_Glow" / "_Bloom" above zero) take the saber color.
		let saberColor;
		if (floats.has('_CustomColors')) saberColor = floats.get('_CustomColors') > 0;
		else saberColor = (floats.get('_Glow') || 0) > 0 || (floats.get('_Bloom') || 0) > 0;
		// How much the part blooms in the game.
		const glow = Math.max(0, floats.get('_Glow') || 0, floats.get('_Bloom') || 0);
		const shader = shaderOf ? shaderOf(mat.m_Shader) : null;
		const blend = blendMode(mat, floats, shader);
		const cutoff = floats.has('_Cutoff') ? floats.get('_Cutoff') : 0.5;
		return {name: mat.m_Name || '', shader: shader ? shader.name : '', color, texture, repeat, offset, saberColor, glow, blend, cutoff, transparent: blend === 'blend' || blend === 'additive'};
	}

	/* ------------------------------------------------------------------ math (column-major 4×4) */

	function compose(t, q, s) {
		const x = q.x;
		const y = q.y;
		const z = q.z;
		const w = q.w;
		const x2 = x + x;
		const y2 = y + y;
		const z2 = z + z;
		const xx = x * x2;
		const xy = x * y2;
		const xz = x * z2;
		const yy = y * y2;
		const yz = y * z2;
		const zz = z * z2;
		const wx = w * x2;
		const wy = w * y2;
		const wz = w * z2;
		return [
			(1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0,
			(xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0,
			(xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0,
			t.x, t.y, t.z, 1,
		];
	}

	function multiply(a, b) {
		const o = new Array(16);
		for (let c = 0; c < 4; c++) {
			for (let r = 0; r < 4; r++) {
				o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
			}
		}
		return o;
	}

	const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

	/** Inverse-transpose of the upper 3×3, for transforming normals. */
	function normalMatrix(m) {
		const a = m[0];
		const b = m[4];
		const c = m[8];
		const d = m[1];
		const e = m[5];
		const f = m[9];
		const g = m[2];
		const h = m[6];
		const i = m[10];
		const A = e * i - f * h;
		const B = -(d * i - f * g);
		const C = d * h - e * g;
		const det = a * A + b * B + c * C || 1;
		// The cofactor matrix divided by the determinant is the inverse transpose (row-major).
		return [
			A / det, B / det, C / det,
			-(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
			(b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
		];
	}

	/* ------------------------------------------------------------------ text */

	// Text in a saber (TextMeshPro, Unity's legacy TextMesh and UI Text) has no mesh in the file:
	// Unity builds it when the saber loads. It is rebuilt here as quads in the text object's own
	// space (x right, y up, facing -Z), then placed like any mesh.
	//
	// TextMeshPro: glyphs from its font asset's atlas, drawn by visuals.js as a signed distance
	// field like TextMeshPro's own shader. Other text, or a font whose atlas can't be read, is drawn
	// into a texture with a plain font when the environment has OffscreenCanvas.

	/** [r, g, b, a] from a Unity Color (floats) or Color32 (packed `rgba`). */
	function colorOf(c, fallback) {
		if (!c || typeof c !== 'object') return fallback;
		if (typeof c.r === 'number') return [c.r, c.g, c.b, c.a == null ? 1 : c.a];
		if (typeof c.rgba === 'number') return [c.rgba & 255, (c.rgba >>> 8) & 255, (c.rgba >>> 16) & 255, c.rgba >>> 24].map(v => v / 255);
		return fallback;
	}

	const NAMED_COLORS = {white: 'ffffff', black: '000000', red: 'ff0000', green: '00ff00', blue: '0000ff', yellow: 'ffff00', orange: 'ff8000', purple: 'a020f0'};
	const RICH_TAGS = new Set(['align', 'allcaps', 'alpha', 'b', 'br', 'color', 'cspace', 'font', 'font-weight', 'gradient', 'i', 'indent', 'line-height', 'line-indent', 'link', 'lowercase', 'margin', 'mark', 'material', 'mspace', 'nobr', 'noparse', 'page', 'pos', 'rotate', 's', 'size', 'smallcaps', 'space', 'sprite', 'strikethrough', 'style', 'sub', 'sup', 'u', 'uppercase', 'voffset', 'width']);

	function hexColor(value, alpha) {
		const v = String(value || '').replace(/["']/g, '').trim().toLowerCase();
		const hex = (NAMED_COLORS[v] || v.replace(/^#/, '')).replace(/^([0-9a-f])([0-9a-f])([0-9a-f])$/, '$1$1$2$2$3$3');
		if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
		const n = k => parseInt(hex.substr(k, 2), 16) / 255;
		return [n(0), n(2), n(4), hex.length === 8 ? n(6) : alpha];
	}

	/**
	 * Characters of a text with their color and style. Rich text tags change color, bold, italic
	 * and case; tags it doesn't know are left in the text, as TextMeshPro does.
	 */
	function textRuns(text, base, style, rich) {
		const runs = [];
		const colors = [base];
		let bold = (style & 1) !== 0;
		let italic = (style & 2) !== 0;
		let lower = (style & 8) !== 0;
		let upper = (style & 16) !== 0 || (style & 32) !== 0;
		let alpha = null;
		const push = ch => {
			let c = ch;
			if (upper) c = c.toUpperCase();
			else if (lower) c = c.toLowerCase();
			const color = colors[colors.length - 1].slice();
			if (alpha != null) color[3] = alpha;
			for (const one of c) runs.push({code: one.codePointAt(0), color, bold, italic});
		};
		let i = 0;
		while (i < text.length) {
			if (rich && text[i] === '<') {
				const end = text.indexOf('>', i);
				const m = end > 0 ? /^<(\/?)([a-z-]+)(?:\s*=\s*([^>]*))?\s*\/?>$/i.exec(text.slice(i, end + 1)) : null;
				if (m && RICH_TAGS.has(m[2].toLowerCase())) {
					const close = !!m[1];
					const tag = m[2].toLowerCase();
					if (tag === 'noparse' && !close) {
						const stop = text.toLowerCase().indexOf('</noparse>', end);
						const literal = text.slice(end + 1, stop < 0 ? text.length : stop);
						for (const ch of literal) push(ch);
						i = stop < 0 ? text.length : stop + 10;
						continue;
					}
					if (tag === 'br') push('\n');
					else if (tag === 'b') bold = !close || (style & 1) !== 0;
					else if (tag === 'i') italic = !close || (style & 2) !== 0;
					else if (tag === 'lowercase') lower = !close;
					else if (tag === 'uppercase' || tag === 'allcaps' || tag === 'smallcaps') upper = !close;
					else if (tag === 'alpha') {
						const a = /^#?([0-9a-f]{2})$/i.exec(String(m[3] || '').trim());
						alpha = close || !a ? null : parseInt(a[1], 16) / 255;
					}
					else if (tag === 'color') {
						if (close) {
							if (colors.length > 1) colors.pop();
						} else colors.push(hexColor(m[3], base[3]) || colors[colors.length - 1]);
					}
					i = end + 1;
					continue;
				}
			}
			const ch = String.fromCodePoint(text.codePointAt(i));
			push(ch);
			i += ch.length;
		}
		return runs;
	}

	/** Glyph metrics and atlas of a TextMeshPro font asset (both serialized layouts), or null. */
	function readTmpFont(fa) {
		const chars = new Map();
		if (fa.m_FaceInfo && Array.isArray(fa.m_GlyphTable) && Array.isArray(fa.m_CharacterTable)) {
			// TextMeshPro 1.4 and later: glyph rects from the bottom of the atlas.
			const glyphs = new Map(fa.m_GlyphTable.map(g => [g.m_Index, g]));
			for (const ch of fa.m_CharacterTable) {
				const g = glyphs.get(ch.m_GlyphIndex);
				if (!g || !g.m_Metrics || !g.m_GlyphRect) continue;
				const m = g.m_Metrics;
				const r = g.m_GlyphRect;
				chars.set(ch.m_Unicode, {w: m.m_Width, h: m.m_Height, bx: m.m_HorizontalBearingX, by: m.m_HorizontalBearingY, adv: m.m_HorizontalAdvance, x: r.m_X, y: r.m_Y, rw: r.m_Width, rh: r.m_Height, scale: (g.m_Scale || 1) * (ch.m_Scale || 1)});
			}
			const fi = fa.m_FaceInfo;
			return {
				pointSize: fi.m_PointSize,
				scale: fi.m_Scale || 1,
				lineHeight: fi.m_LineHeight,
				ascender: fi.m_AscentLine,
				descender: fi.m_DescentLine,
				atlasWidth: fa.m_AtlasWidth,
				atlasHeight: fa.m_AtlasHeight,
				padding: fa.m_AtlasPadding || 0,
				atlas: (fa.m_AtlasTextures || [])[0],
				material: fa.material || fa.m_Material,
				topDown: false,
				boldSpacing: fa.boldSpacing == null ? 7 : fa.boldSpacing,
				spacing: fa.normalSpacingOffset || 0,
				italic: fa.italicStyle == null ? 35 : fa.italicStyle,
				chars,
			};
		}
		if (fa.m_fontInfo && Array.isArray(fa.m_glyphInfoList)) {
			// Earlier versions: glyph rects from the top of the atlas.
			for (const g of fa.m_glyphInfoList) chars.set(g.id, {w: g.width, h: g.height, bx: g.xOffset, by: g.yOffset, adv: g.xAdvance, x: g.x, y: g.y, rw: g.width, rh: g.height, scale: g.scale || 1});
			const fi = fa.m_fontInfo;
			return {
				pointSize: fi.PointSize,
				scale: fi.Scale || 1,
				lineHeight: fi.LineHeight,
				ascender: fi.Ascender,
				descender: fi.Descender,
				atlasWidth: fi.AtlasWidth,
				atlasHeight: fi.AtlasHeight,
				padding: fi.Padding || 0,
				atlas: fa.atlas,
				material: fa.material,
				topDown: true,
				boldSpacing: fa.boldSpacing == null ? 7 : fa.boldSpacing,
				spacing: fa.normalSpacingOffset || 0,
				italic: fa.italicStyle == null ? 35 : fa.italicStyle,
				chars,
			};
		}
		return null;
	}

	/** Local rectangle of a RectTransform (a point at the origin for a plain Transform). */
	function rectOf(t) {
		const size = (t && t.m_SizeDelta) || {x: 0, y: 0};
		const pivot = (t && t.m_Pivot) || {x: 0.5, y: 0.5};
		const w = Math.max(0, size.x || 0);
		const h = Math.max(0, size.y || 0);
		const left = -pivot.x * w;
		const bottom = -pivot.y * h;
		return {left, right: left + w, bottom, top: bottom + h};
	}

	/** TextMeshPro alignment as fractions: h 0 left … 1 right, v 0 top … 1 bottom. */
	function tmpAlignment(c) {
		const old = Number(c.m_textAlignment) || 0;
		const h = old && old !== 0xffff ? old & 0xff : Number(c.m_HorizontalAlignment) || 1;
		const v = old && old !== 0xffff ? old & 0xff00 : Number(c.m_VerticalAlignment) || 256;
		return {h: h & 0x22 ? 0.5 : h & 4 ? 1 : 0, v: v & 256 ? 0 : v & 1024 ? 1 : 0.5};
	}

	// TextAnchor (TextMesh, UI Text): UpperLeft, UpperCenter, … LowerRight.
	const anchorAlignment = a => ({h: ((Number(a) || 0) % 3) / 2, v: Math.floor((Number(a) || 0) / 3) / 2});

	function shrink(rect, margin) {
		if (!margin) return rect;
		return {left: rect.left + (margin.x || 0), right: rect.right - (margin.z || 0), top: rect.top - (margin.y || 0), bottom: rect.bottom + (margin.w || 0)};
	}

	/**
	 * Quads for TextMeshPro text set in `font`. Returns a mesh like decodeMesh's (plus per-vertex
	 * colors), or null when nothing could be set.
	 */
	function setTmpText(runs, font, o) {
		const glyph = code => font.chars.get(code) || font.chars.get(String.fromCodePoint(code).toUpperCase().codePointAt(0)) || font.chars.get(String.fromCodePoint(code).toLowerCase().codePointAt(0));
		const base = o.size / font.pointSize * font.scale * o.unit; // font units → local units
		const em = o.size * 0.01 * o.unit; // TextMeshPro's spacing values are in 1/100 em
		const space = glyph(32);
		const spaceAdvance = space ? space.adv * space.scale * base : font.pointSize * 0.25 * base;
		const lineHeight = font.lineHeight * base + o.lineSpacing * em;
		const wrap = o.wrap && o.rect.right - o.rect.left > 0 ? o.rect.right - o.rect.left : 0;
		const lines = [];
		let line = [];
		let x = 0;
		let lastSpace = -1;
		let missing = 0;
		const endLine = () => {
			lines.push(line);
			line = [];
			x = 0;
			lastSpace = -1;
		};
		for (const r of runs) {
			if (r.code === 10) {
				endLine();
				continue;
			}
			if (r.code === 13) continue;
			if (r.code === 32 || r.code === 9 || r.code === 0xa0) {
				lastSpace = line.length;
				line.push({space: true, x});
				x += (r.code === 9 ? 4 : 1) * spaceAdvance + (font.spacing + o.charSpacing + o.wordSpacing) * em;
				continue;
			}
			const g = glyph(r.code);
			if (!g) {
				missing++;
				continue;
			}
			const s = base * g.scale;
			if (wrap && line.some(item => !item.space) && x + (g.bx + g.w) * s > wrap) {
				if (lastSpace >= 0) {
					// Carry the word being typed over to the next line.
					const moved = line.splice(lastSpace).slice(1);
					const shift = moved.length ? moved[0].x : x;
					const end = x;
					endLine();
					for (const item of moved) line.push(Object.assign(item, {x: item.x - shift}));
					x = end - shift;
				} else endLine();
			}
			line.push({g, s, x, color: r.color, italic: r.italic});
			x += g.adv * s + (font.spacing + o.charSpacing + (r.bold ? font.boldSpacing : 0)) * em;
		}
		endLine();
		const width = items => items.reduce((w, item) => (item.space ? w : Math.max(w, item.x + (item.g.bx + item.g.w) * item.s)), 0);
		const ascender = font.ascender * base;
		const height = ascender - font.descender * base + (lines.length - 1) * lineHeight;
		const rect = o.rect;
		const top = rect.top - (rect.top - rect.bottom - height) * o.align.v;
		const pad = font.padding;
		const shear = font.italic * 0.01;
		const pos = [];
		const uv = [];
		const col = [];
		const idx = [];
		lines.forEach((items, k) => {
			const left = rect.left + (rect.right - rect.left - width(items)) * o.align.h;
			const baseline = top - ascender - k * lineHeight;
			for (const item of items) {
				if (item.space) continue;
				const {g, s} = item;
				const x0 = left + item.x + (g.bx - pad) * s;
				const x1 = x0 + (g.w + 2 * pad) * s;
				const y1 = baseline + (g.by + pad) * s;
				const y0 = y1 - (g.h + 2 * pad) * s;
				const lean = y => (item.italic ? shear * (y - baseline) : 0);
				const u0 = (g.x - pad) / font.atlasWidth;
				const u1 = (g.x + g.rw + pad) / font.atlasWidth;
				const v0 = font.topDown ? 1 - (g.y + g.rh + pad) / font.atlasHeight : (g.y - pad) / font.atlasHeight;
				const v1 = font.topDown ? 1 - (g.y - pad) / font.atlasHeight : (g.y + g.rh + pad) / font.atlasHeight;
				const at = pos.length / 3;
				pos.push(x0 + lean(y0), y0, 0, x0 + lean(y1), y1, 0, x1 + lean(y1), y1, 0, x1 + lean(y0), y0, 0);
				uv.push(u0, v0, u0, v1, u1, v1, u1, v0);
				for (let n = 0; n < 4; n++) col.push(...item.color);
				// Bottom-left, top-left, top-right: clockwise seen from the front, as in Unity.
				idx.push(at, at + 1, at + 2, at + 2, at + 3, at);
			}
		});
		if (!idx.length) return {mesh: null, missing};
		const n = pos.length / 3;
		const normals = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) normals[i * 3 + 2] = -1;
		return {mesh: {name: 'text', vertexCount: n, positions: new Float32Array(pos), normals, uvs: new Float32Array(uv), colors: new Float32Array(col), submeshes: [Uint32Array.from(idx)]}, missing};
	}

	/**
	 * Text drawn with a plain font into a texture, on one quad. Returns {mesh, texture} or null
	 * when this environment can't draw text (no OffscreenCanvas, e.g. Node).
	 */
	function drawnText(runs, o) {
		const Canvas = root.OffscreenCanvas;
		if (typeof Canvas !== 'function') return null;
		const lines = [''];
		for (const r of runs) {
			if (r.code === 10) lines.push('');
			else if (r.code !== 13) lines[lines.length - 1] += String.fromCodePoint(r.code);
		}
		const px = 64;
		const lineHeight = px * 1.2;
		const pad = 8;
		const canvas = new Canvas(1, 1);
		const g = canvas.getContext('2d');
		if (!g) return null;
		const font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + px + 'px sans-serif';
		g.font = font;
		const widths = lines.map(l => g.measureText(l).width);
		const textWidth = Math.max(1, ...widths);
		const w = Math.min(4096, Math.ceil(textWidth + pad * 2));
		const h = Math.min(4096, Math.ceil(lines.length * lineHeight + pad * 2));
		canvas.width = w;
		canvas.height = h;
		g.font = font;
		g.fillStyle = '#fff';
		g.textBaseline = 'middle';
		const lineAlign = o.lineAlign == null ? o.align.h : o.lineAlign;
		lines.forEach((l, k) => g.fillText(l, pad + (textWidth - widths[k]) * lineAlign, pad + lineHeight * (k + 0.5)));
		const img = g.getImageData(0, 0, w, h).data;
		const data = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) data.set(img.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); // bottom-up, like Unity
		const unit = o.em / px;
		const rect = o.rect;
		const left = rect.left + (rect.right - rect.left - textWidth * unit) * o.align.h - pad * unit;
		const top = rect.top - (rect.top - rect.bottom - lines.length * lineHeight * unit) * o.align.v + pad * unit;
		const x1 = left + w * unit;
		const y0 = top - h * unit;
		const mesh = {
			name: 'text',
			vertexCount: 4,
			positions: new Float32Array([left, y0, 0, left, top, 0, x1, top, 0, x1, y0, 0]),
			normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
			uvs: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
			colors: null,
			submeshes: [Uint32Array.from([0, 1, 2, 2, 3, 0])],
		};
		return {mesh, texture: {name: 'text', width: w, height: h, data}};
	}

	/* ------------------------------------------------------------------ saber extraction */

	// Unity saber space → the replayer's .saberContainer: blade (+Z) to -Y, Unity +Y to +Z, X
	// mirrored. Derived from how the replayer turns recorded controller rotations into saber
	// rotations; the reflection also flips triangle winding.
	function toSaberSpace(x, y, z, out, at) {
		out[at] = -x;
		out[at + 1] = -z;
		out[at + 2] = y;
	}

	function bakePart(mesh, matrix, materialIDs) {
		const n = mesh.vertexCount;
		const positions = new Float32Array(n * 3);
		const m = matrix;
		for (let i = 0; i < n; i++) {
			const x = mesh.positions[i * 3];
			const y = mesh.positions[i * 3 + 1];
			const z = mesh.positions[i * 3 + 2];
			toSaberSpace(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], positions, i * 3);
		}
		let normals = null;
		if (mesh.normals) {
			const nm = normalMatrix(m);
			normals = new Float32Array(n * 3);
			for (let i = 0; i < n; i++) {
				const x = mesh.normals[i * 3];
				const y = mesh.normals[i * 3 + 1];
				const z = mesh.normals[i * 3 + 2];
				let nx = nm[0] * x + nm[1] * y + nm[2] * z;
				let ny = nm[3] * x + nm[4] * y + nm[5] * z;
				let nz = nm[6] * x + nm[7] * y + nm[8] * z;
				const len = Math.hypot(nx, ny, nz) || 1;
				nx /= len;
				ny /= len;
				nz /= len;
				toSaberSpace(nx, ny, nz, normals, i * 3);
			}
		}
		const total = mesh.submeshes.reduce((s, t) => s + t.length, 0);
		const indices = new Uint32Array(total);
		const groups = [];
		let start = 0;
		mesh.submeshes.forEach((tri, k) => {
			for (let i = 0; i + 2 < tri.length; i += 3) {
				// Reverse the winding: the conversion above is a reflection.
				indices[start + i] = tri[i];
				indices[start + i + 1] = tri[i + 2];
				indices[start + i + 2] = tri[i + 1];
			}
			groups.push({start, count: tri.length, material: materialIDs[Math.min(k, materialIDs.length - 1)]});
			start += tri.length;
		});
		// Unity UVs and texture rows both start at the bottom, as in WebGL: no flip needed.
		return {name: mesh.name, positions, normals, uvs: mesh.uvs, colors: mesh.colors, indices, groups};
	}

	function read(buffer) {
		const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		const assets = new Assets(bytes);
		const warnings = [];
		const gameObjects = assets.ofClass(1).map(o => assets.read(o.pathID)).filter(Boolean);
		const components = go => (go.m_Component || []).map(c => (Array.isArray(c) ? c[1] : c.component || c)).map(p => assets.ref(p)).filter(Boolean);
		const transformOf = go => components(go).find(c => c.__classID === 4 || c.__classID === 224);

		// Name and author from the saber's descriptor component, when its fields are readable.
		let name = '';
		let author = '';
		for (const o of assets.ofClass(114)) {
			try {
				const mb = assets.read(o.pathID);
				if (mb && (mb.SaberName || mb.saberName)) {
					name = String(mb.SaberName || mb.saberName || '');
					author = String(mb.AuthorName || mb.authorName || '');
					break;
				}
			} catch (e) {
				/* not a descriptor */
			}
		}

		const textures = [];
		const textureByPath = new Map();
		const textureIndex = pptr => {
			if (!pptr || pptr.m_FileID !== 0) return -1;
			if (textureByPath.has(pptr.m_PathID)) return textureByPath.get(pptr.m_PathID);
			let index = -1;
			const tex = assets.read(pptr.m_PathID);
			if (tex && tex.__classID === 28) {
				const decoded = decodeTexture(assets, tex, warnings);
				if (decoded) index = textures.push(decoded) - 1;
			}
			textureByPath.set(pptr.m_PathID, index);
			return index;
		};
		const shaders = new Map();
		const shaderOf = pptr => {
			const key = pptr ? pptr.m_FileID + ':' + pptr.m_PathID : 'none';
			if (!shaders.has(key)) {
				let info = null;
				try {
					info = readShader(assets, pptr);
				} catch (e) {
					info = null; // a shader layout this reader doesn't follow: decide by the material
				}
				shaders.set(key, info);
			}
			return shaders.get(key);
		};
		const materials = [];
		const materialByPath = new Map();
		const materialIndex = pptr => {
			const key = pptr ? pptr.m_FileID + ':' + pptr.m_PathID : 'none';
			if (materialByPath.has(key)) return materialByPath.get(key);
			const mat = assets.ref(pptr);
			const index = materials.push(mat && mat.__classID === 21 ? readMaterial(assets, mat, textureIndex, shaderOf) : {name: '', shader: '', color: [1, 1, 1, 1], texture: -1, repeat: [1, 1], offset: [0, 0], saberColor: false, glow: 0, blend: 'opaque', cutoff: 0.5, transparent: false}) - 1;
			materialByPath.set(key, index);
			return index;
		};
		// TextMeshPro font assets, with their atlas decoded (null when unusable).
		const fontCache = new Map();
		const fontOf = pptr => {
			const key = pptr ? pptr.m_FileID + ':' + pptr.m_PathID : 'none';
			if (!fontCache.has(key)) {
				let font = null;
				try {
					const fa = assets.ref(pptr);
					font = fa ? readTmpFont(fa) : null;
				} catch (e) {
					font = null;
				}
				if (font) {
					font.texture = textureIndex(font.atlas);
					if (font.texture < 0 || !font.chars.size || !(font.pointSize > 0) || !(font.atlasWidth > 0) || !(font.atlasHeight > 0)) font = null;
				}
				fontCache.set(key, font);
			}
			return fontCache.get(key);
		};
		/** A material for text: TextMeshPro's face color, outline and weight when `font` is set. */
		const textMaterial = (name, pptr, font, bold, texture) => {
			let mat = assets.ref(pptr);
			if ((!mat || mat.__classID !== 21) && font) mat = assets.ref(font.material);
			const props = (mat && mat.__classID === 21 && mat.m_SavedProperties) || {};
			const colors = propertyMap(props.m_Colors);
			const floats = propertyMap(props.m_Floats);
			const f = k => Number(floats.get(k)) || 0;
			const out = {name, shader: '', color: colorOf(colors.get('_FaceColor'), [1, 1, 1, 1]), texture, repeat: [1, 1], offset: [0, 0], saberColor: f('_CustomColors') > 0, glow: Math.max(0, f('_Glow'), f('_Bloom')), blend: 'blend', cutoff: 0.5, transparent: true};
			if (font) {
				// As in TextMeshProUGUI's shader: the edge sits at 0.5 in the distance field, moved by
				// weight and dilation; the outline straddles it.
				const ratio = floats.has('_ScaleRatioA') ? f('_ScaleRatioA') : 1;
				const weight = bold ? (floats.has('_WeightBold') ? f('_WeightBold') : 0.5) : f('_WeightNormal');
				out.text = {edge: 0.5 - (weight / 4 + f('_FaceDilate')) * ratio * 0.5, outline: Math.min(1, f('_OutlineWidth') * ratio), outlineColor: colorOf(colors.get('_OutlineColor'), [0, 0, 0, 1]), softness: f('_OutlineSoftness') * ratio};
			}
			return materials.push(out) - 1;
		};

		const meshCache = new Map();
		const loadMesh = pptr => {
			if (pptr.m_FileID !== 0) {
				const file = assets.external(pptr.m_FileID);
				const kind = BUILTIN_MESHES[pptr.m_PathID];
				if (kind && (!file || BUILTIN_FILE.test(file))) return primitive(kind);
				warnings.push('A mesh from another file (' + (file || 'unknown') + ') is not inside this .saber, skipped');
				return null;
			}
			const m = assets.read(pptr.m_PathID);
			return m && m.__classID === 43 ? decodeMesh(assets, m, warnings) : null;
		};
		const meshOf = pptr => {
			if (!pptr || (!pptr.m_FileID && !pptr.m_PathID)) return null;
			const key = pptr.m_FileID + ':' + pptr.m_PathID;
			if (!meshCache.has(key)) meshCache.set(key, loadMesh(pptr));
			return meshCache.get(key);
		};

		const enabled = c => c.m_Enabled !== 0 && c.m_Enabled !== false;
		const textOf = comps =>
			comps.find(c => c.__classID === 102 || (c.__classID === 114 && ((typeof c.m_text === 'string' && 'm_fontAsset' in c) || (typeof c.m_Text === 'string' && c.m_FontData))));

		/** The text on a GameObject as a part (null when hidden, empty or not drawable here). */
		function textPart(c, comps, t, world, renderer) {
			if (!enabled(c) || (renderer && !enabled(renderer))) return null;
			const raw = String(c.__classID === 114 && 'm_fontAsset' in c ? c.m_text : c.m_Text);
			const plain = raw.replace(/<[^>]*>/g, '').replace(/\\[nt]/g, ' ').replace(/\s+/g, ' ').trim();
			const label = 'Text "' + (plain.length > 24 ? plain.slice(0, 23) + '…' : plain) + '"';
			const drawn = (runs, o, pptr) => {
				const d = drawnText(runs, o);
				if (!d) {
					warnings.push(label + ' is not shown: drawing text needs a browser');
					return null;
				}
				const mat = textMaterial(label, pptr, null, false, textures.push(d.texture) - 1);
				const color = (runs[0] && runs[0].color) || [1, 1, 1, 1];
				materials[mat].color = materials[mat].color.map((v, k) => v * color[k]);
				return Object.assign(bakePart(d.mesh, world, [mat]), {name: label});
			};
			if (c.__classID === 102) {
				// Legacy TextMesh: anchored at its origin, sized by character size × font size.
				const style = Number(c.m_FontStyle) || 0;
				const runs = textRuns(raw, colorOf(c.m_Color, [1, 1, 1, 1]), style, !!c.m_RichText);
				const font = assets.ref(c.m_Font);
				const size = Number(c.m_FontSize) || (font && Number(font.m_FontSize)) || 16;
				const em = (Number(c.m_CharacterSize) || 1) * size * 0.1 * (Number(c.m_LineSpacing) || 1);
				return raw.trim() ? drawn(runs, {em, rect: rectOf(null), align: anchorAlignment(c.m_Anchor), lineAlign: (Number(c.m_Alignment) || 0) / 2, bold: style & 1, italic: style & 2}, renderer && (renderer.m_Materials || [])[0]) : null;
			}
			if (!('m_fontAsset' in c)) {
				// UI Text on a canvas: one canvas unit per point.
				const fd = c.m_FontData || {};
				const style = Number(fd.m_FontStyle) || 0;
				const runs = textRuns(raw, colorOf(c.m_Color, [1, 1, 1, 1]), style, fd.m_RichText !== false && fd.m_RichText !== 0);
				return raw.trim() ? drawn(runs, {em: Number(fd.m_FontSize) || 14, rect: rectOf(t), align: anchorAlignment(fd.m_Alignment), bold: style & 1, italic: style & 2}, c.m_Material) : null;
			}
			// TextMeshPro.
			let text = raw;
			if (c.m_parseCtrlCharacters !== false && c.m_parseCtrlCharacters !== 0) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
			if (!text.trim()) return null;
			const style = Number(c.m_fontStyle) || 0;
			const runs = textRuns(text, colorOf(c.m_fontColor, colorOf(c.m_fontColor32, [1, 1, 1, 1])), style, c.m_isRichText !== false && c.m_isRichText !== 0);
			const isUi = !renderer && comps.some(x => x.__classID === 222);
			const size = Number(c.m_fontSize) || 36;
			// 3D TextMeshPro scales its text by 0.1; on a canvas (or orthographic) it doesn't.
			const unit = isUi || c.m_isOrthographic === true || c.m_isOrthographic === 1 ? 1 : 0.1;
			const rect = shrink(rectOf(t), c.m_margin);
			const align = tmpAlignment(c);
			const wrap = 'm_TextWrappingMode' in c ? [1, 2].includes(Number(c.m_TextWrappingMode)) : c.m_enableWordWrapping !== false && c.m_enableWordWrapping !== 0;
			const font = fontOf(c.m_fontAsset);
			if (!font) {
				warnings.push(label + ': its font could not be read; a plain font is used');
				return drawn(runs, {em: size * unit, rect, align, bold: style & 1, italic: style & 2}, c.m_sharedMaterial);
			}
			const set = setTmpText(runs, font, {size, unit, rect, align, wrap, charSpacing: Number(c.m_characterSpacing) || 0, wordSpacing: Number(c.m_wordSpacing) || 0, lineSpacing: Number(c.m_lineSpacing) || 0});
			if (set.missing) warnings.push(label + ': ' + set.missing + ' character(s) are not in its font');
			if (!set.mesh) return null;
			return Object.assign(bakePart(set.mesh, world, [textMaterial(label, c.m_sharedMaterial, font, (style & 1) !== 0, font.texture)]), {name: label, text: true});
		}

		// Parts the replayer can't show, by kind: listed once in the warnings.
		const SKIPPED = {198: 'particle', 199: 'particle', 96: 'trail', 120: 'line', 212: 'sprite'};
		const skipped = {particle: new Set(), trail: new Set(), line: new Set(), sprite: new Set(), ui: new Set()};

		/** Every visible mesh under `rootGo`, baked into saber space relative to rootGo. */
		function collect(rootGo) {
			const parts = [];
			const visit = (go, matrix, isRoot) => {
				if (!go || (go.m_IsActive === false && !isRoot)) return;
				const t = transformOf(go);
				let world = matrix;
				// The root's own placement is replaced by the saber's when the game spawns it.
				if (t && !isRoot) world = multiply(matrix, compose(t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale));
				const comps = components(go);
				const filter = comps.find(c => c.__classID === 33);
				const renderer = comps.find(c => c.__classID === 23 || c.__classID === 137);
				if (renderer && renderer.m_Enabled !== 0 && renderer.m_Enabled !== false) {
					const mesh = renderer.__classID === 137 ? meshOf(renderer.m_Mesh) : filter && meshOf(filter.m_Mesh);
					if (mesh) parts.push(bakePart(mesh, world, (renderer.m_Materials || []).map(materialIndex).concat(renderer.m_Materials && renderer.m_Materials.length ? [] : [materialIndex(null)])));
				}
				const text = textOf(comps);
				if (text) {
					try {
						const part = textPart(text, comps, t, world, renderer);
						if (part) parts.push(part);
					} catch (e) {
						warnings.push('A text in this saber could not be read: ' + ((e && e.message) || e));
					}
				} else if (comps.some(c => c.__classID === 222)) skipped.ui.add(go.__pathID);
				for (const c of comps) if (SKIPPED[c.__classID] && enabled(c)) skipped[SKIPPED[c.__classID]].add(go.__pathID);
				for (const child of (t && t.m_Children) || []) {
					const ct = assets.ref(child);
					if (ct && ct.m_GameObject) visit(assets.ref(ct.m_GameObject), world, false);
				}
			};
			visit(rootGo, IDENTITY, true);
			return {parts};
		}

		const named = n => gameObjects.find(g => String(g.m_Name).toLowerCase() === n);
		let left = named('leftsaber');
		let right = named('rightsaber');
		if (!left && !right) {
			// No LeftSaber/RightSaber: use the top-level object for both hands.
			const top = gameObjects.find(g => {
				const t = transformOf(g);
				return t && (!t.m_Father || !t.m_Father.m_PathID);
			});
			if (!top) throw new Error('No saber objects found in this file');
			left = right = top;
			warnings.push('No "LeftSaber" / "RightSaber" objects; the whole model is used for both hands');
		}
		const result = {
			name,
			author,
			unityVersion: assets.file.unityVersion.join('.'),
			left: left ? collect(left) : null,
			right: right ? collect(right) : null,
			materials,
			textures,
			warnings,
		};
		const SKIPPED_NOTE = {particle: 'particle effect(s)', trail: 'trail renderer(s)', line: 'line renderer(s)', sprite: 'sprite(s)', ui: 'UI element(s) other than text'};
		for (const kind of Object.keys(skipped)) if (skipped[kind].size) warnings.push(skipped[kind].size + ' ' + SKIPPED_NOTE[kind] + ' not shown (not supported yet)');
		if (!result.left) result.left = result.right;
		if (!result.right) result.right = result.left;
		if (!result.left.parts.length && !result.right.parts.length) throw new Error('This .saber contains no visible meshes');
		return result;
	}

	/** Every mesh and texture in the file, decoded but not placed (for tests and diagnostics). */
	function inspect(buffer) {
		const assets = new Assets(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
		const warnings = [];
		const meshes = assets.ofClass(43).map(o => decodeMesh(assets, assets.read(o.pathID), warnings)).filter(Boolean);
		const textures = assets.ofClass(28).map(o => decodeTexture(assets, assets.read(o.pathID), warnings)).filter(Boolean);
		return {unityVersion: assets.file.unityVersion.join('.'), meshes, textures, warnings};
	}

	/* ------------------------------------------------------------------ off the main thread */

	// Where this file was loaded from, so a worker can load it too (only for extension URLs).
	const SCRIPT_URL = typeof document !== 'undefined' && document.currentScript && /^(chrome|moz)-extension:/.test(document.currentScript.src) ? document.currentScript.src : '';

	const workerSource = url =>
		'importScripts(' + JSON.stringify(url) + ');\n' +
		'onmessage = function (e) {\n' +
		'\ttry {\n' +
		'\t\tvar r = self.BLP.unitySaber.read(e.data);\n' +
		'\t\tvar buffers = new Set();\n' +
		'\t\tvar add = function (a) { if (a && a.buffer) buffers.add(a.buffer); };\n' +
		'\t\t[r.left, r.right].forEach(function (side) { side.parts.forEach(function (p) { [p.positions, p.normals, p.uvs, p.colors, p.indices].forEach(add); }); });\n' +
		'\t\tr.textures.forEach(function (t) { add(t.data); });\n' +
		'\t\tpostMessage({ok: true, result: r}, Array.from(buffers));\n' +
		'\t} catch (err) {\n' +
		'\t\tpostMessage({ok: false, error: String((err && err.message) || err)});\n' +
		'\t}\n' +
		'};\n';

	/**
	 * read() in a Web Worker when the page allows it, so a large file doesn't freeze the replay
	 * while it decompresses; otherwise on the main thread. Resolves with `parsedIn` set to
	 * "worker" or "main".
	 */
	function readAsync(buffer) {
		const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		return new Promise((resolve, reject) => {
			const onMain = () =>
				setTimeout(() => {
					try {
						resolve(Object.assign(read(bytes), {parsedIn: 'main'}));
					} catch (e) {
						reject(e);
					}
				}, 0);
			if (!SCRIPT_URL || typeof Worker === 'undefined' || typeof Blob === 'undefined') return onMain();
			let worker = null;
			let url = null;
			let settled = false;
			const finish = fn => {
				if (settled) return;
				settled = true;
				if (worker) worker.terminate();
				if (url) URL.revokeObjectURL(url);
				fn();
			};
			try {
				url = URL.createObjectURL(new Blob([workerSource(SCRIPT_URL)], {type: 'text/javascript'}));
				worker = new Worker(url);
			} catch (e) {
				return finish(onMain); // e.g. the page's CSP forbids blob: workers
			}
			worker.onmessage = e => {
				const d = e.data || {};
				if (d.ok) finish(() => resolve(Object.assign(d.result, {parsedIn: 'worker'})));
				else finish(() => reject(new Error(d.error || 'Could not read this .saber')));
			};
			worker.onerror = ev => {
				if (ev && ev.preventDefault) ev.preventDefault();
				finish(onMain); // the worker could not start or load this script
			};
			worker.postMessage(bytes.slice().buffer); // a copy: the caller keeps its buffer
		});
	}

	BLP.unitySaber = {read, readAsync, inspect, readBundle, lz4, lzma, primitive};
})(typeof globalThis !== 'undefined' ? globalThis : this);
