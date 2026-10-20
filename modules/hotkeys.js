/*
 * BeatLeaderPlus – global keyboard shortcuts (content script, isolated world).
 *
 * Handles the actions listed in BLP.defaults.GLOBAL_HOTKEY_ACTIONS on every BeatLeader page.
 * Replay-specific shortcuts (camera, playback, export, ...) are handled inside the replay page
 * by injected/core.js so they can call the A-Frame scene directly.
 *
 * Usage: BLP.hotkeys.init({openOptions() {...}, toggleTheme() {...}, ...})
 * Each action receives the KeyboardEvent. Unknown/unbound actions are ignored.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.hotkeys) return;
	const U = BLP.utils;

	let actions = {};
	let installed = false;

	function onKeyDown(e) {
		const settings = BLP.state.settings;
		if (!settings || !settings.general.enabled || !settings.hotkeys.enabled) return;
		if (e.repeat || U.isTypingTarget(e.target) || U.isModifierEvent(e)) return;
		const bindings = settings.hotkeys.bindings || {};
		for (const action of BLP.defaults.GLOBAL_HOTKEY_ACTIONS) {
			if (!actions[action] || !U.hotkeyMatches(e, bindings[action])) continue;
			e.preventDefault();
			e.stopImmediatePropagation();
			BLP.log.debug('hotkey', action);
			try {
				actions[action](e);
			} catch (err) {
				BLP.log.error('hotkey action failed', action, err);
			}
			return;
		}
	}

	BLP.hotkeys = {
		init(actionMap) {
			actions = Object.assign({}, actions, actionMap);
			if (!installed) {
				window.addEventListener('keydown', onKeyDown, true);
				installed = true;
			}
		},
		/** Returns the action name bound to `combo` (normalised), if any – used for conflict hints. */
		findAction(combo, bindings) {
			const target = U.normalizeHotkey(combo);
			return Object.keys(bindings || {}).find(k => U.normalizeHotkey(bindings[k]) === target) || null;
		},
	};
})();
