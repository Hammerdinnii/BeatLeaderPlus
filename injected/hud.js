/*
 * BeatLeaderPlus – additions to the replayer's score HUD (PAGE world).
 *
 * The replayer already shows score, accuracy, FC accuracy, combo, multiplier, misses and energy
 * as 3D text (#scoreContainer). This module adds lines in the same style (its `scoreText` mixin),
 * placed under the existing ones and hidden whenever the replayer's "Show HUD" is off:
 *
 *   - PP estimate (from the map's BeatLeader ratings; ranked maps only, modifiers ignored)
 *   - last cut score with its pre / post / accuracy breakdown (optional)
 *
 * and lets the HUD be resized, raised or lowered, recolored and trimmed to the parts you want.
 * Hidden parts use THREE layers (like visuals.js), so the replayer's own visibility bindings keep
 * working underneath.
 *
 * It also owns the "toggle overlays" command, which hides everything BeatLeaderPlus draws.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('hud')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	let ctx = null;
	const hud = {pp: null, lastCut: null, ratings: null, ratingsFor: null, layoutTouched: false, hiddenParts: new Set(), colorKey: ''};

	const cfg = () => R.settings.overlay;

	// The HUD's parts in the replayer's markup (#scoreContainer).
	const HUD_PARTS = {
		score: ['#scoreTextContainer'],
		accuracy: ['#accuracy', '#fcAccuracy'],
		combo: ['#combo'],
		multiplier: ['#multiplier', '#multiplierRing'],
		misses: ['#misses'],
		energy: ['#energyBar'],
	};
	const HUD_TEXTS = ['#score', '#accuracy', '#fcAccuracy', '#combo', '#multiplier', '#misses', '#blpHudPp', '#blpHudLastCut'];
	const HUD_PIVOT = {y: 1, z: -4}; // middle of the HUD: resizing keeps it centred there

	/* ------------------------------------------------------------------ HUD layout, parts, color */

	function applyHudLayout() {
		const container = ctx.scene.querySelector('#scoreContainer');
		const o = container && container.object3D;
		if (!o) return;
		const h = R.active() ? cfg().hud : null;
		const f = h ? U.clamp(Number(h.scale) || 100, 30, 300) / 100 : 1;
		const dy = h ? Number(h.height) || 0 : 0;
		if (f === 1 && dy === 0 && !hud.layoutTouched) return;
		o.scale.setScalar(f);
		// Scale around the pivot, turning with the container on 360° maps (it only spins around Y).
		const c = Math.cos(o.rotation.y);
		const sn = Math.sin(o.rotation.y);
		const py = HUD_PIVOT.y * (1 - f);
		const pz = HUD_PIVOT.z * (1 - f);
		o.position.set(pz * sn, py + dy, pz * c);
		hud.layoutTouched = f !== 1 || dy !== 0;
	}

	function setLayersHidden(obj, hidden) {
		obj.traverse(o => {
			const ud = o.userData;
			if (hidden) {
				if (ud.__blpHudMask === undefined) ud.__blpHudMask = o.layers.mask;
				o.layers.mask = 0;
			} else if (ud.__blpHudMask !== undefined) {
				o.layers.mask = ud.__blpHudMask;
				delete ud.__blpHudMask;
			}
		});
	}

	function applyHudParts() {
		const show = R.active() ? cfg().hud.show : null;
		for (const key of Object.keys(HUD_PARTS)) {
			const hidden = !!show && show[key] === false;
			if (!hidden && !hud.hiddenParts.has(key)) continue;
			for (const sel of HUD_PARTS[key]) {
				const el = ctx.scene.querySelector(sel);
				if (el && el.object3D) setLayersHidden(el.object3D, hidden);
			}
			if (hidden) hud.hiddenParts.add(key);
			else hud.hiddenParts.delete(key);
		}
	}

	function applyHudColor() {
		const h = cfg().hud;
		const color = R.active() && h.colorOverride && U.isHexColor(h.color) ? h.color : '';
		const key = color + '|' + (hud.pp ? 1 : 0) + (hud.lastCut ? 1 : 0);
		if (key === hud.colorKey) return;
		let done = true;
		for (const sel of HUD_TEXTS) {
			const el = ctx.scene.querySelector(sel);
			const text = el && el.components && el.components.text;
			if (!text || !text.data) {
				done = done && !(el && el.hasAttribute('text')); // still initialising: try again later
				continue;
			}
			if (el.__blpHudColor === undefined) el.__blpHudColor = text.data.color;
			if (text.data.color !== (color || el.__blpHudColor)) el.setAttribute('text', 'color', color || el.__blpHudColor);
		}
		if (done) hud.colorKey = key;
	}

	function textEntity(id, position, scale) {
		const container = ctx.scene.querySelector('#scoreContainer');
		if (!container) return null;
		let el = document.getElementById(id);
		if (el && el.isConnected) return el;
		el = document.createElement('a-entity');
		el.id = id;
		el.classList.add('blp-hud-text');
		if (document.getElementById('scoreText')) el.setAttribute('mixin', 'scoreText');
		el.setAttribute('text', {value: '', width: 1, align: 'center', color: '#FFFFFF', lineHeight: 40});
		el.setAttribute('position', position);
		el.setAttribute('scale', scale);
		container.appendChild(el);
		return el;
	}

	function setText(el, value, visible) {
		if (!el || !el.object3D) return;
		el.object3D.visible = visible;
		if (visible && el.__blpText !== value) {
			el.__blpText = value;
			el.setAttribute('text', 'value', value);
		}
	}

	async function loadRatings() {
		const scoreId = R.api.scoreId();
		if (!scoreId || hud.ratingsFor === scoreId) return;
		hud.ratingsFor = scoreId;
		hud.ratings = null;
		try {
			const score = await R.request('resolveScore', {scoreId});
			const d = (score && score.difficulty) || (score && score.leaderboard && score.leaderboard.difficulty) || {};
			if (d.accRating > 0) hud.ratings = {accRating: d.accRating, passRating: d.passRating || 0, techRating: d.techRating || 0};
		} catch (e) {
			R.log.debug('ratings unavailable', e);
		}
	}

	function lastCut(time) {
		const notes = (R.replayInfo && R.replayInfo.notes) || [];
		for (let i = R.api.noteIndexAt(notes, time); i >= 0 && i > -60; i--) {
			const n = notes[i];
			if (n && n.isBlock) return n;
		}
		return null;
	}

	function update(frame) {
		const os = ctx.officialSettings();
		const showHud = !os || !os.settings || os.settings.showHud !== false;
		const base = R.active() && showHud && !R.overlaysHidden;
		const c = cfg();

		const acc = parseFloat((ctx.state().score || {}).accuracy);
		const pp = hud.ratings && isFinite(acc) && acc > 0 ? U.estimatePP(acc / 100, hud.ratings) : null;
		const ppVisible = base && c.ppInHud && pp !== null;
		if (ppVisible || hud.pp) {
			hud.pp = hud.pp || textEntity('blpHudPp', '-1.8 -0.35 -4', '3 3 3');
			setText(hud.pp, '~' + (pp || 0).toFixed(1) + 'pp', ppVisible);
		}

		const cutVisible = base && c.lastCutInHud;
		if (cutVisible || hud.lastCut) {
			hud.lastCut = hud.lastCut || textEntity('blpHudLastCut', '1.8 -0.15 -4', '3 3 3');
			const n = cutVisible ? lastCut(frame.time) : null;
			let text = '';
			if (n && n.score > 0 && n.cutInfo) {
				const pre = Math.round(70 * U.clamp(n.cutInfo.beforeCutRating, 0, 1));
				const post = Math.round(30 * U.clamp(n.cutInfo.afterCutRating, 0, 1));
				const accPts = Math.round(15 * (1 - U.clamp(n.cutInfo.cutDistanceToCenter / 0.3, 0, 1)));
				text = n.score + '  ' + pre + '/' + post + '/' + accPts;
			} else if (n) text = R.api.noteKind(n).toUpperCase();
			setText(hud.lastCut, text, cutVisible && !!text);
		}
	}

	function toggleOverlays() {
		R.overlaysHidden = !R.overlaysHidden;
		if (R.ui) R.ui.applyOfficialVisibility();
		R.emit('overlays', R.overlaysHidden);
		R.api.notify(t(R.overlaysHidden ? 'r.overlaysOff' : 'r.overlaysOn'), 'fas fa-layer-group');
		return !R.overlaysHidden;
	}

	function renderHud(body) {
		const ui = R.ui;
		const c = cfg();
		const h = c.hud;
		body.appendChild(ui.toggle(t('f.overlay.ppInHud'), c.ppInHud, v => R.setPath('overlay.ppInHud', v), t('d.overlay.ppInHud')));
		body.appendChild(ui.toggle(t('f.overlay.lastCutInHud'), c.lastCutInHud, v => R.setPath('overlay.lastCutInHud', v)));
		body.appendChild(ui.range(t('f.overlay.hud.scale'), {min: 50, max: 200, step: 5, value: h.scale, unit: '%'}, v => R.setPath('overlay.hud.scale', v)));
		body.appendChild(ui.range(t('f.overlay.hud.height'), {min: -2, max: 2, step: 0.05, value: h.height, unit: 'm'}, v => R.setPath('overlay.hud.height', v)));
		body.appendChild(ui.toggle(t('f.overlay.hud.colorOverride'), h.colorOverride, v => R.setPath('overlay.hud.colorOverride', v)));
		if (h.colorOverride) body.appendChild(ui.color(t('f.overlay.hud.color'), h.color, v => R.setPath('overlay.hud.color', v)));
		const grid = ui.h('div', {class: 'blp-r-grid'});
		for (const key of Object.keys(h.show)) grid.appendChild(ui.toggle(t('f.overlay.hud.show.' + key), h.show[key], v => R.setPath('overlay.hud.show.' + key, v)));
		body.appendChild(grid);
	}

	function renderInterface(body) {
		const ui = R.ui;
		const c = cfg();
		for (const key of Object.keys(c.hideOfficial)) {
			body.appendChild(ui.toggle(t('h.ovHideOfficial') + ': ' + t('f.overlay.hideOfficial.' + key), c.hideOfficial[key], v => R.setPath('overlay.hideOfficial.' + key, v)));
		}
	}

	R.register({
		name: 'hud',
		init(c) {
			ctx = c;
			R.onCommand('toggleOverlays', toggleOverlays);
			R.ui.addSettingsSection({id: 'hud', order: 85, title: () => t('r.sect.hud'), render: renderHud});
			R.ui.addSettingsSection({id: 'interface', order: 90, title: () => t('r.sect.interface'), render: renderInterface});
		},
		onReplay() {
			loadRatings();
		},
		onSettings() {
			if (!ctx) return;
			if (!R.active()) update(R.frame); // ticks stop while disabled: hide our lines now
			applyHudLayout();
			applyHudParts();
			applyHudColor();
		},
		tick() {
			applyHudLayout();
		},
		maintain(frame) {
			update(frame);
			applyHudParts();
			applyHudColor();
		},
	});
})();
