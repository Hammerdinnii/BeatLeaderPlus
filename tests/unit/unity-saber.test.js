// Unit tests for lib/unity-saber.js (the .saber reader).
//
//   node --test tests/unit/
//
// The fixtures in tests/fixtures are .saber files written by tests/tools/make_saber.py with Unity's
// own type layouts for Unity 2018.1, 2019.4 and 2021.3, using LZMA, LZ4 and a separate .resS
// resource. Each comes with what UnityPy (an independent Unity asset reader) decodes from it.
// extras-*.saber adds built-in meshes, TextMeshPro and TextMesh text and unsupported parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../../lib/unity-saber.js'); // attaches BLP.unitySaber to globalThis, like the other lib files
const saber = globalThis.BLP.unitySaber;

const DIR = path.join(__dirname, '..', 'fixtures');
const load = f => ({name: f, bytes: new Uint8Array(fs.readFileSync(path.join(DIR, f))), expected: JSON.parse(fs.readFileSync(path.join(DIR, f.replace(/\.saber$/, '.expected.json')), 'utf8'))});
const fixtures = fs
	.readdirSync(DIR)
	.filter(f => /^saber-.*\.saber$/.test(f))
	.map(load);
const extras = load('extras-unity2021.3.saber');

const close = (a, b, tol, what) => {
	assert.equal(a.length, b.length, what + ': length');
	for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `${what}[${i}]: ${a[i]} vs ${b[i]}`);
};

function bounds(positions) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			min[k] = Math.min(min[k], positions[i + k]);
			max[k] = Math.max(max[k], positions[i + k]);
		}
	}
	return {min, max};
}

const near = (a, b) => Math.abs(a - b) < 1e-5;
const boxIs = (b, min, max) => min.every((v, k) => near(b.min[k], v)) && max.every((v, k) => near(b.max[k], v));

test('fixtures are present', () => assert.equal(fixtures.length, 3));

