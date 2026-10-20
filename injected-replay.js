/*
 * BeatLeaderPlus – replay viewer bootstrap (PAGE / MAIN world).
 *
 * This is the last file injected into the replay page by modules/replay-bridge.js. By the time
 * it runs, lib/i18n.js, lib/utils.js, injected/core.js, injected/ui.js and every feature module
 * (camera, visuals, playback, hud, audio, export) have registered themselves on window.BLPR.
 * Booting:
 *
 *   1. handshake with the content-script bridge ("hello") to receive settings + runtime values
 *   2. wait for AFRAME and the <a-scene> with the replay components (MutationObserver + polling)
 *   3. register the `blp-runtime` A-Frame component whose tick/tock drive all modules
 *   4. init modules (they add their controls to the replayer's own menus), apply settings,
 *      hook replay events, process URL parameters
 *
 * Injection is idempotent: running this file twice (e.g. script tag + scripting fallback) is a
 * no-op the second time.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || !R.boot) {
		console.error('[BLP] replay runtime missing – was injected/core.js blocked?');
		return;
	}

	// Opens Settings → BL+ in the replayer's own settings menu (hotkey, popup, ?blpPanel=1).
	R.addHotkey('togglePanel', () => R.ui && R.ui.toggleSettings());
	R.onCommand('togglePanel', () => R.ui && R.ui.openSettings());
	R.on('ready', () => {
		if (new URLSearchParams(location.search).get('blpPanel') === '1') setTimeout(() => R.ui.openSettings(), 500);
	});

	R.boot().catch(err => console.error('[BLP] replay runtime failed to start', err));
})();
