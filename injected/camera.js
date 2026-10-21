/*
 * BeatLeaderPlus – camera additions (PAGE world).
 *
 * Builds on the replayer's own cameras:
 *   default   the official free camera (#mainCamera: look-controls + wasd-controls, which already
 *             flies with W A S D and X / C). BLP adds a move-speed setting (wasd acceleration),
 *             Shift-to-sprint, pointer-lock look and a field-of-view setting.
 *   pov       the official first-person camera (toggled through camera-mover / .povswitch).
 *
 * and adds what it lacks:
 *   orbit     circles the player's head or the play-space center
 *   follow    smooth chase camera with lag, world or head-relative offset
 *   path      plays a recorded / keyframed camera path (synced to song time)
 *   presets   named camera setups with hotkeys, next to the official Save / Restore
 *
 * While orbit / follow / path drive the camera, the official look/wasd controls are paused; when
 * the official camera takes over again it continues from the final orientation.
 *
 * UI: a compact block under "Main camera" in the replayer's camera menu, plus a "BL+" camera tab.
 * URL parameters: blpCam=<preset id|name>, blpMode=<mode>, blpPath=<packed path>.
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.module('camera')) return;
	const U = window.BLP.utils;
	const t = (k, v) => R.t(k, v);
	const DEG = Math.PI / 180;
	const MODES = ['default', 'orbit', 'follow', 'pov'];
	const DRIVEN = new Set(['orbit', 'follow', 'path', 'transition']);
	const WASD_EASING_FALLBACK = 20;

	let ctx = null;
	let THREE = null;
	let tmp = null;

	const cam = {
		mode: 'default',
		presetParams: {},
		fovOverride: null,
		current: null,
		sprinting: false,
		orbit: {angle: 0},
		follow: {yaw: null},
		trans: null,
		path: {list: [], current: null, playing: false, playStart: 0, recording: false, lastSample: 0, saveTimer: null},
	};

	/* ------------------------------------------------------------------ helpers */

	const settings = () => R.settings.camera;
	const mainEl = () => ctx && ctx.mainCamera;
	const lookControls = () => {
		const el = mainEl();
		return el && el.components['look-controls'];
	};
	const refreshUi = () => R.ui && R.ui.refresh(true);

	function setOfficialControls(enabled) {
		const el = mainEl();
		if (!el) return;
		if (el.components['look-controls']) el.setAttribute('look-controls', 'enabled', enabled);
		if (el.components['wasd-controls']) el.setAttribute('wasd-controls', 'enabled', enabled);
	}

	function readPose(out) {
		const o = mainEl().object3D;
		out.pos.copy(o.position);
		out.quat.copy(o.quaternion);
		return out;
	}

	function writePose(pos, quat) {
		const o = mainEl().object3D;
		o.position.copy(pos);
		o.quaternion.copy(quat);
	}

	function syncLookControls() {
		const lc = lookControls();
		if (!lc || !lc.pitchObject || !lc.yawObject) return;
		const e = tmp.e1.setFromQuaternion(mainEl().object3D.quaternion, 'YXZ');
		lc.pitchObject.rotation.x = e.x;
		lc.yawObject.rotation.y = e.y;
	}

	function lookQuat(from, to, out) {
		tmp.m4.lookAt(from, to, tmp.up);
		return out.setFromRotationMatrix(tmp.m4);
	}

	function poseToQuat(pose, out) {
		return out.setFromEuler(tmp.e2.set((pose.pitch || 0) * DEG, (pose.yaw || 0) * DEG, (pose.roll || 0) * DEG, 'YXZ'));
	}

	function currentPoseDeg() {
		const o = mainEl().object3D;
		const e = tmp.e1.setFromQuaternion(o.quaternion, 'YXZ');
		return {
			x: U.round(o.position.x, 3),
			y: U.round(o.position.y, 3),
			z: U.round(o.position.z, 3),
			pitch: U.round(e.x / DEG, 2),
			yaw: U.round(e.y / DEG, 2),
			roll: U.round(e.z / DEG, 2),
		};
	}

	function targetPoint(kind, out) {
		if (kind === 'center') return out.set(0, 1.2, 0);
		const hs = ctx.headset;
		if (hs && hs.object3D) return hs.object3D.getWorldPosition(out);
		return out.set(0, 1.7, 0);
	}

	function headQuat(out) {
		const hs = ctx.headset;
		if (hs && hs.object3D) return hs.object3D.getWorldQuaternion(out);
		return out.set(0, 0, 0, 1);
	}

	function applyPose(pos, quat, strength, dt) {
		const k = U.smoothFactor(strength, dt);
		cam.current.pos.lerp(pos, k);
		cam.current.quat.slerp(quat, k);
		writePose(cam.current.pos, cam.current.quat);
	}

	function currentFov() {
		return cam.fovOverride || Number(settings().fov) || 80;
	}

	function applyFov(fov) {
		const el = mainEl();
		if (!el || !el.components.camera) return;
		const v = fov || currentFov();
		if (Math.abs((el.components.camera.data.fov || 0) - v) > 0.01) el.setAttribute('camera', 'fov', v);
	}

	/* ------------------------------------------------------------------ official free camera tweaks */

	/** Move speed, sprint and pointer-lock look for the replayer's own WASD camera. */
	function applyFreeCamera() {
		const el = mainEl();
		if (!el || DRIVEN.has(cam.mode)) return;
		const s = settings().free;
		const wasd = el.components['wasd-controls'];
		if (wasd) {
			const easing = Number(wasd.data.easing) || WASD_EASING_FALLBACK;
			const speed = (R.active() ? Number(s.speed) || 3.25 : 3.25) * (R.active() && cam.sprinting ? Number(s.sprint) || 1 : 1);
			const acceleration = U.round(speed * easing, 3); // terminal speed = acceleration / easing
			if (Math.abs((wasd.data.acceleration || 0) - acceleration) > 1e-3) el.setAttribute('wasd-controls', 'acceleration', acceleration);
		}
		const lc = lookControls();
		const lock = !!(R.active() && s.pointerLock);
		if (lc && lc.data.pointerLockEnabled !== lock) el.setAttribute('look-controls', 'pointerLockEnabled', lock);
	}

	function installSprint() {
		const onKey = e => {
			if (e.shiftKey !== cam.sprinting) {
				cam.sprinting = e.shiftKey;
				applyFreeCamera();
			}
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('keyup', onKey, true);
		window.addEventListener('blur', () => {
			cam.sprinting = false;
			applyFreeCamera();
		});
	}

	/* ------------------------------------------------------------------ POV */

	function enterPov() {
		const cm = ctx.cameraMover();
		if (!cm || cm.pov) return;
		const sw = document.querySelector('.povswitch');
		if (sw) sw.click();
		else if (cm.defaultCamera && cm.povCamera) {
			cm.defaultCamera.setAttribute('camera', 'active', false);
			cm.povCamera.setAttribute('camera', 'active', true);
			cm.pov = true;
			ctx.scene.emit('povchanged', {newPov: true}, false);
		}
	}

	function exitPov() {
		const cm = ctx.cameraMover();
		if (cm && cm.pov && cm.disablePovIfNeeded) cm.disablePovIfNeeded();
	}

	/* ------------------------------------------------------------------ modes */

	function setMode(mode, opts = {}) {
		if (!ctx || !mainEl()) return;
		if (!MODES.includes(mode) && mode !== 'path' && mode !== 'transition') mode = 'default';
		const prev = cam.mode;
		if (!opts.keepPreset) cam.presetParams = {};
		if (!opts.keepFov && mode !== 'transition') cam.fovOverride = null;
		if (prev === 'path' && mode !== 'path') cam.path.playing = false;

		if (mode === 'pov') {
			if (DRIVEN.has(prev)) {
				syncLookControls();
				setOfficialControls(true);
			}
			enterPov();
		} else if (DRIVEN.has(mode)) {
			exitPov();
			if (!DRIVEN.has(prev)) readPose(cam.current);
			if (mode === 'orbit' && prev !== 'orbit') {
				const o = Object.assign({}, settings().orbit, cam.presetParams.orbit || {});
				cam.orbit.angle = (Number(o.startAngle) || 0) * DEG;
			} else if (mode === 'follow') {
				cam.follow.yaw = null;
			}
			setOfficialControls(false);
			if (document.pointerLockElement) document.exitPointerLock();
		} else {
			exitPov();
			if (DRIVEN.has(prev)) {
				syncLookControls();
				setOfficialControls(true);
			}
		}
		cam.mode = mode;
		applyFov();
		applyFreeCamera();
		if (settings().rememberMode && !opts.noRemember && MODES.includes(mode)) R.setRuntime('lastCameraMode', mode);
		if (!opts.silent && mode !== 'transition') R.api.notify(t('r.presetApplied', {name: t('cam.mode.' + mode)}), 'fas fa-video');
		R.emit('cameramode', mode);
		refreshUi();
	}

	function cycleMode() {
		setMode(MODES[(MODES.indexOf(cam.mode) + 1) % MODES.length]);
	}

	/** Smoothly move the official camera to a pose, then hand control back to it. */
	function transitionTo(pose, fov) {
		if (!pose) return setMode('default');
		const to = {pos: new THREE.Vector3(pose.x || 0, pose.y || 1.7, pose.z || 0), quat: poseToQuat(pose, new THREE.Quaternion())};
		const strength = Number(settings().smoothing) || 0;
		const dur = strength > 0 ? 0.35 + strength * 0.9 : 0;
		if (!dur) {
			if (cam.mode !== 'default') setMode('default', {silent: true, keepFov: true});
			writePose(to.pos, to.quat);
			cam.current.pos.copy(to.pos);
			cam.current.quat.copy(to.quat);
			syncLookControls();
			if (fov) applyFov(fov);
			return;
		}
		setMode('transition', {silent: true, keepFov: true});
		cam.trans = {fromPos: cam.current.pos.clone(), fromQuat: cam.current.quat.clone(), to, t: 0, dur};
	}

	/* ------------------------------------------------------------------ per-frame update */

	function updateOrbit(dt) {
		const o = Object.assign({}, settings().orbit, cam.presetParams.orbit || {});
		cam.orbit.angle += (Number(o.speed) || 0) * DEG * dt;
		const center = targetPoint(o.target, tmp.v1);
		const r = Number(o.radius) || 3;
		const pos = tmp.v2.set(center.x + Math.sin(cam.orbit.angle) * r, Number(o.height), center.z + Math.cos(cam.orbit.angle) * r);
		applyPose(pos, lookQuat(pos, center, tmp.q1), Number(settings().smoothing) || 0, dt);
	}

	function updateFollow(dt) {
		const f = Object.assign({}, settings().follow, cam.presetParams.follow || {});
		const offset = Object.assign({x: 0, y: 0.4, z: 2.4}, f.offset || {});
		const target = targetPoint(f.target, tmp.v1);
		const fwd = tmp.v2.set(0, 0, -1).applyQuaternion(headQuat(tmp.q2));
		fwd.y = 0;
		let yaw = fwd.lengthSq() > 1e-6 ? Math.atan2(-fwd.x, -fwd.z) : 0;
		if (f.relative !== 'headYaw') yaw = 0;
		if (cam.follow.yaw === null) cam.follow.yaw = yaw;
		let diff = yaw - cam.follow.yaw;
		while (diff > Math.PI) diff -= 2 * Math.PI;
		while (diff < -Math.PI) diff += 2 * Math.PI;
		cam.follow.yaw += diff * U.smoothFactor(Math.max(0.3, Number(f.lag) || 0), dt);
		const off = tmp.v3.set(Number(offset.x) || 0, Number(offset.y) || 0, Number(offset.z) || 0).applyAxisAngle(tmp.up, cam.follow.yaw);
		const pos = tmp.v4.copy(target).add(off);
		const ahead = Number(f.lookAhead) || 0;
		const look = tmp.v5.set(target.x - Math.sin(cam.follow.yaw) * ahead, target.y, target.z - Math.cos(cam.follow.yaw) * ahead);
		applyPose(pos, lookQuat(pos, look, tmp.q1), Number(f.lag) || 0, dt);
	}

	function updateTransition(dt) {
		const tr = cam.trans;
		if (!tr) return setMode('default', {silent: true});
		tr.t += dt;
		const u = U.clamp(tr.t / tr.dur, 0, 1);
		const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
		cam.current.pos.copy(tr.fromPos).lerp(tr.to.pos, e);
		cam.current.quat.copy(tr.fromQuat).slerp(tr.to.quat, e);
		writePose(cam.current.pos, cam.current.quat);
		if (u >= 1) {
			cam.trans = null;
			setMode('default', {silent: true, keepFov: true, keepPreset: true});
		}
	}

	/* ------------------------------------------------------------------ camera paths */

	// Keyframe layout (compact arrays keep stored and shared paths small):
	//   [time, posX, posY, posZ, quatX, quatY, quatZ, quatW, fov]

	function newPath(name) {
		return {
			id: U.uid('path'),
			name: name || 'Path ' + new Date().toLocaleString(),
			created: Date.now(),
			timeBase: settings().path.timeBase || 'song',
			replayKey: R.replayInfo ? R.replayInfo.key : null,
			keyframes: [],
		};
	}

	function captureKeyframe(time) {
		const o = mainEl().object3D;
		const fov = (mainEl().components.camera && mainEl().components.camera.data.fov) || currentFov();
		return [U.round(time, 4), U.round(o.position.x, 4), U.round(o.position.y, 4), U.round(o.position.z, 4), U.round(o.quaternion.x, 5), U.round(o.quaternion.y, 5), U.round(o.quaternion.z, 5), U.round(o.quaternion.w, 5), U.round(fov, 2)];
	}

	function pathDuration(path) {
		const k = path && path.keyframes;
		return k && k.length ? k[k.length - 1][0] - k[0][0] : 0;
	}

	function samplePath(path, time, outPos, outQuat) {
		const k = path.keyframes;
		if (!k.length) return null;
		if (time <= k[0][0] || k.length === 1) return setFromKf(k[0], outPos, outQuat);
		if (time >= k[k.length - 1][0]) return setFromKf(k[k.length - 1], outPos, outQuat);
		let lo = 0;
		let hi = k.length - 2;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (k[mid][0] <= time) lo = mid;
			else hi = mid - 1;
		}
		const a = k[lo];
		const b = k[lo + 1];
		const u = U.clamp((time - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
		const smooth = settings().path.smooth !== false;
		const p0 = k[Math.max(0, lo - 1)];
		const p3 = k[Math.min(k.length - 1, lo + 2)];
		const axis = i => (smooth ? catmull(p0[i], a[i], b[i], p3[i], u) : U.lerp(a[i], b[i], u));
		outPos.set(axis(1), axis(2), axis(3));
		tmp.q3.set(a[4], a[5], a[6], a[7]);
		tmp.q4.set(b[4], b[5], b[6], b[7]);
		outQuat.copy(tmp.q3).slerp(tmp.q4, u);
		return U.lerp(a[8] || currentFov(), b[8] || currentFov(), u);
	}

	function setFromKf(kf, outPos, outQuat) {
		outPos.set(kf[1], kf[2], kf[3]);
		outQuat.set(kf[4], kf[5], kf[6], kf[7]);
		return kf[8] || currentFov();
	}

	function catmull(p0, p1, p2, p3, u) {
		const u2 = u * u;
		const u3 = u2 * u;
		return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
	}

	function pathTime(frame) {
		const p = cam.path.current;
		if (!p) return 0;
		if (p.timeBase === 'real') {
			const start = p.keyframes.length ? p.keyframes[0][0] : 0;
			let tt = (performance.now() - cam.path.playStart) / 1000 + start;
			const dur = pathDuration(p);
			if (settings().path.loop && dur > 0) tt = start + ((tt - start) % dur);
			else if (dur > 0 && tt > start + dur + 0.5) stopPath();
			return tt;
		}
		return frame.time;
	}

	function updatePath(frame, dt) {
		const p = cam.path.current;
		if (!p || p.keyframes.length < 2) return stopPath();
		const fov = samplePath(p, pathTime(frame), tmp.v1, tmp.q1);
		applyPose(tmp.v1, tmp.q1, settings().path.smooth ? 0.04 : 0, dt);
		if (fov) applyFov(fov);
	}

	function recordSample(frame) {
		const pr = cam.path;
		const p = pr.current;
		if (!pr.recording || !p) return;
		const now = performance.now();
		const rate = U.clamp(Number(settings().path.sampleRate) || 20, 1, 120);
		if (now - pr.lastSample < 1000 / rate) return;
		const time = p.timeBase === 'real' ? (now - pr.recordStart) / 1000 : frame.time;
		const k = p.keyframes;
		if (k.length) {
			const last = k[k.length - 1][0];
			if (p.timeBase !== 'real' && Math.abs(time - last) < 1e-4) return; // paused: nothing new
			// The user seeked backwards: overwrite everything after the new time.
			if (time < last) while (k.length && k[k.length - 1][0] >= time) k.pop();
		}
		pr.lastSample = now;
		k.push(captureKeyframe(time));
	}

	async function loadPaths() {
		try {
			cam.path.list = await R.request('getPaths', {});
		} catch (e) {
			cam.path.list = [];
		}
		const lastId = R.runtime.lastPathId;
		if (!cam.path.current && lastId) cam.path.current = cam.path.list.find(p => p.id === lastId) || null;
	}

	async function savePath(path) {
		path.updated = Date.now();
		delete path.shared;
		await R.request('savePath', {path});
		const i = cam.path.list.findIndex(p => p.id === path.id);
		if (i >= 0) cam.path.list[i] = path;
		else cam.path.list.unshift(path);
		R.setRuntime('lastPathId', path.id);
	}

	function startRecording() {
		if (cam.path.recording) return stopRecording();
		stopPath();
		cam.path.current = newPath();
		cam.path.recording = true;
		cam.path.recordStart = performance.now();
		cam.path.lastSample = 0;
		R.api.notify(t('r.pathRecording'), 'fas fa-circle');
		refreshUi();
	}

	async function stopRecording() {
		const p = cam.path.current;
		cam.path.recording = false;
		if (!p || p.keyframes.length < 2) {
			R.api.notify(t('r.pathTooShort'), 'fas fa-triangle-exclamation');
			return refreshUi();
		}
		p.keyframes.sort((a, b) => a[0] - b[0]);
		await savePath(p);
		R.api.notify(t('r.pathRecorded', {n: p.keyframes.length}), 'fas fa-check');
		refreshUi();
	}

	function addKeyframe() {
		if (!cam.path.current || cam.path.current.shared) cam.path.current = newPath();
		const p = cam.path.current;
		const time = p.timeBase === 'real' ? (p.keyframes.length ? p.keyframes[p.keyframes.length - 1][0] + 2 : 0) : R.api.time();
		p.keyframes = p.keyframes.filter(k => Math.abs(k[0] - time) > 1e-3);
		p.keyframes.push(captureKeyframe(time));
		p.keyframes.sort((a, b) => a[0] - b[0]);
		R.api.notify(t('r.pathKeyframeAdded', {n: p.keyframes.length, time: U.formatTime(time, false)}), 'fas fa-plus');
		clearTimeout(cam.path.saveTimer);
		cam.path.saveTimer = setTimeout(() => savePath(p).catch(() => {}), 600);
		refreshUi();
	}

	function playPath() {
		const p = cam.path.current;
		if (!p) return R.api.notify(t('r.pathEmpty'), 'fas fa-triangle-exclamation');
		if (p.keyframes.length < 2) return R.api.notify(t('r.pathTooShort'), 'fas fa-triangle-exclamation');
		if (cam.path.recording) stopRecording();
		setMode('path', {silent: true});
		cam.path.playing = true;
		cam.path.playStart = performance.now();
		R.api.notify(t('r.pathPlaying'), 'fas fa-route');
		refreshUi();
	}

	function stopPath() {
		if (!cam.path.playing && cam.mode !== 'path') return;
		cam.path.playing = false;
		if (cam.mode === 'path') setMode('default', {silent: true});
		refreshUi();
	}

	function togglePath() {
		if (cam.path.playing) {
			stopPath();
			R.api.notify(t('r.pathStopped'), 'fas fa-stop');
		} else playPath();
	}

	/** Compact, URL-friendly representation of a path. */
	function compactPath(path, maxKeyframes = 1500) {
		let k = path.keyframes;
		if (k.length > maxKeyframes) {
			const step = k.length / maxKeyframes;
			const out = [];
			for (let i = 0; i < maxKeyframes; i++) out.push(k[Math.floor(i * step)]);
			out[out.length - 1] = k[k.length - 1];
			k = out;
		}
		return {n: path.name, tb: path.timeBase, k: k.map(kf => kf.map((v, i) => (i <= 3 ? U.round(v, 3) : i <= 7 ? U.round(v, 4) : U.round(v, 1))))};
	}

	function expandPath(c) {
		if (!c || !Array.isArray(c.k)) throw new Error('Invalid path data');
		const keyframes = c.k.filter(kf => Array.isArray(kf) && kf.length >= 8 && kf.every(v => typeof v === 'number' && isFinite(v)));
		if (keyframes.length < 2) throw new Error('Path has fewer than 2 keyframes');
		return {id: U.uid('path'), name: String(c.n || 'Shared path').slice(0, 80), created: Date.now(), timeBase: c.tb === 'real' ? 'real' : 'song', keyframes: keyframes.sort((a, b) => a[0] - b[0])};
	}

	async function sharePathLink() {
		const p = cam.path.current;
		if (!p || p.keyframes.length < 2) return R.api.notify(t('r.pathEmpty'), 'fas fa-triangle-exclamation');
		const url = new URL(location.href);
		url.searchParams.set('blpPath', await U.packForUrl(JSON.stringify(compactPath(p))));
		url.searchParams.delete('blpCam');
		await U.copyText(url.toString());
		R.api.notify(t('r.pathShareCopied'), 'fas fa-link');
	}

	function exportPath() {
		const p = cam.path.current;
		if (!p) return R.api.notify(t('r.pathEmpty'), 'fas fa-triangle-exclamation');
		const blob = new Blob([JSON.stringify({format: 'beatleaderplus-camera-path', version: 1, path: p}, null, 2)], {type: 'application/json'});
		U.downloadBlob(blob, U.sanitizeFilename('BLP camera path - ' + p.name) + '.json');
		R.api.notify(t('r.pathExported'), 'fas fa-download');
	}

	function importPath() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async () => {
			const file = input.files && input.files[0];
			if (!file) return;
			try {
				const data = JSON.parse(await file.text());
				const raw = data.path || data;
				const path = raw.k ? expandPath(raw) : expandPath({n: raw.name, tb: raw.timeBase, k: raw.keyframes});
				await savePath(path);
				cam.path.current = path;
				refreshUi();
			} catch (e) {
				R.ui.toast(String(e.message || e), 'error');
			}
		};
		input.click();
	}

	async function deleteCurrentPath() {
		const cur = cam.path.current;
		if (!cur) return;
		stopPath();
		await R.request('deletePath', {id: cur.id}).catch(() => {});
		cam.path.list = cam.path.list.filter(p => p.id !== cur.id);
		cam.path.current = cam.path.list[0] || null;
		refreshUi();
	}

	function renameCurrentPath() {
		const cur = cam.path.current;
		if (!cur) return;
		const name = window.prompt(t('r.pathName'), cur.name);
		if (!name) return;
		cur.name = name.slice(0, 80);
		savePath(cur).then(refreshUi);
	}

	/* ------------------------------------------------------------------ presets */

	const presets = () => (R.settings && Array.isArray(R.settings.camera.presets) ? R.settings.camera.presets : []);

	function findPreset(idOrName) {
		if (!idOrName) return null;
		const needle = String(idOrName).toLowerCase();
		return presets().find(p => p.id === idOrName) || presets().find(p => String(p.name).toLowerCase() === needle) || null;
	}

	function applyPreset(p, opts = {}) {
		if (!p || !ctx) return;
		stopPath();
		switch (p.mode) {
			case 'pov':
			case 'fpvSmooth': // presets from older versions
				setMode('pov', {silent: true});
				break;
			case 'orbit':
				cam.presetParams = {orbit: p.orbit || {}};
				setMode('orbit', {silent: true, keepPreset: true});
				break;
			case 'follow':
				cam.presetParams = {follow: p.follow || {}};
				setMode('follow', {silent: true, keepPreset: true});
				break;
			default:
				transitionTo(p.pose, p.fov);
		}
		cam.fovOverride = Number(p.fov) || null;
		applyFov();
		if (!opts.silent) R.api.notify(t('r.presetApplied', {name: p.name}), 'fas fa-video');
	}

	function capturePreset() {
		const mode = cam.mode === 'orbit' || cam.mode === 'follow' || cam.mode === 'pov' ? cam.mode : 'static';
		const name = window.prompt(t('r.presetName'), t('cam.mode.' + mode) + ' ' + (presets().length + 1));
		if (!name) return;
		const hotkey = window.prompt(t('r.presetHotkeyPrompt', {name}), '') || '';
		const preset = {id: U.uid('preset'), name: name.trim().slice(0, 60), hotkey: U.normalizeHotkey(hotkey), mode, fov: U.round(currentFov(), 1)};
		if (mode !== 'pov') preset.pose = currentPoseDeg();
		if (mode === 'orbit') preset.orbit = Object.assign({}, settings().orbit, cam.presetParams.orbit || {});
		if (mode === 'follow') preset.follow = U.deepClone(Object.assign({}, settings().follow, cam.presetParams.follow || {}));
		R.patchSettings({camera: {presets: presets().concat([preset])}});
		R.api.notify(t('r.presetSaved', {name: preset.name}), 'fas fa-floppy-disk');
	}

	function deletePreset(id) {
		R.patchSettings({camera: {presets: presets().filter(p => p.id !== id)}});
		R.api.notify(t('r.presetDeleted'), 'fas fa-trash');
	}

	/* ------------------------------------------------------------------ URL params & startup */

	async function applyStartup() {
		const params = new URLSearchParams(location.search);
		const s = settings();
		const sharedPath = params.get('blpPath');
		if (sharedPath) {
			try {
				const path = expandPath(JSON.parse(await U.unpackFromUrl(sharedPath)));
				path.shared = true;
				cam.path.current = path;
				R.api.notify(t('r.pathLoadedShared'), 'fas fa-route');
				if (s.path.autoPlayShared) {
					if (R.api.isPlaying() || R.replayInfo) setTimeout(playPath, 300);
					else
						R.on('songstart', function once() {
							R.off('songstart', once);
							playPath();
						});
				}
			} catch (e) {
				R.log.warn('could not load shared path', e);
			}
		}
		const preset = findPreset(params.get('blpCam'));
		const urlMode = params.get('blpMode');
		if (preset) applyPreset(preset);
		else if (urlMode && MODES.includes(urlMode)) setMode(urlMode);
		else if (!sharedPath) {
			const def = findPreset(s.defaultPreset);
			if (def) applyPreset(def, {silent: true});
			else if (s.rememberMode && R.runtime.lastCameraMode && R.runtime.lastCameraMode !== 'default') setMode(R.runtime.lastCameraMode, {silent: true});
			else if (s.mode && s.mode !== 'default') setMode(s.mode, {silent: true});
		}
		refreshUi();
	}

	/* ------------------------------------------------------------------ camera menu UI */

	function pathOptions() {
		const pr = cam.path;
		const options = pr.list.map(p => ({value: p.id, label: p.name + ' (' + p.keyframes.length + ')'}));
		if (pr.current && !pr.list.some(p => p.id === pr.current.id)) options.unshift({value: pr.current.id, label: pr.current.name + ' (' + t(pr.current.shared ? 'r.pathShared' : 'r.pathUnsaved') + ')'});
		return options;
	}

	function selectPath(id) {
		stopPath();
		cam.path.current = cam.path.list.find(p => p.id === id) || cam.path.current;
		R.setRuntime('lastPathId', id);
		refreshUi();
	}

	/** Compact block under the official "Main camera" controls. */
	function renderQuick(body) {
		const ui = R.ui;
		body.appendChild(
			ui.row(
				...['orbit', 'follow'].map(m => ui.button(t('cam.mode.' + m), () => setMode(cam.mode === m ? 'default' : m), {active: cam.mode === m}))
			)
		);
		const presetOptions = [{value: '', label: t('r.presetSelect')}].concat(presets().map(p => ({value: p.id, label: p.name + (p.hotkey ? ' (' + U.formatHotkey(p.hotkey) + ')' : '')})));
		body.appendChild(
			ui.row(
				ui.select('', presetOptions, '', id => id && applyPreset(findPreset(id))),
				ui.button('', capturePreset, {icon: 'fas fa-floppy-disk', title: t('r.savePreset')})
			)
		);
		const options = pathOptions();
		if (options.length) {
			if (!cam.path.current) cam.path.current = cam.path.list[0] || null;
			body.appendChild(
				ui.row(
					ui.select('', options, cam.path.current ? cam.path.current.id : '', selectPath),
					ui.button('', togglePath, {icon: cam.path.playing ? 'fas fa-stop' : 'fas fa-play', active: cam.path.playing, title: t(cam.path.playing ? 'r.pathStop' : 'r.pathPlay')})
				)
			);
		}
		body.appendChild(ui.hint(t('r.cameraMore')));
	}

	function renderFreeSection(body) {
		const ui = R.ui;
		const s = settings();
		body.appendChild(
			ui.range(t('r.fov'), {min: 20, max: 130, step: 1, value: currentFov(), unit: '°'}, v => {
				cam.fovOverride = null;
				R.setPath('camera.fov', v);
				applyFov(v);
			})
		);
		body.appendChild(ui.range(t('f.camera.free.speed'), {min: 0.5, max: 15, step: 0.25, value: s.free.speed, unit: ' m/s'}, v => R.setPath('camera.free.speed', v)));
		body.appendChild(ui.range(t('f.camera.free.sprint'), {min: 1, max: 8, step: 0.5, value: s.free.sprint, unit: '×'}, v => R.setPath('camera.free.sprint', v)));
		body.appendChild(ui.toggle(t('r.flyMode'), s.free.pointerLock, v => R.setPath('camera.free.pointerLock', v), t('d.camera.free.pointerLock')));
	}

	function renderModesSection(body) {
		const ui = R.ui;
		const s = settings();
		const clear = () => (cam.presetParams = {});
		body.appendChild(ui.range(t('r.smoothing'), {min: 0, max: 1, step: 0.05, value: s.smoothing}, v => R.setPath('camera.smoothing', v)));
		body.appendChild(ui.range(t('f.camera.orbit.radius'), {min: 0.5, max: 12, step: 0.1, value: s.orbit.radius, unit: 'm'}, v => (clear(), R.setPath('camera.orbit.radius', v))));
		body.appendChild(ui.range(t('f.camera.orbit.height'), {min: -1, max: 8, step: 0.1, value: s.orbit.height, unit: 'm'}, v => (clear(), R.setPath('camera.orbit.height', v))));
		body.appendChild(ui.range(t('f.camera.orbit.speed'), {min: -90, max: 90, step: 1, value: s.orbit.speed, unit: '°/s'}, v => (clear(), R.setPath('camera.orbit.speed', v))));
		body.appendChild(ui.range(t('f.camera.follow.lag'), {min: 0, max: 1, step: 0.05, value: s.follow.lag}, v => (clear(), R.setPath('camera.follow.lag', v))));
		body.appendChild(ui.range(t('f.camera.follow.offset.z'), {min: -6, max: 8, step: 0.05, value: s.follow.offset.z, unit: 'm'}, v => (clear(), R.setPath('camera.follow.offset.z', v))));
	}

	function renderPresetsSection(body) {
		const ui = R.ui;
		const list = ui.h('div', {class: 'blp-r-list'});
		for (const p of presets()) {
			list.appendChild(
				ui.h(
					'div',
					{class: 'blp-r-list-item'},
					ui.button(p.name, () => applyPreset(p), {className: 'blp-r-grow', title: t('cam.mode.' + (p.mode === 'static' ? 'default' : p.mode))}),
					ui.button('✕', () => deletePreset(p.id), {title: t('common.delete')})
				)
			);
		}
		body.appendChild(list);
	}

	function renderPathsSection(body) {
		const ui = R.ui;
		const pr = cam.path;
		const cur = pr.current;
		if (cur) body.appendChild(ui.hint(cur.name + ' · ' + t('opt.pathKeyframes', {n: cur.keyframes.length, d: pathDuration(cur).toFixed(1)})));
		body.appendChild(
			ui.row(
				ui.button('', togglePath, {icon: pr.playing ? 'fas fa-stop' : 'fas fa-play', active: pr.playing, disabled: !cur, title: t(pr.playing ? 'r.pathStop' : 'r.pathPlay')}),
				ui.button(t(pr.recording ? 'r.pathStopRecord' : 'r.pathRecord'), startRecording, {icon: pr.recording ? 'fas fa-stop' : 'fas fa-circle', active: pr.recording}),
				ui.button('', addKeyframe, {icon: 'fas fa-plus', title: t('r.pathKeyframe')})
			)
		);
		body.appendChild(
			ui.row(
				cur && (cur.shared || !pr.list.some(p => p.id === cur.id)) ? ui.button('', () => savePath(cur).then(refreshUi), {icon: 'fas fa-floppy-disk', title: t('common.save')}) : null,
				ui.button('', renameCurrentPath, {icon: 'fas fa-pen', title: t('common.rename'), disabled: !cur}),
				ui.button('', deleteCurrentPath, {icon: 'fas fa-trash', title: t('common.delete'), disabled: !cur}),
				ui.button('', exportPath, {icon: 'fas fa-download', title: t('r.exportPath'), disabled: !cur}),
				ui.button('', sharePathLink, {icon: 'fas fa-link', title: t('r.sharePath'), disabled: !cur}),
				ui.button('', importPath, {icon: 'fas fa-upload', title: t('r.pathImport')})
			)
		);
	}

	/* ------------------------------------------------------------------ module */

	R.cameraStatus = () => ({
		mode: cam.mode,
		modes: MODES,
		presets: presets().map(p => ({id: p.id, name: p.name})),
		path: cam.path.current ? {name: cam.path.current.name, playing: cam.path.playing, recording: cam.path.recording} : null,
	});

	R.camera = {
		setMode,
		applyPreset,
		findPreset,
		playPath,
		stopPath,
		startRecording,
		addKeyframe,
		get mode() {
			return cam.mode;
		},
	};

	R.register({
		name: 'camera',
		init(c) {
			ctx = c;
			THREE = c.THREE;
			tmp = {
				v1: new THREE.Vector3(),
				v2: new THREE.Vector3(),
				v3: new THREE.Vector3(),
				v4: new THREE.Vector3(),
				v5: new THREE.Vector3(),
				q1: new THREE.Quaternion(),
				q2: new THREE.Quaternion(),
				q3: new THREE.Quaternion(),
				q4: new THREE.Quaternion(),
				e1: new THREE.Euler(0, 0, 0, 'YXZ'),
				e2: new THREE.Euler(0, 0, 0, 'YXZ'),
				m4: new THREE.Matrix4(),
				up: new THREE.Vector3(0, 1, 0),
			};
			cam.current = {pos: new THREE.Vector3(), quat: new THREE.Quaternion()};
			if (mainEl()) readPose(cam.current);
			installSprint();
			// The official Left / Center / Right buttons hand control back to the official camera.
			['cameraToLeft', 'cameraToCenter', 'cameraToRight', 'cameraRestore'].forEach(id => {
				const el = document.getElementById(id);
				if (el) el.addEventListener('click', () => DRIVEN.has(cam.mode) && setMode('default', {silent: true}), true);
			});

			R.addHotkey('cycleCamera', cycleMode);
			R.addHotkey('pathPlay', togglePath);
			R.addHotkey('pathRecord', startRecording);
			R.addHotkey('pathKeyframe', addKeyframe);
			R.addHotkeyProvider(() => presets().filter(p => p.hotkey).map(p => ({combo: p.hotkey, run: () => applyPreset(p)})));

			R.onCommand('setCameraMode', ({mode}) => setMode(mode));
			R.onCommand('applyPreset', ({id}) => applyPreset(findPreset(id)));

			R.ui.addCameraSection({id: 'quick', placement: 'quick', order: 0, render: renderQuick});
			R.ui.addCameraSection({id: 'free', order: 10, title: () => t('h.cameraFree'), render: renderFreeSection});
			R.ui.addCameraSection({id: 'modes', order: 20, title: () => t('cam.mode.orbit') + ' / ' + t('cam.mode.follow'), render: renderModesSection});
			R.ui.addCameraSection({id: 'presets', order: 30, title: () => t('r.presets'), render: renderPresetsSection});
			R.ui.addCameraSection({id: 'paths', order: 40, title: () => t('r.paths'), render: renderPathsSection});
		},
		async onReady() {
			applyFreeCamera();
			await loadPaths();
			await applyStartup();
		},
		onSettings() {
			if (!ctx) return;
			if (!R.active()) {
				if (cam.mode !== 'default') setMode('default', {silent: true, noRemember: true});
				applyFov(80);
				applyFreeCamera();
				return;
			}
			applyFov();
			applyFreeCamera();
		},
		tick(frame) {
			if (!mainEl()) return;
			const dt = frame.dt;
			if (cam.mode === 'orbit') updateOrbit(dt);
			else if (cam.mode === 'follow') updateFollow(dt);
			else if (cam.mode === 'path') updatePath(frame, dt);
			else if (cam.mode === 'transition') updateTransition(dt);
			if (cam.path.recording) recordSample(frame);
		},
		maintain() {
			if (cam.mode !== 'path') applyFov();
		},
	});
})();
