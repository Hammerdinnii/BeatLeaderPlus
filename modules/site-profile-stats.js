/*
 * BeatLeaderPlus – profile statistics drawer (content script, isolated world).
 *
 * Opened from the dock on /u/<id> pages. Uses the public BeatLeader API (through the
 * background worker) to compute:
 *   - summary tiles (average / median accuracy, FC rate, average stars)
 *   - accuracy distribution of the player's top 100 PP scores
 *   - personal bests over time (top scores by date with a "best PP so far" line)
 *   - recent accuracy trend (last 100 scores with a rolling average)
 * Charts are drawn on <canvas> without any chart library.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.profileStats) return;
	const U = BLP.utils;
	const t = (k, v) => BLP.i18n.t(k, v);
	const h = U.h;

	const DRAWER_ID = 'blp-stats-drawer';

	function css(name, fallback) {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return v || fallback;
	}

	function palette() {
		return {
			primary: css('--blp-primary', '#ff3d9a'),
			accent: css('--blp-accent', '#40c4ff'),
			text: css('--blp-text', '#ececf4'),
			muted: css('--blp-muted', '#9a9ab0'),
			grid: css('--blp-border', '#2c2c3a'),
			good: css('--blp-success', '#4cd964'),
			bad: css('--blp-danger', '#ff5370'),
		};
	}

	function setupCanvas(canvas, width, height) {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		canvas.style.width = width + 'px';
		canvas.style.height = height + 'px';
		const ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = '11px system-ui, sans-serif';
		return ctx;
	}

	function drawHistogram(canvas, bins, labels) {
		const W = 380;
		const H = 170;
		const ctx = setupCanvas(canvas, W, H);
		const p = palette();
		const pad = {l: 28, r: 8, t: 10, b: 26};
		const max = Math.max(1, ...bins);
		const bw = (W - pad.l - pad.r) / bins.length;
		ctx.strokeStyle = p.grid;
		ctx.fillStyle = p.muted;
		for (let i = 0; i <= 4; i++) {
			const y = pad.t + ((H - pad.t - pad.b) * i) / 4;
			ctx.globalAlpha = 0.5;
			ctx.beginPath();
			ctx.moveTo(pad.l, y);
			ctx.lineTo(W - pad.r, y);
			ctx.stroke();
			ctx.globalAlpha = 1;
			ctx.fillText(String(Math.round(max - (max * i) / 4)), 2, y + 4);
		}
		bins.forEach((v, i) => {
			const bh = ((H - pad.t - pad.b) * v) / max;
			const x = pad.l + i * bw + 2;
			const y = H - pad.b - bh;
			const g = ctx.createLinearGradient(0, y, 0, H - pad.b);
			g.addColorStop(0, p.primary);
			g.addColorStop(1, p.accent);
			ctx.fillStyle = g;
			ctx.fillRect(x, y, bw - 4, bh);
			ctx.fillStyle = p.muted;
			ctx.save();
			ctx.translate(x + (bw - 4) / 2, H - pad.b + 12);
			ctx.textAlign = 'center';
			ctx.fillText(labels[i], 0, 0);
			ctx.restore();
		});
	}

	function drawTimeSeries(canvas, points, opts) {
		const W = 380;
		const H = 180;
		const ctx = setupCanvas(canvas, W, H);
		const p = palette();
		const pad = {l: 40, r: 10, t: 10, b: 24};
		if (!points.length) {
			ctx.fillStyle = p.muted;
			ctx.fillText(t('site.noData'), W / 2 - 40, H / 2);
			return;
		}
		const xs = points.map(pt => pt.x);
		const ys = points.map(pt => pt.y).concat(opts.line ? opts.line.map(pt => pt.y) : []);
		let x0 = Math.min(...xs);
		let x1 = Math.max(...xs);
		if (x1 === x0) x1 = x0 + 1;
		let y0 = opts.yMin !== undefined ? opts.yMin : Math.min(...ys);
		let y1 = opts.yMax !== undefined ? opts.yMax : Math.max(...ys);
		if (y1 === y0) y1 = y0 + 1;
		const X = x => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
		const Y = y => H - pad.b - ((y - y0) / (y1 - y0)) * (H - pad.t - pad.b);

		ctx.strokeStyle = p.grid;
		ctx.fillStyle = p.muted;
		for (let i = 0; i <= 4; i++) {
			const v = y0 + ((y1 - y0) * i) / 4;
			const y = Y(v);
			ctx.globalAlpha = 0.5;
			ctx.beginPath();
			ctx.moveTo(pad.l, y);
			ctx.lineTo(W - pad.r, y);
			ctx.stroke();
			ctx.globalAlpha = 1;
			ctx.fillText(opts.yFormat(v), 2, y + 4);
		}
		const fmtDate = s => new Date(s * 1000).toLocaleDateString(undefined, {month: 'short', year: '2-digit'});
		ctx.fillText(fmtDate(x0), pad.l, H - 6);
		ctx.textAlign = 'right';
		ctx.fillText(fmtDate(x1), W - pad.r, H - 6);
		ctx.textAlign = 'left';

		for (const pt of points) {
			ctx.fillStyle = pt.color || p.accent;
			ctx.globalAlpha = 0.85;
			ctx.beginPath();
			ctx.arc(X(pt.x), Y(pt.y), pt.r || 2.5, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
		if (opts.line && opts.line.length) {
			ctx.strokeStyle = p.primary;
			ctx.lineWidth = 2;
			ctx.beginPath();
			opts.line.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Y(pt.y)) : ctx.moveTo(X(pt.x), Y(pt.y))));
			ctx.stroke();
		}
	}

	const accOf = s => (typeof s.accuracy === 'number' ? (s.accuracy <= 1.0001 ? s.accuracy * 100 : s.accuracy) : null);
	const timeOf = s => Number(s.timepost || s.timeset) || 0;
	const starsOf = s => {
		const d = (s.leaderboard && s.leaderboard.difficulty) || s.difficulty || {};
		return typeof d.stars === 'number' ? d.stars : null;
	};

	function accColor(acc) {
		const p = palette();
		if (acc >= 97) return '#ffffff';
		if (acc >= 95) return p.accent;
		if (acc >= 93) return p.good;
		if (acc >= 90) return '#ffd54f';
		return p.bad;
	}

	async function fetchScores(playerId, sortBy) {
		const url = `${U.API_BASE}/player/${encodeURIComponent(playerId)}/scores?sortBy=${sortBy}&order=desc&page=1&count=100`;
		const res = await BLP.send('fetchJson', {url});
		return (res && (res.data || res.scores)) || [];
	}

	function tile(label, value) {
		return h('div', {class: 'blp-tile'}, h('div', {class: 'blp-tile-value'}, value), h('div', {class: 'blp-tile-label'}, label));
	}

	async function render(body, playerId) {
		body.textContent = t('common.loading');
		let top;
		let recent;
		try {
			[top, recent] = await Promise.all([fetchScores(playerId, 'pp'), fetchScores(playerId, 'date')]);
		} catch (e) {
			body.textContent = t('site.loadFailed') + ' ' + e.message;
			return;
		}
		body.textContent = '';
		const ranked = top.filter(s => accOf(s) !== null && (s.pp || 0) > 0);
		const base = ranked.length ? ranked : top.filter(s => accOf(s) !== null);
		if (!base.length) {
			body.textContent = t('site.noData');
			return;
		}
		const accs = base.map(accOf).sort((a, b) => a - b);
		const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
		const median = accs.length % 2 ? accs[(accs.length - 1) / 2] : (accs[accs.length / 2 - 1] + accs[accs.length / 2]) / 2;
		const fcRate = (base.filter(s => s.fullCombo).length / base.length) * 100;
		const stars = base.map(starsOf).filter(v => v !== null);
		const avgStars = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null;

		body.appendChild(
			h(
				'div',
				{class: 'blp-tiles'},
				tile(t('site.avgAcc'), avg.toFixed(2) + '%'),
				tile(t('site.medianAcc'), median.toFixed(2) + '%'),
				tile(t('site.fcRate'), fcRate.toFixed(0) + '%'),
				tile(t('site.avgStars'), avgStars !== null ? avgStars.toFixed(2) + '★' : '—')
			)
		);
		body.appendChild(h('p', {class: 'blp-muted'}, t('site.scoresAnalyzed', {n: base.length})));

		// Accuracy distribution
		const labels = ['<90', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
		const bins = new Array(labels.length).fill(0);
		for (const a of accs) {
			if (a < 90) bins[0]++;
			else bins[Math.min(10, Math.floor(a) - 89)]++;
		}
		const histCanvas = h('canvas');
		body.appendChild(h('h4', null, t('site.accDistribution')));
		body.appendChild(histCanvas);
		drawHistogram(histCanvas, bins, labels);

		// Personal bests over time: top scores by date + best-so-far PP line
		const pbPoints = base
			.filter(s => timeOf(s) > 0 && s.pp > 0)
			.map(s => ({x: timeOf(s), y: s.pp, color: accColor(accOf(s)), r: 2 + Math.min(4, (s.pp / (base[0].pp || 1)) * 4)}))
			.sort((a, b) => a.x - b.x);
		let best = 0;
		const bestLine = pbPoints.map(pt => {
			best = Math.max(best, pt.y);
			return {x: pt.x, y: best};
		});
		const pbCanvas = h('canvas');
		body.appendChild(h('h4', null, t('site.pbOverTime')));
		body.appendChild(pbCanvas);
		drawTimeSeries(pbCanvas, pbPoints, {line: bestLine, yMin: 0, yFormat: v => Math.round(v) + 'pp'});

		// Recent accuracy trend with rolling average
		const rec = recent
			.filter(s => accOf(s) !== null && timeOf(s) > 0)
			.map(s => ({x: timeOf(s), y: accOf(s), color: accColor(accOf(s))}))
			.sort((a, b) => a.x - b.x);
		const rolling = rec.map((pt, i) => {
			const win = rec.slice(Math.max(0, i - 9), i + 1);
			return {x: pt.x, y: win.reduce((a, b) => a + b.y, 0) / win.length};
		});
		const recCanvas = h('canvas');
		body.appendChild(h('h4', null, t('f.overlay.stats.accuracy') + ' · ' + t('site.statDate')));
		body.appendChild(recCanvas);
		const minAcc = rec.length ? Math.max(0, Math.floor(Math.min(...rec.map(r => r.y)) - 1)) : 80;
		drawTimeSeries(recCanvas, rec, {line: rolling, yMin: minAcc, yMax: 100, yFormat: v => v.toFixed(0) + '%'});
	}

	BLP.profileStats = {
		open(playerId, name) {
			this.close();
			const body = h('div', {class: 'blp-drawer-body'});
			const drawer = h(
				'aside',
				{id: DRAWER_ID, class: 'blp-drawer', 'data-blp-ui': ''},
				h(
					'div',
					{class: 'blp-drawer-head'},
					h('strong', null, t('site.profileStats') + (name ? ' · ' + name : '')),
					h('button', {class: 'blp-btn blp-icon-btn', type: 'button', title: t('common.close'), onclick: () => this.close()}, '✕')
				),
				body
			);
			document.body.appendChild(drawer);
			requestAnimationFrame(() => drawer.classList.add('blp-open'));
			render(body, playerId);
		},
		close() {
			const d = document.getElementById(DRAWER_ID);
			if (d) d.remove();
		},
	};
})();
