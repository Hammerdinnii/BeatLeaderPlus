/*
 * BeatLeaderPlus – replay viewer bootstrap (PAGE / MAIN world).
 *
 * This is the last file injected into the replay page by modules/replay-bridge.js. By the time
 * it runs, lib/i18n.js, lib/utils.js, injected/core.js, injected/ui.js and every feature module
 * (camera, visuals, playback, overlays, audio, export) have registered themselves on
 * window.BLPR. Booting:
 *
 *   1. handshake with the content-script bridge ("hello") to receive settings + runtime values
 *   2. wait for AFRAME and the <a-scene> with the replay components (MutationObserver + polling)
 *   3. register the `blp-runtime` A-Frame component whose tick/tock drive all modules
 *   4. init modules, apply settings, hook replay events, process URL parameters
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

	// Global page-level hotkeys that belong to the panel itself.
	R.addHotkey('togglePanel', () => R.ui && R.ui.togglePanel());

	R.boot().catch(err => console.error('[BLP] replay runtime failed to start', err));
})();
