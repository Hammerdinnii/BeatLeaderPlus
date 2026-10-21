/*
 * BeatLeaderPlus – replay runtime core (PAGE / MAIN world).
 *
 * Injected into the BeatLeader web replayer by modules/replay-bridge.js. Because this runs in the
 * page's own JavaScript world it can talk to A-Frame directly (window.AFRAME, <a-scene>
 * components such as `song`, `song-controls`, `replay-loader`, `camera-mover`, …).
 *
 * The core provides everything the feature modules (camera, visuals, playback, hud, audio,
 * export) share:
 *   BLPR.settings / BLPR.runtime     current effective settings and persisted runtime values
 *   BLPR.request(type, payload)      request/response messaging with the content-script bridge
 *   BLPR.patchSettings(patch)        apply a settings change locally and persist it
 *   BLPR.on / emit                   event bus ('settings', 'replay', 'note', 'seek', 'speed', …)
 *   BLPR.waitForScene()              MutationObserver + polling until the A-Frame scene is ready
 *   BLPR.ctx                         live references to scene, components and key entities
 *   BLPR.api                         time / seek / speed / play / pause / notify helpers
 *   BLPR.register(module)            module lifecycle: init, onSettings, onReplay, tick, tock, maintain
 *   BLPR.addHotkey(action, fn)       replay-page shortcuts (bindings come from settings.hotkeys)
 *
 * EXTENDING: create injected/my-feature.js that calls BLPR.register({name: 'my-feature', init(ctx)
 * {...}, tick(frame) {...}}), add it to FILES in modules/replay-bridge.js before
 * injected-replay.js, and list it in web_accessible_resources (covered by injected/*.js).
 *
 * Replay internals used (from the open-source BeatLeader replayer):
 *   scene.components.song                getCurrentTime(), getDuration(), speed, setPlaybackRate()
 *   scene.components['song-controls']    seek(time), baseSongSpeed
 *   scene.components['replay-loader']    replay {info, frames, notes, heights}, allStructs
 *   scene.systems.state.state            isPlaying, isPaused, score {score, accuracy, combo, …}
 *   events                               replayloaded, replayunload, timechanged, songstartaudio,
 *                                        colorChanged, showHotkeyNotification
 */
