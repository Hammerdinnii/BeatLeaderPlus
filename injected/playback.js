/*
 * BeatLeaderPlus – playback additions (PAGE world).
 *
 * The replayer already has speed controls (slider, +/- keys, wheel), beat stepping (, .),
 * "Change speed around mistakes", loop-on-finish and timeline markers. This module adds what it
 * doesn't have and extends what it does:
 *
 *   - frame-by-frame stepping (next recorded replay frame, or a fixed step)
 *   - reverse playback (paused, scrubbing backwards at a configurable rate)
 *   - A-B section loop with optional pre-roll
 *   - bookmarks with notes, stored per replay and drawn on the replayer's timeline
 *   - low-accuracy cuts as an extra trigger for the replayer's own slow motion (its
 *     computeMissWindows() is wrapped; its speed and offsets are used)
 *   - remembered speed / jump distance across sessions
 *   - an accuracy graph above the replayer's timeline
 *
 * Controls live in Settings → BL+ ("Playback" and "Timeline" sections).
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
		lastKnownSpeed: null,
		restoredFor: null,
		tl: null,
	};

	const cfg = () => R.settings.playback;
	const fmt = sec => U.formatTime(sec, true);
	const refreshUi = () => R.ui && R.ui.refresh(true);

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
		refreshUi();
	}

	function stopReverse(announce) {
		if (!pb.reverse.active) return;
		pb.reverse.active = false;
		clearInterval(pb.reverse.timer);
		pb.reverse.timer = null;
		if (announce) R.api.notify(t('r.reverseOff'), 'fas fa-pause');
		refreshUi();
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
		refreshUi();
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
		refreshUi();
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
		refreshUi();
	}

	function removeBookmark(item) {
		pb.bookmarks.items = pb.bookmarks.items.filter(b => b !== item);
		saveBookmarks();
		drawTimeline();
		refreshUi();
	}

	function nextBookmark() {
		const now = R.api.time();
		const next = pb.bookmarks.items.find(b => b.t > now + 0.05);
		if (!next) return R.api.notify(t('r.noMoreBookmarks'), 'fas fa-bookmark');
		R.api.seek(next.t);
	}

	/* ------------------------------------------------------------------ official slow motion + low-acc cuts */

	function addLowAccWindows(sc) {
		const p = cfg();
		const s = (sc.settings && sc.settings.settings) || {};
		if (!R.active() || !p.slowOnLowAcc || !s.autoSpeedControls) return;
		const notes = sc.replayData && sc.replayData.notes;
		if (!notes) return;
		const startOffset = parseFloat(s.offsetSlowBeginning || 0);
		const endOffset = parseFloat(s.offsetSlowEnding || 0);
		const threshold = Number(p.lowAccThreshold) || 100;
		const windows = (sc.missWindows || []).slice();
		for (const n of notes) {
			if (!n || !(n.score > 0) || n.score >= threshold) continue;
			const start = Math.max(0, n.time + startOffset);
			windows.push([start, Math.max(start, n.time + endOffset)]);
		}
		windows.sort((a, b) => a[0] - b[0]);
		const merged = [];
		for (const w of windows) {
			const last = merged[merged.length - 1];
			if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
			else merged.push(w.slice());
		}
		sc.missWindows = merged;
	}

	/** Wrap the replayer's computeMissWindows() so low-accuracy cuts become extra slow-mo windows. */
	function hookOfficialSlowMo() {
		const sc = ctx.songControls();
		if (!sc || typeof sc.computeMissWindows !== 'function') return;
		if (!sc.__blpSlowHooked) {
			const orig = sc.computeMissWindows;
			sc.computeMissWindows = function (...args) {
				const result = orig.apply(this, args);
				try {
					addLowAccWindows(this);
				} catch (e) {
					R.log.warn('low-acc slow-mo failed', e);
				}
				return result;
			};
			sc.__blpSlowHooked = true;
		}
		sc.computeMissWindows();
	}

	function officialSlowMoOn() {
		const os = ctx.officialSettings();
		return !!(os && os.settings && os.settings.autoSpeedControls);
	}

	/* ------------------------------------------------------------------ remembered speed & JD */

	function watchOfficialSpeed() {
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
		g.fillStyle = 'rgba(255,255,255,0.7)';
		g.font = '9px system-ui, sans-serif';
		g.fillText(maxAcc.toFixed(1) + '%', 2, 9);
		g.fillText(minAcc.toFixed(1) + '%', 2, h - 8);
	}

	/* ------------------------------------------------------------------ Settings → BL+ sections */

	function renderPlayback(body) {
		const ui = R.ui;
		const s = cfg();
		const L = pb.loop;
		body.appendChild(
			ui.row(
				ui.button('◀', () => frameStep(-1), {title: t('hk.frameBack') + ' (' + U.formatHotkey(R.get('hotkeys.bindings.frameBack')) + ')'}),
				ui.button('⏪', toggleReverse, {active: pb.reverse.active, title: t('hk.reverse') + ' (' + U.formatHotkey(R.get('hotkeys.bindings.reverse')) + ')'}),
				ui.button('▶', () => frameStep(1), {title: t('hk.frameForward') + ' (' + U.formatHotkey(R.get('hotkeys.bindings.frameForward')) + ')'})
			)
		);
		body.appendChild(
			ui.row(
				ui.button('A', () => setLoopA(), {active: L.a !== null, title: t('r.setA')}),
				ui.button('B', () => setLoopB(), {active: L.b !== null, title: t('r.setB')}),
				ui.button('✕', () => clearLoop(), {disabled: L.a === null, title: t('r.loopCleared')}),
				L.a !== null ? ui.h('span', {class: 'blp-r-hint blp-r-inline'}, fmt(L.a) + (L.b !== null ? ' → ' + fmt(L.b) : '')) : null
			)
		);
		body.appendChild(ui.toggle(t('f.playback.persistSpeed'), s.persistSpeed, v => R.setPath('playback.persistSpeed', v)));
		body.appendChild(ui.toggle(t('f.playback.persistJd'), s.persistJd, v => R.setPath('playback.persistJd', v)));
		body.appendChild(ui.toggle(t('f.playback.slowOnLowAcc'), s.slowOnLowAcc, v => R.setPath('playback.slowOnLowAcc', v), t('d.playback.slowOnLowAcc')));
		if (s.slowOnLowAcc) {
			body.appendChild(ui.range(t('f.playback.lowAccThreshold'), {min: 60, max: 115, step: 1, value: s.lowAccThreshold}, v => R.setPath('playback.lowAccThreshold', v)));
			if (!officialSlowMoOn()) body.appendChild(ui.hint(t('r.slowmoOff')));
		}
	}

	function renderTimeline(body) {
		const ui = R.ui;
		const s = cfg();
		body.appendChild(ui.toggle(t('f.playback.timelineGraph'), s.timelineGraph, v => R.setPath('playback.timelineGraph', v)));
		body.appendChild(ui.toggle(t('f.playback.bookmarksOnTimeline'), s.bookmarksOnTimeline, v => R.setPath('playback.bookmarksOnTimeline', v)));
		const list = ui.h('div', {class: 'blp-r-list'});
		if (!pb.bookmarks.items.length) list.appendChild(ui.hint(t('r.noBookmarks')));
		for (const b of pb.bookmarks.items) {
			list.appendChild(
				ui.h(
					'div',
					{class: 'blp-r-list-item'},
					ui.button(U.formatTime(b.t, false), () => R.api.seek(b.t), {title: t('common.jump')}),
					ui.input(b.note, {
						placeholder: t('common.notes'),
						onChange: v => {
							b.note = v.slice(0, 500);
							saveBookmarks();
							drawTimeline();
						},
					}),
					ui.button('✕', () => removeBookmark(b), {title: t('common.delete')})
				)
			);
		}
		body.appendChild(list);
		body.appendChild(ui.row(ui.button('🔖 ' + t('r.addBookmark'), () => addBookmark(), {disabled: !pb.bookmarks.key})));
	}

	/* ------------------------------------------------------------------ module */

	R.playback = {frameStep, addBookmark, setLoopA, setLoopB, clearLoop, toggleReverse, drawTimeline};

	R.register({
		name: 'playback',
		init(c) {
			ctx = c;
			const jd = document.getElementById('jd');
			if (jd) jd.addEventListener('input', () => cfg().persistJd && R.setRuntime('lastJd', Number(jd.value)));
			R.on('songstart', restoreSpeedAndJd);
			R.on('overlays', drawTimeline);
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
			const playlistStep = dir => {
				const pl = ctx.playlist();
				const fn = pl && (dir > 0 ? pl.next : pl.previous);
				if (!fn) return R.api.notify(t('r.noPlaylist'), 'fas fa-list');
				Promise.resolve(fn.call(pl)).catch(() => {});
				R.api.notify(t(dir > 0 ? 'r.nextReplay' : 'r.prevReplay'), dir > 0 ? 'fas fa-forward-step' : 'fas fa-backward-step');
			};
			R.onCommand('nextReplay', () => playlistStep(1));
			R.onCommand('prevReplay', () => playlistStep(-1));
			R.ui.addSettingsSection({id: 'playback', order: 50, title: () => t('r.sect.playback'), render: renderPlayback});
			R.ui.addSettingsSection({id: 'timeline', order: 60, title: () => t('r.sect.timeline'), render: renderTimeline});
			window.addEventListener('resize', U.debounce(drawTimeline, 200));
		},
		onReady() {
			pb.lastKnownSpeed = R.api.getSpeed();
			hookOfficialSlowMo();
			if (R.api.isPlaying()) restoreSpeedAndJd();
		},
		onSettings() {
			if (!ctx) return;
			if (!R.active()) stopReverse();
			hookOfficialSlowMo();
			drawTimeline();
		},
		onReplay(info) {
			loadBookmarks(info);
			if (R.api.isPlaying()) restoreSpeedAndJd();
			// The replayer computes its windows on replay load; add ours once its data is in place.
			setTimeout(hookOfficialSlowMo, 300);
			setTimeout(drawTimeline, 500);
		},
		tick(frame) {
			const L = pb.loop;
			if (L.a !== null && L.b !== null && frame.playing && frame.time >= L.b && !R.api.seekBusy()) {
				R.api.seek(Math.max(0, L.a - (Number(cfg().loopPreRoll) || 0)));
			}
		},
		maintain() {
			watchOfficialSpeed();
			if (pb.tl && !pb.tl.canvas.isConnected) drawTimeline();
		},
	});
})();
