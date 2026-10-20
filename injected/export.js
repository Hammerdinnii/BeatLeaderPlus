/*
 * BeatLeaderPlus – export & sharing (PAGE world).
 *
 *   - "Copy replay link with my settings": the official URL parameters (time, speed, jd, cpx/cpy/
 *     cpz/crx/cry camera, forceFpv) work for everyone; BLP-only state (camera mode, colors,
 *     overlay layout) is packed into blpCfg (deflate + base64url) and applied as session-only
 *     overrides when the link is opened with BeatLeaderPlus installed.
 *   - screenshots at any resolution, optionally with the stats overlay painted in
 *   - clip recording of the WebGL canvas with MediaRecorder (+ song audio)
 *   - export of the current settings as JSON (importable from the options page)
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('export')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);

	let ctx = null;
	const clip = {rec: null, out: null, g: null, timer: null, chunks: [], audio: null, startedAt: 0};
	const KEEP_PARAMS = ['scoreId', 'link', 'playlist', 'id', 'difficulty', 'mode', 'playerID', 'hash', 'context'];

	/* ------------------------------------------------------------------ share link */

	function cameraConfig(mode) {
		const c = R.settings.camera;
		const out = {mode, fov: c.fov, smoothing: c.smoothing};
		if (mode === 'orbit') out.orbit = c.orbit;
		if (mode === 'follow') out.follow = c.follow;
		if (mode === 'fpvSmooth') out.fpv = c.fpv;
		if (mode === 'free') out.free = {speed: c.free.speed};
		return out;
	}

	function visualsConfig() {
		const v = R.settings.visuals;
		const out = {};
		const sabers = {};
		if (v.sabers.override) Object.assign(sabers, {override: true, leftColor: v.sabers.leftColor, rightColor: v.sabers.rightColor});
		if (v.sabers.trailOverride) {
			['trailOverride', 'trailMatchSaber', 'leftTrailColor', 'rightTrailColor', 'trailLength', 'trailWidth', 'trailOpacity'].forEach(k => (sabers[k] = v.sabers[k]));
		}
		if (v.sabers.style !== 'default' && v.sabers.style !== 'custom') sabers.style = v.sabers.style;
		if (v.sabers.glowIntensity !== 100) sabers.glowIntensity = v.sabers.glowIntensity;
		if (v.sabers.thickness !== 100) sabers.thickness = v.sabers.thickness;
		if (Object.keys(sabers).length) out.sabers = sabers;
		if (v.notes.override || v.notes.bombOverride || v.notes.chainOverride || v.notes.arcOverride) out.notes = v.notes;
		if (v.environment.override) out.environment = v.environment;
		if (v.accuracyHeat.enabled) out.accuracyHeat = v.accuracyHeat;
		return out;
	}

	async function buildShareLink() {
		const s = R.settings;
		const L = s.export.link;
		const src = new URL(location.href);
		const url = new URL(location.origin + location.pathname);
		for (const k of KEEP_PARAMS) if (src.searchParams.has(k)) url.searchParams.set(k, src.searchParams.get(k));
		if (L.includeTime) url.searchParams.set('time', String(Math.round(R.api.time() * 1000)));
		if (L.includeSpeed) {
			const sp = R.api.getSpeed();
			if (Math.abs(sp - 1) > 1e-3) url.searchParams.set('speed', String(Math.round(sp * 100)));
		}
		if (L.includeJd) {
			const jd = R.api.getJd();
			if (jd) url.searchParams.set('jd', String(jd));
		}
		const cfg = {};
		if (L.includeCamera) {
			const mode = R.camera ? R.camera.mode : 'default';
			const el = ctx.mainCamera;
			const lc = el && el.components['look-controls'];
			if ((mode === 'default' || mode === 'transition') && el && lc && lc.pitchObject) {
				const p = el.object3D.position;
				url.searchParams.set('cpx', p.x.toFixed(3));
				url.searchParams.set('cpy', p.y.toFixed(3));
				url.searchParams.set('cpz', p.z.toFixed(3));
				url.searchParams.set('crx', lc.pitchObject.rotation.x.toFixed(3));
				url.searchParams.set('cry', lc.yawObject.rotation.y.toFixed(3));
			} else if (mode === 'pov') {
				url.searchParams.set('forceFpv', '1');
			} else if (mode !== 'path') {
				url.searchParams.set('blpMode', mode);
				cfg.camera = cameraConfig(mode);
			}
		}
		if (L.includeColors) {
			const v = visualsConfig();
			if (Object.keys(v).length) cfg.visuals = v;
		}
		if (L.includeOverlay) {
			const o = s.overlay;
			cfg.overlay = {enabled: o.enabled, position: o.position, x: o.x, y: o.y, scale: o.scale, opacity: o.opacity, style: o.style, stats: o.stats, graph: o.graph};
		}
		if (Object.keys(cfg).length) url.searchParams.set('blpCfg', await U.packForUrl(JSON.stringify(cfg)));
		return url.toString();
	}

	async function copyLink() {
		const link = await buildShareLink();
		const ok = await U.copyText(link);
		R.api.notify(ok ? t('r.linkCopied') : link, 'fas fa-link');
		return link;
	}

	/** Apply blpCfg from the URL as session-only overrides (never saved). */
	async function applyLinkConfig() {
		const packed = new URLSearchParams(location.search).get('blpCfg');
		if (!packed) return;
		try {
			const cfg = JSON.parse(await U.unpackFromUrl(packed));
			const allowed = {};
			if (U.isObject(cfg.camera)) {
				const cam = Object.assign({}, cfg.camera);
				delete cam.presets;
				delete cam.defaultPreset;
				delete cam.replaceOfficialUi;
				allowed.camera = cam;
			}
			if (U.isObject(cfg.visuals)) {
				const vis = U.deepClone(cfg.visuals);
				if (vis.sabers) delete vis.sabers.customModel;
				allowed.visuals = vis;
			}
			if (U.isObject(cfg.overlay)) allowed.overlay = cfg.overlay;
			R.setSessionOverrides(allowed);
			R.log.info('applied shared link settings', allowed);
		} catch (e) {
			R.log.warn('invalid blpCfg parameter', e);
		}
	}

	/* ------------------------------------------------------------------ screenshot */

	function baseFilename() {
		const info = R.replayInfo;
		const name = info ? `${info.playerName} - ${info.songName}` : 'replay';
		const time = U.formatTime(R.api.time(), false).replace(':', 'm') + 's';
		return U.sanitizeFilename(`BeatLeaderPlus ${name} ${time}`);
	}

	function loadImage(src) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = reject;
			img.src = src;
		});
	}

	function renderToDataUrl(width, height) {
		const renderer = ctx.renderer;
		const scene = ctx.scene;
		const camera = scene.camera;
		const gl = renderer.domElement;
		if (!width || !height) {
			renderer.render(scene.object3D, camera);
			return {url: gl.toDataURL('image/png'), w: gl.width, h: gl.height};
		}
		const size = renderer.getSize(new ctx.THREE.Vector2());
		const prevW = size.width !== undefined ? size.width : size.x;
		const prevH = size.height !== undefined ? size.height : size.y;
		const pr = renderer.getPixelRatio();
		const aspect = camera.aspect;
		try {
			renderer.setPixelRatio(1);
			renderer.setSize(width, height, false);
			if (renderer.setScissorTest) renderer.setScissorTest(false);
			if (camera.isPerspectiveCamera) {
				camera.aspect = width / height;
				camera.updateProjectionMatrix();
			}
			renderer.render(scene.object3D, camera);
			// Must read synchronously, before the browser composites and clears the buffer.
			return {url: gl.toDataURL('image/png'), w: width, h: height};
		} finally {
			renderer.setPixelRatio(pr);
			renderer.setSize(prevW, prevH, false);
			if (camera.isPerspectiveCamera) {
				camera.aspect = aspect;
				camera.updateProjectionMatrix();
			}
		}
	}

	async function screenshot() {
		const s = R.settings.export.screenshot;
		const w = s.useWindowSize ? 0 : U.clamp(Math.round(Number(s.width) || 1920), 320, 7680);
		const h = s.useWindowSize ? 0 : U.clamp(Math.round(Number(s.height) || 1080), 240, 4320);
		const shot = renderToDataUrl(w, h);
		const img = await loadImage(shot.url);
		const out = document.createElement('canvas');
		out.width = shot.w;
		out.height = shot.h;
		const g = out.getContext('2d');
		g.drawImage(img, 0, 0, shot.w, shot.h);
		if (s.includeOverlay && R.overlays) R.overlays.drawToCanvas(g, shot.w, shot.h);
		const mime = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'}[s.format] || 'image/png';
		const blob = await new Promise(resolve => out.toBlob(resolve, mime, 0.92));
		U.downloadBlob(blob, baseFilename() + '.' + (s.format === 'jpeg' ? 'jpg' : s.format || 'png'));
		R.api.notify(t('r.screenshotSaved'), 'fas fa-camera');
		return true;
	}

	/* ------------------------------------------------------------------ clip recording */

	function clipSupported() {
		return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
	}

	function startClip() {
		if (clip.rec) return stopClip();
		if (!clipSupported()) {
			R.api.notify(t('r.clipUnsupported'), 'fas fa-triangle-exclamation');
			return false;
		}
		const c = R.settings.export.clip;
		const w = U.clamp(Math.round(Number(c.width) || 1280), 320, 3840);
		const h = U.clamp(Math.round(Number(c.height) || 720), 240, 2160);
		const fps = U.clamp(Number(c.fps) || 60, 10, 120);
		clip.out = document.createElement('canvas');
		clip.out.width = w;
		clip.out.height = h;
		clip.g = clip.out.getContext('2d');
		const stream = clip.out.captureStream(fps);
		const song = R.api.song();
		const an = song && song.audioAnalyser;
		const node = an && (an.analyser || an.gainNode);
		if (c.includeAudio && node && an.context && an.context.createMediaStreamDestination) {
			try {
				const dest = an.context.createMediaStreamDestination();
				node.connect(dest);
				dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
				clip.audio = {node, dest};
			} catch (e) {
				R.log.warn('could not capture song audio', e);
			}
		}
		const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
		clip.chunks = [];
		clip.rec = new MediaRecorder(stream, {mimeType: mime || undefined, videoBitsPerSecond: U.clamp(Number(c.bitrateMbps) || 8, 1, 60) * 1e6});
		clip.rec.ondataavailable = e => e.data && e.data.size && clip.chunks.push(e.data);
		clip.rec.onstop = () => {
			const blob = new Blob(clip.chunks, {type: 'video/webm'});
			U.downloadBlob(blob, baseFilename() + '.webm');
			if (clip.audio) {
				try {
					clip.audio.node.disconnect(clip.audio.dest);
				} catch (e) {
					/* already disconnected */
				}
			}
			stream.getTracks().forEach(tr => tr.stop());
			Object.assign(clip, {rec: null, out: null, g: null, chunks: [], audio: null});
			R.api.notify(t('r.clipSaved'), 'fas fa-film');
			R.ui && R.ui.refreshPanel(true);
		};
		clip.rec.start(250);
		clip.startedAt = performance.now();
		clip.timer = setTimeout(stopClip, U.clamp(Number(c.seconds) || 10, 1, 600) * 1000);
		R.api.notify(t('r.clipRecording', {s: c.seconds}), 'fas fa-circle');
		document.documentElement.classList.add('blp-r-recording');
		R.ui && R.ui.refreshPanel(true);
		return true;
	}

	function stopClip() {
		clearTimeout(clip.timer);
		document.documentElement.classList.remove('blp-r-recording');
		if (clip.rec && clip.rec.state !== 'inactive') clip.rec.stop();
		return true;
	}

	function captureClipFrame() {
		if (!clip.rec || !clip.g) return;
		const gl = ctx.renderer.domElement;
		const W = clip.out.width;
		const H = clip.out.height;
		const scale = Math.min(W / gl.width, H / gl.height);
		const dw = gl.width * scale;
		const dh = gl.height * scale;
		const dx = (W - dw) / 2;
		const dy = (H - dh) / 2;
		const g = clip.g;
		g.fillStyle = '#000';
		g.fillRect(0, 0, W, H);
		g.drawImage(gl, dx, dy, dw, dh);
		if (R.settings.export.clip.includeOverlay && R.overlays) {
			g.save();
			g.translate(dx, dy);
			R.overlays.drawToCanvas(g, dw, dh);
			g.restore();
		}
		// recording indicator
		const elapsed = (performance.now() - clip.startedAt) / 1000;
		g.fillStyle = 'rgba(255, 23, 68, 0.9)';
		g.beginPath();
		g.arc(W - 18, 18, 6, 0, Math.PI * 2);
		if (Math.floor(elapsed * 2) % 2 === 0) g.fill();
	}

	/* ------------------------------------------------------------------ settings export */

	function exportSettings() {
		const data = {format: 'beatleaderplus-config', version: R.settings.schemaVersion, exportedAt: new Date().toISOString(), settings: R.settings};
		U.downloadBlob(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}), 'BeatLeaderPlus-settings.json');
		return true;
	}

	/* ------------------------------------------------------------------ panel tab */

	function renderTab(body) {
		const ui = R.ui;
		const s = R.settings;
		const shot = s.export.screenshot;
		const clipCfg = s.export.clip;
		body.appendChild(
			ui.section(
				t('h.expLink'),
				ui.row(ui.button('🔗 ' + t('r.copyLink'), copyLink, {primary: true})),
				ui.hint(
					['includeTime', 'includeSpeed', 'includeJd', 'includeCamera', 'includeColors', 'includeOverlay']
						.filter(k => s.export.link[k])
						.map(k => t('f.export.link.' + k))
						.join(' · ')
				)
			)
		);
		body.appendChild(
			ui.section(
				t('h.expScreenshot'),
				ui.row(ui.button('📷 ' + t('r.screenshot'), screenshot, {primary: true})),
				ui.hint(shot.useWindowSize ? t('f.export.screenshot.useWindowSize') : shot.width + ' × ' + shot.height + ' · ' + String(shot.format).toUpperCase())
			)
		);
		body.appendChild(
			ui.section(
				t('h.expClip'),
				clipSupported()
					? ui.row(ui.button(clip.rec ? '⏹ ' + t('r.clipStop') : '⏺ ' + t('r.clip'), startClip, {primary: !clip.rec, active: !!clip.rec}))
					: ui.hint(t('r.clipUnsupported')),
				ui.slider(t('f.export.clip.seconds'), {min: 2, max: 120, step: 1, value: clipCfg.seconds, unit: 's'}, v => R.setPath('export.clip.seconds', v)),
				ui.hint(clipCfg.width + ' × ' + clipCfg.height + ' · ' + clipCfg.fps + ' fps · ' + clipCfg.bitrateMbps + ' Mbps')
			)
		);
		const audio = s.audio;
		body.appendChild(
			ui.section(
				t('r.quick'),
				ui.toggle(t('f.overlay.enabled'), s.overlay.enabled, v => R.setPath('overlay.enabled', v)),
				ui.select(
					t('f.overlay.position'),
					['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'].map(p => ({value: p, label: t('pos.' + p)})),
					s.overlay.position,
					v => R.setPath('overlay.position', v)
				),
				ui.toggle(t('f.audio.enabled'), audio.enabled, v => R.setPath('audio.enabled', v)),
				ui.slider(t('f.audio.master'), {min: 0, max: 100, step: 1, value: audio.master, unit: '%'}, v => R.setPath('audio.master', v)),
				ui.row(...['good', 'bad', 'miss', 'bomb'].map(slot => ui.button('🔊 ' + t('opt.slot.' + slot), () => R.audio && R.audio.preview(slot)))),
				ui.row(ui.button('⬇ ' + t('r.exportSettings'), exportSettings))
			)
		);
	}

	/* ------------------------------------------------------------------ module */

	R.exporter = {buildShareLink, copyLink, screenshot, startClip, stopClip, exportSettings};

	R.register({
		name: 'export',
		init(c) {
			ctx = c;
			R.addHotkey('screenshot', () => screenshot().catch(e => R.ui.toast(String(e.message || e), 'error')));
			R.addHotkey('recordClip', startClip);
			R.addHotkey('copyLink', () => copyLink().catch(e => R.ui.toast(String(e.message || e), 'error')));
			R.onCommand('buildLink', () => buildShareLink());
			R.onCommand('copyLink', () => copyLink());
			R.onCommand('screenshot', () => screenshot());
			R.onCommand('recordClip', () => startClip());
			R.onCommand('exportSettings', () => exportSettings());
			R.ui.addTab({id: 'export', icon: '📤', title: t('r.tab.export'), order: 40, render: renderTab});
			applyLinkConfig();
		},
		tock() {
			captureClipFrame();
		},
	});
})();