for (const fx of fixtures) {
	test(`${fx.name}: meshes decode like UnityPy`, () => {
		const info = saber.inspect(fx.bytes);
		assert.equal(info.unityVersion, fx.expected.unity.replace(/f\d+$/, ''));
		assert.deepEqual(info.warnings, []);
		const names = info.meshes.map(m => m.name).sort();
		assert.deepEqual(names, Object.keys(fx.expected.meshes).sort());
		for (const mesh of info.meshes) {
			const ref = fx.expected.meshes[mesh.name];
			assert.equal(mesh.vertexCount, ref.vertexCount);
			close(mesh.positions, ref.positions, 1e-6, mesh.name + ' positions');
			close(mesh.normals, ref.normals, 1e-6, mesh.name + ' normals');
			close(mesh.uvs, ref.uvs, 1e-4, mesh.name + ' uvs');
			// UnityPy reports 8-bit colors as 0–255; the reader normalises them for three.js.
			const refColors = ref.colors.some(c => c > 1) ? ref.colors.map(c => c / 255) : ref.colors;
			close(mesh.colors, refColors, 1e-6, mesh.name + ' colors');
			const refTriangles = ref.submeshes.map((sub, k) => sub.map(i => i + (ref.baseVertex[k] || 0)));
			assert.deepEqual(mesh.submeshes.map(s => Array.from(s)), refTriangles, mesh.name + ' triangles');
		}
	});

	test(`${fx.name}: textures decode like UnityPy`, () => {
		const info = saber.inspect(fx.bytes);
		assert.deepEqual(info.textures.map(t => t.name).sort(), Object.keys(fx.expected.textures).sort());
		for (const tex of info.textures) {
			const ref = fx.expected.textures[tex.name];
			assert.equal(tex.width, ref.width);
			assert.equal(tex.height, ref.height);
			// DXT endpoint interpolation may round differently by a step.
			close(tex.data, Buffer.from(ref.rgba, 'base64'), 3, tex.name);
		}
	});

	test(`${fx.name}: sabers placed in the replayer's saber space`, () => {
		const s = saber.read(fx.bytes);
		assert.equal(s.name, fx.expected.descriptor.name);
		assert.equal(s.author, fx.expected.descriptor.author);
		assert.deepEqual(s.warnings, []);

		// LeftSaber: blade + handle (the inactive "EventGlow" is skipped). RightSaber: blade only
		// (its handle renderer is disabled).
		assert.deepEqual(s.left.parts.map(p => p.name), ['BladeMesh', 'HandleMesh']);
		assert.deepEqual(s.right.parts.map(p => p.name), ['BladeMesh']);

		// Blade: Unity x∈[-0.02,0.02] y∈[-0.01,0.03] z∈[0,1] → (-x, -z, y). The root's own offset
		// is ignored, as in the game.
		const blade = bounds(s.left.parts[0].positions);
		assert.ok(boxIs(blade, [-0.02, -1, -0.01], [0.02, 0, 0.03]), JSON.stringify(blade));
		const rightBlade = bounds(s.right.parts[0].positions);
		assert.ok(boxIs(rightBlade, [-0.02, -1.1, -0.01], [0.02, 0, 0.03]), JSON.stringify(rightBlade));
		// Handle: rotated 90° about Unity Z, moved 5 cm back → sits on the +Y (grip) side.
		const handle = bounds(s.left.parts[1].positions);
		assert.ok(boxIs(handle, [-0.015, 0.05, -0.03], [0.015, 0.25, 0.03]), JSON.stringify(handle));

		// Submeshes keep their own materials.
		const handleGroups = s.left.parts[1].groups;
		assert.equal(handleGroups.length, 2);
		assert.deepEqual(handleGroups.map(g => s.materials[g.material].name), ['Handle', 'Accent']);
		const mat = name => s.materials.find(m => m.name === name);
		assert.equal(mat('BladeLeft').saberColor, true, '_CustomColors = 1');
		assert.equal(mat('BladeRight').saberColor, true, 'no _CustomColors, _Glow > 0');
		assert.equal(mat('Handle').saberColor, false, '_CustomColors = 0 wins over _Glow');
		// Alpha alone doesn't make a part see-through: saber shaders use it for glow.
		assert.equal(mat('Accent').transparent, false);
		assert.equal(mat('Accent').blend, 'opaque');
		// Bloom amount: the larger of _Glow and _Bloom, also for parts in their own color.
		assert.equal(mat('BladeLeft').glow, 1);
		assert.ok(Math.abs(mat('BladeRight').glow - 0.8) < 1e-6);
		assert.equal(mat('Handle').glow, 1);
		assert.equal(mat('Accent').glow, 0);
		assert.equal(s.textures[mat('BladeLeft').texture].name, 'BladeTex');

		// Winding: after the mirror, every triangle must face the way its vertex normals point.
		for (const part of [...s.left.parts, ...s.right.parts]) {
			const p = part.positions;
			const n = part.normals;
			for (let i = 0; i < part.indices.length; i += 3) {
				const [a, b, c] = [part.indices[i], part.indices[i + 1], part.indices[i + 2]];
				const e1 = [0, 1, 2].map(k => p[b * 3 + k] - p[a * 3 + k]);
				const e2 = [0, 1, 2].map(k => p[c * 3 + k] - p[a * 3 + k]);
				const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
				const dot = cross[0] * n[a * 3] + cross[1] * n[a * 3 + 1] + cross[2] * n[a * 3 + 2];
				assert.ok(dot > 0, `${part.name} triangle ${i / 3} faces inwards`);
			}
		}
	});
}

test('readAsync falls back to the main thread outside a page', async () => {
	const r = await saber.readAsync(fixtures[0].bytes);
	assert.equal(r.parsedIn, 'main');
	assert.equal(r.left.parts.length, 2);
	await assert.rejects(saber.readAsync(new Uint8Array([1, 2, 3])), /Not a Unity asset bundle/);
});

test('rejects files that are not asset bundles', () => {
	assert.throws(() => saber.read(new TextEncoder().encode('not a saber at all')), /Not a Unity asset bundle/);
	assert.throws(() => saber.read(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])), /\.zip archive/);
});

test('truncated files fail with an error instead of hanging', () => {
	const bytes = fixtures[1].bytes;
	for (const cut of [40, 120, bytes.length >> 1, bytes.length - 3]) assert.throws(() => saber.read(bytes.subarray(0, cut)));
});

/* ------------------------------------------------------------------ extras */

const partNamed = (side, name) => side.parts.find(p => p.name === name);

