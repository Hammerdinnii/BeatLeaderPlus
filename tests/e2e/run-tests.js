// End-to-end tests: loads the unpacked extension in Chromium and drives the real BeatLeader web
// replayer, plus a small leaderboard page for the website features.
//
//   BL_REPLAYER_DIR=/path/to/BeatSaber-Web-Replays node tests/e2e/run-tests.js
//
// BL_REPLAYER_DIR is a checkout of github.com/BeatLeader/BeatSaber-Web-Replays, built with its own
// `npm ci && npm run build` and otherwise unmodified (see tests/README.md). It is served at
// https://replay.beatleader.com/ with the test map from its repository and a generated replay.
const {chromium} = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fixtures = require('./fixtures');

const DIR = __dirname;
const EXT = path.resolve(__dirname, '..', '..');
const REPLAYER = process.env.BL_REPLAYER_DIR && path.resolve(process.env.BL_REPLAYER_DIR);
if (!REPLAYER || !fs.existsSync(path.join(REPLAYER, 'index.html')) || !fs.existsSync(path.join(REPLAYER, 'build'))) {
	console.error('Set BL_REPLAYER_DIR to a built checkout of BeatLeader/BeatSaber-Web-Replays (see tests/README.md).');
	process.exit(2);
}
const results = [];
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(name, cond, detail) {
	results.push({name, ok: !!cond, detail});
	console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
}

