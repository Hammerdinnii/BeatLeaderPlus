/*
 * BeatLeaderPlus – stats overlay / HUD (PAGE world).
 *
 * A draggable HTML overlay that shows live replay statistics:
 *   score, accuracy, FC accuracy, combo, multiplier, mistakes, energy (from the replayer's state
 *   system), PP estimate (BeatLeader ratings from the score API), last cut breakdown (pre / post /
 *   accuracy points), cut timing, saber speed, left/right averages, notes cut, song time,
 *   a mini accuracy graph and swing direction indicators.
 *
 * Per-note statistics are computed from the replay's note structs with prefix sums so seeking
 * anywhere is O(log n). The overlay can also be painted onto a canvas (drawToCanvas) for
 * screenshots and clip recording.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('overlays')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);
	const h = U.h;

	let ctx = null;
	const ov = {
		el: null,
		rows: {},
		graph: null,
		swing: null,
		lastCutEl: null,
		lastUpdate: 0,
		structureKey: '',
		prefix: null,
		ratings: null,
		ratingsFor: null,
	};

	const cfg = () => R.settings.overlay;

	/* ------------------------------------------------------------------ per-replay statistics */

	function cutParts(cut) {
		if (!cut) return null;
		const pre = Math.round(70 * U.clamp(cut.beforeCutRating, 0, 1));
		const post = Math.round(30 * U.clamp(cut.afterCutRating, 0, 1));
		const acc = Math.round(15 * (1 - U.clamp(cut.cutDistanceToCenter / 0.3, 0, 1)));
		return {pre, post, acc};
	}

	function buildPrefix(notes) {
		const n = notes.length;
		const p = {
			sum: [new Float64Array(n), new Float64Array(n)],
			count: [new Uint32Array(n), new Uint32Array(n)],
			cut: new Uint32Array(n),
			blocks: 0,
		};
		let s0 = 0;
		let s1 = 0;
		let c0 = 0;
		let c1 = 0;
		let cut = 0;
		for (let i = 0; i < n; i++) {
			const note = notes[i];
			if (note.isBlock) p.blocks++;
			if (R.api.noteKind(note) === 'good' && note.score > 0) {
				cut++;
				if (R.api.noteHand(note) === 1) {
					s1 += note.score;
					c1++;
				} else {
					s0 += note.score;
					c0++;
				}
			}
			p.sum[0][i] = s0;
			p.sum[1][i] = s1;
			p.count[0][i] = c0;
			p.count[1][i] = c1;
			p.cut[i] = cut;
		}
		return p;
	}

	async function loadRatings() {
		const scoreId = R.api.scoreId();
		if (!scoreId || ov.ratingsFor === scoreId) return;
		ov.ratingsFor = scoreId;
		ov.ratings = null;
		try {
			const score = await R.request('resolveScore', {scoreId});
			const d = (score && score.difficulty) || (score && score.leaderboard && score.leaderboard.difficulty) || {};
			if (d.accRating > 0) ov.ratings = {accRating: d.accRating, passRating: d.passRating || 0, techRating: d.techRating || 0, stars: d.stars};
		} catch (e) {
			R.log.debug('ratings unavailable', e);
		}
	}

	/* ------------------------------------------------------------------ DOM */

	const STAT_ORDER = ['score', 'accuracy', 'fcAccuracy', 'pp', 'combo', 'multiplier', 'misses', 'energy', 'notes', 'handAcc', 'timeDeviation', 'saberSpeed', 'time'];
	const STAT_LABEL = {
		score: 'r.hud.score',
		accuracy: 'r.hud.acc',
		fcAccuracy: 'r.hud.fcAcc',
		pp: 'r.hud.pp',
		combo: 'r.hud.combo',
		multiplier: 'r.hud.mult',
		misses: 'r.hud.misses',
		energy: 'r.hud.energy',
		notes: 'r.hud.notes',
		handAcc: 'r.hud.left',
		timeDeviation: 'r.hud.timing',
		saberSpeed: 'r.hud.speed',
		time: 'r.hud.time',
	};

	function build() {
		const c = cfg();
		const key = JSON.stringify([c.stats, c.graph, c.swing, c.style, R.overlaysHidden]);
		if (ov.el && ov.structureKey === key) return;
		if (ov.el) ov.el.remove();
		ov.structureKey = key;
		ov.rows = {};
		const grid = h('div', {class: 'blp-r-hud-grid'});
		for (const stat of STAT_ORDER) {
			if (!c.stats[stat]) continue;
			const v = h('span', {class: 'blp-r-hud-v'}, '—');
			const label = stat === 'handAcc' ? t('r.hud.left') + ' / ' + t('r.hud.right') : t(STAT_LABEL[stat]);
			grid.appendChild(h('div', {class: 'blp-r-hud-stat blp-r-hud-' + stat}, h('span', {class: 'blp-r-hud-k'}, label), v));
			ov.rows[stat] = v;
		}
		ov.lastCutEl = c.stats.lastCut ? h('div', {class: 'blp-r-hud-lastcut'}, '—') : null;
		ov.graph = c.graph.enabled ? h('canvas', {class: 'blp-r-hud-graph'}) : null;
		ov.swing = c.swing.enabled ? {left: h('canvas', {class: 'blp-r-hud-swing'}), right: h('canvas', {class: 'blp-r-hud-swing'})} : null;
		const head = h('div', {class: 'blp-r-hud-head', title: t('r.hud.dragHint')}, h('span', {class: 'blp-r-brand'}, 'BL+'), h('span', {class: 'blp-r-hud-title'}, ''));
		ov.title = head.lastChild;
		ov.el = h(
			'div',
			{id: 'blp-r-hud', class: 'blp-r-hud blp-r-hud-' + (c.style || 'glass')},
			head,
			grid,
			ov.lastCutEl,
			ov.graph,
			ov.swing ? h('div', {class: 'blp-r-hud-swings'}, ov.swing.left, ov.swing.right) : null
		);
		['pointerdown', 'mousedown', 'click', 'wheel'].forEach(ev => ov.el.addEventListener(ev, e => e.stopPropagation()));
		document.body.appendChild(ov.el);
		R.ui.makeDraggable(ov.el, head, (x, y) => R.patchSettings({overlay: {position: 'custom', x, y}}));
		applyLayout();
	}

	function applyLayout() {
		const el = ov.el;
		if (!el) return;
		const c = cfg();
		const m = 16;
		const pos = c.position || 'top-left';
		Object.assign(el.style, {left: 'auto', right: 'auto', top: 'auto', bottom: 'auto'});
		if (pos === 'custom') {
			el.style.left = U.clamp(Number(c.x) || 0, 0, window.innerWidth - 60) + 'px';
			el.style.top = U.clamp(Number(c.y) || 0, 0, window.innerHeight - 40) + 'px';
			el.style.transformOrigin = 'top left';
		} else {
			const [v, hz] = pos.split('-');
			el.style[v] = (v === 'bottom' ? 90 : m) + 'px';
			el.style[hz] = m + 'px';
			el.style.transformOrigin = v + ' ' + hz;
		}
		el.style.opacity = U.clamp((Number(c.opacity) || 92) / 100, 0.1, 1);
		el.style.transform = 'scale(' + U.clamp(Number(c.scale) || 1, 0.3, 3) + ')';
		const visible = R.active() && c.enabled && !R.overlaysHidden;
		el.style.display = visible ? '' : 'none';
		if (ov.graph) {
			const gh = U.clamp(Number(c.graph.height) || 56, 20, 300);
			const dpr = window.devicePixelRatio || 1;
			ov.graph.width = Math.round(220 * dpr);
			ov.graph.height = Math.round(gh * dpr);
			ov.graph.style.height = gh + 'px';
		}
		if (ov.swing) {
			const dpr = window.devicePixelRatio || 1;
			for (const cnv of [ov.swing.left, ov.swing.right]) {
				cnv.width = Math.round(56 * dpr);
				cnv.height = Math.round(56 * dpr);
			}
		}
	}

	/* ------------------------------------------------------------------ updates */

	function lastBlockNote(notes, idx, predicate) {
		for (let i = idx; i >= 0 && i > idx - 60; i--) {
			const n = notes[i];
			if (n.isBlock && predicate(n)) return n;
		}
		return null;
	}

	function update(frame) {
		const c = cfg();
		const st = ctx.state();
		const sc = st.score || {};
		const notes = (R.replayInfo && R.replayInfo.notes) || [];
		const idx = notes.length ? R.api.noteIndexAt(notes, frame.time) : -1;
		const p = ov.prefix;
		const set = (key, text, cls) => {
			const el = ov.rows[key];
			if (!el) return;
			if (el.textContent !== text) el.textContent = text;
			el.className = 'blp-r-hud-v' + (cls ? ' ' + cls : '');
		};
		const acc = parseFloat(sc.accuracy);
		set('score', sc.score !== undefined ? U.formatNumber(sc.score) : '—');
		set('accuracy', isFinite(acc) ? acc.toFixed(2) + '%' : '—');
		const fc = parseFloat(sc.fcAccuracy);
		set('fcAccuracy', isFinite(fc) ? fc.toFixed(2) + '%' : '—');
		set('combo', sc.combo !== undefined ? String(sc.combo) : '—');
		set('multiplier', sc.multiplier ? '×' + sc.multiplier : '—');
		set('misses', sc.misses !== undefined ? String(sc.misses) : '—', sc.misses ? 'blp-r-bad' : 'blp-r-good');
		set('energy', isFinite(sc.energy) ? Math.round(sc.energy * 100) + '%' : '—');
		const pp = ov.ratings && isFinite(acc) ? U.estimatePP(acc / 100, ov.ratings) : null;
		set('pp', pp !== null ? pp.toFixed(1) + 'pp' : '—');
		set('time', U.formatTime(frame.time, false) + ' / ' + U.formatTime(R.api.duration(), false));
		if (p && idx >= 0) {
			set('notes', p.cut[idx] + ' / ' + p.blocks);
			const l = p.count[0][idx] ? (p.sum[0][idx] / p.count[0][idx]).toFixed(2) : '—';
			const r = p.count[1][idx] ? (p.sum[1][idx] / p.count[1][idx]).toFixed(2) : '—';
			set('handAcc', l + ' / ' + r);
		} else {
			set('notes', p ? '0 / ' + p.blocks : '—');
			set('handAcc', '—');
		}

		const last = idx >= 0 ? lastBlockNote(notes, idx, () => true) : null;
		const lastCut = idx >= 0 ? lastBlockNote(notes, idx, n => n.cutInfo) : null;
		if (lastCut && lastCut.cutInfo) {
			const dev = lastCut.cutInfo.timeDeviation * 1000;
			set('timeDeviation', Math.abs(dev).toFixed(1) + 'ms ' + t(dev < 0 ? 'r.hud.early' : 'r.hud.late'));
			set('saberSpeed', lastCut.cutInfo.saberSpeed.toFixed(1) + ' m/s');
		} else {
			set('timeDeviation', '—');
			set('saberSpeed', '—');
		}
		if (ov.lastCutEl) {
			let text = '—';
			let colorHex = null;
			if (last) {
				const kind = R.api.noteKind(last);
				if (kind === 'good' && last.score > 0) {
					const parts = cutParts(last.cutInfo);
					text = t('r.hud.lastCut') + ': ' + last.score + (parts ? '  (' + parts.pre + ' / ' + parts.post + ' / ' + parts.acc + ')' : '');
					colorHex = R.heatColor ? R.heatColor(last.score) : null;
				} else text = t('r.hud.lastCut') + ': ' + kind.toUpperCase();
			}
			if (ov.lastCutEl.textContent !== text) ov.lastCutEl.textContent = text;
			ov.lastCutEl.style.color = colorHex || '';
		}
		if (ov.title && R.replayInfo) {
			const title = R.replayInfo.playerName;
			if (ov.title.textContent !== title) ov.title.textContent = title;
		}
		if (ov.graph) drawGraph(ov.graph, notes, idx, frame.time, c.graph);
		if (ov.swing) {
			drawSwing(ov.swing.left, idx >= 0 ? lastBlockNote(notes, idx, n => n.cutInfo && R.api.noteHand(n) === 0) : null, 'left');
			drawSwing(ov.swing.right, idx >= 0 ? lastBlockNote(notes, idx, n => n.cutInfo && R.api.noteHand(n) === 1) : null, 'right');
		}
	}

	function drawGraph(canvas, notes, idx, time, gcfg) {
		const g = canvas.getContext('2d');
		const dpr = window.devicePixelRatio || 1;
		const W = canvas.width / dpr;
		const H = canvas.height / dpr;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, W, H);
		g.fillStyle = 'rgba(255,255,255,0.05)';
		g.fillRect(0, 0, W, H);
		if (idx < 1) return;
		const windowSec = Number(gcfg.window) || 0;
		const t0 = windowSec > 0 ? Math.max(0, time - windowSec) : 0;
		const t1 = windowSec > 0 ? Math.max(time, windowSec) : Math.max(1, R.api.duration());
		const pts = [];
		for (let i = 0; i <= idx; i++) {
			const n = notes[i];
			if (n.isBlock && n.time >= t0 && typeof n.accuracy === 'number' && n.accuracy > 0) pts.push(n);
		}
		if (!pts.length) return;
		const accs = pts.map(n => n.accuracy);
		const minAcc = Math.max(0, Math.min(...accs) - 0.3);
		const maxAcc = Math.min(100, Math.max(...accs) + 0.3);
		const X = tt => ((tt - t0) / Math.max(0.001, t1 - t0)) * W;
		const Y = a => H - 2 - ((a - minAcc) / Math.max(0.05, maxAcc - minAcc)) * (H - 4);
		if (gcfg.showCuts) {
			for (const n of pts) {
				if (!(n.score > 0)) continue;
				g.fillStyle = R.heatColor ? R.heatColor(n.score) : '#fff';
				g.globalAlpha = 0.55;
				const y = H - 2 - (U.clamp(n.score, 70, 115) - 70) / 45 * (H - 4);
				g.fillRect(X(n.time) - 0.75, y - 0.75, 1.5, 1.5);
			}
			g.globalAlpha = 1;
		}
		g.beginPath();
		pts.forEach((n, i) => (i ? g.lineTo(X(n.time), Y(n.accuracy)) : g.moveTo(X(n.time), Y(n.accuracy))));
		g.strokeStyle = '#ff3d9a';
		g.lineWidth = 1.6;
		g.stroke();
		for (const n of pts) {
			const k = R.api.noteKind(n);
			if (k === 'miss' || k === 'bad') {
				g.fillStyle = '#ff1744';
				g.fillRect(X(n.time) - 0.75, 0, 1.5, H);
			}
		}
		g.fillStyle = 'rgba(255,255,255,0.75)';
		g.font = '9px system-ui, sans-serif';
		g.fillText(maxAcc.toFixed(2) + '%', 3, 10);
		g.fillText(minAcc.toFixed(2) + '%', 3, H - 4);
	}

	function drawSwing(canvas, note, hand) {
		const g = canvas.getContext('2d');
		const dpr = window.devicePixelRatio || 1;
		const S = canvas.width / dpr;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, S, S);
		const c = S / 2;
		const col = R.saberColor ? R.saberColor(hand) : hand === 'left' ? '#ff2e63' : '#2e9bff';
		g.strokeStyle = 'rgba(255,255,255,0.18)';
		g.lineWidth = 1;
		g.beginPath();
		g.arc(c, c, c - 3, 0, Math.PI * 2);
		g.stroke();
		if (!note || !note.cutInfo || !note.cutInfo.saberDir) return;
		const d = note.cutInfo.saberDir;
		const len = Math.hypot(d.x, d.y) || 1;
		const dx = d.x / len;
		const dy = -d.y / len;
		const r = c - 8;
		g.strokeStyle = col;
		g.fillStyle = col;
		g.lineWidth = 3;
		g.beginPath();
		g.moveTo(c - dx * r, c - dy * r);
		g.lineTo(c + dx * r, c + dy * r);
		g.stroke();
		const ang = Math.atan2(dy, dx);
		g.beginPath();
		g.moveTo(c + dx * r, c + dy * r);
		g.lineTo(c + dx * r - Math.cos(ang - 0.5) * 9, c + dy * r - Math.sin(ang - 0.5) * 9);
		g.lineTo(c + dx * r - Math.cos(ang + 0.5) * 9, c + dy * r - Math.sin(ang + 0.5) * 9);
		g.closePath();
		g.fill();
		g.fillStyle = 'rgba(255,255,255,0.85)';
		g.font = '9px system-ui, sans-serif';
		g.textAlign = 'center';
		const devi = note.cutInfo.cutDirDeviation;
		if (isFinite(devi)) g.fillText((devi > 0 ? '+' : '') + devi.toFixed(0) + '°', c, S - 3);
	}

	/* ------------------------------------------------------------------ export painting */

	/** Paint the HUD onto a 2D canvas context of size W×H (screenshots and clips). */
	function drawToCanvas(g, W, H) {
		if (!ov.el || ov.el.style.display === 'none') return;
		const rect = ov.el.getBoundingClientRect();
		const sx = W / window.innerWidth;
		const sy = H / window.innerHeight;
		const x = rect.left * sx;
		const y = rect.top * sy;
		const w = rect.width * sx;
		const hgt = rect.height * sy;
		g.save();
		g.globalAlpha = U.clamp((Number(cfg().opacity) || 92) / 100, 0.1, 1);
		g.fillStyle = 'rgba(12, 12, 20, 0.72)';
		const radius = 10 * sx;
		g.beginPath();
		g.moveTo(x + radius, y);
		g.arcTo(x + w, y, x + w, y + hgt, radius);
		g.arcTo(x + w, y + hgt, x, y + hgt, radius);
		g.arcTo(x, y + hgt, x, y, radius);
		g.arcTo(x, y, x + w, y, radius);
		g.closePath();
		g.fill();
		// Text rows: mirror the DOM layout so positions match what is on screen.
		g.textBaseline = 'middle';
		ov.el.querySelectorAll('.blp-r-hud-stat, .blp-r-hud-lastcut, .blp-r-hud-head').forEach(row => {
			const r = row.getBoundingClientRect();
			const fontPx = parseFloat(getComputedStyle(row).fontSize) * sy;
			g.font = `600 ${fontPx}px system-ui, sans-serif`;
			const cy = (r.top + r.height / 2) * sy;
			if (row.classList.contains('blp-r-hud-stat')) {
				const k = row.querySelector('.blp-r-hud-k');
				const v = row.querySelector('.blp-r-hud-v');
				g.fillStyle = 'rgba(255,255,255,0.6)';
				g.textAlign = 'left';
				g.fillText(k.textContent, r.left * sx, cy);
				g.fillStyle = getComputedStyle(v).color;
				g.textAlign = 'right';
				g.fillText(v.textContent, r.right * sx, cy);
			} else {
				g.fillStyle = getComputedStyle(row).color;
				g.textAlign = 'left';
				g.fillText(row.textContent, r.left * sx, cy);
			}
		});
		for (const cnv of [ov.graph, ov.swing && ov.swing.left, ov.swing && ov.swing.right]) {
			if (!cnv) continue;
			const r = cnv.getBoundingClientRect();
			if (r.width && r.height) g.drawImage(cnv, r.left * sx, r.top * sy, r.width * sx, r.height * sy);
		}
		g.restore();
	}

	/* ------------------------------------------------------------------ toggles */

	function toggleHud() {
		const on = !cfg().enabled;
		R.setPath('overlay.enabled', on);
		R.api.notify(t(on ? 'r.hudOn' : 'r.hudOff'), 'fas fa-chart-line');
	}

	function toggleOverlays() {
		R.overlaysHidden = !R.overlaysHidden;
		document.documentElement.classList.toggle('blp-r-overlays-hidden', R.overlaysHidden);
		applyLayout();
		R.emit('overlays', R.overlaysHidden);
		R.api.notify(t(R.overlaysHidden ? 'r.overlaysOff' : 'r.overlaysOn'), 'fas fa-layer-group');
		return !R.overlaysHidden;
	}

	/* ------------------------------------------------------------------ module */

	R.overlays = {drawToCanvas, toggleHud, toggleOverlays};

	R.register({
		name: 'overlays',
		init(c) {
			ctx = c;
			R.addHotkey('toggleHud', toggleHud);
			R.onCommand('toggleOverlays', toggleOverlays);
			R.onCommand('toggleHud', toggleHud);
			window.addEventListener('resize', U.debounce(applyLayout, 150));
		},
		onSettings() {
			if (!ctx) return;
			if (!R.active()) {
				if (ov.el) ov.el.style.display = 'none';
				return;
			}
			build();
			applyLayout();
		},
		onReplay(info) {
			ov.prefix = buildPrefix(info.notes);
			loadRatings();
		},
		tick(frame) {
			if (!ov.el || !cfg().enabled || R.overlaysHidden) return;
			if (frame.now - ov.lastUpdate < 66 && !frame.seeked) return; // ~15 Hz is plenty for text
			ov.lastUpdate = frame.now;
			update(frame);
		},
	});
})();
