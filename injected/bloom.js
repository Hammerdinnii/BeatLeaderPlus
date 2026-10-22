/*
 * BeatLeaderPlus – bloom on custom saber models (PAGE world).
 *
 * Like the game, only the glowing parts bloom: visuals.js gives each glowing part of a custom
 * model a copy on R.saberGlow.layer, which no camera of the replayer draws. Right after the
 * replayer draws its main view (scene.mainRenderer.render with the scene camera), this module:
 *
 *   1. draws only those copies, with the same camera, into an off-screen target
 *   2. blurs it with the UnrealBloomPass that ships in the replayer's A-Frame build (three r95)
 *   3. adds the blur over the frame, in the viewport the main view was just drawn in
 *
 * It runs inside the replayer's draw, so the result is in the frame before its tock: clip
 * recording picks it up. Screenshots call apply() themselves (export.js). The ortho views draw
 * after the main view and get no bloom. The glow copies are drawn without the rest of the
 * scene, so a note in front of a blade doesn't hide its bloom.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('bloom')) return;

	let ctx = null;
	let THREE = null;
	let gfx = null; // created on first use
	let broken = false;
	const stats = (R.saberBloomStats = {frames: 0});

	const cfg = () => R.settings.visuals.sabers;

	function enabled() {
		const s = cfg();
		return !broken && R.active() && s.style === 'custom' && !!(s.bloom && s.bloom.enabled) && !!R.saberGlow && R.saberGlow.count() > 0;
	}

	function setup(width, height) {
		const w = Math.max(1, Math.round(width / 2));
		const h = Math.max(1, Math.round(height / 2));
		if (!gfx) {
			const target = new THREE.WebGLRenderTarget(w, h, {minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat});
			const pass = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 1, 0.5, 0);
			pass.renderToScreen = false;
			const copy = THREE.CopyShader;
			const material = new THREE.ShaderMaterial({
				uniforms: THREE.UniformsUtils.clone(copy.uniforms),
				vertexShader: copy.vertexShader,
				fragmentShader: copy.fragmentShader,
				blending: THREE.AdditiveBlending,
				depthTest: false,
				depthWrite: false,
				transparent: true,
			});
			const quad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), material);
			quad.frustumCulled = false;
			const scene = new THREE.Scene();
			scene.add(quad);
			gfx = {target, pass, material, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), w, h};
		} else if (gfx.w !== w || gfx.h !== h) {
			gfx.target.setSize(w, h);
			gfx.pass.setSize(w, h);
			gfx.w = w;
			gfx.h = h;
		}
		return gfx;
	}

	/** Adds bloom over what `camera` just drew. Leaves the renderer as it found it. */
	function apply(camera) {
		if (!enabled() || !camera) return false;
		const renderer = ctx.renderer;
		const scene = ctx.scene.object3D;
		const size = renderer.getDrawingBufferSize();
		const g = setup(size.width, size.height);
		const s = cfg().bloom;
		const clearColor = renderer.getClearColor().clone();
		const clearAlpha = renderer.getClearAlpha();
		const mask = camera.layers.mask;
		const background = scene.background;
		// The replayer turns off color auto-clear (A-Frame's MainRenderer), which would make
		// "clear and draw" keep last frame's glow and bloom: it piles up to solid white.
		const autoClearColor = renderer.autoClearColor;
		try {
			renderer.autoClearColor = true;
			// 1. Only the glow copies, on black.
			renderer.setClearColor(0x000000, 0);
			scene.background = null;
			camera.layers.set(R.saberGlow.layer);
			renderer.render(scene, camera, g.target, true);
			// 2. Blur. The pass leaves its result in renderTargetsHorizontal[0].
			g.pass.strength = 1.5 * (Number(s.strength) || 0) / 100;
			g.pass.radius = Math.min(1, Math.max(0, (Number(s.size) || 0) / 100));
			g.pass.threshold = Math.min(1, Math.max(0, (Number(s.threshold) || 0) / 100));
			g.pass.render(renderer, null, g.target, 0, false);
			// 3. Add it over the frame (the screen viewport is still the main view's).
			g.material.uniforms.tDiffuse.value = g.pass.renderTargetsHorizontal[0].texture;
			g.material.uniforms.opacity.value = 1;
			renderer.render(g.scene, g.camera, undefined, false);
			stats.frames++;
			return true;
		} catch (e) {
			// A renderer this doesn't work with: switch bloom off rather than break the replayer's frame.
			broken = true;
			R.log.warn('saber bloom disabled', e);
			return false;
		} finally {
			camera.layers.mask = mask;
			scene.background = background;
			renderer.setClearColor(clearColor, clearAlpha);
			renderer.autoClearColor = autoClearColor;
		}
	}

	function hookMainRender() {
		const scene = ctx.scene;
		const main = scene.mainRenderer;
		if (!main || main.__blpBloom || typeof main.render !== 'function') return;
		if (!THREE.UnrealBloomPass || !THREE.CopyShader || !THREE.LuminosityHighPassShader) {
			broken = true;
			R.log.warn('this replayer build has no UnrealBloomPass: saber bloom unavailable');
			return;
		}
		const render = main.render;
		main.render = function (object, camera, renderTarget, forceClear, cameraData) {
			const out = render.apply(this, arguments);
			// The main view only: not the ortho views, which reuse this call with their cameras.
			if (!renderTarget && camera === scene.camera) apply(camera);
			return out;
		};
		main.__blpBloom = true;
	}

	R.saberBloom = {apply, enabled, target: () => (gfx ? gfx.target : null), pass: () => (gfx ? gfx.pass : null)};

	R.register({
		name: 'bloom',
		init(c) {
			ctx = c;
			THREE = c.THREE;
			hookMainRender();
		},
		maintain() {
			hookMainRender(); // in case the renderer was not ready at init
		},
	});
})();