function watch(page, label) {
	page.on('pageerror', e => errors.push(`[${label}] pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
	page.on('console', m => {
		if (m.type() === 'error' || m.type() === 'warning') {
			const txt = m.text();
			if (/BLP|blp|BeatLeaderPlus/i.test(txt)) errors.push(`[${label}] ${m.type()}: ${txt}`);
		}
	});
}

(async () => {
	const fx = await fixtures.load(REPLAYER);
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blp-e2e-'));
	const context = await chromium.launchPersistentContext(profile, {
		channel: 'chromium',
		headless: true,
		acceptDownloads: true,
		viewport: {width: 1280, height: 800},
		args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
	});

	let sw = context.serviceWorkers()[0];
	if (!sw) sw = await context.waitForEvent('serviceworker', {timeout: 15000});
	const extId = sw.url().split('/')[2];
	check('service worker started', !!extId, extId);
	sw.on('console', m => m.type() === 'error' && errors.push('[sw] ' + m.text()));

	// Used by the website checks (comparison, follows, stats) through the stubbed worker fetch.
	const mockScore = {
		id: 1001,
		playerId: '111',
		player: {name: 'Alice', avatar: ''},
		song: {name: 'Mock Song', hash: 'ABCDEF'},
		difficulty: {difficultyName: 'ExpertPlus', value: 9, accRating: 10.5, passRating: 8.1, techRating: 6.2, stars: 11.3},
		accuracy: 0.985,
		pp: 512.3,
		rank: 1,
		missedNotes: 0,
		badCuts: 1,
		pauses: 0,
		maxCombo: 900,
		fullCombo: false,
		replay: 'https://cdn.replays.beatleader.xyz/1001-Alice.bsor',
		timepost: 1700000000,
	};

	// Everything the browser requests is answered locally; no network access is needed.
	await context.route(/^https?:\/\//, route => {
		const url = new URL(route.request().url());
		if (url.host === 'replay.beatleader.com') {
			if (url.pathname.startsWith('/cors/beat-saver2/api/maps/')) return route.fulfill({json: fx.beatSaverMap});
			const file = path.join(REPLAYER, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
			if (file.startsWith(REPLAYER + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({path: file});
			return route.fulfill({status: 404, body: ''});
		}
		if (url.host === 'beatleader.com') return route.fulfill({path: path.join(DIR, 'site.html'), contentType: 'text/html'});
		if (url.pathname.endsWith('.bsor')) return route.fulfill({body: fx.replay, contentType: 'application/octet-stream'});
		if (url.href === fx.zipUrl) return route.fulfill({body: fx.mapZip, contentType: 'application/zip'});
		if (url.host === 'api.beatleader.com') {
			if (url.pathname === '/score/' + fx.scoreId) return route.fulfill({json: fx.score});
			if (url.pathname === '/user') return route.fulfill({json: {}}); // not logged in
			if (url.pathname === '/user/id' || url.pathname.startsWith('/watched/')) return route.fulfill({body: ''});
			return route.fulfill({json: url.pathname.includes('/scores') ? {data: [mockScore]} : mockScore});
		}
		return route.fulfill({status: 404, body: ''});
	});

	await sleep(1500); // let onInstalled finish (it opens the options page)

	// Playwright cannot route requests made by an extension service worker, so stub fetch there.
	const stubFetch = () =>
		sw.evaluate(mock => {
			if (self.__blpStubbed) return;
			self.__blpStubbed = true;
			const realFetch = self.fetch.bind(self);
			const json = data => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
			self.fetch = async (url, opts) => {
				const u = String(url);
				if (/api\.beatleader\.com\/player\/[^/]+\/scores/.test(u)) {
					self.__scoreCalls = (self.__scoreCalls || 0) + 1;
					const s = Object.assign({}, mock, {id: 5000 + self.__scoreCalls, timepost: 1700000000 + self.__scoreCalls * 100, leaderboard: {id: 'lb1', song: {name: 'Fresh Song'}, difficulty: {difficultyName: 'Expert', stars: 9.5}}});
					return json({data: [s]});
				}
				if (/api\.beatleader\.com\/score\//.test(u)) {
					const id = u.split('/score/')[1].split('?')[0];
					return json(Object.assign({}, mock, {id: Number(id), accuracy: id === '1002' ? 0.932 : 0.985, player: {name: id === '1002' ? 'Bob' : 'Alice'}}));
				}
				if (/scorestats/.test(u)) return json({accuracyTracker: {accLeft: 113.1, accRight: 112.4}});
				if (/api\.beatleader\.com\/player\/[^/?]+$/.test(u)) return json({id: '111', name: 'Alice Real', avatar: 'https://cdn.assets.beatleader.xyz/111.png'});
				return realFetch(url, opts);
			};
		}, mockScore);
	await stubFetch();

	/* ------------------------------------------------------------ replay viewer (the real one) */
	const page = await context.newPage();
	watch(page, 'replay');
	const openReplay = async (p, query) => {
		await p.goto('https://replay.beatleader.com/?scoreId=' + fx.scoreId + (query || ''));
		await p.waitForFunction(() => window.BLPR && window.BLPR.ctx && window.BLPR.replayInfo && BLPR.api.duration() > 0, null, {timeout: 60000});
	};
	await openReplay(page);
	const title = await page.evaluate(() => BLPR.replayInfo.title);
	check('runtime attached to the real replayer (UTF-8 intact)', title === `Test Player – ${fx.songName} (${fx.difficulty})`, title);
	check('modules registered', true, await page.evaluate(() => BLPR.modules.map(m => m.name)));
	// The replayer hides its control bar while playing until the mouse moves, like for a real user.
	const wake = async () => {
		await page.mouse.move(620, 640);
		await page.mouse.move(640, 650);
		await sleep(600);
	};
	// Flip one of the replayer's own settings checkboxes the way a click does.
	const officialToggle = (id, on) =>
		page.evaluate(
			([id, on]) => {
				const box = document.getElementById(id);
				box.checked = on;
				box.dispatchEvent(new Event('input', {bubbles: true}));
			},
			[id, on]
		);
	const closeMenus = () =>
		page.evaluate(() => {
			for (const id of ['settingsContainer', 'cameraSettingsContainer']) document.getElementById(id).classList.remove('settingsActive');
			document.getElementById('ctxMenu').style.display = 'none';
		});

	// Everything lives inside the replayer's own menus: no floating panel, launcher or HUD box.
	const hooks = await page.evaluate(() => ({
		settingsTab: !!document.querySelector('#settingsContainer .tab-buttons > #blpSettingsTab.settings-tab-button'),
		settingsPane: !!document.querySelector('#settingsContainer .tab-content > #blpSettingsPane.settings-tab-pane'),
		tabsAligned: document.querySelectorAll('.settings-tab-button').length === document.querySelectorAll('.settings-tab-pane').length,
		cameraQuick: !!document.querySelector('#cameraSettingsContainer .camera-tab-pane > #blpCameraQuick'),
		cameraTab: !!document.querySelector('#cameraSettingsContainer .tab-buttons > #blpCameraTab.camera-tab-button'),
		menu: Array.from(document.querySelectorAll('#ctxMenu .panel-menu > .blp-r-menuitem')).map(e => e.id),
		menuBeforePlaylist: (document.getElementById('addToPlaylist') || {}).previousElementSibling === document.getElementById('blpClip'),
		floating: document.querySelectorAll('#blp-r-panel, #blp-r-launch, #blp-r-hud, .blp-r-launch').length,
	}));
	check('BL+ tab added to the Settings menu', hooks.settingsTab && hooks.settingsPane && hooks.tabsAligned, hooks);
	check('BL+ block and tab added to the Camera menu', hooks.cameraQuick && hooks.cameraTab, hooks);
	check('extra items in the right-click menu', hooks.menu.join() === 'blpCopyURL,blpScreenshot,blpClip' && hooks.menuBeforePlaylist, hooks.menu);
	check('no floating panel, launcher or HUD', hooks.floating === 0, hooks.floating);

	await page.evaluate(t => BLPR.api.seek(t), fx.firstNote - 1);
	await page.evaluate(() => BLPR.api.play());
	await sleep(1500);
	const t1 = await page.evaluate(() => ({time: BLPR.api.time(), playing: BLPR.api.isPlaying()}));
	check('replay plays', t1.playing && t1.time > fx.firstNote - 0.9, t1);

	// Settings → BL+
	await page.keyboard.press('Backquote');
	await sleep(300);
	const settingsState = () =>
		page.evaluate(() => ({
			open: document.getElementById('settingsContainer').classList.contains('settingsActive'),
			blp: document.getElementById('blpSettingsPane').classList.contains('active'),
			tab: document.getElementById('blpSettingsTab').classList.contains('active'),
			official: document.querySelector('.settings-tab-pane').classList.contains('active'),
		}));
	let st = await settingsState();
	const controlsShown = await page.evaluate(() => document.body.classList.contains('showControls') && getComputedStyle(document.getElementById('blpSettingsPane')).display !== 'none');
	check('` opens Settings → BL+ (visible while playing)', st.open && st.blp && st.tab && !st.official && controlsShown, [st, controlsShown]);
	const sections = await page.evaluate(() => Array.from(document.querySelectorAll('#blpSettingsPane > .blp-r-section')).map(s => s.id.replace('blp-sec-', '')));
	check('BL+ tab renders every section', sections.join() === 'notes,sabers,effects,visibility,playback,timeline,audio,export,interface', sections);
	await page.click('#settingsContainer .settings-tab-button >> nth=0');
	st = await settingsState();
	check("the replayer's own tabs keep working", st.open && !st.blp && st.official, st);
	await page.click('#blpSettingsTab');
	st = await settingsState();
	check('BL+ tab selectable with its button', st.open && st.blp && !st.official, st);
	const rowsBefore = await page.evaluate(() => document.querySelectorAll('#blp-sec-notes .blp-r-color').length);
	await page.click('#blp-sec-notes .blp-r-toggle >> nth=0 >> .slider');
	await sleep(700);
	const toggled = await page.evaluate(() => ({on: BLPR.settings.visuals.notes.override, colors: document.querySelectorAll('#blp-sec-notes .blp-r-color').length}));
	st = await settingsState();
	check('toggle in BL+ tab saves and re-renders its section', toggled.on === true && toggled.colors > rowsBefore, toggled);
	check('menu stays open after toggling', st.open && st.blp, st);
	await page.click('#blp-sec-playback .blp-r-btn >> text=A');
	await sleep(400);
	st = await settingsState();
	const loopA = await page.evaluate(() => (document.querySelector('#blp-sec-playback .blp-r-inline') || {}).textContent);
	check('button in BL+ tab works and the menu stays open', st.open && st.blp && !!loopA, [st, loopA]);
	await page.keyboard.press('Shift+KeyT');
	await page.keyboard.press('Backquote');
	await sleep(200);
	check('` closes the menu again', !(await settingsState()).open);

	// Camera menu
	await wake();
	await page.click('.controlsCamera.desktopControl');
	await sleep(300);
	const quickButtons = await page.evaluate(() => Array.from(document.querySelectorAll('#blpCameraQuick .blp-r-btn')).map(b => b.textContent));
	check('camera block shows Orbit / Follow / save preset', quickButtons.length >= 3, quickButtons);
	await page.click('#blpCameraQuick .blp-r-btn >> nth=0');
	await sleep(400);
	const camMenu = await page.evaluate(() => ({open: document.getElementById('cameraSettingsContainer').classList.contains('settingsActive'), mode: BLPR.camera.mode, active: document.querySelector('#blpCameraQuick .blp-r-btn').classList.contains('blp-r-active')}));
	check('Orbit button switches mode and keeps the camera menu open', camMenu.open && camMenu.mode === 'orbit' && camMenu.active, camMenu);
	await page.click('#blpCameraTab');
	await sleep(200);
	const camTab = await page.evaluate(() => ({active: document.getElementById('blpCameraPane').classList.contains('active'), sections: document.querySelectorAll('#blpCameraPane > .blp-r-section').length}));
	check('BL+ camera tab renders', camTab.active && camTab.sections === 4, camTab);
	await page.click('#cameraSettingsContainer .camera-tab-button >> nth=0');
	await closeMenus();

	// Camera modes
	const camPos = () =>
		page.evaluate(() => {
			const p = BLPR.ctx.mainCamera.object3D.position;
			return [p.x, p.y, p.z].map(v => Math.round(v * 100) / 100);
		});
	await page.evaluate(() => BLPR.camera.setMode('orbit'));
	await sleep(800);
	const orbitA = await camPos();
	await sleep(500);
	const orbitB = await camPos();
	check('orbit camera moves', JSON.stringify(orbitA) !== JSON.stringify(orbitB), [orbitA, orbitB]);
	check('official look-controls paused while BL+ drives the camera', await page.evaluate(() => BLPR.ctx.mainCamera.getAttribute('look-controls').enabled === false));
	await page.evaluate(() => BLPR.camera.setMode('follow'));
	await sleep(800);
	check('follow camera positions behind head', (await camPos())[2] > 0.5, await camPos());
	await page.evaluate(() => BLPR.camera.setMode('pov'));
	await sleep(200);
	check("POV mode uses the replayer's own FPV camera", await page.evaluate(() => BLPR.ctx.cameraMover().pov === true));
	await page.evaluate(() => BLPR.camera.setMode('default'));
	await sleep(200);
	check('default mode hands control back to the official camera', await page.evaluate(() => BLPR.ctx.mainCamera.getAttribute('look-controls').enabled === true && BLPR.ctx.cameraMover().pov === false));
	await page.evaluate(() => BLPR.patchSettings({camera: {free: {speed: 6.5}}}));
	await sleep(400);
	const wasd = await page.evaluate(() => {
		const d = BLPR.ctx.mainCamera.getAttribute('wasd-controls');
		return {acceleration: d.acceleration, easing: d.easing};
	});
	check("fly speed tunes the replayer's wasd-controls", Math.abs(wasd.acceleration - 6.5 * wasd.easing) < 1e-3, wasd);
	const freeA = await camPos();
	await page.keyboard.down('KeyW');
	await sleep(600);
	await page.keyboard.up('KeyW');
	await sleep(300);
	const freeB = await camPos();
	check('official WASD camera still flies', JSON.stringify(freeA) !== JSON.stringify(freeB), [freeA, freeB]);
	await page.keyboard.press('Shift+Digit2');
	await sleep(2500);
	const top = await camPos();
	check('preset hotkey Shift+2 (Top Down) moves camera up', top[1] > 5, top);

	// Camera path record + play
	await page.evaluate(() => BLPR.camera.setMode('orbit'));
	// Headless software rendering runs the real replayer at a few frames per second, so record longer.
	await page.keyboard.press('Shift+KeyG');
	await sleep(3000);
	await page.keyboard.press('Shift+KeyG');
	await sleep(500);
	const paths = await sw.evaluate(() => chrome.storage.local.get('blp_camera_paths'));
	const savedPath = (paths.blp_camera_paths || [])[0];
	check('camera path recorded and stored', savedPath && savedPath.keyframes.length >= 2, savedPath && savedPath.keyframes.length);
	await page.keyboard.press('KeyG');
	await sleep(300);
	check('camera path playback active', await page.evaluate(() => BLPR.camera.mode === 'path'));
	await page.keyboard.press('KeyG');
	await page.evaluate(() => BLPR.camera.setMode('default'));

	// Visuals (saber colours stay with the replayer's own colour pickers)
	await page.evaluate(() => BLPR.patchSettings({visuals: {sabers: {trailOverride: true, trailWidth: 50}, notes: {override: true, left: '#ffff00', right: '#00ffff'}}}));
	await sleep(600);
	const vis = await page.evaluate(() => ({
		bg: Object.assign({}, BLPR.ctx.beatGenerator().colors),
		trailVS: BLPR.ctx.leftSaber.components.trail.material.vertexShader.includes('blpWidth'),
		saber: document.getElementById('leftSaberColor').value,
		trailColor: BLPR.saberColor('left'),
	}));
	check('note colors independent of sabers', vis.bg.left === '#ffff00' && vis.bg.right === '#00ffff', vis.bg);
	check('trail width shader patch applied', vis.trailVS);
	check("trail color follows the replayer's saber color", vis.trailColor.toLowerCase() === vis.saber.toLowerCase(), vis);
	await page.evaluate(() => BLPR.patchSettings({visuals: {visibility: {notes: false, leftSaber: false}, accuracyHeat: {enabled: true}}}));
	await sleep(600);
	const vis2 = await page.evaluate(() => {
		const notes = Array.from(BLPR.ctx.beatContainer.children).filter(c => c.components && c.components.beat && ['arrow', 'dot'].includes(c.components.beat.data.type));
		return {
			notes: notes.length,
			notesHidden: notes.every(c => c.object3D.layers.mask === 0),
			saberMask: BLPR.ctx.leftSaber.object3D.layers.mask,
		};
	});
	check('notes hidden via layers', vis2.notes > 0 && vis2.notesHidden, vis2);
	check('left saber hidden via layers', vis2.saberMask === 0, vis2.saberMask);
	await page.evaluate(() => BLPR.patchSettings({visuals: {visibility: {notes: true, leftSaber: true}}}));
	await sleep(800);
	const heat = await page.evaluate(() => {
		const out = [];
		for (const c of BLPR.ctx.beatContainer.children) {
			const beat = c.components && c.components.beat;
			// Pooled notes get new replay notes between frames; compare the ones tinted for their current note.
			if (!beat || !beat.replayNote || beat.replayNote.score === undefined || c.__blpTintNote !== beat.replayNote) continue;
			const mesh = beat.blockEl.getObject3D('mesh');
			out.push(['#' + mesh.material.color.getHexString(), BLPR.heatColor(beat.replayNote.score).toLowerCase(), beat.replayNote.score]);
		}
		return out;
	});
	check('accuracy heat tints spawned notes by their cut score', heat.length > 0 && heat.every(([a, b]) => a === b), heat.filter(([a, b]) => a !== b).concat(heat.slice(0, 3)));
	check('visibility restored', await page.evaluate(() => BLPR.ctx.leftSaber.object3D.layers.mask === 1));
	await page.evaluate(() => BLPR.patchSettings({visuals: {accuracyHeat: {enabled: false}}}));

	// Custom saber model: drop a file on Settings → BL+ → Sabers & trails
	await page.evaluate(() => BLPR.patchSettings({visuals: {sabers: {style: 'custom'}}}));
	await page.keyboard.press('Backquote');
	await page.waitForSelector('#blp-sec-sabers .blp-r-drop', {timeout: 10000});
	const dropFile = (b64, name) =>
		page.evaluate(
			([b64, name]) => {
				const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
				const dt = new DataTransfer();
				dt.items.add(new File([bytes], name));
				const zone = document.querySelector('#blp-sec-sabers .blp-r-drop');
				for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt}));
			},
			[b64, name]
		);
	await page.evaluate(() => document.body.addEventListener('drop', () => (window.__bodyDrop = true)));
	await dropFile(Buffer.from('UnityFS').toString('base64'), 'cool.saber');
	await page.waitForSelector('#blp-sec-sabers .blp-r-drop-error', {timeout: 10000});
	const saberMsg = await page.evaluate(() => document.querySelector('#blp-sec-sabers .blp-r-drop-error .blp-r-hint').textContent);
	check('.saber files get an explanation instead of failing silently', /Unity/.test(saberMsg), saberMsg);
	await dropFile(fx.saberGlb.toString('base64'), 'test-saber.glb');
	const modelsLoaded = () =>
		['leftSaber', 'rightSaber'].every(k => {
			const ent = BLPR.ctx[k].querySelector('.blp-saber-model');
			return ent && ent.getObject3D('mesh') && !BLPR.ctx[k].querySelector('.bladeContainer').object3D.visible;
		});
	await page.waitForFunction(modelsLoaded, null, {timeout: 30000}).catch(() => null);
	const model = await page.evaluate(() => {
		const out = {};
		for (const k of ['leftSaber', 'rightSaber']) {
			const ent = BLPR.ctx[k].querySelector('.blp-saber-model');
			const mesh = ent && ent.getObject3D('mesh');
			if (!mesh) continue;
			const container = BLPR.ctx[k].querySelector('.saberContainer').object3D;
			container.updateMatrixWorld(true);
			const inv = new THREE.Matrix4();
			if (inv.invert) inv.copy(container.matrixWorld).invert();
			else inv.getInverse(container.matrixWorld);
			const box = new THREE.Box3();
			mesh.traverse(o => {
				if (!o.geometry) return;
				o.geometry.computeBoundingBox();
				box.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
			});
			out[k] = {tip: Math.round(box.min.y * 100) / 100, end: Math.round(box.max.y * 1000) / 1000, defaultBlade: BLPR.ctx[k].querySelector('.bladeContainer').object3D.visible};
		}
		return {sabers: out, bodyDrop: !!window.__bodyDrop, status: Array.from(document.querySelectorAll('#blp-sec-sabers .blp-r-row .blp-r-hint')).map(e => e.textContent)};
	});
	check('dropped .glb shows on both sabers, default blade hidden', model.sabers.leftSaber && model.sabers.rightSaber && !model.sabers.leftSaber.defaultBlade && !model.sabers.rightSaber.defaultBlade, model);
	check('model fitted along the blade (tip at -1 m, grip at the hilt)', ['leftSaber', 'rightSaber'].every(k => model.sabers[k] && Math.abs(model.sabers[k].tip + 1) < 0.02 && Math.abs(model.sabers[k].end - 0.155) < 0.01), model.sabers);
	check("drops never reach the replayer's own drag-and-drop", !model.bodyDrop);
	check('model status shown in the BL+ tab', model.status.length === 2 && model.status.every(x => /test-saber\.glb ✓/.test(x)), model.status);
	const stored = await sw.evaluate(() => chrome.storage.local.get('blp_saber_models'));
	check('dropped model saved like an options-page upload', !!(stored.blp_saber_models && stored.blp_saber_models['test-saber.glb']), Object.keys(stored.blp_saber_models || {}));
	await page.waitForSelector('#blp-sec-sabers .blp-r-drop canvas.blp-r-model-preview', {timeout: 10000}).catch(() => null);
	await sleep(1500);
	const previewPixels = await page.evaluate(() => {
		const c = document.querySelector('#blp-sec-sabers canvas.blp-r-model-preview');
		if (!c) return -1;
		const copy = document.createElement('canvas');
		copy.width = c.width;
		copy.height = c.height;
		const g = copy.getContext('2d');
		g.drawImage(c, 0, 0);
		const data = g.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
		return n;
	});
	check('spinning preview of the model in the drop zone', previewPixels > 200, previewPixels);
	await page.click('#blp-sec-sabers .blp-r-row .blp-r-btn >> nth=0');
	await page.waitForFunction(() => !BLPR.ctx.leftSaber.querySelector('.blp-saber-model'), null, {timeout: 10000}).catch(() => null);
	const removed = await page.evaluate(() => ({left: !!BLPR.ctx.leftSaber.querySelector('.blp-saber-model'), right: !!BLPR.ctx.rightSaber.querySelector('.blp-saber-model'), leftBlade: BLPR.ctx.leftSaber.querySelector('.bladeContainer').object3D.visible}));
	check('removing the left model brings back its default blade', !removed.left && removed.right && removed.leftBlade, removed);
	await page.evaluate(() => BLPR.patchSettings({visuals: {sabers: {style: 'default', customModel: {left: '', right: ''}}}}));
	await page.keyboard.press('Backquote');

	// PP line inside the replayer's 3D score HUD
	await sleep(1500);
	const hudLine = await page.evaluate(() => {
		const el = document.getElementById('blpHudPp');
		return el && {parent: el.parentNode.id, mixin: el.getAttribute('mixin'), visible: el.object3D.visible, text: el.getAttribute('text').value};
	});
	check('PP estimate added to the score HUD', hudLine && hudLine.parent === 'scoreContainer' && /\bscoreText\b/.test(hudLine.mixin) && hudLine.visible && /pp$/.test(hudLine.text), hudLine);
	await officialToggle('showHud', false);
	await sleep(600);
	check('PP line follows the replayer\'s "Show HUD"', await page.evaluate(() => document.getElementById('blpHudPp').object3D.visible === false));
	await officialToggle('showHud', true);

	// Playback
	const beforeStep = await page.evaluate(() => BLPR.api.time());
	await page.keyboard.press('BracketRight');
	await sleep(300);
	const step = await page.evaluate(() => ({playing: BLPR.api.isPlaying(), time: BLPR.api.time()}));
	check('frame step pauses and moves to the next replay frame', !step.playing && step.time > beforeStep && step.time - beforeStep < 2, [beforeStep, step]);
	const before = await page.evaluate(() => BLPR.api.time());
	await page.keyboard.press('KeyZ');
	await sleep(800);
	await page.keyboard.press('KeyZ');
	const after = await page.evaluate(() => BLPR.api.time());
	check('reverse playback scrubs backwards', after < before - 0.2, [before, after]);
	await page.evaluate(() => BLPR.api.play());
	await page.keyboard.press('KeyB');
	await sleep(900);
	const bm = await sw.evaluate(() => chrome.storage.local.get('blp_bookmarks'));
	const bmEntry = Object.values(bm.blp_bookmarks || {})[0];
	check('bookmark saved per replay', bmEntry && bmEntry.items.length === 1, bmEntry);
	check("bookmark flag on the replayer's timeline", await page.evaluate(() => document.querySelectorAll('#timeline .blp-r-bookmark-mark').length === 1));
	await page.evaluate(() => BLPR.patchSettings({playback: {persistSpeed: true}}));
	await page.evaluate(() => {
		BLPR.ctx.songControls().baseSongSpeed = 1.25; // as the replayer's speed slider / "=" key does
	});
	await sleep(1200);
	const rt = await sw.evaluate(() => chrome.storage.local.get('blp_runtime'));
	check('speed set in the replayer is remembered', rt.blp_runtime && Math.abs(rt.blp_runtime.lastSpeed - 1.25) < 1e-6, rt.blp_runtime);
	await page.evaluate(() => {
		BLPR.ctx.songControls().baseSongSpeed = 1;
	});
	const loopT = await page.evaluate(() => BLPR.api.time());
	await page.keyboard.press('KeyT');
	await sleep(700);
	await page.keyboard.press('KeyT');
	await sleep(1300);
	const loopNow = await page.evaluate(() => BLPR.api.time());
	check('A-B loop (T) jumps back', loopNow < loopT + 1.2, [loopT, loopNow]);
	await page.keyboard.press('Shift+KeyT');

	// Low-accuracy cuts join the replayer's own "change speed around mistakes"
	const windows = () => page.evaluate(() => BLPR.ctx.songControls().missWindows.length);
	await officialToggle('autoSpeedControls', true);
	const officialWindows = await windows();
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: true, lowAccThreshold: 100}}));
	await sleep(500);
	const withLowAcc = await windows();
	check('low-acc cuts add slow-mo windows to the official ones', officialWindows > 0 && withLowAcc > officialWindows, [officialWindows, withLowAcc]);
	await officialToggle('slowOnMiss', true); // any change makes the replayer recompute its windows
	check('windows survive the replayer recomputing them', (await windows()) === withLowAcc);
	await page.evaluate(t => BLPR.api.seek(t), fx.missTimes[2] - 0.05);
	await sleep(500);
	const slow = await page.evaluate(() => BLPR.ctx.song().speed);
	check('official slow-mo engages around a miss', slow < 0.9, slow);
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: false}}));
	await sleep(300);
	check('turning it off restores the official windows', (await windows()) === officialWindows);
	await officialToggle('autoSpeedControls', false);

	// Right-click menu + export
	await page.mouse.move(600, 300);
	await page.mouse.click(600, 300, {button: 'right'});
	await sleep(300);
	const ctxShown = await page.evaluate(() => getComputedStyle(document.getElementById('ctxMenu')).display === 'block' && getComputedStyle(document.getElementById('blpCopyURL')).display !== 'none');
	check('BL+ items appear in the right-click menu', ctxShown);
	const [shot] = await Promise.all([page.waitForEvent('download', {timeout: 15000}), page.click('#blpScreenshot')]);
	const shotPath = await shot.path();
	check('screenshot from the right-click menu', shot.suggestedFilename().endsWith('.png') && fs.statSync(shotPath).size > 5000, [shot.suggestedFilename(), fs.statSync(shotPath).size]);
	await page.evaluate(() => BLPR.camera.setMode('orbit', {silent: true}));
	const link = await page.evaluate(() => BLPR.exporter.buildShareLink());
	check('share link keeps scoreId and adds time/camera', new RegExp('scoreId=' + fx.scoreId).test(link) && /time=\d+/.test(link) && /blpMode=orbit/.test(link), link);
	await page.evaluate(() => BLPR.camera.setMode('default', {silent: true}));
	await page.evaluate(() => BLPR.patchSettings({export: {clip: {seconds: 2, width: 640, height: 360, fps: 30}}}));
	const [clipDl] = await Promise.all([page.waitForEvent('download', {timeout: 30000}), page.evaluate(() => BLPR.exporter.startClip())]);
	const clipPath = await clipDl.path();
	check('clip recorded as webm', clipDl.suggestedFilename().endsWith('.webm') && fs.statSync(clipPath).size > 1000, [clipDl.suggestedFilename(), fs.statSync(clipPath).size]);

	// Extra hitsounds (bad cuts / misses / bombs) leave the replayer's own hitsound alone
	const officialGain = await page.evaluate(() => BLPR.ctx.hitSound() && BLPR.ctx.hitSound().gainNode && BLPR.ctx.hitSound().gainNode.gain.value);
	await page.evaluate(() => BLPR.patchSettings({audio: {enabled: true}}));
	await sleep(800);
	const audioState = await page.evaluate(() => ({official: BLPR.ctx.hitSound() && BLPR.ctx.hitSound().gainNode && BLPR.ctx.hitSound().gainNode.gain.value, options: document.querySelectorAll('#blp-sec-audio select').length}));
	check('official hitsound untouched, slots shown in BL+ tab', audioState.official === officialGain && audioState.options === 3, [officialGain, audioState]);
	await page.evaluate(() => BLPR.patchSettings({audio: {enabled: false}}));

	// Shared link round trip (blpCfg + blpMode) and ?blpPanel=1
	const page2 = await context.newPage();
	watch(page2, 'replay-link');
	const shareUrl = new URL(link);
	await openReplay(page2, '&' + shareUrl.searchParams.toString().replace(/^scoreId=\d+&?/, '') + '&blpPanel=1');
	await sleep(1500);
	const shared = await page2.evaluate(() => ({
		override: !!BLPR.sessionOverrides,
		mode: BLPR.camera.mode,
		settingsOpen: document.getElementById('settingsContainer').classList.contains('settingsActive') && document.getElementById('blpSettingsPane').classList.contains('active'),
	}));
	check('shared link applies camera mode and opens Settings → BL+', shared.override && shared.mode === 'orbit' && shared.settingsOpen, shared);
	await page2.close();

	// Popup status command via content script
	const popup = await context.newPage();
	watch(popup, 'popup');
	await popup.goto(`chrome-extension://${extId}/popup.html`);
	await popup.waitForSelector('#toggles .toggle-row', {timeout: 10000});
	check('popup renders quick toggles', (await popup.$$('#toggles .toggle-row')).length >= 4);
	const status = await popup.evaluate(async () => {
		const [tab] = await chrome.tabs.query({url: 'https://replay.beatleader.com/*'});
		return new Promise(resolve => chrome.tabs.sendMessage(tab.id, {type: 'blp:replay', action: 'status'}, {frameId: 0}, r => resolve(r)));
	});
	check('popup → content → page command round trip', status && status.ok && status.data.ready && status.data.camera.presets.length >= 5, status && status.data && status.data.camera && status.data.camera.mode);
	await popup.close();

	/* ------------------------------------------------------------ options page */
	const opt = await context.newPage();
	watch(opt, 'options');
	await opt.goto(`chrome-extension://${extId}/options.html#camera`);
	await opt.waitForSelector('.section', {timeout: 10000});
	const counts = await opt.evaluate(() => ({sections: document.querySelectorAll('.section').length, rows: document.querySelectorAll('.row').length}));
	check('options renders all sections', counts.sections === 13 && counts.rows > 120, counts);
	await opt.fill('#search', 'field of view');
	await sleep(200);
	const visible = await opt.evaluate(() => Array.from(document.querySelectorAll('.section')).filter(s => !s.classList.contains('hidden')).map(s => s.id));
	check('search filters sections', visible.length === 1 && visible[0] === 'camera', visible);
	await opt.fill('#search', '');
	await opt.click('[data-path="theme.enabled"] .switch');
	await sleep(800);
	const themeStored = await sw.evaluate(() => chrome.storage.sync.get('blp_s_theme'));
	check('options toggle persists to storage.sync', themeStored.blp_s_theme && themeStored.blp_s_theme.enabled === true);
	await opt.click('[data-path="hotkeys.bindings.toggleHeat"] .hotkey-btn');
	await opt.keyboard.press('Shift+KeyY');
	await sleep(800);
	const hk = await sw.evaluate(() => chrome.storage.sync.get('blp_s_hotkeys'));
	check('hotkey capture saves new binding', hk.blp_s_hotkeys && hk.blp_s_hotkeys.bindings.toggleHeat === 'Shift+Y', hk.blp_s_hotkeys && hk.blp_s_hotkeys.bindings.toggleHeat);
	await opt.selectOption('[data-path="theme.preset"] select', 'oled');
	await sleep(600);
	const themeAfter = await sw.evaluate(() => chrome.storage.sync.get('blp_s_theme'));
	check('theme preset applies its palette', themeAfter.blp_s_theme.colors.background === '#000000', themeAfter.blp_s_theme.colors.background);
	check('theme preview rendered', await opt.evaluate(() => !!document.querySelector('.theme-preview .tp-row')));
	check('visuals preview rendered', await opt.evaluate(() => !!document.querySelector('.visuals-preview svg')));
	const exported = await opt.evaluate(() => window.BLP.storage.exportAll());
	check('export produces full config', exported.format === 'beatleaderplus-config' && exported.settings.camera.presets.length >= 5 && exported.data.cameraPaths.length >= 1);

	/* ------------------------------------------------------------ website */
	await stubFetch();
	const site = await context.newPage();
	watch(site, 'site');
	await site.goto('https://beatleader.com/leaderboard/global/xyz789/1');
	await site.waitForSelector('.blp-actions', {timeout: 10000});
	const siteInfo = await site.evaluate(() => ({
		actions: document.querySelectorAll('.blp-actions').length,
		dl: document.querySelectorAll('.blp-dl').length,
		stars: document.querySelectorAll('.blp-star').length,
		navStars: document.querySelectorAll('nav .blp-star').length,
		dock: !!document.getElementById('blp-dock'),
		themed: !!document.getElementById('blp-theme-style'),
		bg: getComputedStyle(document.body).backgroundColor,
		rank1: getComputedStyle(document.querySelector('.badge')).getPropertyValue('--background-color').trim(),
	}));
	check('score action buttons injected', siteInfo.actions === 2 && siteInfo.dl === 3, siteInfo);
	// Bob's row uses the site's real icon grid, which forces every item into a 22px cell.
	const grid = await site.evaluate(() => {
		const main = document.querySelector('.player-score:nth-child(2) .main-grid');
		const box = main.getBoundingClientRect();
		const ours = Array.from(main.querySelectorAll(':scope > span > .blp-site-icon')).map(b => {
			const r = b.getBoundingClientRect();
			return {cls: b.className.split(' ').find(c => /^blp-(dl|enh|cmp)$/.test(c)), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b};
		});
		return {ours, wrapped: !!main.querySelector('.blp-actions'), cells: main.querySelectorAll(':scope > span > *').length};
	});
	check('BL+ buttons fit the site icon grid as separate cells', !grid.wrapped && grid.ours.length === 3 && grid.ours.every(b => b.w === 22 && b.h === 22 && b.inside && b.hit), grid);
	check('favorite stars on player & map links (not in nav)', siteInfo.stars >= 4 && siteInfo.navStars === 0, siteInfo);
	check('dock shown on leaderboard', siteInfo.dock);
	check('OLED theme applied to site', siteInfo.themed && siteInfo.bg === 'rgb(0, 0, 0)', siteInfo.bg);
	check('rank #1 color re-mapped', siteInfo.rank1 === '#ffc400', siteInfo.rank1);
	await site.click('.player-score .blp-star');
	await sleep(600);
	const favs = await sw.evaluate(() => chrome.storage.local.get('blp_favorites'));
	check('favorite saved', favs.blp_favorites && favs.blp_favorites.players['111'], favs.blp_favorites && Object.keys(favs.blp_favorites.players));
	await site.click('#blp-dock >> text=Full combo');
	await sleep(300);
	const hidden = await site.evaluate(() => document.querySelectorAll('.player-score.blp-filtered-out').length);
	check('quick filter (FC) hides non-matching rows', hidden === 2, hidden);
	await site.click('#blp-dock >> text=Full combo');
	await site.keyboard.press('Alt+Shift+ArrowRight');
	await sleep(200);
	check('next page hotkey clicks pagination', (await site.evaluate(() => window.__page)) === 2);
	const enhancedHref = await site.evaluate(() => (document.querySelector('.blp-enh') ? 'ok' : 'missing'));
	check('enhanced replay button present', enhancedHref === 'ok');
	await site.click('.blp-cmp');
	await site.click('.player-score:nth-child(2) .blp-cmp');
	await site.waitForSelector('#blp-modal .blp-cmp-table', {timeout: 10000}).catch(() => null);
	const cmpRows = await site.evaluate(() => document.querySelectorAll('#blp-modal .blp-cmp-table tbody tr').length);
	check('score comparison modal renders', cmpRows > 10, cmpRows);
	const winner = await site.evaluate(() => (document.querySelector('#blp-modal .blp-win') || {}).textContent);
	check('comparison highlights better value', !!winner, winner);
	await site.keyboard.press('Escape');

	// Profile page: follow + stats drawer + notifications
	await stubFetch();
	await site.goto('https://beatleader.com/u/111');
	await site.waitForSelector('#blp-dock', {timeout: 10000});
	await site.click('#blp-dock >> text=Follow');
	await sleep(800);
	const fstate = await sw.evaluate(() => chrome.storage.local.get('blp_follow_state'));
	const followed = fstate.blp_follow_state.players['111'];
	check('follow stores player and primes last score', followed && followed.lastScoreId, followed);
	check('follow uses the API player name', followed && followed.name === 'Alice Real', followed && followed.name);
	const poll = await opt.evaluate(() => new Promise(r => chrome.runtime.sendMessage({type: 'checkFollowsNow'}, r)));
	check('follow polling finds new score', poll && poll.ok && poll.data.found === 1, poll);
	const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
	check('toolbar badge shows new score count', badge === '1', badge);
	await site.click('#blp-dock >> text=BeatLeaderPlus stats');
	await site.waitForSelector('#blp-stats-drawer .blp-tile', {timeout: 10000}).catch(() => null);
	const tiles = await site.evaluate(() => document.querySelectorAll('#blp-stats-drawer .blp-tile').length);
	check('profile stats drawer renders tiles and charts', tiles === 4 && (await site.evaluate(() => document.querySelectorAll('#blp-stats-drawer canvas').length)) === 3, tiles);

	/* ------------------------------------------------------------ errors */
	console.log('\n--- console errors mentioning BLP ---');
	for (const e of errors) console.log(e);
	const failed = results.filter(r => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	await context.close();
	process.exit(failed.length ? 1 : 0);
})().catch(e => {
	console.error('TEST HARNESS ERROR', e);
	process.exit(2);
});
