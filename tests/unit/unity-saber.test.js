// Unit tests for lib/unity-saber.js (the .saber reader).
//
//   node --test tests/unit/
//
// The fixtures in tests/fixtures are .saber files written by tests/tools/make_saber.py with Unity's
// own type layouts for Unity 2018.1, 2019.4 and 2021.3, using LZMA, LZ4 and a separate .resS
// resource. Each comes with what UnityPy (an independent Unity asset reader) decodes from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../../lib/unity-saber.js'); // attaches BLP.unitySaber to globalThis, like the other lib files
const saber = globalThis.BLP.unitySaber;

const DIR = path.join(__dirname, '..', 'fixtures');
const fixtures = fs
	.readdirSync(DIR)
	.filter(f => f.endsWith('.saber'))
	.map(f => ({name: f, bytes: new Uint8Array(fs.readFileSync(path.join(DIR, f))), expected: JSON.parse(fs.readFileSync(path.join(DIR, f.replace(/\.saber$/, '.expected.json')), 'utf8'))}));

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
		assert.equal(mat('Accent').transparent, true);
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
