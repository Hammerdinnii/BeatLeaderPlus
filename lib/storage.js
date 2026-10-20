/*
 * BeatLeaderPlus – persistence layer.
 *
 * Settings layout
 * ---------------
 *   chrome.storage.sync   blp_meta                  {version, localSections[], updated}
 *                         blp_s_<section>           one item per top-level settings section
 *   chrome.storage.local  blp_s_<section>           sections that exceed the sync per-item quota
 *                                                   (e.g. a large custom CSS block) or when sync
 *                                                   is unavailable/disabled ("local fallback")
 *                         blp_domain_overrides      {[domain]: partialSettings}
 *                         blp_runtime / blp_bookmarks / blp_camera_paths / blp_hitsound_pack /
 *                         blp_saber_models / blp_favorites / blp_follow_state
 *
 * Only sections whose JSON changed since the last load/save are written, and all sync writes of
 * one save are batched into a single set() call, to respect the sync write-rate quotas.
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.storage) return;

	const U = BLP.utils;
	const D = BLP.defaults;
	const KEYS = D.KEYS;
	const SYNC_ITEM_LIMIT = 7600; // bytes, a little below QUOTA_BYTES_PER_ITEM (8192)

	const log = U.createLogger('[BLP:storage]', () => storage._debug);
	const lastSavedJson = {};

	function area(name) {
		try {
			return root.chrome && chrome.storage && chrome.storage[name] ? chrome.storage[name] : null;
		} catch (e) {
			return null;
		}
	}

	async function safeGet(areaName, keys) {
		const a = area(areaName);
		if (!a) return {};
		try {
			return (await a.get(keys)) || {};
		} catch (e) {
			log.warn('get failed on', areaName, e && e.message);
			return {};
		}
	}

	async function safeSet(areaName, items) {
		const a = area(areaName);
		if (!a) throw new Error('storage.' + areaName + ' unavailable');
		await a.set(items);
	}

	async function safeRemove(areaName, keys) {
		const a = area(areaName);
		if (!a) return;
		try {
			await a.remove(keys);
		} catch (e) {
			/* ignore */
		}
	}

	const sectionKey = s => KEYS.sectionPrefix + s;

	/* ------------------------------------------------------------------ migration */

	function migrate(settings) {
		const from = settings.schemaVersion || 1;
		if (from < 2) {
			// v2 introduced editable built-in camera presets.
			if (!Array.isArray(U.getPath(settings, 'camera.presets')) || !settings.camera.presets.length) {
				U.setPath(settings, 'camera.presets', U.deepClone(D.BUILTIN_CAMERA_PRESETS));
			}
		}
		if (from < 3) {
			// v3 normalised hotkey strings and renamed overlay corner shorthands.
			const bindings = U.getPath(settings, 'hotkeys.bindings', {});
			for (const k of Object.keys(bindings)) bindings[k] = U.normalizeHotkey(bindings[k]);
			const corner = {tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right'};
			const pos = U.getPath(settings, 'overlay.position');
			if (corner[pos]) settings.overlay.position = corner[pos];
		}
		settings.schemaVersion = D.SCHEMA_VERSION;
		return settings;
	}

	/* ------------------------------------------------------------------ settings */

	const storage = {
		_debug: false,
		KEYS,

		hasSync: () => !!area('sync'),

		/** Load the global settings, merged over defaults and migrated. */
		async loadSettings() {
			const keys = D.SECTIONS.map(sectionKey).concat([KEYS.meta]);
			const [syncData, localData] = await Promise.all([safeGet('sync', keys), safeGet('local', keys)]);
			const meta = syncData[KEYS.meta] || localData[KEYS.meta] || {};
			const localSections = Array.isArray(meta.localSections) ? meta.localSections : [];
			const raw = {};
			for (const s of D.SECTIONS) {
				const k = sectionKey(s);
				const preferLocal = localSections.includes(s);
				const v = preferLocal ? localData[k] || syncData[k] : syncData[k] || localData[k];
				if (v !== undefined) {
					raw[s] = v;
					lastSavedJson[s] = JSON.stringify(v);
				}
			}
			const hadData = Object.keys(raw).length > 0;
			raw.schemaVersion = meta.version || (hadData ? 1 : D.SCHEMA_VERSION);
			const merged = migrate(U.withDefaults(raw, D.DEFAULT_SETTINGS));
			storage._debug = !!merged.general.debug;
			return merged;
		},

		/**
		 * Persist settings. Pass `{force: true}` to write every section regardless of the change cache.
		 * Returns {sync: [...sections], local: [...sections]}.
		 */
		async saveSettings(settings, opts = {}) {
			const changed = D.SECTIONS.filter(s => {
				if (settings[s] === undefined) return false;
				return opts.force || JSON.stringify(settings[s]) !== lastSavedJson[s];
			});
			const stored = await safeGet('sync', [KEYS.meta]);
			const localMeta = await safeGet('local', [KEYS.meta]);
			const meta = stored[KEYS.meta] || localMeta[KEYS.meta] || {localSections: []};
			const localSections = new Set(meta.localSections || []);
			if (!changed.length) return {sync: [], local: []};

			const syncItems = {};
			const localItems = {};
			const canSync = storage.hasSync();
			for (const s of changed) {
				const k = sectionKey(s);
				const size = new Blob([JSON.stringify({[k]: settings[s]})]).size;
				if (canSync && size < SYNC_ITEM_LIMIT) {
					syncItems[k] = settings[s];
					localSections.delete(s);
				} else {
					localItems[k] = settings[s];
					localSections.add(s);
				}
			}

			const newMeta = {version: D.SCHEMA_VERSION, localSections: Array.from(localSections), updated: Date.now()};
			const result = {sync: [], local: []};

			if (Object.keys(syncItems).length) {
				try {
					await safeSet('sync', Object.assign({}, syncItems, {[KEYS.meta]: newMeta}));
					result.sync = Object.keys(syncItems);
					// Remove stale local copies of sections that now live in sync.
					await safeRemove('local', Object.keys(syncItems));
				} catch (e) {
					// Quota or sync disabled: fall back to local storage for everything in this batch.
					log.warn('sync write failed, falling back to local:', e && e.message);
					for (const k of Object.keys(syncItems)) {
						localItems[k] = syncItems[k];
						newMeta.localSections.push(k.slice(KEYS.sectionPrefix.length));
					}
				}
			}
			if (Object.keys(localItems).length) {
				await safeSet('local', Object.assign({}, localItems, {[KEYS.meta]: newMeta}));
				result.local = Object.keys(localItems);
				try {
					await safeSet('sync', {[KEYS.meta]: newMeta});
					await safeRemove('sync', Object.keys(localItems));
				} catch (e) {
					/* sync unavailable – meta lives in local */
				}
			} else {
				await safeSet('local', {[KEYS.meta]: newMeta}).catch(() => {});
			}
			for (const s of changed) lastSavedJson[s] = JSON.stringify(settings[s]);
			storage._debug = !!(settings.general && settings.general.debug);
			return result;
		},

		/** Merge a partial settings object into the stored settings and save. */
		async patchSettings(patch) {
			const current = await storage.loadSettings();
			const next = U.deepMerge(current, patch);
			await storage.saveSettings(next);
			return next;
		},

		async resetSettings() {
			const keys = D.SECTIONS.map(sectionKey).concat([KEYS.meta]);
			await safeRemove('sync', keys);
			await safeRemove('local', keys.concat([KEYS.domainOverrides]));
			for (const s of Object.keys(lastSavedJson)) delete lastSavedJson[s];
			const fresh = U.deepClone(D.DEFAULT_SETTINGS);
			await storage.saveSettings(fresh, {force: true});
			return fresh;
		},

		/* -------------------------------------------------------------- per-domain */

		async loadDomainOverrides() {
			return storage.getLocal(KEYS.domainOverrides, {});
		},

		async saveDomainOverrides(map) {
			return storage.setLocal(KEYS.domainOverrides, map || {});
		},

		/** Settings that apply to `host`: global settings plus the domain's overrides (if enabled). */
		async loadEffective(host) {
			const settings = await storage.loadSettings();
			return storage.applyDomain(settings, await storage.loadDomainOverrides(), host);
		},

		applyDomain(settings, overrides, host) {
			if (!settings.general.perDomain || !host) return settings;
			const o = overrides && overrides[U.domainKey(host)];
			if (!o) return settings;
			const merged = U.deepMerge(settings, o);
			merged.general.perDomain = true; // the scope switch itself is always global
			return merged;
		},

		/* -------------------------------------------------------------- local helpers */

		async getLocal(key, fallback) {
			const data = await safeGet('local', [key]);
			return data[key] === undefined ? U.deepClone(fallback) : data[key];
		},

		async setLocal(key, value) {
			await safeSet('local', {[key]: value});
			return value;
		},

		async removeLocal(key) {
			await safeRemove('local', [key]);
		},

		/** Read-modify-write helper for local JSON blobs. */
		async updateLocal(key, fallback, mutator) {
			const current = await storage.getLocal(key, fallback);
			const next = (await mutator(current)) || current;
			await storage.setLocal(key, next);
			return next;
		},

		/* -------------------------------------------------------------- change events */

		/**
		 * Call `callback()` (debounced) whenever settings or domain overrides change in any
		 * extension context. Returns an unsubscribe function.
		 */
		onSettingsChanged(callback, delay = 60) {
			if (!root.chrome || !chrome.storage || !chrome.storage.onChanged) return () => {};
			const fire = U.debounce(callback, delay);
			const listener = (changes, areaName) => {
				const keys = Object.keys(changes);
				const relevant = keys.some(k => k.startsWith(KEYS.sectionPrefix) || k === KEYS.meta || k === KEYS.domainOverrides);
				if (relevant) {
					for (const k of keys) {
						if (k.startsWith(KEYS.sectionPrefix) && changes[k].newValue !== undefined) {
							lastSavedJson[k.slice(KEYS.sectionPrefix.length)] = JSON.stringify(changes[k].newValue);
						}
					}
					fire(areaName, keys);
				}
			};
			chrome.storage.onChanged.addListener(listener);
			return () => chrome.storage.onChanged.removeListener(listener);
		},

		/** Subscribe to a single local key. */
		onLocalChanged(key, callback) {
			if (!root.chrome || !chrome.storage || !chrome.storage.onChanged) return () => {};
			const listener = (changes, areaName) => {
				if (areaName === 'local' && changes[key]) callback(changes[key].newValue);
			};
			chrome.storage.onChanged.addListener(listener);
			return () => chrome.storage.onChanged.removeListener(listener);
		},

		/* -------------------------------------------------------------- import / export */

		async exportAll({includeHitsounds = false, includeModels = false} = {}) {
			const settings = await storage.loadSettings();
			const out = {
				format: 'beatleaderplus-config',
				version: D.SCHEMA_VERSION,
				exportedAt: new Date().toISOString(),
				settings,
				domainOverrides: await storage.loadDomainOverrides(),
				data: {
					bookmarks: await storage.getLocal(KEYS.bookmarks, {}),
					cameraPaths: await storage.getLocal(KEYS.cameraPaths, []),
					favorites: await storage.getLocal(KEYS.favorites, D.DEFAULT_FAVORITES),
					followedPlayers: (await storage.getLocal(KEYS.follow, D.DEFAULT_FOLLOW_STATE)).players,
				},
			};
			if (includeHitsounds) out.data.hitsoundPack = await storage.getLocal(KEYS.hitsoundPack, null);
			if (includeModels) out.data.saberModels = await storage.getLocal(KEYS.saberModels, {});
			return out;
		},

		/** Validate and import a config produced by exportAll (or a bare settings object). */
		async importAll(json) {
			const data = typeof json === 'string' ? JSON.parse(json) : json;
			if (!U.isObject(data)) throw new Error('Invalid file: expected a JSON object.');
			let settings = data.settings;
			if (!settings && (data.general || data.theme || data.camera)) settings = data; // bare settings
			if (!U.isObject(settings)) throw new Error('Invalid file: no settings found.');
			const merged = migrate(U.withDefaults(U.deepClone(settings), D.DEFAULT_SETTINGS));
			await storage.saveSettings(merged, {force: true});
			if (U.isObject(data.domainOverrides)) await storage.saveDomainOverrides(data.domainOverrides);
			const extra = data.data || {};
			if (U.isObject(extra.bookmarks)) await storage.setLocal(KEYS.bookmarks, extra.bookmarks);
			if (Array.isArray(extra.cameraPaths)) await storage.setLocal(KEYS.cameraPaths, extra.cameraPaths);
			if (U.isObject(extra.favorites)) await storage.setLocal(KEYS.favorites, U.withDefaults(extra.favorites, D.DEFAULT_FAVORITES));
			if (U.isObject(extra.followedPlayers)) {
				await storage.updateLocal(KEYS.follow, D.DEFAULT_FOLLOW_STATE, st => {
					st.players = Object.assign({}, st.players, extra.followedPlayers);
					return st;
				});
			}
			if (extra.hitsoundPack) await storage.setLocal(KEYS.hitsoundPack, extra.hitsoundPack);
			if (U.isObject(extra.saberModels)) await storage.setLocal(KEYS.saberModels, extra.saberModels);
			return merged;
		},

		migrate,
	};

	BLP.storage = storage;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