test('extras: Unity built-in meshes are rebuilt (the stick is a built-in Cylinder)', () => {
	const s = saber.read(extras.bytes);
	const stick = partNamed(s.left, 'Cylinder');
	assert.ok(stick, s.left.parts.map(p => p.name).join(', '));
	// Unity's Cylinder: radius 0.5, height 2, scaled (0.03, 0.1, 0.03) and 10 cm back along Unity Z,
	// so Unity x∈[-0.015,0.015] y∈[-0.1,0.1] z∈[-0.115,-0.085] → (-x, -z, y).
	assert.ok(boxIs(bounds(stick.positions), [-0.015, 0.085, -0.1], [0.015, 0.115, 0.1]), JSON.stringify(bounds(stick.positions)));
	// Its built-in Default-Material isn't in the file either: plain white.
	assert.deepEqual(s.materials[stick.groups[0].material].color, [1, 1, 1, 1]);
	// A mesh from another file can't be loaded and says so.
	assert.ok(s.warnings.some(w => /another file \(archive:\/CAB-other/.test(w)), s.warnings.join('\n'));
	assert.equal(s.left.parts.length, 4); // blade, handle, stick, text
});

test('built-in primitives match Unity sizes and face outwards', () => {
	const sizes = {
		Cube: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
		Cylinder: [[-0.5, -1, -0.5], [0.5, 1, 0.5]],
		Sphere: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
		Capsule: [[-0.5, -1, -0.5], [0.5, 1, 0.5]],
		Plane: [[-5, 0, -5], [5, 0, 5]],
		Quad: [[-0.5, -0.5, 0], [0.5, 0.5, 0]],
	};
	for (const [kind, [min, max]] of Object.entries(sizes)) {
		const m = saber.primitive(kind);
		assert.ok(boxIs(bounds(m.positions), min, max), kind + ' ' + JSON.stringify(bounds(m.positions)));
		assert.equal(m.uvs.length / 2, m.vertexCount);
		const p = m.positions;
		const n = m.normals;
		const tri = m.submeshes[0];
		for (let i = 0; i < tri.length; i += 3) {
			const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
			const e1 = [0, 1, 2].map(k => p[b * 3 + k] - p[a * 3 + k]);
			const e2 = [0, 1, 2].map(k => p[c * 3 + k] - p[a * 3 + k]);
			const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
			const area = Math.hypot(...cross);
			if (area < 1e-9) continue; // the rings at a sphere's poles
			const dot = [a, b, c].reduce((d, v) => d + cross[0] * n[v * 3] + cross[1] * n[v * 3 + 1] + cross[2] * n[v * 3 + 2], 0);
			assert.ok(dot > 0, `${kind} triangle ${i / 3} faces inwards`);
		}
		// Normals point away from the center (all but the flat ones, which face +Y / -Z).
		if (kind !== 'Plane' && kind !== 'Quad') {
			for (let v = 0; v < m.vertexCount; v++) assert.ok(p[v * 3] * n[v * 3] + p[v * 3 + 1] * n[v * 3 + 1] + p[v * 3 + 2] * n[v * 3 + 2] > 0, `${kind} normal ${v}`);
		}
	}
	// The Quad faces -Z, towards a camera in front of it.
	assert.deepEqual(Array.from(saber.primitive('Quad').normals.subarray(0, 3)), [0, 0, -1]);
});

test('extras: TextMeshPro text is set from its font asset', () => {
	const s = saber.read(extras.bytes);
	const text = s.left.parts.find(p => p.text);
	assert.ok(text, 'no text part');
	assert.equal(text.name, 'Text "TILE+ HI!"');
	// "TILE+" and "HI" (the "\\n" typed as two characters is a line break, "!" isn't in the font):
	// 7 glyph quads.
	assert.equal(text.positions.length / 3, 28);
	assert.equal(text.indices.length, 42);
	assert.ok(s.warnings.includes('Text "TILE+ HI!": 1 character(s) are not in its font'), s.warnings.join('\n'));

	// Font size 2 in a 3D text: 2 / 16 pt × 0.1 = 0.0125 units per font unit. The glyph quads
	// include the atlas padding (4). Centered in its 2 × 0.5 rect; the rect sits 0.3 forward along
	// Unity Z (→ -Y here) and 0.05 up (→ +Z).
	const b = bounds(text.positions);
	assert.ok(boxIs(b, [-0.41875, -0.3, -0.1875], [0.40625, -0.3, 0.3375]), JSON.stringify(b));

	// The material: TextMeshPro's face color and outline, the atlas as its texture.
	const mat = s.materials[text.groups[0].material];
	assert.ok(mat.text, 'distance field material');
	assert.equal(mat.text.edge, 0.5);
	assert.ok(Math.abs(mat.text.outline - 0.08) < 1e-6); // _OutlineWidth 0.1 × _ScaleRatioA 0.8
	assert.deepEqual(mat.text.outlineColor, [0, 0, 0, 1]);
	assert.equal(s.textures[mat.texture].name, 'TestFont Atlas');

	// UVs: the first glyph ("T", atlas cell 0) spans x 5…15 and y 5…19 plus 4 of padding.
	const uv = Array.from(text.uvs.subarray(0, 8));
	close(uv, [1 / 128, 1 / 24, 1 / 128, 23 / 24, 19 / 128, 23 / 24, 19 / 128, 1 / 24], 1e-6, 'T uvs');
	// Colors: white, and the "+" (5th glyph) orange from its <color> tag.
	close(Array.from(text.colors.subarray(0, 4)), [1, 1, 1, 1], 1e-6, 'T color');
	close(Array.from(text.colors.subarray(16 * 4, 16 * 4 + 4)), [1, 0x80 / 255, 0, 1], 1e-6, '+ color');
});

test('extras: the atlas decodes like UnityPy (alpha)', () => {
	const info = saber.inspect(extras.bytes);
	const atlas = info.textures.find(t => t.name === 'TestFont Atlas');
	const ref = Buffer.from(extras.expected.textures['TestFont Atlas'].rgba, 'base64');
	// Alpha8: UnityPy leaves the color black, the reader white (so a material color shows).
	for (let i = 3; i < ref.length; i += 4) assert.equal(atlas.data[i], ref[i], 'alpha ' + (i >> 2));
});

test('extras: BC7 textures (every mode) decode like UnityPy', () => {
	const info = saber.inspect(extras.bytes);
	const tex = info.textures.find(t => t.name === 'BC7Tex');
	const ref = extras.expected.textures.BC7Tex;
	assert.ok(tex, info.warnings.join('\n'));
	assert.deepEqual([tex.width, tex.height], [ref.width, ref.height]);
	assert.deepEqual(Array.from(tex.data), Array.from(Buffer.from(ref.rgba, 'base64')));
});

test('extras: text that needs drawing and unsupported parts are listed', () => {
	const s = saber.read(extras.bytes);
	// The legacy TextMesh needs OffscreenCanvas, which Node doesn't have.
	assert.ok(s.warnings.includes('Text "BL+" is not shown: drawing text needs a browser'), s.warnings.join('\n'));
	assert.ok(s.warnings.includes('1 trail renderer(s) not shown (not supported yet)'), s.warnings.join('\n'));
	assert.deepEqual(s.right.parts.map(p => p.name), ['BladeMesh', 'Cube', 'Quad', 'Sphere', 'Capsule']);
});

test('extras: see-through only by render queue, render type or blend factors', () => {
	const s = saber.read(extras.bytes);
	const mat = name => s.materials.find(m => m.name === name);
	// Alpha 0 on a dark grip means "doesn't glow" in the game: still solid.
	assert.deepEqual([mat('DarkGrip').blend, mat('DarkGrip').transparent], ['opaque', false]);
	assert.deepEqual([mat('Glass').blend, mat('Glass').transparent], ['blend', true]); // render queue 3000
	assert.deepEqual([mat('Shine').blend, mat('Shine').transparent], ['additive', true]); // SrcAlpha + One
	assert.deepEqual([mat('Leaf').blend, mat('Leaf').transparent], ['cutout', false]); // RenderType TransparentCutout
	assert.ok(Math.abs(mat('Leaf').cutoff - 0.3) < 1e-6);
});

test('extras: legacy TextMesh is drawn where OffscreenCanvas exists', () => {
	// A stand-in canvas that records what is drawn.
	const drawn = [];
	globalThis.OffscreenCanvas = class {
		constructor(w, h) {
			this.width = w;
			this.height = h;
		}
		getContext() {
			const canvas = this;
			return {
				measureText: t => ({width: t.length * 40}),
				fillText: (t, x, y) => drawn.push({t, x, y, font: this.font}),
				getImageData: () => ({data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255)}),
				set font(f) {
					canvas.font = f;
				},
				get font() {
					return canvas.font;
				},
			};
		}
	};
	try {
		const s = saber.read(extras.bytes);
		const text = partNamed(s.right, 'Text "BL+"');
		assert.ok(text, s.right.parts.map(p => p.name).join(', '));
		assert.deepEqual(drawn.map(d => d.t), ['BL+']);
		assert.match(drawn[0].font, /^bold 64px/);
		// Yellow, from the TextMesh's Color32.
		assert.deepEqual(s.materials[text.groups[0].material].color, [1, 1, 0, 1]);
		// Anchored at its middle: centered on the object (10 cm back along Unity Z → +Y here).
		const b = bounds(text.positions);
		// (the canvas rounds its height up to whole pixels: 92.8 → 93)
		assert.ok(Math.abs(b.min[0] + b.max[0]) < 1e-6 && Math.abs(b.min[2] + b.max[2]) < 0.01, JSON.stringify(b));
		assert.ok(Math.abs(b.min[1] - 0.1) < 1e-6 && Math.abs(b.max[1] - 0.1) < 1e-6, JSON.stringify(b));
		// Character size 0.1 × font size 20 × 0.1: 0.2 units per em; the text is 120 px of 64 px em.
		assert.ok(Math.abs(b.max[0] - b.min[0] - (120 + 16) / 64 * 0.2) < 1e-6, JSON.stringify(b));
	} finally {
		delete globalThis.OffscreenCanvas;
	}
});
