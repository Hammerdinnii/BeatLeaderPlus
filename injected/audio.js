/*
 * BeatLeaderPlus – custom hitsounds (PAGE world).
 *
 * Four slots (good cut, bad cut, miss, bomb), each with its own sound and volume, plus a master
 * volume. Sounds are either built in (synthesised here, no audio assets needed) or come from an
 * imported hitsound pack (stored by the options page, delivered through the bridge as
 * ArrayBuffers and decoded with Web Audio).
 *
 * Scheduling: each frame we look 150 ms of song time ahead and schedule the replay's note events
 * on our AudioContext clock (converted with the current playback speed), so hitsounds land on
 * the beat instead of a frame late. Seeking or pausing cancels everything not yet played.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('audio')) return;
	const U = window.BLP.utils;

	const LOOKAHEAD = 0.15;
	let ctx = null;
	const au = {
		ac: null,
		master: null,
		buffers: new Map(), // sound ref -> AudioBuffer
		packLoaded: false,
		scheduledUntil: -1,
		cursor: -1,
		pending: [],
		officialMuted: false,
	};

	const cfg = () => R.settings.audio;

	/* ------------------------------------------------------------------ built-in sounds */

	function synth(ac, seconds, fn) {
		const rate = ac.sampleRate;
		const len = Math.max(1, Math.floor(rate * seconds));
		const buf = ac.createBuffer(1, len, rate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = fn(i / rate, i / len);
		return buf;
	}

	function buildBuiltins(ac) {
		const TAU = Math.PI * 2;
		const noise = () => Math.random() * 2 - 1;
		return {
			'builtin:click': synth(ac, 0.06, (s, p) => (noise() * 0.5 + Math.sin(TAU * 2400 * s) * 0.6) * Math.exp(-p * 9)),
			'builtin:tick': synth(ac, 0.03, (s, p) => Math.sin(TAU * 3800 * s) * Math.exp(-p * 7)),
			'builtin:chime': synth(ac, 0.35, (s, p) => (Math.sin(TAU * 1318.5 * s) * 0.5 + Math.sin(TAU * 1975.5 * s) * 0.35) * Math.exp(-p * 6)),
			'builtin:buzz': synth(ac, 0.16, (s, p) => (Math.sin(TAU * 140 * s) > 0 ? 0.55 : -0.55) * Math.exp(-p * 3)),
			'builtin:thud': synth(ac, 0.22, (s, p) => Math.sin(TAU * (110 - 70 * p) * s) * Math.exp(-p * 5)),
			'builtin:boom': (() => {
				let last = 0;
				return synth(ac, 0.45, (s, p) => {
					last = last * 0.92 + noise() * 0.08; // crude low-pass
					return (last * 3 + Math.sin(TAU * (70 - 40 * p) * s) * 0.6) * Math.exp(-p * 4);
				});
			})(),
		};
	}

	/* ------------------------------------------------------------------ audio context */

	function ensureContext() {
		if (au.ac) return au.ac;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		au.ac = new AC({latencyHint: 'interactive'});
		au.master = au.ac.createGain();
		au.master.connect(au.ac.destination);
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
			for (const s of pack.sounds || []) {
				try {
					const buffer = await au.ac.decodeAudioData(s.data.slice(0));
					au.buffers.set('pack:' + s.id, buffer);
				} catch (e) {
					R.log.warn('could not decode hitsound', s.name, e);
				}
			}
		} catch (e) {
			R.log.warn('could not load hitsound pack', e);
		}
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
		const c = cfg();
		const slot = c.slots[slotName];
		if (!slot || !slot.enabled || !slot.sound || slot.sound === 'none') return;
		const buffer = au.buffers.get(slot.sound);
		if (!buffer) return;
		const src = au.ac.createBufferSource();
		src.buffer = buffer;
		const gain = au.ac.createGain();
		gain.gain.value = U.clamp((Number(slot.volume) || 0) / 100, 0, 2);
		src.connect(gain);
		gain.connect(au.master);
		src.start(Math.max(au.ac.currentTime, when));
		au.pending.push({src, when});
		src.onended = () => {
			const i = au.pending.findIndex(p => p.src === src);
			if (i >= 0) au.pending.splice(i, 1);
			gain.disconnect();
		};
	}

	const KIND_TO_SLOT = {good: 'good', bad: 'bad', miss: 'miss', bomb: 'bomb'};

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
		const latency = (Number(cfg().latencyMs) || 0) / 1000;
		while (au.cursor + 1 < notes.length && notes[au.cursor + 1].time <= horizon) {
			au.cursor++;
			const note = notes[au.cursor];
			const slot = KIND_TO_SLOT[R.api.noteKind(note)];
			if (!slot) continue;
			const delay = Math.max(0, (note.time - frame.time) / frame.speed) + latency;
			play(slot, au.ac.currentTime + delay);
		}
	}

	/* ------------------------------------------------------------------ official hitsound */

	function applyOfficialMute() {
		const hs = ctx.hitSound();
		if (!hs || !hs.gainNode) return;
		const mute = R.active() && cfg().enabled && cfg().muteOfficial;
		if (mute) {
			if (hs.gainNode.gain.value !== 0) hs.gainNode.gain.value = 0;
			au.officialMuted = true;
		} else if (au.officialMuted) {
			const slider = document.getElementById('hitsoundSlider');
			const v = slider ? Number(slider.value) : 0.3;
			if (hs.setVolume) hs.setVolume(v);
			else hs.gainNode.gain.value = v * 0.3;
			au.officialMuted = false;
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
		init(c) {
			ctx = c;
			// Sent by the bridge when the options page imports a new hitsound pack.
			R.onCommand('reloadHitsounds', () => {
				for (const k of Array.from(au.buffers.keys())) if (k.startsWith('pack:')) au.buffers.delete(k);
				au.packLoaded = false;
				if (R.active() && cfg().enabled) return loadPack();
			});
		},
		onSettings() {
			if (!ctx) return;
			const c = cfg();
			if (R.active() && c.enabled) {
				ensureContext();
				loadPack();
				if (au.master) au.master.gain.value = U.clamp((Number(c.master) || 0) / 100, 0, 2);
			} else {
				cancelPending();
			}
			applyOfficialMute();
		},
		tick(frame) {
			if (!cfg().enabled) return;
			schedule(frame);
		},
		maintain() {
			applyOfficialMute();
		},
	});
})();
