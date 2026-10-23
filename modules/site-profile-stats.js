/*
 * BeatLeaderPlus – profile statistics drawer (content script, isolated world).
 *
 * Opened from the dock on /u/<id> pages. Loads the player's top 100 PP scores and last 100
 * scores from the public BeatLeader API (through the background worker). For the chosen set
 * (top 100, or recent ranked scores) it shows:
 *   - stat tiles: average / median / best accuracy, FC rate, average stars, top play,
 *     mistakes per play, average cut of the left and right hand
 *   - accuracy vs star rating (every score, with a trend line)
 *   - accuracy distribution
 *   - accuracy and PP over time (every score, with a 10-score average)
 *   - a sortable table of the scores
 *
 * Charts are drawn on <canvas> without a chart library and resize with the drawer, which can be
 * widened from its header. Hovering a chart (or focusing it and using the arrow keys) shows the
 * score, bar or date under the pointer; the table has every value without hovering.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.profileStats) return;
	const U = BLP.utils;
	const t = (k, v) => BLP.i18n.t(k, v);
	const h = U.h;

	const DRAWER_ID = 'blp-stats-drawer';
	const AVG_WINDOW = 10; // scores in the moving average of the over-time charts

	/* ------------------------------------------------------------------ data */

	const accOf = s => (typeof s.accuracy === 'number' ? (s.accuracy <= 1.0001 ? s.accuracy * 100 : s.accuracy) : null);
	const timeOf = s => Number(s.timepost || s.timeset) || 0;

	/** The fields the drawer uses, from a BeatLeader API score. */
	function toRow(s) {
		const lb = s.leaderboard || {};
		const song = lb.song || {};
		const diff = lb.difficulty || s.difficulty || {};
		const mode = diff.modeName && diff.modeName !== 'Standard' ? diff.modeName + ' ' : '';
		const hand = v => (typeof v === 'number' && v > 0 ? v : null);
		return {
			acc: accOf(s),
			pp: Number(s.pp) || 0,
			stars: typeof diff.stars === 'number' && diff.stars > 0 ? diff.stars : null,
			time: timeOf(s),
			fc: !!s.fullCombo,
			mistakes: (s.missedNotes || 0) + (s.badCuts || 0) + (s.bombCuts || 0) + (s.wallsHit || 0),
			left: hand(s.accLeft),
			right: hand(s.accRight),
			song: String(song.name || '?'),
			diff: mode + String(diff.difficultyName || '').replace(/^ExpertPlus$/, 'Expert+'),
			leaderboardId: lb.id || s.leaderboardId || '',
		};
	}

	async function fetchScores(playerId, sortBy) {
		const url = `${U.API_BASE}/player/${encodeURIComponent(playerId)}/scores?sortBy=${sortBy}&order=desc&page=1&count=100`;
		const res = await BLP.send('fetchJson', {url});
		return ((res && (res.data || res.scores)) || []).map(toRow);
	}

	const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

	function median(list) {
		if (!list.length) return null;
		const s = list.slice().sort((a, b) => a - b);
		const m = s.length >> 1;
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	}

	/** Least-squares line through (x, y): {slope, at(x)}, or null without enough spread. */
	function trend(points) {
		if (points.length < 3) return null;
		const mx = mean(points.map(p => p.x));
		const my = mean(points.map(p => p.y));
		let sxx = 0;
		let sxy = 0;
		for (const p of points) {
			sxx += (p.x - mx) ** 2;
			sxy += (p.x - mx) * (p.y - my);
		}
		if (sxx < 0.25) return null;
		const slope = sxy / sxx;
		return {slope, at: x => my + slope * (x - mx)};
	}

	/** Each row of `rows` (oldest first) with the average of `key` over it and the 9 before. */
	function movingAverage(rows, key) {
		return rows.map((r, i) => mean(rows.slice(Math.max(0, i - AVG_WINDOW + 1), i + 1).map(x => x[key])));
	}

	/* ------------------------------------------------------------------ formatting */

	const fmtAcc = v => v.toFixed(2) + '%';
	const fmtPp = v => Math.round(v).toLocaleString() + 'pp';
	const fmtStars = v => v.toFixed(2) + '★';
	const fmtDay = s => new Date(s * 1000).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
	const mapLabel = r => r.song + (r.diff ? ' · ' + r.diff : '');
	const mistakesLabel = r => (r.fc ? t('site.st.fc') : t('site.st.mistakes', {n: r.mistakes}));

	/* ------------------------------------------------------------------ colors */

	function relLum(color) {
		const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim()) || /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(String(color));
		if (!m) return 0;
		const rgb = m.length === 2 ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : [m[1], m[2], m[3]].map(Number);
		const [r, g, b] = rgb.map(v => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	/**
	 * Chart colors for the drawer's background: scores in blue, averages and trends in magenta,
	 * background scores in gray (validated pairs for dark and light surfaces).
	 */
	function palette(el) {
		const cs = getComputedStyle(el);
		const surface = cs.backgroundColor || '#14141c';
		const light = relLum(surface) > 0.4;
		return {
			surface,
			series: light ? '#2a78d6' : '#3987e5',
			emphasis: '#d55181',
			context: light ? '#83818f' : '#727082',
			grid: light ? '#e1e0d9' : '#2c2c38',
			axis: light ? '#6b6a75' : '#9a9ab0',
		};
	}

	/* ------------------------------------------------------------------ scales */

	/** Round tick values covering [min, max], about `count` of them. */
	function niceTicks(min, max, count) {
		if (!(max > min)) max = min + 1;
		const raw = (max - min) / Math.max(1, count);
		const pow = 10 ** Math.floor(Math.log10(raw));
		const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw) || 10 * pow;
		const ticks = [];
		for (let v = Math.floor(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
		if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
		return ticks;
	}

	/** Month (or day, for short spans) boundaries between two times, at most `count`. */
	function timeTicks(t0, t1, count) {
		const days = (t1 - t0) / 86400;
		const ticks = [];
		if (days < 60) {
			const step = [1, 2, 7, 14, 30].find(s => days / s <= count) || 30;
			const d = new Date(t0 * 1000);
			d.setHours(0, 0, 0, 0);
			for (d.setDate(d.getDate() + 1); d.getTime() / 1000 <= t1; d.setDate(d.getDate() + step)) ticks.push({t: d.getTime() / 1000, label: d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})});
			return ticks;
		}
		const months = days / 30.4;
		const step = [1, 2, 3, 6, 12, 24].find(s => months / s <= count) || 24;
		const d = new Date(t0 * 1000);
		d.setHours(0, 0, 0, 0);
		d.setDate(1);
		d.setMonth(d.getMonth() + 1);
		while (d.getMonth() % step) d.setMonth(d.getMonth() + 1);
		for (; d.getTime() / 1000 <= t1; d.setMonth(d.getMonth() + step)) ticks.push({t: d.getTime() / 1000, label: d.toLocaleDateString(undefined, {month: 'short', year: 'numeric'})});
		return ticks;
	}

	/* ------------------------------------------------------------------ chart frame */

	function setupCanvas(canvas, width, height) {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		canvas.style.width = width + 'px';
		canvas.style.height = height + 'px';
		const ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = '11px system-ui, sans-serif';
		ctx.textBaseline = 'middle';
		return ctx;
	}

	/** Gridlines with y labels, and x labels under the plot. */
	function drawAxes(ctx, plot, c, yTicks, Y, yFmt, xTicks, X) {
		ctx.lineWidth = 1;
		ctx.strokeStyle = c.grid;
		ctx.fillStyle = c.axis;
		ctx.textAlign = 'right';
		for (const v of yTicks) {
			const y = Math.round(Y(v)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(plot.l, y);
			ctx.lineTo(plot.r, y);
			ctx.stroke();
			ctx.fillText(yFmt(v), plot.l - 6, y);
		}
		ctx.textAlign = 'center';
		let lastRight = -Infinity;
		for (const tk of xTicks) {
			const x = X(tk.t !== undefined ? tk.t : tk.v);
			const w = ctx.measureText(tk.label).width;
			if (x - w / 2 < lastRight + 8 || x - w / 2 < 0 || x + w / 2 > plot.r + 16) continue;
			ctx.fillText(tk.label, x, plot.b + 14);
			lastRight = x + w / 2;
		}
	}

	function dot(ctx, x, y, r, fill, stroke, c, hollow) {
		ctx.beginPath();
		ctx.arc(x, y, r + 2, 0, Math.PI * 2);
		ctx.fillStyle = c.surface; // 2px surface ring keeps overlapping dots apart
		ctx.fill();
		ctx.beginPath();
		ctx.arc(x, y, hollow ? r - 1 : r, 0, Math.PI * 2);
		if (hollow) {
			ctx.lineWidth = 2;
			ctx.strokeStyle = stroke;
			ctx.stroke();
		} else {
			ctx.fillStyle = fill;
			ctx.fill();
		}
	}

	function line(ctx, points, color) {
		if (points.length < 2) return;
		ctx.lineWidth = 2;
		ctx.lineJoin = ctx.lineCap = 'round';
		ctx.strokeStyle = color;
		ctx.beginPath();
		points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
		ctx.stroke();
	}

	/** Legend: [{kind: 'dot' | 'ring' | 'line' | 'bar', color, label}]. */
	function legend(items) {
		return h(
			'div',
			{class: 'blp-legend'},
			...items.map(it => h('span', {class: 'blp-legend-item'}, h('i', {class: 'blp-key blp-key-' + it.kind, style: '--blp-key:' + it.color}), it.label))
		);
	}

	/**
	 * A chart card: title, note, legend and a canvas with a hover layer. `draw(ctx, w, h, c)`
	 * paints the chart and returns {plot, marks, mode}: each mark {px, py, d} (plus x0/x1 for
	 * bars); mode 'x' snaps to the nearest mark by x (with a crosshair), 'point' to the nearest
	 * dot, 'bar' to the bar under the pointer. `tip(d)` gives the tooltip {title, sub, rows:
	 * [{value, label}]}; `active(ctx, mark, c)` draws the hover highlight.
	 */
	function chartCard({title, note, keys, height, draw, tip, active}) {
		const canvas = h('canvas', {tabindex: '0', role: 'img', 'aria-label': title + (note ? '. ' + note : '')});
		const tooltip = h('div', {class: 'blp-tip', role: 'status', hidden: ''});
		const plotEl = h('div', {class: 'blp-chart-plot'}, canvas, tooltip);
		const el = h('section', {class: 'blp-chart'}, h('h4', null, title), note ? h('p', {class: 'blp-chart-note'}, note) : null, keys ? legend(keys) : null, plotEl);
		let geom = null;
		let current = -1;
		let width = 0;

		function render() {
			width = Math.max(240, Math.floor(plotEl.clientWidth || 380));
			const c = palette(el); // the card's own background, for the rings around dots
			const ctx = setupCanvas(canvas, width, height);
			geom = draw(ctx, width, height, c);
			canvas.dataset.marks = String(geom.marks.length); // what a hover can land on (tests read it)
			if (geom && current >= 0 && geom.marks[current]) {
				const m = geom.marks[current];
				if (geom.mode === 'x') {
					ctx.strokeStyle = c.axis;
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.moveTo(Math.round(m.px) + 0.5, geom.plot.t);
					ctx.lineTo(Math.round(m.px) + 0.5, geom.plot.b);
					ctx.stroke();
				}
				active(ctx, m, c, geom);
			}
		}

		function showTip() {
			const m = geom && geom.marks[current];
			if (!m) {
				tooltip.hidden = true;
				return;
			}
			const info = tip(m.d);
			tooltip.textContent = '';
			tooltip.appendChild(h('div', {class: 'blp-tip-title'}, info.title));
			if (info.sub) tooltip.appendChild(h('div', {class: 'blp-tip-sub'}, info.sub));
			for (const row of info.rows) tooltip.appendChild(h('div', {class: 'blp-tip-row'}, h('strong', null, row.value), row.label ? h('span', null, row.label) : null));
			tooltip.hidden = false;
			const tw = tooltip.offsetWidth;
			const th = tooltip.offsetHeight;
			const x = m.px + 14 + tw > width ? m.px - 14 - tw : m.px + 14;
			const anchorY = geom.mode === 'bar' ? geom.plot.t : m.py;
			const y = Math.min(Math.max(0, anchorY - th / 2), height - th);
			tooltip.style.left = Math.max(0, x) + 'px';
			tooltip.style.top = y + 'px';
		}

		function select(i) {
			if (i === current) return;
			current = i;
			render();
			showTip();
		}

		function nearest(px, py) {
			if (!geom || !geom.marks.length) return -1;
			const {plot, marks, mode} = geom;
			if (py < plot.t - 12 || py > plot.b + 12 || px < plot.l - 16 || px > plot.r + 16) return -1;
			if (mode === 'bar') return marks.findIndex(m => px >= m.x0 && px < m.x1);
			let best = -1;
			let bestD = Infinity;
			marks.forEach((m, i) => {
				const d = mode === 'x' ? Math.abs(m.px - px) : Math.hypot(m.px - px, m.py - py);
				if (d < bestD) {
					bestD = d;
					best = i;
				}
			});
			// A dot only has to be the closest within 24px; the crosshair takes any x.
			return mode === 'point' && bestD > 24 ? -1 : best;
		}

		canvas.addEventListener('pointermove', e => {
			const r = canvas.getBoundingClientRect();
			select(nearest(e.clientX - r.left, e.clientY - r.top));
		});
		canvas.addEventListener('pointerleave', () => select(-1));
		canvas.addEventListener('blur', () => select(-1));
		canvas.addEventListener('keydown', e => {
			if (!geom || !geom.marks.length) return;
			const n = geom.marks.length;
			const move = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[e.key];
			if (move) select(current < 0 ? (move > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, current + move)));
			else if (e.key === 'Home') select(0);
			else if (e.key === 'End') select(n - 1);
			else if (e.key === 'Escape') select(-1);
			else return;
			e.preventDefault();
		});
		return {el, render, marks: () => (geom ? geom.marks : []), select};
	}

	/* ------------------------------------------------------------------ the charts */

	const PAD = {l: 46, r: 14, t: 12, b: 26};

	function plotOf(w, hgt) {
		return {l: PAD.l, r: w - PAD.r, t: PAD.t, b: hgt - PAD.b};
	}

	function noData(ctx, plot, c) {
		ctx.fillStyle = c.axis;
		ctx.textAlign = 'center';
		ctx.fillText(t('site.noData'), (plot.l + plot.r) / 2, (plot.t + plot.b) / 2);
		return {plot, marks: [], mode: 'point'};
	}

	/** Accuracy against star rating: one dot per score (filled = full combo) and a trend line. */
	function accVsStars(rows) {
		const pts = rows.filter(r => r.stars !== null).sort((a, b) => a.stars - b.stars); // arrow keys go by stars
		const fit = trend(pts.map(r => ({x: r.stars, y: r.acc})));
		const note = fit ? t('site.st.trendNote', {n: (fit.slope >= 0 ? '+' : '') + fit.slope.toFixed(2)}) : t('site.st.eachScore');
		return chartCard({
			title: t('site.st.accVsStars'),
			note,
			keys: [
				{kind: 'dot', color: 'var(--blp-viz-series)', label: t('site.st.fc')},
				{kind: 'ring', color: 'var(--blp-viz-series)', label: t('site.st.withMistakes')},
				fit ? {kind: 'line', color: 'var(--blp-viz-emphasis)', label: t('site.st.trend')} : null,
			].filter(Boolean),
			height: 220,
			draw(ctx, w, hgt, c) {
				const plot = plotOf(w, hgt);
				if (!pts.length) return noData(ctx, plot, c);
				const xs = pts.map(r => r.stars);
				const ys = pts.map(r => r.acc);
				const xt = niceTicks(Math.min(...xs) - 0.2, Math.max(...xs) + 0.2, Math.max(3, Math.floor((plot.r - plot.l) / 70)));
				const yt = niceTicks(Math.min(...ys) - 0.3, Math.min(100, Math.max(...ys) + 0.3), 4);
				const X = v => plot.l + ((v - xt[0]) / (xt[xt.length - 1] - xt[0])) * (plot.r - plot.l);
				const Y = v => plot.b - ((v - yt[0]) / (yt[yt.length - 1] - yt[0])) * (plot.b - plot.t);
				drawAxes(ctx, plot, c, yt, Y, v => v + '%', xt.map(v => ({v, label: v + '★'})), X);
				const marks = pts.map(r => ({px: X(r.stars), py: Y(r.acc), d: r}));
				for (const m of marks) dot(ctx, m.px, m.py, 4, c.series, c.series, c, !m.d.fc);
				if (fit) line(ctx, [[X(xt[0]), Y(fit.at(xt[0]))], [X(xt[xt.length - 1]), Y(fit.at(xt[xt.length - 1]))]].map(([x, y]) => [x, Math.min(plot.b, Math.max(plot.t, y))]), c.emphasis);
				return {plot, marks, mode: 'point'};
			},
			tip: r => ({title: r.song, sub: [r.diff, fmtStars(r.stars)].filter(Boolean).join(' · '), rows: [{value: fmtAcc(r.acc), label: t('site.st.accuracy')}, {value: fmtPp(r.pp)}, {value: mistakesLabel(r)}, {value: fmtDay(r.time)}]}),
			active(ctx, m, c) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = c.axis;
				ctx.beginPath();
				ctx.arc(m.px, m.py, 8, 0, Math.PI * 2);
				ctx.stroke();
			},
		});
	}

	/** How many scores fall in each accuracy band (1% wide, 2% for a wide spread). */
	function distribution(rows) {
		const accs = rows.map(r => r.acc).sort((a, b) => a - b);
		const lo = Math.floor(accs[Math.floor(accs.length * 0.05)]);
		const top = Math.min(100, Math.floor(accs[accs.length - 1]) + 1);
		const size = top - lo > 12 ? 2 : 1;
		const bins = [];
		if (accs[0] < lo) bins.push({from: -Infinity, to: lo, label: '<' + lo, n: 0, stars: []});
		for (let v = lo; v < top; v += size) bins.push({from: v, to: Math.min(top, v + size), label: String(v), n: 0, stars: []});
		for (const r of rows) {
			const b = bins.find(x => r.acc >= x.from && (r.acc < x.to || (x.to === top && r.acc <= top)));
			if (!b) continue;
			b.n++;
			if (r.stars !== null) b.stars.push(r.stars);
		}
		return chartCard({
			title: t('site.accDistribution'),
			note: t('site.st.distNote'),
			height: 190,
			draw(ctx, w, hgt, c) {
				const plot = plotOf(w, hgt);
				const yt = niceTicks(0, Math.max(...bins.map(b => b.n)), 4);
				const Y = v => plot.b - (v / yt[yt.length - 1]) * (plot.b - plot.t);
				const slot = (plot.r - plot.l) / bins.length;
				const bw = Math.min(24, slot - 2); // thin bars; the slot's leftover is air
				const X = i => plot.l + slot * i + slot / 2;
				drawAxes(ctx, plot, c, yt, Y, v => String(v), bins.map((b, i) => ({v: i, label: b.label})), X);
				const marks = bins.map((b, i) => ({px: X(i), py: Y(b.n), x0: plot.l + slot * i, x1: plot.l + slot * (i + 1), bw, d: b}));
				ctx.fillStyle = c.series;
				for (const m of marks) roundedBar(ctx, m.px - bw / 2, m.py, bw, plot.b - m.py);
				// Label the tallest bar only; the others are in the tooltip and the axis.
				const tallest = marks.reduce((a, b) => (b.d.n > a.d.n ? b : a), marks[0]);
				if (tallest && tallest.d.n) {
					ctx.fillStyle = c.axis;
					ctx.textAlign = 'center';
					ctx.fillText(String(tallest.d.n), tallest.px, Math.max(plot.t + 6, tallest.py - 9));
				}
				return {plot, marks, mode: 'bar'};
			},
			tip: b => ({
				title: b.from === -Infinity ? t('site.st.below', {n: b.to}) : b.from + '–' + b.to + '%',
				rows: [{value: String(b.n), label: t('site.st.scores')}, {value: Math.round((b.n / rows.length) * 100) + '%', label: t('site.st.ofScores')}, b.stars.length ? {value: fmtStars(mean(b.stars)), label: t('site.st.avgStarsShort')} : null].filter(Boolean),
			}),
			active(ctx, m, c, g) {
				ctx.globalAlpha = 0.18;
				ctx.fillStyle = c.axis;
				ctx.fillRect(m.x0 + 1, g.plot.t, m.x1 - m.x0 - 2, g.plot.b - g.plot.t);
				ctx.globalAlpha = 1;
			},
		});
	}

	function roundedBar(ctx, x, y, w, hgt) {
		if (hgt <= 0) return;
		const r = Math.min(4, w / 2, hgt);
		ctx.beginPath();
		ctx.moveTo(x, y + hgt);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + r);
		ctx.lineTo(x + w, y + hgt);
		ctx.closePath();
		ctx.fill();
	}

	/** A value per score over time (gray dots) with its 10-score average (magenta line). */
	function overTime(rows, {title, key, fmt, axisFmt}) {
		const chrono = rows.filter(r => r.time > 0).sort((a, b) => a.time - b.time);
		const avg = movingAverage(chrono, key);
		return chartCard({
			title,
			keys: [
				{kind: 'dot', color: 'var(--blp-viz-context)', label: t('site.st.score')},
				{kind: 'line', color: 'var(--blp-viz-emphasis)', label: t('site.st.average', {n: AVG_WINDOW})},
			],
			height: 200,
			draw(ctx, w, hgt, c) {
				const plot = plotOf(w, hgt);
				if (!chrono.length) return noData(ctx, plot, c);
				let t0 = chrono[0].time;
				let t1 = chrono[chrono.length - 1].time;
				if (t1 - t0 < 86400) {
					t0 -= 43200;
					t1 += 43200;
				}
				const vals = chrono.map(r => r[key]);
				const span = Math.max(...vals) - Math.min(...vals) || 1;
				const yt = niceTicks(Math.min(...vals) - span * 0.05, Math.max(...vals) + span * 0.05, 4);
				const X = v => plot.l + ((v - t0) / (t1 - t0)) * (plot.r - plot.l);
				const Y = v => plot.b - ((v - yt[0]) / (yt[yt.length - 1] - yt[0])) * (plot.b - plot.t);
				drawAxes(ctx, plot, c, yt, Y, axisFmt, timeTicks(t0, t1, Math.max(2, Math.floor((plot.r - plot.l) / 75))), X);
				const marks = chrono.map((r, i) => ({px: X(r.time), py: Y(r[key]), ay: Y(avg[i]), d: {r, avg: avg[i]}}));
				for (const m of marks) dot(ctx, m.px, m.py, 4, c.context, c.context, c);
				line(
					ctx,
					marks.map(m => [m.px, m.ay]),
					c.emphasis
				);
				return {plot, marks, mode: 'x'};
			},
			tip: ({r, avg: a}) => ({
				title: r.song,
				sub: [r.diff, r.stars !== null ? fmtStars(r.stars) : '', fmtDay(r.time)].filter(Boolean).join(' · '),
				rows: [
					{value: fmt(r[key]), label: key === 'acc' ? t('site.st.accuracy') : t('site.st.thisScore')},
					{value: fmt(a), label: t('site.st.average', {n: AVG_WINDOW}).toLowerCase()},
					key === 'acc' ? {value: fmtPp(r.pp)} : {value: fmtAcc(r.acc), label: t('site.st.accuracy')},
				],
			}),
			active(ctx, m, c) {
				dot(ctx, m.px, m.py, 5, c.series, c.series, c);
				dot(ctx, m.px, m.ay, 4, c.emphasis, c.emphasis, c);
			},
		});
	}

	/* ------------------------------------------------------------------ tiles and table */

	function tile(label, value, title) {
		return h('div', {class: 'blp-tile', title: title || ''}, h('div', {class: 'blp-tile-value'}, value), h('div', {class: 'blp-tile-label'}, label));
	}

	function tiles(rows) {
		const accs = rows.map(r => r.acc);
		const stars = rows.map(r => r.stars).filter(v => v !== null);
		const best = rows.reduce((a, b) => (b.pp > a.pp ? b : a), rows[0]);
		const hands = rows.filter(r => r.left !== null && r.right !== null);
		const list = [
			tile(t('site.avgAcc'), fmtAcc(mean(accs))),
			tile(t('site.medianAcc'), fmtAcc(median(accs))),
			tile(t('site.st.bestAcc'), fmtAcc(Math.max(...accs))),
			tile(t('site.fcRate'), Math.round((rows.filter(r => r.fc).length / rows.length) * 100) + '%'),
			tile(t('site.avgStars'), stars.length ? fmtStars(mean(stars)) : '—'),
			tile(t('site.st.topPlay'), best.pp > 0 ? fmtPp(best.pp) : '—', mapLabel(best)),
			tile(t('site.st.mistakesPerPlay'), mean(rows.map(r => r.mistakes)).toFixed(1)),
		];
		if (hands.length) {
			list.push(tile(t('site.st.leftHand'), mean(hands.map(r => r.left)).toFixed(1), t('site.st.handsTitle')));
			list.push(tile(t('site.st.rightHand'), mean(hands.map(r => r.right)).toFixed(1), t('site.st.handsTitle')));
		}
		return h('div', {class: 'blp-tiles'}, ...list);
	}

	/** Every score of the set, sortable by clicking a column. */
	function scoreTable(rows) {
		const cols = [
			{key: 'song', label: t('site.st.map'), fmt: r => mapLabel(r), num: false},
			{key: 'stars', label: '★', fmt: r => (r.stars !== null ? r.stars.toFixed(2) : '—'), num: true},
			{key: 'acc', label: t('site.st.accuracy'), fmt: r => fmtAcc(r.acc), num: true},
			{key: 'pp', label: 'PP', fmt: r => Math.round(r.pp).toLocaleString(), num: true},
			{key: 'mistakes', label: t('site.st.mistakesShort'), fmt: r => (r.fc ? 'FC' : String(r.mistakes)), num: true},
			{key: 'time', label: t('site.statDate'), fmt: r => (r.time ? fmtDay(r.time) : '—'), num: true},
		];
		let sortKey = 'pp';
		let dir = -1;
		const tbody = h('tbody');
		const head = h('tr');
		const fill = () => {
			const sorted = rows.slice().sort((a, b) => {
				const x = a[sortKey];
				const y = b[sortKey];
				if (x === y) return 0;
				if (x === null) return 1;
				if (y === null) return -1;
				return (x < y ? -1 : 1) * dir;
			});
			tbody.textContent = '';
			for (const r of sorted) {
				tbody.appendChild(
					h(
						'tr',
						null,
						...cols.map(c => {
							const text = c.fmt(r);
							if (c.key === 'song' && r.leaderboardId) return h('td', null, h('a', {href: `/leaderboard/global/${encodeURIComponent(r.leaderboardId)}/1`}, text));
							return h('td', {class: c.num ? 'blp-num' : ''}, text);
						})
					)
				);
			}
			Array.from(head.children).forEach((th, i) => th.setAttribute('aria-sort', cols[i].key === sortKey ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
		};
		for (const c of cols) {
			head.appendChild(
				h(
					'th',
					{class: c.num ? 'blp-num' : ''},
					h(
						'button',
						{
							type: 'button',
							onclick: () => {
								dir = sortKey === c.key ? -dir : c.num ? -1 : 1;
								sortKey = c.key;
								fill();
							},
						},
						c.label
					)
				)
			);
		}
		fill();
		return h('details', {class: 'blp-scores'}, h('summary', null, t('site.st.table', {n: rows.length})), h('div', {class: 'blp-scores-wrap'}, h('table', {class: 'blp-cmp-table blp-scores-table'}, h('thead', null, head), tbody)));
	}

	/* ------------------------------------------------------------------ drawer */

	const SETS = ['top', 'recent'];
	let state = null; // {playerId, top, recent, set, charts}

	function rowsOf(set) {
		const all = state[set].filter(r => r.acc !== null);
		const ranked = all.filter(r => r.pp > 0);
		return ranked.length ? ranked : all;
	}

	function renderSet(drawer, body) {
		const rows = rowsOf(state.set);
		body.textContent = '';
		body.appendChild(
			h(
				'div',
				{class: 'blp-seg', role: 'group', 'aria-label': t('site.st.show')},
				...SETS.map(s =>
					h(
						'button',
						{
							type: 'button',
							class: 'blp-seg-btn' + (s === state.set ? ' blp-on' : ''),
							'aria-pressed': String(s === state.set),
							onclick: () => {
								if (state.set === s) return;
								state.set = s;
								renderSet(drawer, body);
							},
						},
						t('site.st.set.' + s)
					)
				)
			)
		);
		if (!rows.length) {
			body.appendChild(h('p', {class: 'blp-muted'}, t('site.noData')));
			return;
		}
		body.appendChild(h('p', {class: 'blp-muted'}, t('site.st.basis.' + state.set, {n: rows.length})));
		body.appendChild(tiles(rows));
		// Legend keys use the same colors as the marks (dark or light steps, by the background).
		const c = palette(drawer);
		for (const k of ['series', 'emphasis', 'context']) drawer.style.setProperty('--blp-viz-' + k, c[k]);
		state.charts = [
			accVsStars(rows),
			distribution(rows),
			overTime(rows, {title: t('site.st.accOverTime'), key: 'acc', fmt: fmtAcc, axisFmt: v => +v.toFixed(2) + '%'}),
			overTime(rows, {title: t('site.st.ppOverTime'), key: 'pp', fmt: fmtPp, axisFmt: v => Math.round(v) + 'pp'}),
		];
		const grid = h('div', {class: 'blp-charts'}, ...state.charts.map(c => c.el));
		body.appendChild(grid);
		body.appendChild(h('p', {class: 'blp-muted blp-chart-help'}, t('site.st.help')));
		body.appendChild(scoreTable(rows));
		requestAnimationFrame(() => state && state.charts.forEach(c => c.render()));
	}

	async function load(drawer, body, playerId) {
		body.textContent = t('common.loading');
		try {
			const [top, recent] = await Promise.all([fetchScores(playerId, 'pp'), fetchScores(playerId, 'date')]);
			if (!state || state.playerId !== playerId) return;
			Object.assign(state, {top, recent});
		} catch (e) {
			body.textContent = t('site.loadFailed') + ' ' + e.message;
			return;
		}
		renderSet(drawer, body);
	}

	let resizeObserver = null;

	/** Two diagonal arrows, pointing out (widen) or in (narrow). */
	function sizeIcon(wide) {
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS(NS, 'path');
		path.setAttribute('d', wide ? 'M10 4v6H4M10 10 4 4M14 20v-6h6M14 14l6 6' : 'M4 10V4h6M4 4l6 6M20 14v6h-6M20 20l-6-6');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '2');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		return svg;
	}

	function setWide(drawer, wide) {
		drawer.classList.toggle('blp-wide', wide);
		const btn = drawer.querySelector('.blp-wide-btn');
		if (btn) {
			btn.setAttribute('aria-pressed', String(wide));
			btn.title = wide ? t('site.st.narrow') : t('site.st.wide');
			btn.textContent = '';
			btn.appendChild(sizeIcon(wide));
		}
	}

	BLP.profileStats = {
		open(playerId, name) {
			this.close();
			const body = h('div', {class: 'blp-drawer-body'});
			const drawer = h(
				'aside',
				{id: DRAWER_ID, class: 'blp-drawer blp-stats', 'data-blp-ui': '', role: 'dialog', 'aria-label': t('site.profileStats')},
				h(
					'div',
					{class: 'blp-drawer-head'},
					h('strong', null, t('site.profileStats') + (name ? ' · ' + name : '')),
					h(
						'span',
						{class: 'blp-drawer-tools'},
						h(
							'button',
							{
								class: 'blp-btn blp-icon-btn blp-wide-btn',
								type: 'button',
								'aria-pressed': 'false',
								title: t('site.st.wide'),
								onclick: () => {
									const wide = !drawer.classList.contains('blp-wide');
									setWide(drawer, wide);
									BLP.storage.updateLocal(BLP.defaults.KEYS.siteUi, {}, ui => Object.assign(ui, {statsWide: wide})).catch(() => {});
								},
							},
							sizeIcon(false)
						),
						h('button', {class: 'blp-btn blp-icon-btn', type: 'button', title: t('common.close'), onclick: () => this.close()}, '✕')
					)
				),
				body
			);
			document.body.appendChild(drawer);
			state = {playerId, top: [], recent: [], set: 'top', charts: []};
			BLP.storage
				.getLocal(BLP.defaults.KEYS.siteUi, {})
				.then(ui => setWide(drawer, !!(ui && ui.statsWide)))
				.catch(() => {});
			// Charts follow the drawer's width (window resize, wide mode).
			let pending = 0;
			resizeObserver = new ResizeObserver(() => {
				window.cancelAnimationFrame(pending);
				pending = requestAnimationFrame(() => state && state.charts.forEach(c => c.render()));
			});
			resizeObserver.observe(body);
			requestAnimationFrame(() => drawer.classList.add('blp-open'));
			load(drawer, body, playerId);
		},
		close() {
			if (resizeObserver) resizeObserver.disconnect();
			resizeObserver = null;
			state = null;
			const d = document.getElementById(DRAWER_ID);
			if (d) d.remove();
		},
	};
})();
