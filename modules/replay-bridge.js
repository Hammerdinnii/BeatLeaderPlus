/*
 * BeatLeaderPlus – replay page bridge (content script, isolated world).
 *
 * HOW THE INJECTION WORKS
 * -----------------------
 * Content scripts run in an isolated JavaScript world: they share the DOM with the page but not
 * its globals, so they cannot see window.AFRAME, the <a-scene> components or the replay player.
 * To reach those we inject our replay runtime into the page's own (MAIN) world:
 *
 *   1. Primary: <script src="chrome-extension://…/injected/*.js"> tags (files are listed in
 *      web_accessible_resources). `async = false` keeps execution order.
 *   2. Fallback: if a script fails to load (e.g. a strict CSP), we ask the background worker to
 *      run chrome.scripting.executeScript({world: 'MAIN', frameIds: [thisFrame]}) with the same
 *      file list.
 *
 * The page runtime has no chrome.* access, so it talks to this bridge with window.postMessage:
 *   page → content   {channel, dir: 'p2c', id?, type, payload}     (requests, e.g. save bookmarks)
 *   content → page   {channel, dir: 'c2p', id?, type, payload}     (init, settings, commands)
 *   replies          {channel, dir, replyTo: id, ok, data | error}
 * Only an explicit allow-list of request types is handled, and settings patches from the page
 * are restricted to replay-related sections.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.replayBridge) return;
	const {utils: U, storage, defaults: D} = BLP;

	const CHANNEL = 'BLP_BRIDGE_v1';
	const FILES = [
		'lib/i18n.js',
		'lib/utils.js',
		'lib/unity-saber.js',
		'injected/core.js',
		'injected/ui.js',
		'injected/camera.js',
		'injected/visuals.js',
		'injected/bloom.js',
		'injected/playback.js',
		'injected/hud.js',
		'injected/audio.js',
		'injected/export.js',
		'injected/performance.js',
		'injected-replay.js',
	];
	const PAGE_PATCHABLE_SECTIONS = ['camera', 'playback', 'overlay', 'visuals', 'audio', 'export'];
	const MAX_PATHS = 100;
	const MODEL_EXT = /\.(glb|gltf|obj|saber)$/i;
	const MAX_MODEL_BYTES = 32 * 1024 * 1024; // same limit as uploads on the options page

	const pending = new Map();
	let seq = 0;
	let started = false;
	let pageStatus = {loaded: false, ready: false};

	const targetOrigin = () => (location.origin && location.origin !== 'null' ? location.origin : '*');

	function post(msg) {
		window.postMessage(Object.assign({channel: CHANNEL, dir: 'c2p'}, msg), targetOrigin());
	}

	function request(type, payload, timeout = 8000) {
		const id = 'c' + ++seq;
		return new Promise((resolve, reject) => {
			pending.set(id, {resolve, reject});
			post({id, type, payload});
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error('Replay page did not respond'));
				}
			}, timeout);
		});
	}

	function b64ToBuffer(b64) {
		const bytes = U.base64ToBytes(b64);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}

	async function initPayload() {
		const settings = BLP.state.settings || (await BLP.ready);
		return {
			settings,
			strings: BLP.i18n.table(),
			locale: BLP.i18n.getLocale(),
			version: chrome.runtime.getManifest().version,
			runtime: await storage.getLocal(D.KEYS.runtime, {}),
		};
	}

	/* ------------------------------------------------------------------ page → content handlers */

	const handlers = {
		async hello() {
			pageStatus.loaded = true;
			return initPayload();
		},
		async status(p) {
			pageStatus = Object.assign(pageStatus, p || {});
			return true;
		},
		async getBookmarks({key}) {
			const all = await storage.getLocal(D.KEYS.bookmarks, {});
			return all[key] || {items: []};
		},
		async saveBookmarks({key, title, scoreId, items}) {
			if (!key || typeof key !== 'string') throw new Error('Invalid key');
			await storage.updateLocal(D.KEYS.bookmarks, {}, all => {
				const clean = (Array.isArray(items) ? items : [])
					.filter(b => b && isFinite(b.t))
					.slice(0, 500)
					.map(b => ({t: Number(b.t), note: String(b.note || '').slice(0, 500), created: Number(b.created) || Date.now()}));
				if (!clean.length) delete all[key];
				else all[key] = {title: String(title || '').slice(0, 200), scoreId: scoreId ? String(scoreId) : null, url: location.href, updated: Date.now(), items: clean};
				return all;
			});
			return true;
		},
		async getPaths() {
			return storage.getLocal(D.KEYS.cameraPaths, []);
		},
		async savePath({path}) {
			if (!path || !path.id || !Array.isArray(path.keyframes)) throw new Error('Invalid path');
			await storage.updateLocal(D.KEYS.cameraPaths, [], list => {
				const i = list.findIndex(p => p.id === path.id);
				if (i >= 0) list[i] = path;
				else list.unshift(path);
				return list.slice(0, MAX_PATHS);
			});
			return true;
		},
		async deletePath({id}) {
			await storage.updateLocal(D.KEYS.cameraPaths, [], list => list.filter(p => p.id !== id));
			return true;
		},
		async getHitsounds() {
			const pack = await storage.getLocal(D.KEYS.hitsoundPack, null);
			if (!pack || !Array.isArray(pack.sounds)) return {name: null, sounds: []};
			return {name: pack.name, sounds: pack.sounds.map(s => ({id: s.id, name: s.name, mime: s.mime, data: b64ToBuffer(s.b64)}))};
		},
		async getSaberModel({name}) {
			const models = await storage.getLocal(D.KEYS.saberModels, {});
			const m = models[name];
			if (!m) throw new Error('Stored model not found: ' + name);
			return {name: m.name, mime: m.mime, data: b64ToBuffer(m.b64)};
		},
		async listSaberModels() {
			const models = await storage.getLocal(D.KEYS.saberModels, {});
			return Object.values(models).map(m => ({name: m.name, size: m.size}));
		},
		/** A model dropped on Settings → BL+; stored like an upload from the options page. */
		async saveSaberModel({name, data}) {
			const clean = String(name || '')
				.split(/[\\/]/)
				.pop()
				.slice(0, 120);
			if (!MODEL_EXT.test(clean)) throw new Error('Unsupported model type: ' + clean);
			if (!(data instanceof ArrayBuffer) || !data.byteLength) throw new Error('Empty model file');
			if (data.byteLength > MAX_MODEL_BYTES) throw new Error('Model is larger than ' + MAX_MODEL_BYTES / 1048576 + ' MB');
			const mime = /\.obj$/i.test(clean) ? 'text/plain' : /\.gltf$/i.test(clean) ? 'model/gltf+json' : /\.saber$/i.test(clean) ? 'application/octet-stream' : 'model/gltf-binary';
			const b64 = U.bytesToBase64(new Uint8Array(data));
			await storage.updateLocal(D.KEYS.saberModels, {}, m => Object.assign(m, {[clean]: {name: clean, mime, size: data.byteLength, b64, added: Date.now()}}));
			return {ref: 'stored:' + clean, name: clean};
		},
		async patchSettings({patch}) {
			if (!U.isObject(patch)) throw new Error('Invalid patch');
			const filtered = {};
			for (const k of PAGE_PATCHABLE_SECTIONS) if (U.isObject(patch[k])) filtered[k] = patch[k];
			if (!Object.keys(filtered).length) return false;
			await storage.patchSettings(filtered);
			return true;
		},
		async getRuntime() {
			return storage.getLocal(D.KEYS.runtime, {});
		},
		async setRuntime({values}) {
			if (!U.isObject(values)) return false;
			await storage.updateLocal(D.KEYS.runtime, {}, rt => Object.assign(rt, values));
			return true;
		},
		async openOptions({section}) {
			return BLP.send('openOptions', {section: section || 'camera'});
		},
		async resolveScore({scoreId}) {
			return BLP.send('resolveScore', {scoreId});
		},
	};

	function onMessage(e) {
		if (e.source !== window || !e.data || e.data.channel !== CHANNEL || e.data.dir !== 'p2c') return;
		const msg = e.data;
		if (msg.replyTo) {
			const p = pending.get(msg.replyTo);
			if (p) {
				pending.delete(msg.replyTo);
				msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'Page error'));
			}
			return;
		}
		const handler = Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
		const reply = (ok, dataOrError) => msg.id && post(ok ? {replyTo: msg.id, ok: true, data: dataOrError} : {replyTo: msg.id, ok: false, error: String(dataOrError)});
		if (!handler) return reply(false, 'Unknown request: ' + msg.type);
		Promise.resolve()
			.then(() => handler(msg.payload || {}))
			.then(
				data => reply(true, data),
				err => {
					BLP.log.warn('bridge handler failed', msg.type, err);
					reply(false, (err && err.message) || err);
				}
			);
	}

	/* ------------------------------------------------------------------ injection */

	function inject() {
		const parent = document.head || document.documentElement;
		let fellBack = false;
		const fallback = () => {
			if (fellBack) return;
			fellBack = true;
			BLP.log.warn('script tag injection blocked, using chrome.scripting fallback');
			BLP.send('injectMain', {files: FILES}).catch(err => BLP.log.error('MAIN world injection failed', err));
		};
		for (const file of FILES) {
			const s = document.createElement('script');
			s.src = chrome.runtime.getURL(file);
			// Extension resources carry no charset header and the replayer page declares none, so
			// without this the UTF-8 sources (icons, dashes) would be decoded as windows-1252.
			s.charset = 'utf-8';
			s.async = false;
			s.dataset.blp = file;
			s.onload = () => s.remove();
			s.onerror = () => {
				s.remove();
				fallback();
			};
			parent.appendChild(s);
		}
	}

	BLP.replayBridge = {
		start() {
			if (started) return;
			started = true;
			window.addEventListener('message', onMessage);
			inject();
			storage.onLocalChanged(D.KEYS.hitsoundPack, () => request('command', {action: 'reloadHitsounds'}, 20000).catch(() => {}));
		},
		pushSettings(settings) {
			if (!started) return;
			post({type: 'settings', payload: {settings, strings: BLP.i18n.table(), locale: BLP.i18n.getLocale()}});
		},
		/** Send a command to the page runtime (used by the popup and global hotkeys). */
		command(action, payload, timeout) {
			return request('command', Object.assign({action}, payload || {}), timeout);
		},
		status: () => Object.assign({}, pageStatus),
	};
})();
