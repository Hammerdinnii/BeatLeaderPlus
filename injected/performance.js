/*
 * BeatLeaderPlus – FPS limiter (PAGE world).
 *
 * The replayer's A-Frame build draws from scene.render(), which re-schedules itself every frame
 * with mainRenderer.requestAnimationFrame(this.render). Replacing scene.render with a wrapper
 * puts every frame through it: frames that come sooner than the chosen limit are skipped (only
 * the next one is scheduled), the rest run the replayer's own render.
 *
 * Only drawing is limited. The replayer's separate `calculate` loop keeps updating the game at
 * the display's rate, so hitsounds, slow motion and our own note events keep their timing.
 *
 * The replayer's FPS counter counts display frames, not drawn ones, so Settings → BL+ →
 * Performance shows how many frames are actually drawn.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('performance')) return;
	const t = (k, v) => R.t(k, v);

	const LIMITS = [0, 30, 45, 60, 72, 90, 120, 144, 165, 240];

	let ctx = null;
	// renders/skipped count every frame since load; fps is what was drawn in the last second.
	const perf = (R.performance = {renders: 0, skipped: 0, fps: 0, limit: 0});
	const drawn = [];

	const activeLimit = () => {
		const v = R.active() ? Number(R.settings.playback.fpsLimit) || 0 : 0;
		return v > 0 ? Math.max(1, v) : 0;
	};

	function wrapRender() {
		const scene = ctx.scene;
		if (scene.__blpRenderWrapped || typeof scene.render !== 'function' || !scene.mainRenderer) return;
		const render = scene.render; // bound to the scene by A-Frame
		let next = 0;
		const limited = function (time) {
			const now = typeof time === 'number' ? time : performance.now();
			const limit = (perf.limit = activeLimit());
			const xr = scene.renderer && scene.renderer.xr;
			if (limit && !(xr && xr.isPresenting)) {
				// 1 ms of slack for requestAnimationFrame jitter, so a limit at the display rate
				// never drops frames.
				if (now + 1 < next) {
					perf.skipped++;
					scene.mainRenderer.requestAnimationFrame(limited);
					return;
				}
				const interval = 1000 / limit;
				// Aim at an even spacing; after a stall (hidden tab) start over instead of catching up.
				next = Math.max(next + interval, now + interval / 2);
			}
			perf.renders++;
			drawn.push(now);
			while (drawn.length && drawn[0] <= now - 1000) drawn.shift();
			perf.fps = drawn.length;
			return render.call(scene, time);
		};
		scene.render = limited;
		scene.__blpRenderWrapped = true;
	}

	/* ------------------------------------------------------------------ Settings → BL+ section */

	function renderSection(body) {
		const ui = R.ui;
		const current = Number(R.settings.playback.fpsLimit) || 0;
		const options = LIMITS.concat(LIMITS.includes(current) ? [] : [current]).map(v => ({value: String(v), label: v ? t('r.fpsValue', {n: v}) : t('r.fpsOff')}));
		body.appendChild(ui.select(t('f.playback.fpsLimit'), options, String(current), v => R.setPath('playback.fpsLimit', Number(v)), t('d.playback.fpsLimit')));
		body.appendChild(ui.h('p', {class: 'blp-r-hint', id: 'blp-r-fps-now'}, readout()));
	}

	const readout = () => t('r.fpsNow', {n: perf.fps});

	R.register({
		name: 'performance',
		init(c) {
			ctx = c;
			wrapRender();
			R.ui.addSettingsSection({id: 'performance', order: 65, title: () => t('r.sect.performance'), render: renderSection});
			setInterval(() => {
				const el = document.getElementById('blp-r-fps-now');
				if (el && el.offsetParent) el.textContent = readout();
			}, 500);
		},
		maintain() {
			wrapRender(); // in case the scene's renderer was not ready at init
		},
	});
})();
