/*
 * BeatLeaderPlus – early content script (document_start, all frames).
 *
 * Loads the effective settings for this host as early as possible, applies the website theme
 * before first paint and exposes a small shared state object that the document_idle scripts
 * (content.js and modules/*) build on:
 *
 *   BLP.page        {host, isReplayHost, isSiteHost}
 *   BLP.ready       Promise<settings> resolved once settings are loaded
 *   BLP.state       {settings}
 *   BLP.onSettings  (fn) => subscribe to live settings changes (from options/popup/other tabs)
 *   BLP.log         logger honouring the "debug logging" setting
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.page) return; // already initialised in this frame

	const {utils: U, storage, i18n, theme} = BLP;
	const host = location.hostname;

	BLP.page = {
		host,
		isReplayHost: U.REPLAY_HOST_RE.test(host),
		isSiteHost: U.SITE_HOST_RE.test(host),
	};
	BLP.state = {settings: null};
	BLP.log = U.createLogger('[BLP]', () => BLP.state.settings && BLP.state.settings.general.debug);

	const listeners = [];
	BLP.onSettings = fn => {
		listeners.push(fn);
		return () => listeners.splice(listeners.indexOf(fn) >>> 0, 1);
	};

	function adopt(settings) {
		BLP.state.settings = settings;
		i18n.setLocale(settings.general.language);
		storage._debug = !!settings.general.debug;
		theme.apply(settings);
	}

	BLP.ready = storage
		.loadEffective(host)
		.then(settings => {
			adopt(settings);
			return settings;
		})
		.catch(err => {
			console.error('[BLP] failed to load settings, using defaults', err);
			const fallback = U.deepClone(BLP.defaults.DEFAULT_SETTINGS);
			adopt(fallback);
			return fallback;
		});

	storage.onSettingsChanged(async () => {
		try {
			const settings = await storage.loadEffective(host);
			adopt(settings);
			for (const fn of listeners.slice()) {
				try {
					fn(settings);
				} catch (e) {
					BLP.log.error('settings listener failed', e);
				}
			}
		} catch (e) {
			BLP.log.error('failed to reload settings', e);
		}
	});

	/** Promise wrapper around chrome.runtime.sendMessage that unwraps {ok, data, error}. */
	BLP.send = function (type, payload) {
		return new Promise((resolve, reject) => {
			try {
				chrome.runtime.sendMessage(Object.assign({type}, payload || {}), res => {
					const err = chrome.runtime.lastError;
					if (err) return reject(new Error(err.message));
					if (!res) return reject(new Error('No response'));
					if (!res.ok) return reject(new Error(res.error || 'Request failed'));
					resolve(res.data);
				});
			} catch (e) {
				reject(e); // extension context invalidated (extension reloaded)
			}
		});
	};
})();
