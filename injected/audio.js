/*
 * BeatLeaderPlus – extra hitsounds (PAGE world).
 *
 * The replayer plays a hitsound for good cuts (and lets you pick the file and volume). It is
 * silent for bad cuts, misses and bomb hits; this module adds a sound for each of those, using
 * built-in synthesised sounds or an imported hitsound pack. Volumes are relative to the replayer's
 * own hitsound slider, so its mixer still controls everything.
 *
 * Scheduling: each frame we look 150 ms of song time ahead and schedule the replay's events on our
 * AudioContext clock (converted with the playback speed), so sounds land on time. Seeking or
 * pausing cancels everything not yet played.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('audio')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	const LOOKAHEAD = 0.15;
	const SLOTS = ['bad', 'miss', 'bomb'];
	const BUILTINS = ['builtin:click', 'builtin:tick', 'builtin:chime', 'builtin:buzz', 'builtin:thud', 'builtin:boom'];
	const OFFICIAL_DEFAULT_VOLUME = 0.3;

	const au = {ac: null, out: null, buffers: new Map(), packNames: [], packLoaded: false, cursor: -1, pending: []};
	const cfg = () => R.settings.audio;

	/* ------------------------------------------------------------------ built-in sounds */

	function synth(ac, seconds, fn) {
		const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
		const buf = ac.createBuffer(1, len, ac.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = fn(i / ac.sampleRate, i / len);
		return buf;
	}

	function buildBuiltins(ac) {
		const TAU = Math.PI * 2;
		const noise = () => Math.random() * 2 - 1;
		let last = 0;
		return {
			'builtin:click': synth(ac, 0.06, (s, p) => (noise() * 0.5 + Math.sin(TAU * 2400 * s) * 0.6) * Math.exp(-p * 9)),
			'builtin:tick': synth(ac, 0.03, (s, p) => Math.sin(TAU * 3800 * s) * Math.exp(-p * 7)),
			'builtin:chime': synth(ac, 0.35, (s, p) => (Math.sin(TAU * 1318.5 * s) * 0.5 + Math.sin(TAU * 1975.5 * s) * 0.35) * Math.exp(-p * 6)),
			'builtin:buzz': synth(ac, 0.16, (s, p) => (Math.sin(TAU * 140 * s) > 0 ? 0.55 : -0.55) * Math.exp(-p * 3)),
			'builtin:thud': synth(ac, 0.22, (s, p) => Math.sin(TAU * (110 - 70 * p) * s) * Math.exp(-p * 5)),
			'builtin:boom': synth(ac, 0.45, (s, p) => ((last = last * 0.92 + noise() * 0.08) * 3 + Math.sin(TAU * (70 - 40 * p) * s) * 0.6) * Math.exp(-p * 4)),
		};
	}

	/* ------------------------------------------------------------------ audio context */

	function ensureContext() {
		if (au.ac) return au.ac;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		au.ac = new AC({latencyHint: 'interactive'});
		au.out = au.ac.createGain();
		au.out.connect(au.ac.destination);
		const builtins = buildBuiltins(au.ac);
		for (const k of Object.keys(builtins)) au.buffers.set(k, builtins[k]);
		// Browsers start contexts suspended until a user gesture.
		const resume = () => au.ac && au.ac.state === 'suspended' && au.ac.resume().catch(() => {});
		['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, resume, {capture: true}));
		return au.ac;
	}

	async function loadPack() {
		if (au.packLoaded || !ensureContext()) return;
		au.packLoaded = true;
		try {
			const pack = await R.request('getHitsounds', {}, 20000);
			au.packNames = [];
			for (const s of pack.sounds || []) {
				try {
					au.buffers.set('pack:' + s.id, await au.ac.decodeAudioData(s.data.slice(0)));
					au.packNames.push({value: 'pack:' + s.id, label: s.name});
				} catch (e) {
					R.log.warn('could not decode hitsound', s.name, e);
				}
			}
			if (R.ui) R.ui.refresh();
		} catch (e) {
			R.log.warn('could not load hitsound pack', e);
		}
	}

	/** The replayer's hitsound slider, normalised so its default level is 1. */
	function officialVolumeFactor() {
		const slider = document.getElementById('hitsoundSlider');
		const v = slider ? Number(slider.value) : OFFICIAL_DEFAULT_VOLUME;
		return U.clamp((isFinite(v) ? v : OFFICIAL_DEFAULT_VOLUME) / OFFICIAL_DEFAULT_VOLUME, 0, 3);
	}

	/* ------------------------------------------------------------------ scheduling */

	function cancelPending() {
		const now = au.ac ? au.ac.currentTime : 0;
		for (const p of au.pending) {
			if (p.when > now) {
				try {
					p.src.stop();
				} catch (e) {
					/* already stopped */
				}
			}
		}
		au.pending = [];
		au.cursor = -1;
	}

	function play(slotName, when) {
		const slot = cfg().slots[slotName];
		if (!slot || !slot.enabled || !slot.sound || slot.sound === 'none') return;
		const buffer = au.buffers.get(slot.sound);
		if (!buffer) return;
		const src = au.ac.createBufferSource();
		src.buffer = buffer;
		const gain = au.ac.createGain();
		gain.gain.value = U.clamp((Number(slot.volume) || 0) / 100, 0, 2) * officialVolumeFactor();
		src.connect(gain);
		gain.connect(au.out);
		src.start(Math.max(au.ac.currentTime, when));
		au.pending.push({src, when});
		src.onended = () => {
			const i = au.pending.findIndex(p => p.src === src);
			if (i >= 0) au.pending.splice(i, 1);
			gain.disconnect();
		};
	}

	function schedule(frame) {
		const notes = R.replayInfo && R.replayInfo.notes;
		if (!notes || !notes.length || !au.ac) return;
		if (!frame.playing || frame.speed <= 0.001) {
			if (au.pending.length || au.cursor !== -1) cancelPending();
			return;
		}
		if (frame.seeked || au.cursor < 0) {
			cancelPending();
			au.cursor = R.api.noteIndexAt(notes, frame.time);
		}
		if (au.ac.state === 'suspended') return;
		const horizon = frame.time + LOOKAHEAD * frame.speed;
		while (au.cursor + 1 < notes.length && notes[au.cursor + 1].time <= horizon) {
			au.cursor++;
			const note = notes[au.cursor];
			const kind = R.api.noteKind(note);
			if (!SLOTS.includes(kind)) continue;
			play(kind, au.ac.currentTime + Math.max(0, (note.time - frame.time) / frame.speed));
		}
	}

	/* ------------------------------------------------------------------ Settings → BL+ section */

	function renderAudio(body) {
		const ui = R.ui;
		const c = cfg();
		body.appendChild(ui.toggle(t('f.audio.enabled'), c.enabled, v => R.setPath('audio.enabled', v), t('d.audio.enabled')));
		if (!c.enabled) return;
		const options = [{value: 'none', label: t('opt.sound.none')}].concat(BUILTINS.map(id => ({value: id, label: t('opt.sound.' + id)})), au.packNames);
		for (const slot of SLOTS) {
			const s = c.slots[slot];
			body.appendChild(ui.select(t('opt.slot.' + slot), options, options.some(o => o.value === s.sound) ? s.sound : 'none', v => R.setPath('audio.slots.' + slot + '.sound', v)));
			body.appendChild(
				ui.row(
					ui.range('', {min: 0, max: 150, step: 5, value: s.volume, unit: '%'}, v => R.setPath('audio.slots.' + slot + '.volume', v)),
					ui.button('', () => R.audio.preview(slot), {icon: 'fas fa-play', title: t('common.preview')})
				)
			);
		}
	}

	/* ------------------------------------------------------------------ module */

	R.audio = {
		preview(slotName) {
			if (!ensureContext()) return;
			au.ac.resume().catch(() => {});
			play(slotName, au.ac.currentTime);
		},
	};

	R.register({
		name: 'audio',
		init() {
			// Sent by the bridge when the options page imports a new hitsound pack.
			R.onCommand('reloadHitsounds', () => {
				for (const k of Array.from(au.buffers.keys())) if (k.startsWith('pack:')) au.buffers.delete(k);
				au.packLoaded = false;
				au.packNames = [];
				if (R.active() && cfg().enabled) return loadPack();
			});
			R.ui.addSettingsSection({id: 'audio', order: 70, title: () => t('r.sect.audio'), render: renderAudio});
		},
		onSettings() {
			if (R.active() && cfg().enabled) {
				ensureContext();
				loadPack();
			} else cancelPending();
		},
		tick(frame) {
			if (cfg().enabled) schedule(frame);
		},
	});
})();
