/*
 * BeatLeaderPlus – main content script (document_idle, all frames).
 *
 * Detects what kind of page we are on and starts the matching modules:
 *   - replay viewer  → modules/replay-bridge.js injects the page-world runtime (injected/*.js)
 *   - website pages  → modules/site-enhancements.js + modules/site-profile-stats.js
 * It also wires the global hotkeys and answers messages from the popup.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || !BLP.page || BLP.contentStarted) return;
	BLP.contentStarted = true;

	function detectPageType() {
		if (BLP.page.isReplayHost) return 'replay';
		// Any A-Frame scene driven by the BeatLeader replay components counts as a replay viewer.
		if (document.querySelector('a-scene[replay-loader], a-scene[replay-player], a-scene[bind__replay-loader]')) return 'replay';
		if (BLP.page.isSiteHost) return 'site';
		return 'other';
	}

	function siteToast(msg) {
		if (BLP.site && BLP.page.type === 'site') BLP.site.toast(msg);
	}

	async function main() {
		await BLP.ready;
		const type = detectPageType();
		BLP.page.type = type;
		const isReplay = type === 'replay';
		BLP.log.debug('page type', type, location.href);

		BLP.hotkeys.init({
			openOptions: () => BLP.send('openOptions', {}).catch(err => BLP.log.warn(err)),
			toggleTheme: async () => {
				const s = await BLP.storage.loadSettings();
				s.theme.enabled = !s.theme.enabled;
				await BLP.storage.saveSettings(s);
				siteToast(BLP.i18n.t('f.theme.enabled') + ': ' + BLP.i18n.t(s.theme.enabled ? 'common.on' : 'common.off'));
			},
			toggleOverlays: () => {
				if (isReplay) BLP.replayBridge.command('toggleOverlays').catch(() => {});
				else if (BLP.site) {
					const shown = BLP.site.toggleUi();
					siteToast(BLP.i18n.t(shown ? 'r.overlaysOn' : 'r.overlaysOff'));
				}
			},
			nextMap: () => {
				if (isReplay) BLP.replayBridge.command('nextReplay').catch(() => {});
				else if (BLP.site) BLP.site.nextPage();
			},
			prevMap: () => {
				if (isReplay) BLP.replayBridge.command('prevReplay').catch(() => {});
				else if (BLP.site) BLP.site.prevPage();
			},
		});

		if (isReplay) BLP.replayBridge.start();
		else if (type === 'site') BLP.site.start();

		BLP.onSettings(settings => {
			if (isReplay) BLP.replayBridge.pushSettings(settings);
			else if (type === 'site') BLP.site.refresh();
		});

		chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
			if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('blp:')) return false;
			if (window !== window.top) return false; // the popup talks to the top frame only
			(async () => {
				switch (msg.type) {
					case 'blp:pageInfo':
						return {
							type,
							url: location.href,
							host: location.hostname,
							replay: isReplay ? BLP.replayBridge.status() : null,
							site: type === 'site' && BLP.site ? BLP.site.pageInfo() : null,
						};
					case 'blp:replay':
						if (!isReplay) throw new Error('Not a replay page');
						return BLP.replayBridge.command(msg.action, msg.payload, msg.timeout || 8000);
					default:
						throw new Error('Unknown message ' + msg.type);
				}
			})().then(
				data => sendResponse({ok: true, data}),
				err => sendResponse({ok: false, error: String((err && err.message) || err)})
			);
			return true;
		});
	}

	main().catch(err => console.error('[BLP] content script failed', err));
})();
