/*
 * BeatLeaderPlus – visual additions (PAGE world).
 *
 * Only what the replayer doesn't already offer. Saber colors, light / wall / bomb / background
 * colors, saber width, trail type and length, lasers / floor / lights and headset opacity all stay
 * in the replayer's own Settings menu; these additions build on them:
 *
 *   - note colors independent of saber colors (beat-generator colors), chain and arc colors
 *   - trail color, thickness (vertex shader patch) and brightness on top of the official trail
 *   - saber glow intensity and styles: neon, particle, custom GLTF/GLB/OBJ model
 *   - miss / bad-cut / bomb flashes, 3D mistake markers, hit particles
 *   - show / hide sabers, trails, notes, bombs, walls, arcs and chains (THREE layers, so the
 *     replayer's own visibility logic and object pools are never touched)
 *   - accuracy heat: notes tinted with the cut score they receive in this replay
 *
 * Controls live in Settings → BL+ (sections "Notes", "Sabers & trails", "Effects", "Show").
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('visuals')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	let ctx = null;
	let THREE = null;
	const OFFICIAL_SABER = {left: '#bf2121', right: '#335aff'};

	const st = {
		noteOverridden: false,
		trailTouched: false,
		models: {left: {key: '', url: '', el: null, objUrl: null}, right: {key: '', url: '', el: null, objUrl: null}},
		saberFiles: new Map(),
		dropTarget: 'both',
		dropBusy: false,
		dropError: '',
		storedModels: null,
		hiddenKeys: new Set(),
		beatsHidden: false,
		heatTinted: false,
		chainTinted: false,
		particles: null,
		markers: [],
		colorCache: new Map(),
		v1: null,
		v2: null,
	};

	const vis = () => R.settings.visuals;
	const sabers = () => ({left: ctx.leftSaber, right: ctx.rightSaber});

	function color(hex) {
		let c = st.colorCache.get(hex);
		if (!c) {
			c = new THREE.Color(hex);
			st.colorCache.set(hex, c);
			if (st.colorCache.size > 200) st.colorCache.clear();
		}
		return c;
	}

	const brighten = hex => U.mixColors(hex, '#ffffff', 0.35);

	/* ------------------------------------------------------------------ colors */

	/** The saber color currently set in the replayer's Colors tab. */
	function saberColor(hand) {
		const el = document.getElementById(hand + 'SaberColor');
		return el && U.isHexColor(el.value) ? el.value : OFFICIAL_SABER[hand];
	}
	R.saberColor = saberColor;

	/** Notes normally follow the saber colors; the override sets beat-generator's colors directly. */
	function applyNoteColors() {
		const bg = ctx.beatGenerator();
		if (!bg || !bg.colors) return;
		const n = vis().notes;
		if (R.active() && n.override) {
			bg.colors.left = n.left;
			bg.colors.right = n.right;
			st.noteOverridden = true;
		} else if (st.noteOverridden) {
			bg.colors.left = saberColor('left');
			bg.colors.right = saberColor('right');
			st.noteOverridden = false;
		}
	}

	function applyArcColor() {
		const n = vis().notes;
		if (!(R.active() && n.arcOverride)) return;
		const mats = ctx.materials();
		if (!mats) return;
		const c = color(n.arc);
		for (const k of ['splinematerialred', 'splinematerialblue']) {
			const m = mats[k];
			if (m && m.uniforms && m.uniforms.mainColor && !m.uniforms.mainColor.value.equals(c)) m.uniforms.mainColor.value = c.clone();
		}
	}

	/* ------------------------------------------------------------------ trails */

	function patchTrailShader(mat, width) {
		if (!mat || !mat.vertexShader) return;
		mat.userData = mat.userData || {};
		if (mat.userData.blpOrigVS === undefined) mat.userData.blpOrigVS = mat.vertexShader;
		if (!mat.userData.blpPatched) {
			const orig = mat.userData.blpOrigVS;
			if (!/float forward_offset\s*=/.test(orig)) return;
			mat.vertexShader = 'uniform float blpWidth;\n' + orig.replace(/float forward_offset\s*=[^;]+;/, 'float forward_offset = (1.0 - blpWidth) + blpWidth * uv.x;');
			mat.uniforms.blpWidth = {value: width};
			mat.userData.blpPatched = true;
			mat.needsUpdate = true;
		}
		mat.uniforms.blpWidth.value = width;
	}

	function unpatchTrailShader(mat) {
		if (!mat || !mat.userData || !mat.userData.blpPatched) return;
		mat.vertexShader = mat.userData.blpOrigVS;
		delete mat.uniforms.blpWidth;
		mat.userData.blpPatched = false;
		mat.needsUpdate = true;
	}

	/** Color, thickness and brightness on top of the official trail (type and length stay official). */
	function updateTrails() {
		const s = vis().sabers;
		const on = R.active() && s.trailOverride;
		if (!on && !st.trailTouched) return;
		for (const [hand, el] of Object.entries(sabers())) {
			const trail = el && el.components.trail;
			if (!trail || !trail.material) continue;
			if (on) {
				patchTrailShader(trail.material, U.clamp((Number(s.trailWidth) || 90) / 100, 0.05, 1));
				const c = color(s.trailMatchSaber ? saberColor(hand) : s[hand + 'TrailColor']);
				const o = Math.max(0, (Number(s.trailOpacity) || 0) / 100);
				const u = trail.material.uniforms.bladeColor;
				if (u) {
					u.value = {x: c.r * o, y: c.g * o, z: c.b * o, w: Math.min(1, o)};
					trail.material.uniformsNeedUpdate = true;
				}
			} else {
				unpatchTrailShader(trail.material);
				try {
					trail.updateColor();
				} catch (e) {
					/* trail not initialised */
				}
			}
		}
		st.trailTouched = on;
	}

	/* ------------------------------------------------------------------ saber styles & models */

	function setMaterialProp(el, prop, value) {
		if (!el || !el.components.material) return;
		if (el.components.material.data[prop] !== value) el.setAttribute('material', prop, value);
	}

	function applySaberStyle() {
		const s = vis().sabers;
		const on = R.active();
		const style = on ? s.style : 'default';
		const glow = on ? ((Number(s.glowIntensity) || 0) / 100) * (style === 'neon' ? 4 : 1) : 1;
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el) continue;
			setMaterialProp(el.querySelector('.saberglow'), 'opacity', U.round(U.clamp(0.08 * glow, 0, 1), 3));
			const bladeColor = style === 'neon' ? brighten(saberColor(hand)) : '#ffffff';
			const blade = el.querySelector('.blade');
			const cur = blade && blade.components.material ? String(blade.components.material.data.color).toLowerCase() : null;
			if (cur && cur !== bladeColor && !(bladeColor === '#ffffff' && cur === '#fff')) blade.setAttribute('material', 'color', bladeColor);
		}
		updateCustomModels();
	}

	/* ------------------------------------------------------------------ custom saber models */

	const MODEL_EXT = /\.(glb|gltf|obj|saber)$/i;
	const MAX_MODEL_BYTES = 32 * 1024 * 1024;
	// The replayer's saber, in its .saberContainer: a 1 m blade from the hilt towards -Y and a
	// 0.155 m handle towards +Y. Auto-fit maps a model onto that.
	const SABER_LENGTH = 1.155;
	const HANDLE_END = 0.155;
	const DEG = Math.PI / 180;

	function modelFormat(name) {
		return /\.saber(\?|#|$)/i.test(name) ? 'saber' : /\.obj(\?|#|$)/i.test(name) ? 'obj' : 'gltf';
	}

	const modelName = ref => (ref.startsWith('stored:') ? ref.slice(7) : ref.split(/[?#]/)[0].split('/').pop() || ref);

	function setDefaultSaberVisible(el, visible) {
		['.bladeContainer', '.saberHandle'].forEach(sel => {
			const part = el.querySelector(sel);
			if (part && part.object3D) part.object3D.visible = visible;
		});
	}

	/** Everything a loaded model depends on; when it changes the model is loaded again. */
	function modelKey(hand, s) {
		const url = String(s.customModel[hand] || '').trim();
		if (!url) return '';
		const m = s.customModel;
		const colored = m.tint || modelFormat(url) !== 'gltf';
		return [url, m.autoFit ? 1 : 0, m.unlit ? 1 : 0, m.tint ? 1 : 0, colored ? saberColor(hand) : ''].join('|');
	}

	const refreshModelUi = () => R.ui && R.ui.refresh();

	function updateCustomModels() {
		const s = vis().sabers;
		const want = R.active() && s.style === 'custom';
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el) continue;
			const slot = st.models[hand];
			const key = want ? modelKey(hand, s) : '';
			if (slot.key !== key) {
				// A-Frame entities override remove(), so detach through the parent.
				if (slot.el && slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
				if (slot.objUrl) URL.revokeObjectURL(slot.objUrl);
				Object.assign(slot, {key, url: key.split('|')[0], el: null, objUrl: null, loaded: false, state: key ? 'loading' : '', error: '', info: null});
				setDefaultSaberVisible(el, true);
				if (key) loadModel(hand, el, slot, key).catch(e => modelFailed(slot, key, e));
				refreshModelUi();
			}
			if (slot.el) {
				const m = s.customModel;
				slot.el.object3D.scale.setScalar(Number(m.scale) || 1);
				slot.el.object3D.rotation.set((Number(m.rotX) || 0) * DEG, (Number(m.rotY) || 0) * DEG, (Number(m.rotZ) || 0) * DEG);
				setDefaultSaberVisible(el, !(slot.loaded && m.hideDefault));
			}
		}
	}

	function modelFailed(slot, key, err) {
		if (slot.key !== key) return;
		slot.state = 'error';
		slot.error = String((err && err.message) || err);
		if (R.ui) R.ui.toast(slot.error, 'error');
		refreshModelUi();
	}

	/** The model file's bytes: from extension storage (stored:<name>) or a URL. */
	async function modelBytes(url) {
		if (url.startsWith('stored:')) {
			const data = await R.request('getSaberModel', {name: url.slice(7)}, 30000);
			return {name: data.name, mime: data.mime, data: data.data};
		}
		const res = await fetch(url);
		if (!res.ok) throw new Error(t('r.modelFailed', {name: modelName(url)}) + ' (HTTP ' + res.status + ')');
		return {name: modelName(url), data: await res.arrayBuffer()};
	}

	/** .saber files are parsed once and shared by both hands (they hold both sabers). */
	function parsedSaber(url) {
		let entry = st.saberFiles.get(url);
		if (!entry) {
			entry = modelBytes(url)
				.then(file => window.BLP.unitySaber.readAsync(file.data))
				.then(parsed => {
					R.log.debug('.saber parsed in', parsed.parsedIn, parsed.name);
					return parsed;
				});
			st.saberFiles.set(url, entry);
			entry.catch(() => st.saberFiles.delete(url));
			while (st.saberFiles.size > 2) st.saberFiles.delete(st.saberFiles.keys().next().value);
		}
		return entry;
	}

	async function loadModel(hand, saberEl, slot, key) {
		const url = slot.url;
		const m = vis().sabers.customModel;
		const container = saberEl.querySelector('.saberContainer') || saberEl;
		const ent = document.createElement('a-entity');
		ent.classList.add('blp-saber-model');
		const done = () => {
			slot.loaded = true;
			slot.state = 'loaded';
			updateCustomModels();
			refreshModelUi();
		};

		if (modelFormat(url) === 'saber') {
			const parsed = await parsedSaber(url);
			if (slot.key !== key) return;
			slot.info = {name: parsed.name, author: parsed.author, warnings: parsed.warnings};
			// Already placed in saber space by the reader: no auto-fit.
			ent.setObject3D('mesh', buildSaberObject(parsed, hand, m));
			container.appendChild(ent);
			slot.el = ent;
			return done();
		}

		let src = url;
		let name = modelName(url);
		if (url.startsWith('stored:')) {
			const file = await modelBytes(url);
			if (slot.key !== key) return;
			name = file.name;
			slot.objUrl = URL.createObjectURL(new Blob([file.data], {type: file.mime || 'application/octet-stream'}));
			src = slot.objUrl;
		}
		if (slot.key !== key) return; // settings changed while loading
		if (modelFormat(name) === 'obj') {
			// OBJ files carry no colors: use the saber color, flat like the replayer's own blade.
			ent.setAttribute('material', {shader: 'flat', color: saberColor(hand)});
			ent.setAttribute('obj-model', 'obj: url(' + src + ')');
		} else ent.setAttribute('gltf-model', 'url(' + src + ')');
		ent.addEventListener('model-loaded', () => {
			if (slot.key !== key) return;
			const mesh = ent.getObject3D('mesh');
			if (mesh) prepareModel(mesh, hand, m);
			done();
		});
		ent.addEventListener('model-error', () => modelFailed(slot, key, new Error(t('r.modelFailed', {name}))));
		container.appendChild(ent);
		slot.el = ent;
	}

	const isPowerOfTwo = n => n > 0 && (n & (n - 1)) === 0;

	/** three.js textures for a parsed .saber, created once per file. */
	function saberTextures(parsed) {
		if (!parsed.threeTextures) {
			parsed.threeTextures = parsed.textures.map(tex => {
				const tx = new THREE.DataTexture(tex.data, tex.width, tex.height, THREE.RGBAFormat);
				const pot = isPowerOfTwo(tex.width) && isPowerOfTwo(tex.height);
				// Unity stores rows bottom-up like WebGL, so no flip.
				tx.flipY = false;
				tx.wrapS = tx.wrapT = pot ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
				tx.magFilter = THREE.LinearFilter;
				tx.minFilter = pot ? THREE.LinearMipMapLinearFilter || THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
				tx.generateMipmaps = pot;
				tx.needsUpdate = true;
				return tx;
			});
		}
		return parsed.threeTextures;
	}

	/** One saber of a parsed .saber file as a three.js group. */
	function buildSaberObject(parsed, hand, m) {
		const side = parsed[hand] || parsed.left || parsed.right;
		const textures = saberTextures(parsed);
		const materials = parsed.materials.map(mat => {
			let map = mat.texture >= 0 ? textures[mat.texture] : null;
			if (map && (mat.repeat[0] !== 1 || mat.repeat[1] !== 1 || mat.offset[0] || mat.offset[1])) {
				map = map.clone();
				map.needsUpdate = true;
				map.repeat.set(mat.repeat[0], mat.repeat[1]);
				map.offset.set(mat.offset[0], mat.offset[1]);
			}
			// Materials marked for custom colors take the saber color, as in the game.
			const tint = mat.saberColor || m.tint;
			const params = {
				color: tint ? new THREE.Color(saberColor(hand)) : new THREE.Color(mat.color[0], mat.color[1], mat.color[2]),
				map,
				transparent: mat.transparent,
				opacity: mat.color[3],
				side: THREE.DoubleSide,
			};
			return m.unlit ? new THREE.MeshBasicMaterial(params) : new THREE.MeshStandardMaterial(Object.assign(params, {roughness: 0.6, metalness: 0.1}));
		});
		const group = new THREE.Group();
		for (const part of side.parts) {
			const geo = new THREE.BufferGeometry();
			setAttr(geo, 'position', new THREE.BufferAttribute(part.positions, 3));
			if (part.normals) setAttr(geo, 'normal', new THREE.BufferAttribute(part.normals, 3));
			if (part.uvs) setAttr(geo, 'uv', new THREE.BufferAttribute(part.uvs, 2));
			const small = part.positions.length / 3 < 65536;
			geo.setIndex(new THREE.BufferAttribute(small ? new Uint16Array(part.indices) : part.indices, 1));
			for (const g of part.groups) geo.addGroup(g.start, g.count, g.material);
			geo.computeBoundingSphere();
			const mesh = new THREE.Mesh(geo, materials);
			mesh.name = part.name;
			group.add(mesh);
		}
		return group;
	}

	function invert(matrix) {
		const r = new THREE.Matrix4();
		return typeof r.invert === 'function' ? r.copy(matrix).invert() : r.getInverse(matrix);
	}

	/** Bounding box of everything under `root`, in root's own coordinates. */
	function localBounds(root) {
		root.updateMatrixWorld(true);
		const toRoot = invert(root.matrixWorld);
		const box = new THREE.Box3();
		const part = new THREE.Box3();
		const m = new THREE.Matrix4();
		root.traverse(o => {
			if (!o.geometry) return;
			if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
			part.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(toRoot, o.matrixWorld));
			box.union(part);
		});
		if (box.isEmpty()) return null;
		const size = box.getSize(new THREE.Vector3());
		const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
		return {box, size, center: box.getCenter(new THREE.Vector3()), axis, length: size[axis]};
	}

	/**
	 * Scale and turn the model so its longest side runs along the blade. Saber models keep the grip
	 * at their origin, so the end nearest the origin goes to the hilt.
	 */
	function fitModel(mesh) {
		mesh.position.set(0, 0, 0);
		mesh.quaternion.set(0, 0, 0, 1);
		mesh.scale.set(1, 1, 1);
		const b = localBounds(mesh);
		if (!b || !(b.length > 0)) return;
		const sign = b.center[b.axis] < -0.05 * b.length ? -1 : 1;
		const dir = new THREE.Vector3();
		dir[b.axis] = sign;
		const q = new THREE.Quaternion().setFromUnitVectors(dir, new THREE.Vector3(0, -1, 0));
		const scale = SABER_LENGTH / b.length;
		const butt = b.center.clone();
		butt[b.axis] = sign > 0 ? b.box.min[b.axis] : b.box.max[b.axis];
		mesh.quaternion.copy(q);
		mesh.scale.setScalar(scale);
		mesh.position.set(0, HANDLE_END, 0).sub(butt.multiplyScalar(scale).applyQuaternion(q));
	}

	function prepareModel(mesh, hand, m) {
		if (m.unlit || m.tint) {
			const tint = m.tint ? new THREE.Color(saberColor(hand)) : null;
			const convert = mat => {
				let base = mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1);
				let map = mat.map || null;
				const em = mat.emissive;
				// Glowing sabers often keep their look in the emissive color over a dark base.
				if (m.unlit && em && em.r + em.g + em.b > 0.05 && base.r + base.g + base.b < 0.3) {
					base = em.clone();
					map = mat.emissiveMap || map;
				}
				if (tint) base = tint.clone();
				if (!m.unlit) {
					if (mat.color) mat.color.copy(base);
					return mat;
				}
				return new THREE.MeshBasicMaterial({
					color: base,
					map,
					transparent: mat.transparent,
					opacity: mat.opacity,
					side: mat.side,
					alphaTest: mat.alphaTest || 0,
					vertexColors: mat.vertexColors,
					skinning: !!mat.skinning,
				});
			};
			mesh.traverse(o => {
				if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
			});
		}
		if (m.autoFit) fitModel(mesh);
	}

	/* ------------------------------------------------------------------ model drop zone & preview */

	async function importModel(file) {
		const name = file.name || 'model';
		st.dropError = '';
		if (!MODEL_EXT.test(name)) st.dropError = t('r.modelUnsupported', {name});
		else if (file.size > MAX_MODEL_BYTES) st.dropError = t('r.modelTooBig', {name});
		if (st.dropError) return refreshModelUi();
		st.dropBusy = true;
		refreshModelUi();
		try {
			const res = await R.request('saveSaberModel', {name, data: await file.arrayBuffer()}, 30000);
			const customModel = {};
			if (st.dropTarget !== 'right') customModel.left = res.ref;
			if (st.dropTarget !== 'left') customModel.right = res.ref;
			st.storedModels = null;
			await R.patchSettings({visuals: {sabers: {style: 'custom', customModel}}});
		} catch (e) {
			st.dropError = String((e && e.message) || e);
		} finally {
			st.dropBusy = false;
			refreshModelUi();
		}
	}

	function pickModel() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.glb,.gltf,.obj,.saber';
		input.addEventListener('change', () => input.files && input.files[0] && importModel(input.files[0]));
		input.click();
	}

	function dropZone() {
		const ui = R.ui;
		const zone = ui.h(
			'div',
			{class: 'blp-r-drop' + (st.dropError ? ' blp-r-drop-error' : ''), tabindex: '0', role: 'button'},
			ui.h('div', {class: 'blp-r-drop-title'}, st.dropBusy ? t('r.modelSaving') : t('r.modelDrop')),
			ui.h('div', {class: 'blp-r-hint'}, st.dropError || t('r.modelFormats'))
		);
		// Keep drops away from the replayer's own drag-and-drop (it opens dropped replays and maps).
		const stop = e => {
			e.preventDefault();
			e.stopPropagation();
		};
		const over = e => {
			stop(e);
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			zone.classList.add('blp-r-drop-over');
		};
		zone.addEventListener('dragenter', over);
		zone.addEventListener('dragover', over);
		zone.addEventListener('dragleave', e => {
			stop(e);
			if (!zone.contains(e.relatedTarget)) zone.classList.remove('blp-r-drop-over');
		});
		zone.addEventListener('drop', e => {
			stop(e);
			zone.classList.remove('blp-r-drop-over');
			const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
			if (file) importModel(file);
		});
		zone.addEventListener('click', pickModel);
		zone.addEventListener('keydown', e => {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			stop(e);
			pickModel();
		});
		const shown = previewSource();
		if (shown) {
			zone.appendChild(previewCanvas());
			setTimeout(startPreview, 0);
		}
		return zone;
	}

	const preview = {canvas: null, renderer: null, scene: null, camera: null, spin: null, source: null, raf: 0};
	const PREVIEW_W = 220;
	const PREVIEW_H = 110;

	/** The loaded model shown in the drop zone (right saber first, like most saber previews). */
	function previewSource() {
		for (const hand of ['right', 'left']) {
			const slot = st.models[hand];
			const mesh = slot.loaded && slot.el && slot.el.getObject3D('mesh');
			if (mesh) return mesh;
		}
		return null;
	}

	function previewCanvas() {
		if (!preview.canvas) {
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			preview.canvas = document.createElement('canvas');
			preview.canvas.className = 'blp-r-model-preview';
			preview.canvas.width = PREVIEW_W * dpr;
			preview.canvas.height = PREVIEW_H * dpr;
		}
		return preview.canvas;
	}

	/** A copy of the model, laid along X and centered, turning around its own length. */
	function previewModel(mesh) {
		const copy = mesh.clone();
		copy.position.set(0, 0, 0);
		copy.quaternion.set(0, 0, 0, 1);
		copy.scale.set(1, 1, 1);
		const b = localBounds(copy);
		const outer = new THREE.Group();
		if (!b || !(b.length > 0)) return outer;
		const dir = new THREE.Vector3();
		dir[b.axis] = 1;
		const inner = new THREE.Group();
		copy.position.copy(b.center).negate();
		inner.add(copy);
		inner.quaternion.setFromUnitVectors(dir, new THREE.Vector3(1, 0, 0));
		inner.scale.setScalar(1 / b.length);
		outer.add(inner);
		return outer;
	}

	function drawPreview() {
		if (!preview.renderer) {
			try {
				preview.renderer = new THREE.WebGLRenderer({canvas: preview.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true});
			} catch (e) {
				return false;
			}
			preview.renderer.setPixelRatio(1);
			preview.renderer.setSize(preview.canvas.width, preview.canvas.height, false);
			preview.scene = new THREE.Scene();
			preview.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
			const light = new THREE.DirectionalLight(0xffffff, 0.8);
			light.position.set(1, 2, 3);
			preview.scene.add(light);
			preview.camera = new THREE.PerspectiveCamera(35, PREVIEW_W / PREVIEW_H, 0.01, 20);
			preview.camera.position.set(0, 0, 1.1);
		}
		const mesh = previewSource();
		if (preview.source !== mesh) {
			if (preview.spin) preview.scene.remove(preview.spin);
			preview.spin = mesh ? previewModel(mesh) : null;
			if (preview.spin) preview.scene.add(preview.spin);
			preview.source = mesh;
		}
		if (preview.spin) preview.spin.rotation.x = (performance.now() / 1000) * 0.9;
		preview.renderer.render(preview.scene, preview.camera);
		return true;
	}

	/** Runs while the drop zone is on screen; the next render of the section restarts it. */
	function startPreview() {
		if (preview.raf) return;
		const loop = () => {
			preview.raf = 0;
			const c = preview.canvas;
			if (!c || !c.isConnected || !c.offsetParent || !drawPreview()) return;
			preview.raf = requestAnimationFrame(loop);
		};
		preview.raf = requestAnimationFrame(loop);
	}

	async function loadStoredModels() {
		if (st.storedModels) return;
		st.storedModels = [];
		try {
			st.storedModels = await R.request('listSaberModels', {});
		} catch (e) {
			R.log.debug('stored models unavailable', e);
		}
		if (st.storedModels.length) refreshModelUi();
	}

	function renderModelControls(body) {
		const ui = R.ui;
		const m = vis().sabers.customModel;
		const target = v => ({value: v, label: t('r.modelTarget.' + v)});
		body.appendChild(ui.select(t('r.modelTarget'), ['both', 'left', 'right'].map(target), st.dropTarget, v => (st.dropTarget = v)));
		body.appendChild(dropZone());
		let warnings = null;
		for (const hand of ['left', 'right']) {
			const ref = String(m[hand] || '').trim();
			if (!ref) continue;
			const slot = st.models[hand];
			const status = slot.state === 'loading' ? ' · ' + t('r.modelLoading') : slot.state === 'error' ? ' · ' + slot.error : slot.state === 'loaded' ? ' · ' + t('r.modelLoaded') : '';
			// .saber files name themselves (and their author) in their descriptor.
			const info = slot.info;
			const label = info && info.name ? (info.author ? t('r.modelBy', {name: info.name, author: info.author}) : info.name) : modelName(ref);
			if (info && info.warnings.length && !warnings) warnings = info.warnings;
			body.appendChild(
				ui.row(
					ui.h('span', {class: 'blp-r-hint blp-r-inline blp-r-grow', title: ref}, t('common.' + hand) + ': ' + label + status),
					ui.button('✕', () => set('sabers.customModel.' + hand, ''), {title: t('r.modelRemove')})
				)
			);
		}
		if (warnings) body.appendChild(ui.hint(t('r.modelNote') + ' ' + warnings[0] + (warnings.length > 1 ? ' ' + t('r.modelMoreWarnings', {n: warnings.length - 1}) : '')));
		loadStoredModels();
		if (st.storedModels && st.storedModels.length) {
			const options = [{value: '', label: t('r.modelChoose')}].concat(st.storedModels.map(x => ({value: 'stored:' + x.name, label: x.name})));
			body.appendChild(
				ui.select(t('r.modelStored'), options, '', ref => {
					if (!ref) return;
					const customModel = {};
					if (st.dropTarget !== 'right') customModel.left = ref;
					if (st.dropTarget !== 'left') customModel.right = ref;
					R.patchSettings({visuals: {sabers: {customModel}}});
				})
			);
		}
		const path = k => 'sabers.customModel.' + k;
		body.appendChild(ui.toggle(t('f.visuals.sabers.customModel.autoFit'), m.autoFit, x => set(path('autoFit'), x), t('d.visuals.sabers.customModel.autoFit')));
		body.appendChild(ui.toggle(t('f.visuals.sabers.customModel.unlit'), m.unlit, x => set(path('unlit'), x), t('d.visuals.sabers.customModel.unlit')));
		body.appendChild(ui.toggle(t('f.visuals.sabers.customModel.tint'), m.tint, x => set(path('tint'), x)));
		body.appendChild(ui.toggle(t('f.visuals.sabers.customModel.hideDefault'), m.hideDefault, x => set(path('hideDefault'), x)));
		body.appendChild(ui.range(t('f.visuals.sabers.customModel.scale'), {min: 0.05, max: 5, step: 0.05, value: m.scale, unit: '×'}, x => set(path('scale'), x)));
		for (const axis of ['rotX', 'rotY', 'rotZ']) {
			body.appendChild(ui.range(t('f.visuals.sabers.customModel.' + axis), {min: -180, max: 180, step: 1, value: m[axis], unit: '°'}, x => set(path(axis), x)));
		}
	}

	/* ------------------------------------------------------------------ particles */

	function setAttr(geo, name, attr) {
		if (geo.setAttribute) geo.setAttribute(name, attr);
		else geo.addAttribute(name, attr);
	}

	/** Soft round sprite so particles render as glowing dots instead of squares. */
	function dotTexture() {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const g = c.getContext('2d');
		const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
		grad.addColorStop(0, 'rgba(255,255,255,1)');
		grad.addColorStop(0.3, 'rgba(255,255,255,0.85)');
		grad.addColorStop(1, 'rgba(255,255,255,0)');
		g.fillStyle = grad;
		g.fillRect(0, 0, 64, 64);
		return new THREE.CanvasTexture(c);
	}

	function createParticles(max) {
		const geo = new THREE.BufferGeometry();
		const positions = new Float32Array(max * 3);
		const colors = new Float32Array(max * 3);
		setAttr(geo, 'position', new THREE.BufferAttribute(positions, 3));
		setAttr(geo, 'color', new THREE.BufferAttribute(colors, 3));
		const mat = new THREE.PointsMaterial({
			size: 0.06,
			map: dotTexture(),
			vertexColors: THREE.VertexColors !== undefined ? THREE.VertexColors : true,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			sizeAttenuation: true,
		});
		const points = new THREE.Points(geo, mat);
		points.frustumCulled = false;
		points.renderOrder = 6;
		ctx.scene.object3D.add(points);
		const live = [];
		return {
			spawn(x, y, z, vx, vy, vz, c, life) {
				if (live.length >= max) live.shift();
				live.push({x, y, z, vx, vy, vz, r: c.r, g: c.g, b: c.b, life, max: life});
			},
			update(dt) {
				for (let i = live.length - 1; i >= 0; i--) {
					const p = live[i];
					p.life -= dt;
					if (p.life <= 0) {
						live.splice(i, 1);
						continue;
					}
					p.vy -= 1.8 * dt;
					p.vx *= 0.97;
					p.vz *= 0.97;
					p.x += p.vx * dt;
					p.y += p.vy * dt;
					p.z += p.vz * dt;
				}
				let n = 0;
				for (const p of live) {
					const f = p.life / p.max;
					positions[n * 3] = p.x;
					positions[n * 3 + 1] = p.y;
					positions[n * 3 + 2] = p.z;
					colors[n * 3] = p.r * f;
					colors[n * 3 + 1] = p.g * f;
					colors[n * 3 + 2] = p.b * f;
					n++;
				}
				geo.setDrawRange(0, n);
				geo.attributes.position.needsUpdate = true;
				geo.attributes.color.needsUpdate = true;
				points.visible = n > 0;
			},
			clear() {
				live.length = 0;
			},
		};
	}

	function bladePoints(el, outBase, outTip) {
		const bc = el.querySelector('.bladeContainer');
		const obj = (bc && bc.object3D) || el.object3D;
		obj.updateMatrixWorld();
		obj.localToWorld(outBase.set(0, 0, 0));
		obj.localToWorld(outTip.set(0, -1, 0));
	}

	function saberParticles(dt) {
		if (!(R.active() && vis().sabers.style === 'particle') || !R.api.isPlaying()) return;
		const per = Math.max(1, Math.round(5 * dt * 60));
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el || !el.object3D.visible) continue;
			bladePoints(el, st.v1, st.v2);
			const c = color(brighten(saberColor(hand)));
			for (let i = 0; i < per; i++) {
				const u = Math.random();
				st.particles.spawn(
					st.v1.x + (st.v2.x - st.v1.x) * u,
					st.v1.y + (st.v2.y - st.v1.y) * u,
					st.v1.z + (st.v2.z - st.v1.z) * u,
					(Math.random() - 0.5) * 0.4,
					(Math.random() - 0.2) * 0.4,
					(Math.random() - 0.5) * 0.4,
					c,
					0.25 + Math.random() * 0.2
				);
			}
		}
	}

	function heatColor(score) {
		const h = vis().accuracyHeat;
		if (!(score > 0)) return h.bad;
		if (score >= 115) return h.c115;
		if (score >= 110) return h.c110;
		if (score >= 105) return h.c105;
		if (score >= 100) return h.c100;
		return h.low;
	}
	R.heatColor = heatColor;

	function hitBurst(evt) {
		const fx = vis().effects;
		const heat = vis().accuracyHeat;
		const note = evt.note;
		if (!R.api.cutPointToScene(note, st.v1)) {
			const el = evt.hand === 1 ? ctx.rightSaber : ctx.leftSaber;
			if (!el) return;
			bladePoints(el, st.v2, st.v1);
			st.v1.lerp(st.v2, 0.3);
		}
		let hex;
		if (heat.enabled && heat.target !== 'notes') hex = heatColor(note.score);
		else if (fx.particleColorMode === 'custom') hex = fx.particleColor;
		else if (fx.particleColorMode === 'accuracy') hex = heatColor(note.score);
		else hex = brighten(saberColor(evt.hand === 1 ? 'right' : 'left'));
		const c = color(hex);
		const count = Math.round(14 * U.clamp((Number(fx.particleIntensity) || 100) / 100, 0.1, 4));
		const d = note.cutInfo && note.cutInfo.saberDir;
		const dir = d ? st.v2.set(d.x, d.y, -d.z).normalize() : st.v2.set(0, 0, 0);
		for (let i = 0; i < count; i++) {
			st.particles.spawn(
				st.v1.x,
				st.v1.y,
				st.v1.z,
				dir.x * 1.4 + (Math.random() - 0.5) * 2.2,
				dir.y * 1.4 + Math.random() * 1.6,
				dir.z * 1.4 + (Math.random() - 0.5) * 2.2,
				c,
				0.35 + Math.random() * 0.35
			);
		}
	}

	/* ------------------------------------------------------------------ flash & markers */

	function flash(hex) {
		let el = document.getElementById('blp-r-flash');
		if (!el) {
			el = document.createElement('div');
			el.id = 'blp-r-flash';
			el.className = 'blp-r-flash';
			document.body.appendChild(el);
		}
		const intensity = U.clamp((Number(vis().effects.flashIntensity) || 35) / 100, 0.05, 1);
		el.style.transition = 'none';
		el.style.background = `radial-gradient(ellipse at center, transparent 35%, ${U.withAlpha(hex, intensity)} 100%)`;
		el.style.opacity = '1';
		void el.offsetWidth;
		el.style.transition = 'opacity 0.45s ease-out';
		el.style.opacity = '0';
	}

	function notePosition(note, out) {
		const container = ctx.beatContainer;
		if (container) {
			for (const child of container.children) {
				const beat = child.components && child.components.beat;
				if (beat && beat.replayNote === note) return child.object3D.getWorldPosition(out);
			}
		}
		return R.api.cutPointToScene(note, out) || out.set(0, 1.2, -1);
	}

	function spawnMarker(note, hex) {
		const fx = vis().effects;
		if (!fx.markerStyle || fx.markerStyle === 'none') return;
		const pos = notePosition(note, new THREE.Vector3());
		pos.z = Math.min(pos.z, -0.4);
		const mat = new THREE.MeshBasicMaterial({color: color(hex), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide});
		const group = new THREE.Group();
		if (fx.markerStyle === 'ring') {
			group.add(new THREE.Mesh(new THREE.RingGeometry(0.17, 0.23, 40), mat));
		} else if (fx.markerStyle === 'cross') {
			const a = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.02), mat);
			const b = a.clone();
			a.rotation.z = Math.PI / 4;
			b.rotation.z = -Math.PI / 4;
			group.add(a, b);
		} else {
			const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3, 12), mat);
			p.position.y = 1.5 - pos.y;
			group.add(p);
		}
		group.position.copy(pos);
		group.renderOrder = 7;
		ctx.scene.object3D.add(group);
		const life = Number(fx.markerLifetime) || 1.5;
		st.markers.push({group, mat, life, max: life});
	}

	function updateMarkers(dt) {
		for (let i = st.markers.length - 1; i >= 0; i--) {
			const m = st.markers[i];
			m.life -= dt;
			const f = Math.max(0, m.life / m.max);
			m.mat.opacity = 0.95 * f;
			m.group.scale.setScalar(1 + (1 - f) * 0.4);
			if (m.life <= 0) {
				ctx.scene.object3D.remove(m.group);
				m.group.traverse(o => o.geometry && o.geometry.dispose());
				m.mat.dispose();
				st.markers.splice(i, 1);
			}
		}
	}

	function onNote(evt) {
		if (!R.active()) return;
		const fx = vis().effects;
		const kind = evt.kind;
		if (kind === 'good') {
			if (fx.hitParticles || (vis().accuracyHeat.enabled && vis().accuracyHeat.target !== 'notes')) hitBurst(evt);
			return;
		}
		const colorFor = {miss: fx.missColor, bad: fx.badCutColor, bomb: fx.bombColor}[kind];
		if (!colorFor) return;
		if ((kind === 'miss' && fx.missFlash) || (kind === 'bad' && fx.badCutFlash) || (kind === 'bomb' && fx.bombFlash)) flash(colorFor);
		spawnMarker(evt.note, colorFor);
	}

	/* ------------------------------------------------------------------ visibility (layers) */

	function setHidden(obj, hidden) {
		obj.traverse(o => {
			const ud = o.userData;
			if (hidden) {
				if (ud.__blpMask === undefined) ud.__blpMask = o.layers.mask;
				o.layers.mask = 0;
			} else if (ud.__blpMask !== undefined) {
				o.layers.mask = ud.__blpMask;
				delete ud.__blpMask;
			}
		});
	}

	function hideKey(key, objects, hidden) {
		if (!hidden && !st.hiddenKeys.has(key)) return;
		for (const o of objects) if (o) setHidden(o, hidden);
		if (hidden) st.hiddenKeys.add(key);
		else st.hiddenKeys.delete(key);
	}

	function beatCategory(el) {
		const c = el.components;
		if (!c) return null;
		if (c.beat) {
			const type = c.beat.data.type;
			if (type === 'mine') return 'bombs';
			if (type === 'sliderhead' || type === 'sliderchain') return 'chains';
			return 'notes';
		}
		if (c.wall) return 'walls';
		if (c.slider) return 'arcs';
		return null;
	}

	function updateVisibility() {
		const v = vis().visibility;
		const on = R.active();
		const hide = key => on && v[key] === false;
		const s = sabers();
		const map = ctx.scene.object3DMap || {};

		hideKey('leftSaber', [s.left && s.left.object3D], hide('leftSaber'));
		hideKey('rightSaber', [s.right && s.right.object3D], hide('rightSaber'));
		hideKey('trailLeft', [map.trail__left], hide('trails') || hide('leftSaber'));
		hideKey('trailRight', [map.trail__right], hide('trails') || hide('rightSaber'));

		const beatTypes = ['notes', 'bombs', 'chains', 'walls', 'arcs'].filter(hide);
		const container = ctx.beatContainer;
		if (container && (beatTypes.length || st.beatsHidden)) {
			for (const child of container.children) {
				const cat = beatCategory(child);
				if (cat) setHidden(child.object3D, beatTypes.includes(cat));
			}
			st.beatsHidden = beatTypes.length > 0;
		}
	}

	/* ------------------------------------------------------------------ accuracy heat & chain tint */

	function tintBeat(beat, hex) {
		const blockEl = beat.blockEl;
		if (!blockEl || blockEl.materialToReset) return false;
		const mesh = blockEl.getObject3D && blockEl.getObject3D('mesh');
		if (!mesh || !mesh.material || !mesh.material.color) return false;
		const c = color(hex);
		mesh.material.color.copy(c);
		if (mesh.material.emissive) mesh.material.emissive.copy(c);
		return true;
	}

	function updateBeatTints() {
		const container = ctx.beatContainer;
		if (!container) return;
		const heat = vis().accuracyHeat;
		const n = vis().notes;
		const heatOn = R.active() && heat.enabled && heat.target !== 'particles';
		const chainOn = R.active() && n.chainOverride;
		if (!heatOn && !chainOn && !st.heatTinted && !st.chainTinted) return;
		for (const child of container.children) {
			const beat = child.components && child.components.beat;
			if (!beat || beat.data.type === 'mine') continue;
			const isChain = beat.data.type === 'sliderchain' || beat.data.type === 'sliderhead';
			let hex = null;
			if (heatOn && beat.replayNote && beat.replayNote.score !== undefined) hex = heatColor(beat.replayNote.score);
			else if (chainOn && isChain) hex = n.chain;
			if (hex) {
				if (child.__blpTintNote !== beat.replayNote || child.__blpTintKey !== hex) {
					if (tintBeat(beat, hex)) {
						child.__blpTintNote = beat.replayNote;
						child.__blpTintKey = hex;
					}
				}
			} else if (child.__blpTintKey) {
				tintBeat(beat, beat.data[beat.data.color] || '#ffffff');
				child.__blpTintKey = '';
				child.__blpTintNote = null;
			}
		}
		st.heatTinted = heatOn;
		st.chainTinted = chainOn;
	}

	/* ------------------------------------------------------------------ Settings → BL+ sections */

	const set = (path, value) => R.setPath('visuals.' + path, value);

	function renderNotes(body) {
		const ui = R.ui;
		const n = vis().notes;
		body.appendChild(ui.toggle(t('f.visuals.notes.override'), n.override, x => set('notes.override', x)));
		if (n.override) body.appendChild(ui.row(ui.color(t('common.left'), n.left, x => set('notes.left', x)), ui.color(t('common.right'), n.right, x => set('notes.right', x))));
		body.appendChild(ui.toggle(t('f.visuals.notes.chainOverride'), n.chainOverride, x => set('notes.chainOverride', x)));
		if (n.chainOverride) body.appendChild(ui.color(t('f.visuals.notes.chain'), n.chain, x => set('notes.chain', x)));
		body.appendChild(ui.toggle(t('f.visuals.notes.arcOverride'), n.arcOverride, x => set('notes.arcOverride', x)));
		if (n.arcOverride) body.appendChild(ui.color(t('f.visuals.notes.arc'), n.arc, x => set('notes.arc', x)));
		body.appendChild(ui.toggle(t('f.visuals.accuracyHeat.enabled'), vis().accuracyHeat.enabled, x => set('accuracyHeat.enabled', x), t('d.visuals.accuracyHeat.enabled')));
	}

	function renderSabers(body) {
		const ui = R.ui;
		const s = vis().sabers;
		body.appendChild(
			ui.select(
				t('f.visuals.sabers.style'),
				['default', 'neon', 'particle', 'custom'].map(v => ({value: v, label: t('saber.style.' + v)})),
				s.style,
				x => set('sabers.style', x)
			)
		);
		if (s.style === 'custom') renderModelControls(body);
		body.appendChild(ui.range(t('f.visuals.sabers.glowIntensity'), {min: 0, max: 600, step: 10, value: s.glowIntensity, unit: '%'}, x => set('sabers.glowIntensity', x)));
		body.appendChild(ui.toggle(t('f.visuals.sabers.trailOverride'), s.trailOverride, x => set('sabers.trailOverride', x)));
		if (s.trailOverride) {
			body.appendChild(ui.toggle(t('f.visuals.sabers.trailMatchSaber'), s.trailMatchSaber, x => set('sabers.trailMatchSaber', x)));
			if (!s.trailMatchSaber) body.appendChild(ui.row(ui.color(t('common.left'), s.leftTrailColor, x => set('sabers.leftTrailColor', x)), ui.color(t('common.right'), s.rightTrailColor, x => set('sabers.rightTrailColor', x))));
			body.appendChild(ui.range(t('f.visuals.sabers.trailWidth'), {min: 10, max: 100, step: 1, value: s.trailWidth, unit: '%'}, x => set('sabers.trailWidth', x)));
			body.appendChild(ui.range(t('f.visuals.sabers.trailOpacity'), {min: 0, max: 200, step: 5, value: s.trailOpacity, unit: '%'}, x => set('sabers.trailOpacity', x)));
		}
	}

	function renderEffects(body) {
		const ui = R.ui;
		const fx = vis().effects;
		body.appendChild(ui.toggle(t('f.visuals.effects.missFlash'), fx.missFlash, x => set('effects.missFlash', x)));
		body.appendChild(ui.toggle(t('f.visuals.effects.badCutFlash'), fx.badCutFlash, x => set('effects.badCutFlash', x)));
		body.appendChild(ui.toggle(t('f.visuals.effects.bombFlash'), fx.bombFlash, x => set('effects.bombFlash', x)));
		body.appendChild(
			ui.select(
				t('f.visuals.effects.markerStyle'),
				['none', 'ring', 'cross', 'pillar'].map(v => ({value: v, label: t('marker.' + v)})),
				fx.markerStyle,
				x => set('effects.markerStyle', x)
			)
		);
		body.appendChild(ui.toggle(t('f.visuals.effects.hitParticles'), fx.hitParticles, x => set('effects.hitParticles', x)));
	}

	function renderVisibility(body) {
		const ui = R.ui;
		const v = vis().visibility;
		const grid = ui.h('div', {class: 'blp-r-grid'});
		for (const key of Object.keys(v)) grid.appendChild(ui.toggle(t('f.visuals.visibility.' + key), v[key], x => set('visibility.' + key, x)));
		body.appendChild(grid);
	}

	/* ------------------------------------------------------------------ module */

	R.register({
		name: 'visuals',
		init(c) {
			ctx = c;
			THREE = c.THREE;
			st.v1 = new THREE.Vector3();
			st.v2 = new THREE.Vector3();
			st.particles = createParticles(1500);
			R.on('note', onNote);
			// Saber color changes in the replayer reset beat-generator's colors; re-apply ours after.
			['colorChanged', 'colorReset', 'colorsFetched'].forEach(ev => c.scene.addEventListener(ev, () => setTimeout(applyNoteColors, 0)));
			R.addHotkey('toggleHeat', () => {
				const on = !vis().accuracyHeat.enabled;
				R.setPath('visuals.accuracyHeat.enabled', on);
				R.api.notify(t(on ? 'r.heatOn' : 'r.heatOff'), 'fas fa-fire');
			});
			R.ui.addSettingsSection({id: 'notes', order: 10, title: () => t('r.sect.notes'), render: renderNotes});
			R.ui.addSettingsSection({id: 'sabers', order: 20, title: () => t('r.sect.sabers'), render: renderSabers});
			R.ui.addSettingsSection({id: 'effects', order: 30, title: () => t('r.sect.effects'), render: renderEffects});
			R.ui.addSettingsSection({id: 'visibility', order: 40, title: () => t('r.sect.visibility'), render: renderVisibility});
		},
		onSettings() {
			if (!ctx) return;
			applyNoteColors();
			applySaberStyle();
			if (!R.active()) {
				// Ticks stop while disabled, so restore everything right away.
				updateTrails();
				updateVisibility();
				updateBeatTints();
				st.particles.clear();
				st.particles.update(0);
				updateMarkers(1e9);
			}
		},
		onReplay() {
			applyNoteColors();
			st.particles.clear();
		},
		tick(frame) {
			updateTrails();
			updateVisibility();
			updateBeatTints();
			applyArcColor();
			saberParticles(frame.dt);
			st.particles.update(frame.dt);
			updateMarkers(frame.dt);
		},
		maintain() {
			applyNoteColors();
			applySaberStyle();
		},
	});
})();
