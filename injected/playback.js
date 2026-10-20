/*
 * BeatLeaderPlus – playback controls (PAGE world).
 *
 *   - frame-by-frame stepping (next recorded replay frame, or a fixed step)
 *   - reverse playback (paused, scrubbing backwards at a configurable rate)
 *   - A-B section loop with optional pre-roll
 *   - bookmarks with notes, stored per replay and drawn on the timeline
 *   - automatic slow motion around misses / bad cuts / bombs / low-accuracy cuts
 *   - fine speed control (hotkeys, mouse wheel), remembered speed and jump distance
 *   - accuracy graph above the official timeline
 *
 * Speed changes go through BLPR.api.setSpeed which keeps song-controls' baseSongSpeed in sync
 * (song-controls re-applies that value every frame).
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('playback')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	let ctx = null;
	const pb = {
		reverse: {active: false, timer: null},
		loop: {a: null, b: null},
		bookmarks: {key: null, title: '', scoreId: null, items: []},
		slow: {windows: [], active: false, saved: null},
		burst: {timer: null, saved: null},
		lastKnownSpeed: null,
		restoredFor: null,
		tl: null,
	};

	const cfg = () => R.settings.playback;
	const fmt = sec => U.formatTime(sec, true);

	/* ------------------------------------------------------------------ frame stepping */

	function frameStep(dir) {
		stopReverse();
		R.api.pause();
		const now = R.api.time();
		const replay = R.api.replay();
		let target;
		if (cfg().frameStepMode === 'replay' && replay && replay.frames && replay.frames.length > 1) {
			const frames = replay.frames;
			let lo = 0;
			let hi = frames.length - 1;
			let idx = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (frames[mid].time <= now + 1e-4) {
					idx = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			if (dir > 0) target = frames[Math.min(frames.length - 1, idx + 1)].time;
			else target = frames[idx].time < now - 1e-4 ? frames[idx].time : frames[Math.max(0, idx - 1)].time;
		} else {
			target = now + (dir * (Number(cfg().frameStepMs) || 16.7)) / 1000;
		}
		R.api.seek(target);
	}

	/* ------------------------------------------------------------------ reverse */

	function startReverse() {
		if (pb.reverse.active) return;
		R.api.pause();
		pb.reverse.active = true;
		const rate = U.clamp(Number(cfg().reverseRate) || 30, 5, 60);
		pb.reverse.timer = setInterval(() => {
			if (!pb.reverse.active) return;
			if (R.api.isPlaying()) return stopReverse();
			if (R.api.seekBusy()) return;
			const next = R.api.time() - (Number(cfg().reverseSpeed) || 1) / rate;
			if (next <= 0) {
				R.api.seek(0);
				stopReverse();
				return;
			}
			R.api.seek(next);
		}, 1000 / rate);
		R.api.notify(t('r.reverseOn'), 'fas fa-backward');
		R.ui && R.ui.refreshPanel(true);
	}

	function stopReverse(announce) {
		if (!pb.reverse.active) return;
		pb.reverse.active = false;
		clearInterval(pb.reverse.timer);
		pb.reverse.timer = null;
		if (announce) R.api.notify(t('r.reverseOff'), 'fas fa-pause');
		R.ui && R.ui.refreshPanel(true);
	}

	const toggleReverse = () => (pb.reverse.active ? stopReverse(true) : startReverse());

	/* ------------------------------------------------------------------ loop */

	function setLoopA(time = R.api.time()) {
		pb.loop.a = time;
		if (pb.loop.b !== null && pb.loop.b <= time) pb.loop.b = null;
		R.api.notify(t('r.loopA', {time: fmt(time)}), 'fas fa-repeat');
		loopChanged();
	}

	function setLoopB(time = R.api.time()) {
		if (pb.loop.a === null) return setLoopA(time);
		if (time < pb.loop.a) [pb.loop.a, time] = [time, pb.loop.a];
		if (time - pb.loop.a < 0.05) return;
		pb.loop.b = time;
		R.api.notify(t('r.loopB', {a: fmt(pb.loop.a), b: fmt(pb.loop.b)}), 'fas fa-repeat');
		loopChanged();
	}

	function clearLoop(silent) {
		pb.loop.a = pb.loop.b = null;
		if (!silent) R.api.notify(t('r.loopCleared'), 'fas fa-xmark');
		loopChanged();
	}

	function loopCycle() {
		if (pb.loop.a === null) setLoopA();
		else if (pb.loop.b === null) setLoopB();
		else clearLoop();
	}

	function loopChanged() {
		drawTimeline();
		R.ui && R.ui.refreshPanel(true);
	}

	/* ------------------------------------------------------------------ bookmarks */

	async function loadBookmarks(info) {
		pb.bookmarks = {key: info.key, title: info.title, scoreId: info.scoreId, items: []};
		try {
			const res = await R.request('getBookmarks', {key: info.key});
			pb.bookmarks.items = (res.items || []).slice().sort((a, b) => a.t - b.t);
		} catch (e) {
			R.log.warn('could not load bookmarks', e);
		}
		drawTimeline();
		R.ui && R.ui.refreshPanel(true);
	}

	const saveBookmarks = U.debounce(() => {
		const b = pb.bookmarks;
		if (!b.key) return;
		R.request('saveBookmarks', {key: b.key, title: b.title, scoreId: b.scoreId, items: b.items}).catch(err => R.log.warn('bookmark save failed', err));
	}, 500);

	function addBookmark(note = '') {
		if (!pb.bookmarks.key) return;
		const time = R.api.time();
		pb.bookmarks.items.push({t: U.round(time, 3), note, created: Date.now()});
		pb.bookmarks.items.sort((a, b) => a.t - b.t);
		saveBookmarks();
		R.api.notify(t('r.bookmarkAdded', {time: fmt(time)}), 'fas fa-bookmark');
		drawTimeline();
		R.ui && R.ui.refreshPanel(true);
	}

	function removeBookmark(item) {
		pb.bookmarks.items = pb.bookmarks.items.filter(b => b !== item);
		saveBookmarks();
		drawTimeline();
		R.ui && R.ui.refreshPanel(true);
	}

	function nextBookmark() {
		const now = R.api.time();
		const next = pb.bookmarks.items.find(b => b.t > now + 0.05);
		if (!next) return R.api.notify(t('r.noMoreBookmarks'), 'fas fa-bookmark');
		R.api.seek(next.t);
	}

	/* ------------------------------------------------------------------ slow motion */

	function buildSlowWindows() {
		const c = cfg().autoSlowMo;
		const notes = (R.replayInfo && R.replayInfo.notes) || [];
		const raw = [];
		for (const n of notes) {
			const k = R.api.noteKind(n);
			const trigger =
				(k === 'miss' && c.onMiss) ||
				(k === 'bad' && c.onBadCut) ||
				(k === 'bomb' && c.onBomb) ||
				(k === 'good' && c.onLowAcc && n.score > 0 && n.score < Number(c.lowAccThreshold));
			if (trigger) raw.push([n.time - (Number(c.before) || 0), n.time + (Number(c.after) || 0)]);
		}
		raw.sort((a, b) => a[0] - b[0]);
		const merged = [];
		for (const w of raw) {
			const last = merged[merged.length - 1];
			if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
			else merged.push(w.slice());
		}
		pb.slow.windows = merged;
	}

	function inSlowWindow(time) {
		const w = pb.slow.windows;
		let lo = 0;
		let hi = w.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (time < w[mid][0]) hi = mid - 1;
			else if (time > w[mid][1]) lo = mid + 1;
			else return true;
		}
		return false;
	}

	function endSlow() {
		if (!pb.slow.active) return;
		pb.slow.active = false;
		if (pb.slow.saved !== null) R.api.setSpeed(pb.slow.saved, {internal: true});
		pb.slow.saved = null;
	}

	function updateSlowMo(frame) {
		const c = cfg().autoSlowMo;
		if (!c.enabled) return endSlow();
		if (!frame.playing || pb.reverse.active) return;
		const inside = inSlowWindow(frame.time);
		if (inside && !pb.slow.active) {
			pb.slow.saved = R.api.getSpeed();
			pb.slow.active = true;
			R.api.setSpeed(Math.min(Number(c.speed) || 0.25, pb.slow.saved), {internal: true});
		} else if (!inside && pb.slow.active) endSlow();
	}

	/** Short real-time slow-motion burst (used by the visuals "slow-mo burst" effect). */
	function burst(speed, duration) {
		if (pb.slow.active || !R.api.isPlaying()) return;
		if (!pb.burst.timer) pb.burst.saved = R.api.getSpeed();
		clearTimeout(pb.burst.timer);
		R.api.setSpeed(Math.min(speed, pb.burst.saved), {internal: true});
		pb.burst.timer = setTimeout(() => {
			pb.burst.timer = null;
			if (pb.burst.saved !== null) R.api.setSpeed(pb.burst.saved, {internal: true});
			pb.burst.saved = null;
		}, Math.max(50, duration * 1000));
	}

	/* ------------------------------------------------------------------ speed & JD */

	function changeSpeed(delta) {
		const v = U.clamp(U.round(R.api.getSpeed() + delta, 4), 0, 2);
		R.api.setSpeed(v);
		R.api.notify(t('r.speedLabel', {v: v.toFixed(2)}), 'fas fa-gauge-simple');
	}

	function onSpeed({value, internal}) {
		if (internal) return;
		// The user took control: cancel any automatic slow motion restore.
		pb.slow.active = false;
		pb.slow.saved = null;
		if (pb.burst.timer) {
			clearTimeout(pb.burst.timer);
			pb.burst.timer = null;
			pb.burst.saved = null;
		}
		pb.lastKnownSpeed = value;
		if (cfg().persistSpeed) R.setRuntime('lastSpeed', value);
	}

	function watchOfficialSpeed() {
		if (pb.slow.active || pb.burst.timer) return;
		const sp = R.api.getSpeed();
		if (pb.lastKnownSpeed !== null && Math.abs(sp - pb.lastKnownSpeed) > 1e-6 && cfg().persistSpeed) R.setRuntime('lastSpeed', sp);
		pb.lastKnownSpeed = sp;
	}

	function restoreSpeedAndJd() {
		const key = R.replayInfo ? R.replayInfo.key : 'none';
		if (pb.restoredFor === key) return;
		pb.restoredFor = key;
		const params = new URLSearchParams(location.search);
		setTimeout(() => {
			const s = cfg();
			const lastSpeed = Number(R.runtime.lastSpeed);
			if (s.persistSpeed && !params.has('speed') && lastSpeed > 0 && Math.abs(lastSpeed - R.api.getSpeed()) > 1e-4) {
				R.api.setSpeed(lastSpeed, {internal: true});
				pb.lastKnownSpeed = lastSpeed;
			}
			const lastJd = Number(R.runtime.lastJd);
			if (s.persistJd && !params.has('jd') && lastJd > 0) R.api.setJd(lastJd);
		}, 250);
	}

	function installInputs() {
		const jd = document.getElementById('jd');
		if (jd) jd.addEventListener('input', () => cfg().persistJd && R.setRuntime('lastJd', Number(jd.value)));
		const canvas = ctx.canvas;
		if (canvas) {
			canvas.addEventListener(
				'wheel',
				e => {
					const s = cfg();
					if (!R.active() || !s.wheelSpeed) return;
					const mod = s.wheelModifier || 'Alt';
					const ok = mod === 'None' ? !e.altKey && !e.ctrlKey && !e.shiftKey : (mod === 'Alt' && e.altKey) || (mod === 'Shift' && e.shiftKey) || (mod === 'Ctrl' && e.ctrlKey);
					if (!ok) return;
					e.preventDefault();
					e.stopPropagation();
					changeSpeed((e.deltaY < 0 ? 1 : -1) * (Number(s.speedStep) || 0.05));
				},
				{passive: false}
			);
		}
	}

	/* ------------------------------------------------------------------ timeline graph & markers */

	function ensureTimeline() {
		const host = document.getElementById('timeline');
		if (!host) return null;
		if (pb.tl && pb.tl.host === host && pb.tl.canvas.isConnected) return pb.tl;
		if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
		const canvas = document.createElement('canvas');
		canvas.className = 'blp-r-timeline-graph';
		const marks = document.createElement('div');
		marks.className = 'blp-r-timeline-marks';
		host.appendChild(canvas);
		host.appendChild(marks);
		pb.tl = {host, canvas, marks};
		if (window.ResizeObserver) new ResizeObserver(() => drawTimeline()).observe(host);
		return pb.tl;
	}

	function drawTimeline() {
		const tl = ensureTimeline();
		if (!tl) return;
		const s = cfg();
		const show = R.active() && !R.overlaysHidden;
		tl.canvas.style.display = show && s.timelineGraph ? '' : 'none';
		tl.marks.style.display = show ? '' : 'none';
		const dur = R.api.duration();
		tl.marks.textContent = '';
		if (!show || !(dur > 0)) return;

		// Bookmarks and loop markers
		if (s.bookmarksOnTimeline) {
			for (const b of pb.bookmarks.items) {
				const m = document.createElement('div');
				m.className = 'blp-r-bookmark-mark';
				m.style.left = U.clamp((b.t / dur) * 100, 0, 100) + '%';
				m.title = fmt(b.t) + (b.note ? ' – ' + b.note : '');
				m.addEventListener('pointerdown', e => e.stopPropagation());
				m.addEventListener('click', e => {
					e.stopPropagation();
					R.api.seek(b.t);
				});
				tl.marks.appendChild(m);
			}
			if (pb.loop.a !== null) {
				const region = document.createElement('div');
				region.className = 'blp-r-loop-region' + (pb.loop.b === null ? ' blp-r-loop-open' : '');
				const a = (pb.loop.a / dur) * 100;
				const b = pb.loop.b !== null ? (pb.loop.b / dur) * 100 : a;
				region.style.left = a + '%';
				region.style.width = Math.max(0.3, b - a) + '%';
				tl.marks.appendChild(region);
			}
		}

		if (!s.timelineGraph) return;
		const notes = (R.replayInfo && R.replayInfo.notes) || [];
		const points = notes.filter(n => n.isBlock && typeof n.accuracy === 'number' && n.accuracy > 0);
		const dpr = window.devicePixelRatio || 1;
		const w = tl.host.clientWidth;
		const h = 34;
		tl.canvas.width = Math.max(1, Math.round(w * dpr));
		tl.canvas.height = Math.round(h * dpr);
		tl.canvas.style.height = h + 'px';
		tl.canvas.style.opacity = U.clamp((Number(s.timelineGraphOpacity) || 70) / 100, 0.05, 1);
		const g = tl.canvas.getContext('2d');
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, w, h);
		if (points.length < 2) return;
		const settled = points.slice(Math.min(points.length - 1, Math.floor(points.length * 0.05)));
		const minAcc = Math.max(0, Math.min(...settled.map(p => p.accuracy)) - 0.5);
		const maxAcc = Math.min(100, Math.max(...settled.map(p => p.accuracy)) + 0.2);
		const X = time => (time / dur) * w;
		const Y = acc => h - 2 - ((U.clamp(acc, minAcc, maxAcc) - minAcc) / Math.max(0.1, maxAcc - minAcc)) * (h - 4);
		const grad = g.createLinearGradient(0, 0, w, 0);
		grad.addColorStop(0, '#ff3d9a');
		grad.addColorStop(1, '#40c4ff');
		g.beginPath();
		g.moveTo(X(points[0].time), h);
		for (const p of points) g.lineTo(X(p.time), Y(p.accuracy));
		g.lineTo(X(points[points.length - 1].time), h);
		g.closePath();
		g.fillStyle = 'rgba(255, 61, 154, 0.18)';
		g.fill();
		g.beginPath();
		points.forEach((p, i) => (i ? g.lineTo(X(p.time), Y(p.accuracy)) : g.moveTo(X(p.time), Y(p.accuracy))));
		g.strokeStyle = grad;
		g.lineWidth = 1.5;
		g.stroke();
		// mistakes
		g.fillStyle = '#ff1744';
		for (const n of notes) {
			const k = R.api.noteKind(n);
			if (k === 'miss' || k === 'bad' || k === 'bomb') g.fillRect(X(n.time) - 0.75, h - 6, 1.5, 6);
		}
		g.fillStyle = 'rgba(255,255,255,0.7)';
		g.font = '9px system-ui, sans-serif';
		g.fillText(maxAcc.toFixed(1) + '%', 2, 9);
		g.fillText(minAcc.toFixed(1) + '%', 2, h - 8);
	}

	/* ------------------------------------------------------------------ panel tab */

	function renderTab(body) {
		const ui = R.ui;
		const s = cfg();
		const playing = R.api.isPlaying();
		body.appendChild(
			ui.section(
				null,
				ui.row(
					ui.button(t('r.frameBack'), () => frameStep(-1), {title: t('hk.frameBack')}),
					ui.button(playing ? '⏸' : '▶', () => {
						stopReverse();
						R.api.togglePlay();
						setTimeout(() => R.ui.refreshPanel(true), 100);
					}),
					ui.button(t('r.frameForward'), () => frameStep(1), {title: t('hk.frameForward')}),
					ui.button('⏪ ' + t('r.reverse'), toggleReverse, {active: pb.reverse.active})
				),
				ui.slider(t('r.speed'), {min: 0, max: 2, step: Number(s.speedStep) || 0.05, value: R.api.getSpeed(), format: v => v.toFixed(2) + '×'}, v => R.api.setSpeed(v)),
				ui.row(
					ui.button('0.25×', () => R.api.setSpeed(0.25)),
					ui.button('0.5×', () => R.api.setSpeed(0.5)),
					ui.button('1×', () => R.api.setSpeed(1)),
					ui.button('1.5×', () => R.api.setSpeed(1.5))
				)
			)
		);
		const L = pb.loop;
		body.appendChild(
			ui.section(
				t('r.loop'),
				ui.row(
					ui.button(t('r.setA'), () => setLoopA(), {active: L.a !== null}),
					ui.button(t('r.setB'), () => setLoopB(), {active: L.b !== null}),
					ui.button(t('common.clear'), () => clearLoop(), {disabled: L.a === null})
				),
				L.a !== null ? ui.hint('A ' + fmt(L.a) + (L.b !== null ? '  →  B ' + fmt(L.b) : '')) : null
			)
		);
		body.appendChild(
			ui.section(
				t('h.playSlowMo'),
				ui.toggle(t('f.playback.autoSlowMo.enabled'), s.autoSlowMo.enabled, v => R.setPath('playback.autoSlowMo.enabled', v)),
				ui.slider(t('f.playback.autoSlowMo.speed'), {min: 0.05, max: 1, step: 0.05, value: s.autoSlowMo.speed, format: v => v.toFixed(2) + '×'}, v => R.setPath('playback.autoSlowMo.speed', v))
			)
		);
		const list = ui.h('div', {class: 'blp-r-list'});
		if (!pb.bookmarks.items.length) list.appendChild(ui.hint(t('r.noBookmarks')));
		for (const b of pb.bookmarks.items) {
			list.appendChild(
				ui.h(
					'div',
					{class: 'blp-r-list-item'},
					ui.button(fmt(b.t), () => R.api.seek(b.t), {title: t('common.jump')}),
					ui.input(b.note, {
						placeholder: t('common.notes'),
						onChange: v => {
							b.note = v.slice(0, 500);
							saveBookmarks();
							drawTimeline();
						},
					}),
					ui.button('✕', () => removeBookmark(b), {className: 'blp-r-icon', title: t('common.delete')})
				)
			);
		}
		body.appendChild(ui.section(t('r.bookmarks'), list, ui.row(ui.button('🔖 ' + t('r.addBookmark'), () => addBookmark(), {primary: true, disabled: !pb.bookmarks.key}))));
	}

	/* ------------------------------------------------------------------ module */

	R.playback = {burst, frameStep, addBookmark, setLoopA, setLoopB, clearLoop, toggleReverse};

	R.register({
		name: 'playback',
		init(c) {
			ctx = c;
			installInputs();
			R.on('speed', onSpeed);
			R.on('songstart', restoreSpeedAndJd);
			R.on('replayunload', () => {
				stopReverse();
				clearLoop(true);
				pb.bookmarks = {key: null, title: '', scoreId: null, items: []};
				pb.restoredFor = null;
			});
			R.addHotkey('frameBack', () => frameStep(-1), {repeat: true});
			R.addHotkey('frameForward', () => frameStep(1), {repeat: true});
			R.addHotkey('reverse', toggleReverse);
			R.addHotkey('loopCycle', loopCycle);
			R.addHotkey('loopClear', () => clearLoop());
			R.addHotkey('addBookmark', () => addBookmark());
			R.addHotkey('nextBookmark', nextBookmark);
			R.addHotkey('speedUp', () => changeSpeed(Number(cfg().speedStep) || 0.05), {repeat: true});
			R.addHotkey('speedDown', () => changeSpeed(-(Number(cfg().speedStep) || 0.05)), {repeat: true});
			R.addHotkey('speedReset', () => {
				R.api.setSpeed(1);
				R.api.notify(t('r.speedLabel', {v: '1.00'}), 'fas fa-gauge-simple');
			});
			const playlistStep = dir => {
				const pl = ctx.playlist();
				const fn = pl && (dir > 0 ? pl.next : pl.previous);
				if (!fn) return R.api.notify(t('r.noPlaylist'), 'fas fa-list');
				Promise.resolve(fn.call(pl)).catch(() => {});
				R.api.notify(t(dir > 0 ? 'r.nextReplay' : 'r.prevReplay'), dir > 0 ? 'fas fa-forward-step' : 'fas fa-backward-step');
			};
			R.onCommand('nextReplay', () => playlistStep(1));
			R.onCommand('prevReplay', () => playlistStep(-1));
			R.ui.addTab({id: 'playback', icon: '⏯', title: t('r.tab.playback'), order: 20, render: renderTab});
			window.addEventListener('resize', U.debounce(drawTimeline, 200));
		},
		onReady() {
			pb.lastKnownSpeed = R.api.getSpeed();
			if (R.api.isPlaying()) restoreSpeedAndJd();
		},
		onSettings() {
			if (!ctx) return;
			buildSlowWindows();
			if (!R.active()) {
				endSlow();
				stopReverse();
			}
			drawTimeline();
		},
		onReplay(info) {
			buildSlowWindows();
			loadBookmarks(info);
			if (R.api.isPlaying()) restoreSpeedAndJd();
			setTimeout(drawTimeline, 500);
		},
		tick(frame) {
			const L = pb.loop;
			if (L.a !== null && L.b !== null && frame.playing && frame.time >= L.b && !R.api.seekBusy()) {
				R.api.seek(Math.max(0, L.a - (Number(cfg().loopPreRoll) || 0)));
			}
			updateSlowMo(frame);
		},
		maintain() {
			watchOfficialSpeed();
			if (pb.tl && !pb.tl.canvas.isConnected) drawTimeline();
		},
	});
	R.on('overlays', drawTimeline);
})();
