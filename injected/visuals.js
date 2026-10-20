/*
 * BeatLeaderPlus – replay visuals (PAGE world).
 *
 *   - saber colors (through the replayer's own `colorChanged` event so trails, handles and glow
 *     follow), independent note colors (beat-generator colors), bomb / chain / arc colors
 *   - trail color, length, thickness (vertex shader patch) and opacity
 *   - saber styles: thin, thick, neon, particle, custom GLTF/GLB/OBJ models
 *   - environment colors (official color settings + `colors.updateColors()`)
 *   - miss / bad-cut / bomb flashes, 3D mistake markers, slow-motion bursts, hit particles
 *   - visibility switches implemented with THREE layers (object.layers.mask = 0) so the
 *     replayer's own `visible` logic and object pools are never disturbed
 *   - accuracy heat: notes are tinted with the cut score they receive in this replay
 *
 * Changes to the official settings object are kept in memory only: settings.sync() is wrapped so
 * BLP overrides are never written into the replayer's own localStorage settings.
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
	const STAGE = {
		lasers: ['#leftStageLasers', '#rightStageLasers', '[beams]'],
		lighting: ['#lightFixture', '#stageadditiveobj', '#glowContainer'],
		floor: ['#floor'],
		environment: ['#stageObj', '#twister', '#audioColumns', '#substage', '#smoke'],
	};

	const st = {
		applied: {left: null, right: null},
		noteOverridden: false,
		official: {}, // key -> original value of official settings we overrode
		trailTouched: false,
		models: {left: {url: '', el: null, objUrl: null}, right: {url: '', el: null, objUrl: null}},
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

	/* ------------------------------------------------------------------ official settings overrides */

	function officialSettings() {
		const os = ctx.officialSettings();
		return os && os.settings ? os : null;
	}

	function setOfficial(key, value) {
		const os = officialSettings();
		if (!os) return;
		if (!(key in st.official)) st.official[key] = os.settings[key];
		os.settings[key] = value;
	}

	function restoreOfficial(keys) {
		const os = officialSettings();
		if (!os) return;
		for (const key of keys) {
			if (key in st.official) {
				os.settings[key] = st.official[key];
				delete st.official[key];
			}
		}
	}

	function wrapOfficialSync() {
		const os = officialSettings();
		if (!os || os.__blpSyncWrapped) return;
		const orig = os.sync;
		os.sync = function (...args) {
			const swapped = {};
			for (const key of Object.keys(st.official)) {
				swapped[key] = os.settings[key];
				os.settings[key] = st.official[key];
			}
			try {
				return orig.apply(this, args);
			} finally {
				for (const key of Object.keys(swapped)) os.settings[key] = swapped[key];
			}
		};
		os.__blpSyncWrapped = true;
	}

	/* ------------------------------------------------------------------ colors */

	function officialSaberColor(hand) {
		const el = document.getElementById(hand + 'SaberColor');
		return el && U.isHexColor(el.value) ? el.value : OFFICIAL_SABER[hand];
	}

	function saberColor(hand) {
		const s = vis().sabers;
		return R.active() && s.override ? s[hand + 'Color'] : officialSaberColor(hand);
	}
	R.saberColor = saberColor;

	function applySaberColors(force) {
		const s = vis().sabers;
		const on = R.active() && s.override;
		for (const hand of ['left', 'right']) {
			if (on) {
				const desired = s[hand + 'Color'];
				if (force || st.applied[hand] !== desired) {
					st.applied[hand] = desired;
					ctx.scene.emit('colorChanged', {hand, color: desired}, null);
				}
			} else if (st.applied[hand]) {
				st.applied[hand] = null;
				ctx.scene.emit('colorChanged', {hand, color: officialSaberColor(hand)}, null);
			}
		}
		applyNoteColors();
	}

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

	function applyBombColor() {
		const n = vis().notes;
		const mats = ctx.materials();
		if (R.active() && n.bombOverride) {
			setOfficial('bombColor', n.bomb);
			if (mats) ['mineMaterialred', 'mineMaterialblue'].forEach(k => mats[k] && mats[k].color && mats[k].color.set(n.bomb));
		} else if ('bombColor' in st.official) {
			const original = st.official.bombColor;
			restoreOfficial(['bombColor']);
			if (mats) ['mineMaterialred', 'mineMaterialblue'].forEach(k => mats[k] && mats[k].color && original && mats[k].color.set(original));
		}
	}

	const ENV_KEYS = ['redEventColor', 'redBrightEventColor', 'blueEventColor', 'blueBrightEventColor', 'redBGColor', 'redBrightBGColor', 'blueBGColor', 'blueBrightBGColor', 'wallColor', 'backgroundColor'];

	function applyEnvironment() {
		const env = vis().environment;
		const colorsComp = ctx.colors();
		const on = R.active() && env.override;
		if (on) {
			const values = {
				redEventColor: env.lightLeft,
				redBrightEventColor: brighten(env.lightLeft),
				blueEventColor: env.lightRight,
				blueBrightEventColor: brighten(env.lightRight),
				redBGColor: env.backglow,
				redBrightBGColor: brighten(env.backglow),
				blueBGColor: env.backglow,
				blueBrightBGColor: brighten(env.backglow),
				wallColor: env.walls,
				backgroundColor: env.background,
			};
			const os = officialSettings();
			const changed = os && ENV_KEYS.some(k => os.settings[k] !== values[k]);
			if (!changed) return;
			for (const k of ENV_KEYS) setOfficial(k, values[k]);
		} else if (ENV_KEYS.some(k => k in st.official)) {
			restoreOfficial(ENV_KEYS);
		} else return;
		try {
			if (colorsComp && colorsComp.updateColors) colorsComp.updateColors();
		} catch (e) {
			R.log.debug('updateColors failed', e);
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

	function updateTrails() {
		const s = vis().sabers;
		const on = R.active() && s.trailOverride;
		const os = officialSettings();
		for (const [hand, el] of Object.entries(sabers())) {
			const trail = el && el.components.trail;
			if (!trail || !trail.material) continue;
			if (on) {
				st.trailTouched = true;
				const life = Math.round(Number(s.trailLength) || 0);
				if (trail.data.lifetime !== life && trail.data.trailType !== 'none') el.setAttribute('trail', 'lifetime', Math.max(1, life));
				patchTrailShader(trail.material, U.clamp((Number(s.trailWidth) || 90) / 100, 0.05, 1));
				const c = color(s.trailMatchSaber ? saberColor(hand) : s[hand + 'TrailColor']);
				const o = Math.max(0, (Number(s.trailOpacity) || 0) / 100);
				const u = trail.material.uniforms.bladeColor;
				if (u) {
					u.value = {x: c.r * o, y: c.g * o, z: c.b * o, w: Math.min(1, o)};
					trail.material.uniformsNeedUpdate = true;
				}
				if (life === 0 && trail.mesh) trail.mesh.visible = false;
			} else if (st.trailTouched) {
				unpatchTrailShader(trail.material);
				const official = os ? Number(os.settings.trailLength) || 20 : 20;
				if (trail.data.lifetime !== official) el.setAttribute('trail', 'lifetime', official);
				try {
					trail.updateColor();
				} catch (e) {
					/* trail not initialised */
				}
			}
		}
		if (!on) st.trailTouched = false;
	}

	/* ------------------------------------------------------------------ saber styles & models */

	const STYLE_THICKNESS = {thin: 0.45, thick: 1.9, neon: 0.85, particle: 0.6};

	function setMaterialProp(el, prop, value) {
		if (!el || !el.components.material) return;
		const cur = el.components.material.data[prop];
		if (cur !== value) el.setAttribute('material', prop, value);
	}

	function applySaberStyle() {
		const s = vis().sabers;
		const on = R.active();
		const style = on ? s.style : 'default';
		const thick = on ? ((Number(s.thickness) || 100) / 100) * (STYLE_THICKNESS[style] || 1) : 1;
		const glow = on ? ((Number(s.glowIntensity) || 0) / 100) * (style === 'neon' ? 4 : 1) : 1;
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el) continue;
			const container = el.querySelector('.saberContainer');
			if (container && container.object3D) container.object3D.scale.set(thick, 1, thick);
			setMaterialProp(el.querySelector('.saberglow'), 'opacity', U.round(U.clamp(0.08 * glow, 0, 1), 3));
			const bladeColor = style === 'neon' ? brighten(saberColor(hand)) : '#ffffff';
			const blade = el.querySelector('.blade');
			if (blade && blade.components.material && String(blade.components.material.data.color).toLowerCase() !== bladeColor) blade.setAttribute('material', 'color', bladeColor);
		}
		updateCustomModels();
	}

	function modelFormat(name) {
		return /\.obj(\?|#|$)/i.test(name) ? 'obj' : 'gltf';
	}

	function setDefaultSaberVisible(el, visible) {
		['.bladeContainer', '.saberHandle'].forEach(sel => {
			const part = el.querySelector(sel);
			if (part && part.object3D) part.object3D.visible = visible;
		});
	}

	async function updateCustomModels() {
		const s = vis().sabers;
		const want = R.active() && s.style === 'custom';
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el) continue;
			const slot = st.models[hand];
			const url = want ? String(s.customModel[hand] || '').trim() : '';
			if (slot.url !== url) {
				if (slot.el) slot.el.remove();
				if (slot.objUrl) URL.revokeObjectURL(slot.objUrl);
				Object.assign(slot, {url, el: null, objUrl: null, loaded: false});
				setDefaultSaberVisible(el, true);
				if (url) loadModel(hand, el, slot, url).catch(e => R.ui && R.ui.toast(String(e.message || e), 'error'));
			}
			if (slot.el) {
				const m = s.customModel;
				slot.el.object3D.scale.setScalar(Number(m.scale) || 1);
				slot.el.object3D.rotation.set((Number(m.rotX) || 0) * (Math.PI / 180), (Number(m.rotY) || 0) * (Math.PI / 180), (Number(m.rotZ) || 0) * (Math.PI / 180));
				setDefaultSaberVisible(el, !(slot.loaded && m.hideDefault));
			}
		}
	}

	async function loadModel(hand, saberEl, slot, url) {
		let src = url;
		let name = url;
		if (url.startsWith('stored:')) {
			const data = await R.request('getSaberModel', {name: url.slice(7)});
			name = data.name;
			slot.objUrl = URL.createObjectURL(new Blob([data.data], {type: data.mime || 'application/octet-stream'}));
			src = slot.objUrl;
		}
		if (slot.url !== url) return; // settings changed while loading
		const container = saberEl.querySelector('.saberContainer') || saberEl;
		const ent = document.createElement('a-entity');
		ent.classList.add('blp-saber-model');
		if (modelFormat(name) === 'obj') ent.setAttribute('obj-model', 'obj: url(' + src + ')');
		else ent.setAttribute('gltf-model', 'url(' + src + ')');
		ent.addEventListener('model-loaded', () => {
			slot.loaded = true;
			updateCustomModels();
		});
		ent.addEventListener('model-error', () => R.ui && R.ui.toast('Saber model failed to load: ' + name, 'error'));
		container.appendChild(ent);
		slot.el = ent;
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
			points,
			spawn(x, y, z, vx, vy, vz, c, life) {
				if (live.length >= max) live.shift();
				live.push({x, y, z, vx, vy, vz, r: c.r, g: c.g, b: c.b, life, max: life});
			},
			update(dt) {
				let n = 0;
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
		const s = vis().sabers;
		if (!(R.active() && s.style === 'particle') || !R.api.isPlaying()) return;
		const per = Math.max(1, Math.round(5 * dt * 60));
		for (const [hand, el] of Object.entries(sabers())) {
			if (!el || !el.object3D.visible) continue;
			bladePoints(el, st.v1, st.v2);
			const c = color(brighten(saberColor(hand)));
			for (let i = 0; i < per; i++) {
				const u = Math.random();
				const x = st.v1.x + (st.v2.x - st.v1.x) * u;
				const y = st.v1.y + (st.v2.y - st.v1.y) * u;
				const z = st.v1.z + (st.v2.z - st.v1.z) * u;
				st.particles.spawn(x, y, z, (Math.random() - 0.5) * 0.4, (Math.random() - 0.2) * 0.4, (Math.random() - 0.5) * 0.4, c, 0.25 + Math.random() * 0.2);
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
		const pos = R.api.cutPointToScene(note, st.v1);
		if (!pos) {
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
		const dir = note.cutInfo && note.cutInfo.saberDir ? st.v2.set(note.cutInfo.saberDir.x, note.cutInfo.saberDir.y, -note.cutInfo.saberDir.z).normalize() : st.v2.set(0, 0, 0);
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
		const style = vis().effects.markerStyle;
		if (!style || style === 'none') return;
		const pos = notePosition(note, new THREE.Vector3());
		pos.z = Math.min(pos.z, -0.4);
		const mat = new THREE.MeshBasicMaterial({color: color(hex), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide});
		const group = new THREE.Group();
		if (style === 'ring') {
			group.add(new THREE.Mesh(new THREE.RingGeometry(0.17, 0.23, 40), mat));
		} else if (style === 'cross') {
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
		st.markers.push({group, mat, life: Number(vis().effects.markerLifetime) || 1.5, max: Number(vis().effects.markerLifetime) || 1.5});
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
		let hex = null;
		if (kind === 'miss' && fx.missFlash) hex = fx.missColor;
		else if (kind === 'bad' && fx.badCutFlash) hex = fx.badCutColor;
		else if (kind === 'bomb' && fx.bombFlash) hex = fx.bombColor;
		if (hex) flash(hex);
		if (kind === 'miss' || kind === 'bad' || kind === 'bomb') {
			spawnMarker(evt.note, kind === 'miss' ? fx.missColor : kind === 'bad' ? fx.badCutColor : fx.bombColor);
			if (fx.slowMoBurst && R.playback) R.playback.burst(Number(fx.slowMoSpeed) || 0.3, Number(fx.slowMoDuration) || 0.6);
		}
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

	const obj3d = sel => {
		const el = ctx.scene.querySelector(sel);
		return el && el.object3D;
	};

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
		const trailL = ctx.scene.object3DMap && ctx.scene.object3DMap.trail__left;
		const trailR = ctx.scene.object3DMap && ctx.scene.object3DMap.trail__right;

		hideKey('headset', [ctx.headset && ctx.headset.object3D], hide('headset') || (on && R.cameraWantsHeadsetHidden && R.cameraWantsHeadsetHidden()));
		hideKey('leftSaber', [s.left && s.left.object3D], hide('leftSaber'));
		hideKey('rightSaber', [s.right && s.right.object3D], hide('rightSaber'));
		hideKey('trailLeft', [trailL], hide('trails') || hide('leftSaber'));
		hideKey('trailRight', [trailR], hide('trails') || hide('rightSaber'));
		for (const key of Object.keys(STAGE)) hideKey(key, STAGE[key].map(obj3d), hide(key));
		hideKey('hud3d', [obj3d('#scoreContainer')], hide('hud3d') || (on && R.get('overlay.hideOfficial.scoreHud')));

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
			const key = hex ? hex + '|' : '';
			if (hex) {
				if (child.__blpTintNote !== beat.replayNote || child.__blpTintKey !== key) {
					if (tintBeat(beat, hex)) {
						child.__blpTintNote = beat.replayNote;
						child.__blpTintKey = key;
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

	/* ------------------------------------------------------------------ panel tab */

	function renderTab(body) {
		const ui = R.ui;
		const v = vis();
		const set = (path, value) => R.setPath('visuals.' + path, value);

		body.appendChild(
			ui.section(
				t('h.visSabers'),
				ui.toggle(t('f.visuals.sabers.override'), v.sabers.override, x => set('sabers.override', x)),
				ui.row(ui.color(t('common.left'), v.sabers.leftColor, x => set('sabers.leftColor', x)), ui.color(t('common.right'), v.sabers.rightColor, x => set('sabers.rightColor', x))),
				ui.select(
					t('f.visuals.sabers.style'),
					['default', 'thin', 'thick', 'neon', 'particle', 'custom'].map(s => ({value: s, label: t('saber.style.' + s)})),
					v.sabers.style,
					x => set('sabers.style', x)
				),
				ui.slider(t('f.visuals.sabers.glowIntensity'), {min: 0, max: 600, step: 10, value: v.sabers.glowIntensity, unit: '%'}, x => set('sabers.glowIntensity', x)),
				ui.slider(t('f.visuals.sabers.thickness'), {min: 20, max: 300, step: 5, value: v.sabers.thickness, unit: '%'}, x => set('sabers.thickness', x))
			)
		);
		body.appendChild(
			ui.section(
				t('h.visTrails'),
				ui.toggle(t('f.visuals.sabers.trailOverride'), v.sabers.trailOverride, x => set('sabers.trailOverride', x)),
				ui.slider(t('f.visuals.sabers.trailLength'), {min: 0, max: 120, step: 1, value: v.sabers.trailLength}, x => set('sabers.trailLength', x)),
				ui.slider(t('f.visuals.sabers.trailWidth'), {min: 10, max: 100, step: 1, value: v.sabers.trailWidth, unit: '%'}, x => set('sabers.trailWidth', x)),
				ui.slider(t('f.visuals.sabers.trailOpacity'), {min: 0, max: 200, step: 5, value: v.sabers.trailOpacity, unit: '%'}, x => set('sabers.trailOpacity', x))
			)
		);
		body.appendChild(
			ui.section(
				t('h.visNotes'),
				ui.toggle(t('f.visuals.notes.override'), v.notes.override, x => set('notes.override', x)),
				ui.row(ui.color(t('common.left'), v.notes.left, x => set('notes.left', x)), ui.color(t('common.right'), v.notes.right, x => set('notes.right', x))),
				ui.toggle(t('f.visuals.accuracyHeat.enabled'), v.accuracyHeat.enabled, x => set('accuracyHeat.enabled', x)),
				ui.toggle(t('f.visuals.effects.hitParticles'), v.effects.hitParticles, x => set('effects.hitParticles', x))
			)
		);
		body.appendChild(
			ui.section(
				t('h.visEffects'),
				ui.toggle(t('f.visuals.effects.missFlash'), v.effects.missFlash, x => set('effects.missFlash', x)),
				ui.toggle(t('f.visuals.effects.badCutFlash'), v.effects.badCutFlash, x => set('effects.badCutFlash', x)),
				ui.toggle(t('f.visuals.effects.slowMoBurst'), v.effects.slowMoBurst, x => set('effects.slowMoBurst', x)),
				ui.select(
					t('f.visuals.effects.markerStyle'),
					['none', 'ring', 'cross', 'pillar'].map(s => ({value: s, label: t('marker.' + s)})),
					v.effects.markerStyle,
					x => set('effects.markerStyle', x)
				)
			)
		);
		const visSection = ui.section(t('h.visVisibility'));
		const grid = ui.h('div', {class: 'blp-r-grid'});
		for (const key of Object.keys(v.visibility)) grid.appendChild(ui.toggle(t('f.visuals.visibility.' + key), v.visibility[key], x => set('visibility.' + key, x)));
		visSection.appendChild(grid);
		body.appendChild(visSection);
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
			wrapOfficialSync();
			R.on('note', onNote);
			// Re-assert our colors whenever the replayer changes them (e.g. supporter colors fetched).
			const reassert = () => setTimeout(() => R.active() && applySaberColors(false), 0);
			c.scene.addEventListener('colorReset', reassert);
			c.scene.addEventListener('colorsFetched', reassert);
			c.scene.addEventListener('colorChanged', e => {
				const s = vis().sabers;
				if (R.active() && s.override && e.detail && e.detail.color !== s[e.detail.hand + 'Color']) {
					st.applied[e.detail.hand] = null;
					reassert();
				} else setTimeout(applyNoteColors, 0);
			});
			R.addHotkey('toggleHeat', () => {
				const on = !vis().accuracyHeat.enabled;
				R.setPath('visuals.accuracyHeat.enabled', on);
				R.api.notify(t(on ? 'r.heatOn' : 'r.heatOff'), 'fas fa-fire');
			});
			R.ui.addTab({id: 'visuals', icon: '✨', title: t('r.tab.visuals'), order: 30, render: renderTab});
		},
		onSettings() {
			if (!ctx) return;
			applySaberColors(false);
			applyBombColor();
			applyEnvironment();
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
			applySaberColors(true);
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
			applyBombColor();
			applySaberStyle();
		},
	});
})();
