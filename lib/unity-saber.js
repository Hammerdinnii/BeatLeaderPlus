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
 *               Material, Texture2D, and the saber's descriptor (name, author)
 *   textures    RGBA/RGB/Alpha8/565/4444 and DXT1/DXT5/BC4/BC5; other formats fall back to the
 *               material color and are listed in `warnings`
 *
 * read(arrayBuffer) returns plain arrays ready for three.js, already placed in the space of the
 * replayer's .saberContainer (blade from the hilt towards -Y):
 *
 *   {name, author, warnings, materials, textures,
 *    left: {parts: [{positions, normals, uvs, colors, indices, groups: [{start, count, material}]}]},
 *    right: {…}}
 *
 * Everything here is plain JavaScript with no DOM access, so it also runs in Node for tests.
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
		return {version, unityVersion: parseVersion(unityVersion), typeTree, bytes, little: !big, objects, fileSize, metadataSize};
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
				if (format.name === 'DXT1') decodeColorBlock(src, at, out, w, h, bx, by, true);
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

	function readMaterial(assets, mat, textureIndex) {
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
		return {name: mat.m_Name || '', color, texture, repeat, offset, saberColor, glow, transparent: color[3] < 0.999};
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
		const materials = [];
		const materialByPath = new Map();
		const materialIndex = pptr => {
			const key = pptr ? pptr.m_FileID + ':' + pptr.m_PathID : 'none';
			if (materialByPath.has(key)) return materialByPath.get(key);
			const mat = assets.ref(pptr);
			const index = materials.push(mat && mat.__classID === 21 ? readMaterial(assets, mat, textureIndex) : {name: '', color: [1, 1, 1, 1], texture: -1, repeat: [1, 1], offset: [0, 0], saberColor: false, transparent: false}) - 1;
			materialByPath.set(key, index);
			return index;
		};
		const meshCache = new Map();
		const meshOf = pptr => {
			const key = pptr ? pptr.m_PathID : 0;
			if (!meshCache.has(key)) {
				const m = assets.ref(pptr);
				meshCache.set(key, m && m.__classID === 43 ? decodeMesh(assets, m, warnings) : null);
			}
			return meshCache.get(key);
		};

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

	BLP.unitySaber = {read, readAsync, inspect, readBundle, lz4, lzma};
})(typeof globalThis !== 'undefined' ? globalThis : this);
