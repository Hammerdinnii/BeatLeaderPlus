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
 * It also owns the "toggle overlays" command, which hides everything BeatLeaderPlus draws.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('hud')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	let ctx = null;
	const hud = {pp: null, lastCut: null, ratings: null, ratingsFor: null};

	const cfg = () => R.settings.overlay;

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

	function renderInterface(body) {
		const ui = R.ui;
		const c = cfg();
		body.appendChild(ui.toggle(t('f.overlay.ppInHud'), c.ppInHud, v => R.setPath('overlay.ppInHud', v), t('d.overlay.ppInHud')));
		body.appendChild(ui.toggle(t('f.overlay.lastCutInHud'), c.lastCutInHud, v => R.setPath('overlay.lastCutInHud', v)));
		for (const key of Object.keys(c.hideOfficial)) {
			body.appendChild(ui.toggle(t('h.ovHideOfficial') + ': ' + t('f.overlay.hideOfficial.' + key), c.hideOfficial[key], v => R.setPath('overlay.hideOfficial.' + key, v)));
		}
	}

	R.register({
		name: 'hud',
		init(c) {
			ctx = c;
			R.onCommand('toggleOverlays', toggleOverlays);
			R.ui.addSettingsSection({id: 'interface', order: 90, title: () => t('r.sect.interface'), render: renderInterface});
		},
		onReplay() {
			loadRatings();
		},
		onSettings() {
			if (!ctx) return;
			if (!R.active()) update(R.frame); // ticks stop while disabled: hide our lines now
		},
		maintain(frame) {
			update(frame);
		},
	});
})();