(function () {
	'use strict';

	const R = (window.BLPR = window.BLPR || {});
	if (R.__core) return;
	R.__core = true;

	const BLP = window.BLP;
	const U = BLP.utils;
	const CHANNEL = 'BLP_BRIDGE_v1';

	R.settings = null;
	R.runtime = {};
	R.version = '';
	R.sessionOverrides = null;
	R.modules = [];
	R.ctx = null;
	R.frame = {time: 0, prevTime: 0, dt: 0, playing: false, speed: 1, seeked: false, now: 0};
	R.replayInfo = null;

	R.log = U.createLogger('[BLP:replay]', () => R.settings && R.settings.general.debug);
	R.t = (key, vars) => BLP.i18n.t(key, vars);
	R.active = () => !!(R.settings && R.settings.general.enabled);
	R.get = (path, fallback) => U.getPath(R.settings, path, fallback);

	/* ------------------------------------------------------------------ event bus */

	const listeners = {};
	R.on = function (type, fn) {
		(listeners[type] = listeners[type] || []).push(fn);
		return () => R.off(type, fn);
	};
	R.off = function (type, fn) {
		const list = listeners[type];
		if (list) list.splice(list.indexOf(fn) >>> 0, 1);
	};
	R.emit = function (type, detail) {
		for (const fn of (listeners[type] || []).slice()) {
			try {
				fn(detail);
			} catch (e) {
				R.log.error('listener failed for', type, e);
			}
		}
	};

	/* ------------------------------------------------------------------ bridge */

	const pending = new Map();
	let seq = 0;
	const targetOrigin = () => (location.origin && location.origin !== 'null' ? location.origin : '*');
	const post = msg => window.postMessage(Object.assign({channel: CHANNEL, dir: 'p2c'}, msg), targetOrigin());

	R.request = function (type, payload, timeout = 10000) {
		const id = 'p' + ++seq;
		return new Promise((resolve, reject) => {
			pending.set(id, {resolve, reject});
			post({id, type, payload});
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error('Extension bridge timeout for ' + type));
				}
			}, timeout);
		});
	};

	const commandHandlers = {};
	/** Register a handler for commands sent by the popup / global hotkeys. */
	R.onCommand = (action, fn) => (commandHandlers[action] = fn);

	window.addEventListener('message', e => {
		if (e.source !== window || !e.data || e.data.channel !== CHANNEL || e.data.dir !== 'c2p') return;
		const msg = e.data;
		if (msg.replyTo) {
			const p = pending.get(msg.replyTo);
			if (p) {
				pending.delete(msg.replyTo);
				msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'Bridge error'));
			}
			return;
		}
		if (msg.type === 'settings') {
			const incoming = msg.payload && msg.payload.settings;
			// Keep local edits that have not been flushed yet, so the storage echo can't revert them.
			const merged = incoming && Object.keys(queuedPatch).length ? U.deepMerge(incoming, queuedPatch) : incoming;
			applySettings(merged, msg.payload && msg.payload.locale);
			return;
		}
		if (msg.type === 'command') {
			const action = msg.payload && msg.payload.action;
			const fn = commandHandlers[action];
			const reply = (ok, data) => msg.id && post(ok ? {replyTo: msg.id, ok: true, data} : {replyTo: msg.id, ok: false, error: String(data)});
			if (!fn) return reply(false, 'Unknown command: ' + action);
			Promise.resolve()
				.then(() => fn(msg.payload || {}))
				.then(
					data => reply(true, data === undefined ? true : data),
					err => reply(false, (err && err.message) || err)
				);
		}
	});

	/* ------------------------------------------------------------------ settings */

	let rawSettings = null;

	function applySettings(settings, locale) {
		if (!settings) return;
		rawSettings = settings;
		R.settings = R.sessionOverrides ? U.deepMerge(settings, R.sessionOverrides) : settings;
		BLP.i18n.setLocale(locale || settings.general.language);
		R.emit('settings', R.settings);
		for (const m of R.modules) safeCall(m, 'onSettings', R.settings);
	}

	/** Apply settings that only last for this page view (e.g. from a shared link). */
	R.setSessionOverrides = function (overrides) {
		R.sessionOverrides = overrides && Object.keys(overrides).length ? overrides : null;
		if (rawSettings) applySettings(rawSettings);
	};

	let queuedPatch = {};
	const flushPatch = U.debounce(() => {
		const patch = queuedPatch;
		queuedPatch = {};
		R.request('patchSettings', {patch}).catch(err => R.log.warn('could not save settings', err));
	}, 400);

	/**
	 * Change settings from inside the replay page (panel controls, dragging the HUD, ...).
	 * Applied locally right away for responsiveness, persisted (debounced) through the bridge.
	 */
	R.patchSettings = function (patch) {
		R.sessionOverrides = null; // the user took control; drop link-provided overrides
		rawSettings = U.deepMerge(rawSettings || R.settings || {}, patch);
		queuedPatch = U.deepMerge(queuedPatch, patch);
		applySettings(rawSettings);
		flushPatch();
	};

	R.setPath = (path, value) => R.patchSettings(U.pathPatch(path, value));

	const persistRuntime = U.debounce(() => {
		R.request('setRuntime', {values: R.runtime}).catch(() => {});
	}, 800);
	R.setRuntime = function (key, value) {
		R.runtime[key] = value;
		persistRuntime();
	};

	/* ------------------------------------------------------------------ scene discovery */

	function sceneReady() {
		const A = window.AFRAME;
		const scene = document.querySelector('a-scene');
		if (!A || !scene || !scene.hasLoaded || !scene.components) return null;
		const c = scene.components;
		if (!c.song || !c['song-controls'] || !c['replay-loader']) return null;
		return scene;
	}

	/** Resolve once AFRAME, the <a-scene> and the replay components exist (MutationObserver + polling). */
	R.waitForScene = function (timeoutMs = 0) {
		return new Promise((resolve, reject) => {
			const found = sceneReady();
			if (found) return resolve(found);
			let done = false;
			const finish = scene => {
				if (done) return;
				done = true;
				mo.disconnect();
				clearInterval(iv);
				resolve(scene);
			};
			const check = () => {
				const scene = sceneReady();
				if (scene) finish(scene);
				const s = document.querySelector('a-scene');
				if (s && !s.__blpLoadHooked) {
					s.__blpLoadHooked = true;
					s.addEventListener('loaded', () => setTimeout(check, 0));
				}
			};
			const mo = new MutationObserver(check);
			mo.observe(document.documentElement, {childList: true, subtree: true});
			const iv = setInterval(check, 250);
			if (timeoutMs) {
				setTimeout(() => {
					if (!done) {
						done = true;
						mo.disconnect();
						clearInterval(iv);
						reject(new Error('A-Frame scene not found'));
					}
				}, timeoutMs);
			}
		});
	};

	function buildContext(scene) {
		const q = sel => scene.querySelector(sel);
		const comp = name => () => scene.components[name] || null;
		return {
			AFRAME: window.AFRAME,
			THREE: window.AFRAME.THREE || window.THREE,
			scene,
			get renderer() {
				return scene.renderer;
			},
			get canvas() {
				return scene.canvas || document.getElementById('main-canvas');
			},
			get camera() {
				return scene.camera;
			},
			song: comp('song'),
			songControls: comp('song-controls'),
			replayLoader: comp('replay-loader'),
			replayPlayer: comp('replay-player'),
			cameraMover: comp('camera-mover'),
			beatGenerator: comp('beat-generator'),
			officialSettings: comp('settings'),
			colors: comp('colors'),
			playlist: comp('playlist'),
			hitSound: comp('beat-hit-sound'),
			state: () => (scene.systems.state && scene.systems.state.state) || {},
			materials: () => scene.systems.materials || null,
			get mainCamera() {
				return q('#mainCamera') || q('.mainCamera') || q('[camera][look-controls]');
			},
			get povCamera() {
				return q('#povCamera') || q('.povCamera');
			},
			get headset() {
				return q('.headset') || q('#head');
			},
			get leftSaber() {
				return q('#leftHand') || scene.querySelectorAll('[saber-controls]')[0] || null;
			},
			get rightSaber() {
				return q('#rightHand') || scene.querySelectorAll('[saber-controls]')[1] || null;
			},
			get beatContainer() {
				return q('#beatContainer');
			},
			q,
		};
	}

	/* ------------------------------------------------------------------ API helpers */

	const api = (R.api = {});

	api.song = () => R.ctx && R.ctx.song();
	api.duration = () => {
		const s = api.song();
		return s && s.getDuration ? s.getDuration() || 0 : 0;
	};
	/** Current song time in seconds (cached per frame while the runtime ticks). */
	api.time = () => {
		if (R.frame.fresh) return R.frame.time;
		const s = api.song();
		return s && s.getCurrentTime ? s.getCurrentTime() : 0;
	};
	api.isPlaying = () => !!(R.ctx && R.ctx.state().isPlaying);
	api.play = () => {
		if (!R.ctx || api.isPlaying()) return;
		R.ctx.scene.emit('usergesturereceive', null, false);
		R.ctx.scene.emit('gamemenuresume', null, false);
	};
	api.pause = () => {
		if (R.ctx && api.isPlaying()) R.ctx.scene.emit('pausegame', null, false);
	};
	api.togglePlay = () => (api.isPlaying() ? api.pause() : api.play());

	let seekInFlight = false;
	api.seekBusy = () => seekInFlight;
	api.seek = function (time) {
		const sc = R.ctx && R.ctx.songControls();
		const song = api.song();
		if (!sc || !song) return false;
		const dur = api.duration();
		const t = U.clamp(Number(time) || 0, 0, dur > 0 ? Math.max(0, dur - 0.02) : Number(time) || 0);
		seekInFlight = true;
		clearTimeout(api._seekTimer);
		api._seekTimer = setTimeout(() => (seekInFlight = false), 400);
		try {
			sc.seek(t);
		} catch (e) {
			R.log.warn('seek failed', e);
			seekInFlight = false;
			return false;
		}
		R.frame.seeked = true;
		R.emit('seek', t);
		return true;
	};

	api.getSpeed = () => {
		const sc = R.ctx && R.ctx.songControls();
		const s = api.song();
		if (sc && typeof sc.baseSongSpeed === 'number' && !isNaN(sc.baseSongSpeed)) return sc.baseSongSpeed;
		return s ? Number(s.speed) || 1 : 1;
	};

	/**
	 * Set playback speed with full precision. Updates song-controls' base speed (otherwise its tick
	 * would reset the rate), the audio rate and the official slider UI.
	 */
	api.setSpeed = function (value, {internal = false} = {}) {
		const v = U.round(U.clamp(Number(value) || 0, 0, 2), 4);
		const sc = R.ctx && R.ctx.songControls();
		const song = api.song();
		if (!song) return;
		if (sc) sc.baseSongSpeed = v;
		try {
			if (song.source || song.audio) song.setPlaybackRate(v);
		} catch (e) {
			R.log.debug('setPlaybackRate failed (audio not ready yet)', e);
		}
		song.speed = v;
		document.querySelectorAll('.speedSlider').forEach(el => {
			el.value = v;
			el.style.setProperty('--value', v);
		});
		document.querySelectorAll('.songSpeedPercent').forEach(el => (el.textContent = Math.round(v * 10000) / 10000 + 'x'));
		R.emit('speed', {value: v, internal});
	};

	/* ------------------------------------------------------------------ the replayer's own settings */

	/**
	 * Read and change the replayer's own settings (its `settings` component, saved in its
	 * localStorage). Changes go through its own menu control when there is one, the same way a
	 * click does, so the official menu, its value labels and its saved settings stay in sync.
	 */
	const official = (R.official = {});
	official.all = () => {
		const os = R.ctx && R.ctx.officialSettings();
		return (os && os.settings) || null;
	};
	official.get = key => {
		const all = official.all();
		return all ? all[key] : undefined;
	};
	official.input = key => {
		const el = document.getElementById(key);
		return el && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'range') ? el : el && el.tagName === 'SELECT' ? el : null;
	};
	official.set = function (key, value) {
		const input = official.input(key);
		if (input && input.type === 'checkbox') {
			if (input.checked === !!value) return;
			input.checked = !!value;
		} else if (input) {
			if (String(input.value) === String(value)) return;
			input.value = value;
		}
		if (input) {
			input.dispatchEvent(new Event('input', {bubbles: true}));
			input.dispatchEvent(new Event('change', {bubbles: true}));
			return;
		}
		const os = R.ctx && R.ctx.officialSettings();
		if (!os || !os.settings || os.settings[key] === value) return;
		os.settings[key] = value;
		os.sync();
	};
	/** fn(settings) after any change to the replayer's own settings. */
	official.onChange = fn => R.ctx && R.ctx.scene.addEventListener('settingsChanged', e => fn((e.detail && e.detail.settings) || official.all() || {}));

	api.getJd = () => {
		const el = document.getElementById('jd');
		return el && el.value ? Number(el.value) : null;
	};
	api.setJd = v => {
		const el = document.getElementById('jd');
		if (el) {
			el.value = v;
			el.dispatchEvent(new Event('input', {bubbles: true}));
		} else {
			const bg = R.ctx && R.ctx.beatGenerator();
			if (bg && bg.setNewJD) bg.setNewJD(Number(v));
		}
	};

	api.replay = () => {
		const rl = R.ctx && R.ctx.replayLoader();
		return rl ? rl.replay : null;
	};
	api.notes = () => {
		const rl = R.ctx && R.ctx.replayLoader();
		return (rl && rl.allStructs) || [];
	};
	api.scoreId = () => new URLSearchParams(location.search).get('scoreId');

	/** Show a short notification using the replayer's own hotkey notification (or our toast). */
	api.notify = function (text, icon = 'fas fa-star') {
		if (R.settings && !R.settings.general.showToasts) return;
		const scene = R.ctx && R.ctx.scene;
		if (scene && scene.components['hotkey-notification']) scene.emit('showHotkeyNotification', {text, icon});
		else if (R.ui) R.ui.toast(text);
	};

	/** Classify a replay note struct: good | bad | miss | bomb | wall. */
	api.noteKind = function (note) {
		if (!note) return 'good';
		if (note.score === -5) return 'wall';
		if (note.score === -4 || note.eventType === 3) return 'bomb';
		if (note.score === -3 || note.eventType === 2) return 'miss';
		if (note.score === -2 || note.eventType === 1) return 'bad';
		return 'good';
	};

	/** Hand (0 left / 1 right) for a note struct. */
	api.noteHand = function (note) {
		if (note && note.cutInfo && typeof note.cutInfo.saberType === 'number') return note.cutInfo.saberType;
		const id = note && note.id;
		if (typeof id === 'number' && id >= 0) return Math.floor(id / 10) % 10 === 1 ? 1 : 0;
		return 0;
	};

	/** Index of the last note with time <= t (binary search over allStructs, which is time-sorted). */
	api.noteIndexAt = function (notes, t) {
		let lo = 0;
		let hi = notes.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (notes[mid].time <= t) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return ans;
	};

	/** Height offset the replayer applies to tracked objects (see replay-player.js). */
	api.heightOffset = function (time) {
		const replay = api.replay();
		if (!replay) return 0;
		let h = replay.info ? replay.info.height : 1.8;
		if (replay.heights && replay.heights.length) {
			let lo = 0;
			let hi = replay.heights.length - 1;
			let idx = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (replay.heights[mid].time <= time) {
					idx = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			h = replay.heights[idx].height;
		}
		return U.clamp((h - 1.8) * 0.5, -0.2, 0.6);
	};

	/** Convert a replay cut point (Beat Saber space) to scene space. */
	api.cutPointToScene = function (note, out) {
		const THREE = R.ctx.THREE;
		const v = out || new THREE.Vector3();
		const cp = note && note.cutInfo && note.cutInfo.cutPoint;
		if (!cp) return null;
		return v.set(cp.x, cp.y - api.heightOffset(note.time), -cp.z);
	};

	/* ------------------------------------------------------------------ replay info */

	function replayInfoFromLoader() {
		const replay = api.replay();
		if (!replay || !replay.info) return null;
		const i = replay.info;
		return {
			replay,
			notes: api.notes(),
			key: [i.playerID, i.hash, i.difficulty, i.mode, i.timestamp].map(v => String(v || '')).join('_'),
			title: `${i.playerName || '?'} – ${i.songName || '?'} (${i.difficulty || ''})`,
			playerName: i.playerName || '',
			songName: i.songName || '',
			difficulty: i.difficulty || '',
			scoreId: api.scoreId(),
		};
	}

	function onReplayLoaded() {
		const info = replayInfoFromLoader();
		if (!info) return;
		if (R.replayInfo && R.replayInfo.key === info.key && R.replayInfo.notes === info.notes) return;
		R.replayInfo = info;
		noteCursor = -1;
		R.log.info('replay loaded', info.title, info.notes.length, 'events');
		R.emit('replay', info);
		for (const m of R.modules) safeCall(m, 'onReplay', info);
	}

	/* ------------------------------------------------------------------ module registry */

	function safeCall(mod, fnName, ...args) {
		if (!mod || typeof mod[fnName] !== 'function') return undefined;
		try {
			return mod[fnName](...args);
		} catch (e) {
			mod.__errors = (mod.__errors || 0) + 1;
			if (mod.__errors < 5) R.log.error(`module ${mod.name}.${fnName} failed`, e);
			return undefined;
		}
	}
	R.safeCall = safeCall;

	R.register = function (mod) {
		if (!mod || !mod.name) throw new Error('module needs a name');
		if (R.modules.some(m => m.name === mod.name)) return;
		R.modules.push(mod);
		if (R.ctx) {
			safeCall(mod, 'init', R.ctx);
			if (R.settings) safeCall(mod, 'onSettings', R.settings);
			if (R.replayInfo) safeCall(mod, 'onReplay', R.replayInfo);
		}
	};
	R.module = name => R.modules.find(m => m.name === name) || null;

	/* ------------------------------------------------------------------ frame loop */

	let noteCursor = -1;
	let lastMaintain = 0;

	function frameTick(now, delta) {
		if (!R.ctx) return;
		const song = R.ctx.song();
		const f = R.frame;
		f.prevTime = f.time;
		const t = song && song.getCurrentTime ? song.getCurrentTime() : f.time;
		f.time = t;
		f.fresh = true;
		f.now = now;
		f.dt = Math.min(0.1, Math.max(0, (delta || 16) / 1000));
		f.playing = api.isPlaying();
		f.speed = song ? Number(song.speed) || 0 : 1;
		const jump = Math.abs(t - f.prevTime);
		const expected = f.dt * Math.max(f.speed, 0.05) * 4 + 0.15;
		if (jump > expected || t < f.prevTime - 1e-4) f.seeked = true;

		// Note event stream: fire 'note' for every replay event passed while playing forward.
		const notes = R.replayInfo ? R.replayInfo.notes : null;
		if (notes && notes.length) {
			if (f.seeked || noteCursor < 0) {
				noteCursor = api.noteIndexAt(notes, t);
			} else if (t > f.prevTime) {
				while (noteCursor + 1 < notes.length && notes[noteCursor + 1].time <= t) {
					noteCursor++;
					const note = notes[noteCursor];
					const evt = {note, index: noteCursor, kind: api.noteKind(note), hand: api.noteHand(note)};
					R.emit('note', evt);
				}
			}
		}

		if (R.active()) {
			for (const m of R.modules) if (m.tick) safeCall(m, 'tick', f);
			if (now - lastMaintain > 250) {
				lastMaintain = now;
				for (const m of R.modules) if (m.maintain) safeCall(m, 'maintain', f);
			}
		}
		f.seeked = false;
	}

	function frameTock(now, delta) {
		if (!R.ctx || !R.active()) return;
		for (const m of R.modules) if (m.tock) safeCall(m, 'tock', R.frame);
		R.frame.fresh = false;
	}

	function installRuntimeComponent(scene) {
		const A = window.AFRAME;
		if (!A.components['blp-runtime']) {
			A.registerComponent('blp-runtime', {
				tick: (time, delta) => frameTick(time, delta),
				tock: (time, delta) => frameTock(time, delta),
			});
		}
		if (!scene.hasAttribute('blp-runtime')) scene.setAttribute('blp-runtime', '');
	}

	/* ------------------------------------------------------------------ hotkeys */

	const hotkeyHandlers = {};
	const hotkeyProviders = [];
	const GLOBAL_ACTIONS = ['openOptions', 'toggleTheme', 'toggleOverlays', 'nextMap', 'prevMap'];

	/** Bind a replay action (key from settings.hotkeys.bindings[action]). opts.repeat allows key repeat. */
	R.addHotkey = function (action, fn, opts = {}) {
		hotkeyHandlers[action] = {fn, repeat: !!opts.repeat};
	};
	/** Dynamic bindings (e.g. camera preset hotkeys): provider returns [{combo, run}]. */
	R.addHotkeyProvider = fn => hotkeyProviders.push(fn);

	window.addEventListener(
		'keydown',
		e => {
			if (!R.active() || !R.settings.hotkeys.enabled || !R.ctx) return;
			if (U.isTypingTarget(e.target) || U.isModifierEvent(e)) return;
			const bindings = R.settings.hotkeys.bindings || {};
			const consume = () => {
				e.preventDefault();
				e.stopImmediatePropagation();
			};
			for (const action of Object.keys(hotkeyHandlers)) {
				if (GLOBAL_ACTIONS.includes(action)) continue;
				if (!U.hotkeyMatches(e, bindings[action])) continue;
				consume();
				const h = hotkeyHandlers[action];
				if (e.repeat && !h.repeat) return;
				R.log.debug('hotkey', action);
				try {
					h.fn(e);
				} catch (err) {
					R.log.error('hotkey failed', action, err);
				}
				return;
			}
			if (e.repeat) return;
			for (const provider of hotkeyProviders) {
				let list = [];
				try {
					list = provider() || [];
				} catch (err) {
					continue;
				}
				for (const item of list) {
					if (item.combo && U.hotkeyMatches(e, item.combo)) {
						consume();
						item.run(e);
						return;
					}
				}
			}
		},
		true
	);

	/* ------------------------------------------------------------------ boot */

	R.boot = async function () {
		if (R.__booted) return;
		R.__booted = true;
		try {
			const init = await R.request('hello', {}, 15000);
			R.version = init.version;
			R.runtime = init.runtime || {};
			applySettings(init.settings, init.locale);
		} catch (e) {
			console.error('[BLP] could not reach the extension bridge', e);
			return;
		}

		const scene = await R.waitForScene();
		R.ctx = buildContext(scene);
		R.log.info('scene ready');

		installRuntimeComponent(scene);
		for (const m of R.modules) safeCall(m, 'init', R.ctx);
		for (const m of R.modules) safeCall(m, 'onSettings', R.settings);

		scene.addEventListener('replayloaded', () => setTimeout(onReplayLoaded, 0));
		scene.addEventListener('replayunload', () => {
			R.replayInfo = null;
			noteCursor = -1;
			R.emit('replayunload');
			for (const m of R.modules) safeCall(m, 'onReplayUnload');
		});
		scene.addEventListener('timechanged', () => {
			R.frame.seeked = true;
			seekInFlight = false;
			R.emit('timechanged');
		});
		scene.addEventListener('songstartaudio', () => R.emit('songstart'));
		// Our scripts may arrive after the replay finished loading.
		const poll = setInterval(() => {
			if (api.replay() && api.notes().length) {
				onReplayLoaded();
				clearInterval(poll);
			}
		}, 500);

		R.onCommand('status', () => ({
			ready: true,
			version: R.version,
			replay: R.replayInfo ? {title: R.replayInfo.title, key: R.replayInfo.key} : null,
			camera: R.cameraStatus ? R.cameraStatus() : null,
			overlaysHidden: !!R.overlaysHidden,
		}));

		R.request('status', {ready: true}).catch(() => {});
		R.emit('ready', R.ctx);
		for (const m of R.modules) safeCall(m, 'onReady', R.ctx);
	};
})();
