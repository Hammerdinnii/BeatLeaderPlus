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
				if (/api\.beatleader\.com\/player\/[^/?]+$/.test(u)) {
					// Profiles by ID or alias, as the BeatLeader API resolves them.
					const players = {111: {id: '111', name: 'Alice Real', alias: 'alice-cool'}, 222: {id: '222', name: 'Bob Real'}, 333: {id: '333', name: 'Carol Real'}, 444: {id: '444', name: 'Dave Real'}, 999: {id: '999', name: 'Me Real'}};
					players['alice-cool'] = players[111];
					const p = players[decodeURIComponent(u.split('/player/')[1])];
					if (!p) return new Response('{}', {status: 404});
					return json(Object.assign({avatar: 'https://cdn.assets.beatleader.xyz/' + p.id + '.png'}, p));
				}
				return realFetch(url, opts);
			};
		}, mockScore);
	await stubFetch();

	/* ------------------------------------------------------------ replay viewer (the real one) */
	const page = await context.newPage();
	watch(page, 'replay');
	// Record the replayer's own hotkey notifications (A-Frame events bubble up to the document).
	await page.addInitScript(() => {
		window.__blpNotes = [];
		document.addEventListener('showHotkeyNotification', e => window.__blpNotes.push(e.detail && e.detail.text), true);
	});
	const openReplay = async (p, query) => {
		await p.goto('https://replay.beatleader.com/?scoreId=' + fx.scoreId + (query || ''));
		await p.waitForFunction(() => window.BLPR && window.BLPR.ctx && window.BLPR.replayInfo && BLPR.api.duration() > 0, null, {timeout: 60000});
	};
	await openReplay(page);
	const title = await page.evaluate(() => BLPR.replayInfo.title);
	check('runtime attached to the real replayer (UTF-8 intact)', title === `Test Player – ${fx.songName} (${fx.difficulty})`, title);
	check('modules registered', true, await page.evaluate(() => BLPR.modules.map(m => m.name)));
	await sleep(500);
	const notes = await page.evaluate(() => {
		const atLoad = window.__blpNotes.slice();
		BLPR.api.notify('probe'); // proves the listener sees our notifications
		return {atLoad, probe: window.__blpNotes.includes('probe')};
	});
	check('no "ready" notification when a replay loads', notes.probe && !notes.atLoad.some(n => /BeatLeaderPlus/.test(n)), notes);
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
	const officialRange = (id, value) =>
		page.evaluate(
			([id, value]) => {
				const input = document.getElementById(id);
				input.value = value;
				input.dispatchEvent(new Event('input', {bubbles: true}));
			},
			[id, value]
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
	// The replayer shows its controls on its next frames; software rendering can be ~1 fps.
	await page.waitForFunction(() => document.body.classList.contains('showControls') && document.getElementById('blpSettingsPane').classList.contains('active'), null, {timeout: 8000}).catch(() => null);
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
	check('BL+ tab renders every section', sections.join() === 'notes,sabers,effects,visibility,picture,playback,timeline,audio,export,hud,interface', sections);
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
	const camTab = await page.evaluate(() => ({
		active: document.getElementById('blpCameraPane').classList.contains('active'),
		sections: Array.from(document.querySelectorAll('#blpCameraPane > .blp-r-section > .blp-r-header')).map(e => e.textContent),
	}));
	check('BL+ camera tab starts with first person, then ortho', camTab.active && camTab.sections.length === 6 && camTab.sections[0] === 'First person' && camTab.sections[1] === 'Orthographic views', camTab);
	if (process.env.BLP_SHOTS) await page.locator('#cameraSettingsContainer').screenshot({path: path.join(process.env.BLP_SHOTS, 'camera-tab.png')});
	// Its first-person and ortho controls are the replayer's own settings, in both directions.
	const fpvSection = '#blpCameraPane > .blp-r-section:nth-child(1)';
	await page.click(fpvSection + ' .blp-r-toggle .switch >> nth=0');
	await sleep(500);
	const fpvOn = await page.evaluate(sel => ({pov: BLPR.ctx.cameraMover().pov, mode: BLPR.camera.mode, saved: BLPR.official.get('fpvCameraIsOn'), toggle: document.querySelector(sel + ' .blp-r-toggle input').checked}), fpvSection);
	check('First person toggle switches to the replayer\'s FPV camera', fpvOn.pov && fpvOn.mode === 'pov' && fpvOn.saved && fpvOn.toggle, fpvOn);
	const rangeIn = (section, label) =>
		page.evaluate(
			([section, label]) => {
				const row = Array.from(document.querySelectorAll(section + ' .blp-r-range')).find(r => r.textContent.startsWith(label));
				return row ? row.querySelector('input').value : null;
			},
			[section, label]
		);
	await page.evaluate(sel => {
		const row = Array.from(document.querySelectorAll(sel + ' .blp-r-range')).find(r => r.textContent.startsWith('Field of view'));
		const input = row.querySelector('input');
		input.value = '95';
		input.dispatchEvent(new Event('input', {bubbles: true}));
	}, fpvSection);
	await sleep(400);
	const fov = await page.evaluate(() => ({setting: Number(BLPR.official.get('fov')), slider: document.getElementById('fov').value, label: document.getElementById('fovLabel').textContent, camera: BLPR.ctx.povCamera.getAttribute('camera').fov}));
	// (the label's ° goes through the replayer's own bundle, which the test server sends without a charset)
	check('BL+ field of view changes the replayer\'s own FPV setting', fov.setting === 95 && fov.slider === '95' && /^95/.test(fov.label) && Number(fov.camera) === 95, fov);
	await officialRange('cameraZPosition', 2.5);
	await sleep(500);
	check('changing it in the FPV tab updates the BL+ tab', (await rangeIn(fpvSection, 'Z position offset')) === '2.5', await rangeIn(fpvSection, 'Z position offset'));
	const orthoSection = '#blpCameraPane > .blp-r-section:nth-child(2)';
	// The replayer hides its menus while playing once the mouse rests; click the way a user's click lands.
	await page.locator(orthoSection + ' .blp-r-toggle .switch').first().evaluate(el => el.click());
	await sleep(500);
	const ortho = await page.evaluate(sel => ({top: BLPR.official.get('orthographicTopEnabled'), box: document.getElementById('orthographicTopEnabled').checked, ranges: document.querySelectorAll(sel + ' .blp-r-range').length}), orthoSection);
	check('ortho toggle turns on the replayer\'s top view, with its zoom and distance', ortho.top === true && ortho.box && ortho.ranges >= 2, ortho);
	await officialToggle('orthographicTopEnabled', false);
	await officialRange('cameraZPosition', 1);
	await officialRange('fov', 60);
	// BL+ additions to the first-person camera: offsets, smoothing and a level horizon.
	const wasPlaying = await page.evaluate(() => BLPR.api.isPlaying());
	await page.evaluate(() => BLPR.patchSettings({camera: {fpv: {height: 0.5, side: 0, smoothing: 0, levelHorizon: true}}}));
	await page.evaluate(() => BLPR.api.play());
	await sleep(1500);
	const rig = await page.evaluate(() => {
		const r = document.querySelector('.headCamera').object3D;
		const head = BLPR.ctx.headset.object3D;
		return {dy: r.position.y - head.position.y, roll: r.rotation.z};
	});
	check('first-person height offset and level horizon', Math.abs(rig.dy - 0.5) < 0.02 && Math.abs(rig.roll - Math.PI) < 1e-6, rig);
	await page.evaluate(() => BLPR.patchSettings({camera: {fpv: {height: 0, side: 0, smoothing: 50, levelHorizon: false}}}));
	if (!wasPlaying) await page.evaluate(() => BLPR.api.pause());
	await page.keyboard.press('Shift+KeyF'); // the replayer's own FPV hotkey
	await sleep(400);
	check('the replayer\'s Shift+F keeps BL+ in step', await page.evaluate(() => !BLPR.ctx.cameraMover().pov && BLPR.camera.mode === 'default'));
	await page.evaluate(() => window.changeCameraTab(0)); // its menus are hidden by now (mouse idle while playing)
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
	// Headless software rendering runs the replayer at about one frame a second: wait for frames.
	await page.waitForFunction(a => {
		const p = BLPR.ctx.mainCamera.object3D.position;
		return [p.x, p.y, p.z].some((v, i) => Math.abs(Math.round(v * 100) / 100 - a[i]) > 0.005);
	}, orbitA, {timeout: 5000}).catch(() => null);
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
	await dropFile(Buffer.from('hello').toString('base64'), 'readme.txt');
	await page.waitForSelector('#blp-sec-sabers .blp-r-drop-error', {timeout: 10000});
	const dropMsg = await page.evaluate(() => document.querySelector('#blp-sec-sabers .blp-r-drop-error .blp-r-hint').textContent);
	check('unsupported files are explained in the drop zone', /not a \.saber, \.glb, \.gltf or \.obj file/.test(dropMsg), dropMsg);
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
	check('model status shown in the BL+ tab', model.status.length === 2 && model.status.every(x => /test-saber\.glb · loaded/.test(x)), model.status);
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
	// A real .saber file (Unity asset bundle) holding a different left and right saber.
	const saberFile = fs.readFileSync(path.join(DIR, '..', 'fixtures', 'saber-unity2019.4-lz4.saber'));
	await dropFile(saberFile.toString('base64'), 'saber-unity2019.4-lz4.saber');
	await page
		.waitForFunction(
			() => ['leftSaber', 'rightSaber'].every(k => {
				const ent = BLPR.ctx[k].querySelector('.blp-saber-model');
				const group = ent && ent.getObject3D('mesh');
				return group && group.children.length && /saber-unity2019/.test(document.querySelector('#blp-sec-sabers').textContent) === false;
			}),
			null,
			{timeout: 30000}
		)
		.catch(() => null);
	const saberModel = await page.evaluate(() => {
		const out = {};
		for (const [k, hand] of [['leftSaber', 'left'], ['rightSaber', 'right']]) {
			const ent = BLPR.ctx[k].querySelector('.blp-saber-model');
			const group = ent && ent.getObject3D('mesh');
			if (!group) continue;
			const container = BLPR.ctx[k].querySelector('.saberContainer').object3D;
			container.updateMatrixWorld(true);
			const inv = new THREE.Matrix4();
			if (inv.invert) inv.copy(container.matrixWorld).invert();
			else inv.getInverse(container.matrixWorld);
			const parts = group.children.map(mesh => {
				const box = new THREE.Box3();
				mesh.geometry.computeBoundingBox();
				box.copy(mesh.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
				const mats = mesh.geometry.groups.map(g => mesh.material[g.materialIndex]);
				const rgb = c => [c.r, c.g, c.b].map(v => Math.round(v * 1000) / 1000);
				return {name: mesh.name, minY: Math.round(box.min.y * 1000) / 1000, maxY: Math.round(box.max.y * 1000) / 1000, colors: mats.map(m => rgb(m.color)), textured: mats.map(m => !!m.map)};
			});
			const c = new THREE.Color(document.getElementById(hand + 'SaberColor').value);
			out[hand] = {parts, saberColor: [c.r, c.g, c.b].map(v => Math.round(v * 1000) / 1000)};
		}
		out.status = Array.from(document.querySelectorAll('#blp-sec-sabers .blp-r-row .blp-r-hint')).map(e => e.textContent);
		return out;
	});
	check('.saber file: left and right sabers read from the bundle', saberModel.left && saberModel.right && saberModel.left.parts.map(p => p.name).join() === 'BladeMesh,HandleMesh' && saberModel.right.parts.map(p => p.name).join() === 'BladeMesh', saberModel);
	check('.saber file: blades point down the replayer saber (-Y), handle on the grip side', saberModel.left && Math.abs(saberModel.left.parts[0].minY + 1) < 0.01 && Math.abs(saberModel.right.parts[0].minY + 1.1) < 0.01 && saberModel.left.parts[1].minY >= 0.04, saberModel.left && [saberModel.left.parts, saberModel.right.parts]);
	const sameColor = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
	check(
		'.saber file: custom-color materials take the saber colors, textures applied',
		saberModel.left && sameColor(saberModel.left.parts[0].colors[0], saberModel.left.saberColor) && sameColor(saberModel.right.parts[0].colors[0], saberModel.right.saberColor) && sameColor(saberModel.left.parts[1].colors[0], [0.3, 0.3, 0.35]) && saberModel.left.parts[0].textured[0],
		saberModel.left && [saberModel.left.parts[0].colors, saberModel.left.saberColor, saberModel.right.parts[0].colors, saberModel.right.saberColor, saberModel.left.parts[1].colors]
	);
	const parsedIn = await page.evaluate(async b64 => (await BLP.unitySaber.readAsync(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))).parsedIn, saberFile.toString('base64'));
	check('.saber files are read in a background worker on the replay page', parsedIn === 'worker', parsedIn);
	check('.saber file: name and author from its descriptor', saberModel.status.length === 2 && saberModel.status.every(x => /Test Saber ✦ by BeatLeaderPlus tests · loaded/.test(x)), saberModel.status);

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

	// Score HUD size, height, color and parts
	await page.evaluate(() => BLPR.patchSettings({overlay: {hud: {scale: 150, height: 0.3, colorOverride: true, color: '#ff0000', show: {combo: false}}}}));
	await sleep(900);
	const hudLook = await page.evaluate(() => {
		const o = document.getElementById('scoreContainer').object3D;
		const mask = id => document.getElementById(id).object3D.layers.mask;
		return {scale: o.scale.x, y: Math.round(o.position.y * 1000) / 1000, combo: mask('combo'), accuracy: mask('accuracy'), color: document.getElementById('score').getAttribute('text').color};
	});
	check('HUD resized around its middle, raised, recolored, combo hidden', hudLook.scale === 1.5 && hudLook.y === -0.2 && hudLook.combo === 0 && hudLook.accuracy !== 0 && hudLook.color === '#ff0000', hudLook);
	await page.evaluate(() => BLPR.patchSettings({overlay: {hud: {scale: 100, height: 0, colorOverride: false, show: {combo: true}}}}));
	await sleep(900);
	const hudBack = await page.evaluate(() => {
		const o = document.getElementById('scoreContainer').object3D;
		return {scale: o.scale.x, y: o.position.y, combo: document.getElementById('combo').object3D.layers.mask, color: document.getElementById('score').getAttribute('text').color};
	});
	check('HUD back to the replayer\'s own look', hudBack.scale === 1 && hudBack.y === 0 && hudBack.combo !== 0 && /^#fafafa$/i.test(hudBack.color), hudBack);

	// Note size, wall opacity and picture
	await page.evaluate(() => BLPR.patchSettings({visuals: {notes: {size: 130, wallOpacity: 40}, picture: {brightness: 120, contrast: 100, saturation: 80}}}));
	await sleep(1200);
	const looks = await page.evaluate(() => {
		const kids = Array.from(BLPR.ctx.beatContainer.children);
		const notes = kids.filter(c => c.components && c.components.beat && c.components.beat.data.type !== 'mine').map(c => c.object3D.scale.x);
		const walls = kids.filter(c => c.components && c.components.wall).map(c => {
			const m = c.getObject3D('mesh');
			return m && m.material.uniforms.blpOpacity ? m.material.uniforms.blpOpacity.value : null;
		});
		return {notes: notes.length, sized: notes.every(v => Math.abs(v - 1.3) < 1e-6), walls: walls.length, faded: walls.every(v => v !== null && Math.abs(v - 0.4) < 1e-6), filter: BLPR.ctx.canvas.style.filter};
	});
	check('note size applies to every note', looks.notes > 0 && looks.sized, looks);
	check('wall opacity applies to the replayer\'s wall shader', looks.walls > 0 && looks.faded, looks);
	check('picture brightness / saturation filter the 3D view', looks.filter === 'brightness(1.2) saturate(0.8)', looks.filter);
	await page.evaluate(() => BLPR.patchSettings({visuals: {notes: {size: 100, wallOpacity: 100}, picture: {brightness: 100, saturation: 100}}}));
	await sleep(800);
	const looksBack = await page.evaluate(() => ({
		notes: Array.from(BLPR.ctx.beatContainer.children).filter(c => c.components && c.components.beat).every(c => c.object3D.scale.x === 1),
		filter: BLPR.ctx.canvas.style.filter,
	}));
	check('note size and picture reset cleanly', looksBack.notes && looksBack.filter === '', looksBack);

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
	const officialSlow = () => page.evaluate(() => ({setting: BLPR.official.get('autoSpeedControls'), box: document.getElementById('autoSpeedControls').checked}));
	const slowBefore = await officialSlow();
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: true, lowAccThreshold: 100}}));
	await sleep(600);
	const slowLinked = await officialSlow();
	check("low-acc slow-mo turns on the replayer's own \"Change speed around mistakes\"", !slowBefore.setting && slowLinked.setting === true && slowLinked.box, [slowBefore, slowLinked]);
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: false}}));
	await sleep(400);
	const officialWindows = await windows();
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: true}}));
	await sleep(500);
	const withLowAcc = await windows();
	check('low-acc cuts add slow-mo windows to the official ones', officialWindows > 0 && withLowAcc > officialWindows, [officialWindows, withLowAcc]);
	await officialToggle('slowOnMiss', true); // any change makes the replayer recompute its windows
	check('windows survive the replayer recomputing them', (await windows()) === withLowAcc);
	// Paused inside the window, so slow software rendering can't run the song past it.
	await page.evaluate(() => BLPR.api.pause());
	await page.evaluate(t => BLPR.api.seek(t), fx.missTimes[2] - 0.1);
	await sleep(500);
	const slow = await page.evaluate(() => BLPR.ctx.songControls().getCurrentEffectiveSpeed());
	check('official slow-mo engages around a miss', slow < 0.9, slow);
	await page.evaluate(() => BLPR.api.play());
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: false}}));
	await sleep(300);
	check('turning it off restores the official windows', (await windows()) === officialWindows);
	await page.evaluate(() => BLPR.patchSettings({playback: {slowOnLowAcc: true}}));
	await sleep(400);
	await officialToggle('autoSpeedControls', false);
	await sleep(800);
	check("turning the replayer's own off turns low-acc slow-mo off too", await page.evaluate(() => BLPR.settings.playback.slowOnLowAcc === false && !BLPR.official.get('autoSpeedControls')));

	// Pause at mistakes
	await page.evaluate(() => BLPR.patchSettings({playback: {pauseOnMistakes: true}}));
	const pauseFrom = fx.missTimes[3] - 1;
	await page.evaluate(t => {
		BLPR.api.seek(t);
		BLPR.api.play();
	}, pauseFrom);
	await page.waitForFunction(() => !BLPR.api.isPlaying(), null, {timeout: 15000}).catch(() => null);
	const paused = await page.evaluate(from => {
		const first = BLPR.replayInfo.notes.find(n => n.time > from + 0.05 && BLPR.api.noteKind(n) !== 'good');
		return {playing: BLPR.api.isPlaying(), time: BLPR.api.time(), mistake: first && first.time};
	}, pauseFrom);
	check('pause at mistakes stops on the next mistake', !paused.playing && paused.mistake && paused.time >= paused.mistake - 0.05 && paused.time < paused.mistake + 2, paused);
	await page.evaluate(() => BLPR.patchSettings({playback: {pauseOnMistakes: false}}));
	await page.evaluate(() => BLPR.api.play());

	// Speed buttons in Settings → BL+ → Playback
	await page.evaluate(() => BLPR.ui.refresh(true));
	await sleep(300);
	const speedButtons = await page.evaluate(() => Array.from(document.querySelectorAll('#blp-sec-playback .blp-r-btn')).map(b => b.textContent).filter(x => /x$/.test(x)));
	await page.evaluate(() => Array.from(document.querySelectorAll('#blp-sec-playback .blp-r-btn')).find(b => b.textContent === '0.5x').click());
	await sleep(300);
	check('speed buttons set the replayer speed', speedButtons.join(',') === '0.5x,0.75x,1x,1.25x' && (await page.evaluate(() => BLPR.api.getSpeed())) === 0.5, [speedButtons, await page.evaluate(() => BLPR.api.getSpeed())]);
	await page.evaluate(() => BLPR.api.setSpeed(1));

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
	const dockClosed = await site.evaluate(() => ({
		dock: Array.from(document.querySelectorAll('#blp-dock > *')).map(e => e.className),
		dockText: document.getElementById('blp-dock').textContent,
	}));
	check('dock starts collapsed to the BL+ button', dockClosed.dock.length === 1 && dockClosed.dock[0] === 'blp-dock-brand' && dockClosed.dockText === 'BL+', dockClosed);
	await site.click('#blp-dock .blp-dock-brand');
	const dockOpen = await site.evaluate(() => ({
		open: document.getElementById('blp-dock').classList.contains('blp-dock-open'),
		items: document.querySelectorAll('#blp-dock > *').length,
		text: document.getElementById('blp-dock').textContent,
	}));
	check('clicking BL+ opens the dock (filters only on a leaderboard)', dockOpen.open && dockOpen.items === 2, dockOpen);
	// Favorites were removed: BeatLeader's own follow button and playlists cover them.
	check('no favorites: no stars, dock button or filter', (await site.evaluate(() => document.querySelectorAll('.blp-star').length)) === 0 && !/favorite/i.test(dockOpen.text), dockOpen.text);
	const siteInfo = await site.evaluate(() => ({
		actions: document.querySelectorAll('.blp-actions').length,
		dl: document.querySelectorAll('.blp-dl').length,
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
			return {cls: b.className.split(' ').find(c => /^blp-(dl|cmp)$/.test(c)), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b};
		});
		return {ours, wrapped: !!main.querySelector('.blp-actions'), cells: main.querySelectorAll(':scope > span > *').length};
	});
	check('BL+ buttons fit the site icon grid as separate cells', !grid.wrapped && grid.ours.length === 2 && grid.ours.every(b => b.w === 22 && b.h === 22 && b.inside && b.hit), grid);
	check('dock shown on leaderboard', siteInfo.dock);
	check('OLED theme applied to site', siteInfo.themed && siteInfo.bg === 'rgb(0, 0, 0)', siteInfo.bg);
	check('rank #1 color re-mapped', siteInfo.rank1 === '#ffc400', siteInfo.rank1);

	// The dock can be resized, and dragged to any edge, where it runs along that edge.
	await opt.evaluate(() => window.BLP.storage.patchSettings({site: {dockSize: 150}}));
	await site.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('#blp-dock .blp-dock-brand')).fontSize) > 20, null, {timeout: 5000}).catch(() => null);
	const brandFont = await site.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#blp-dock .blp-dock-brand')).fontSize));
	check('dock size setting scales the BL+ button', Math.abs(brandFont - 24) < 0.5, brandFont);
	const dockState = () =>
		site.evaluate(() => {
			const d = document.getElementById('blp-dock');
			const r = d.getBoundingClientRect();
			const vw = document.documentElement.clientWidth;
			return {vertical: d.classList.contains('blp-dock-v'), open: d.classList.contains('blp-dock-open'), inside: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= innerHeight, right: Math.round(vw - r.right), bottom: Math.round(innerHeight - r.bottom), edge: d.dataset.edge};
		});
	const dockBefore = await dockState();
	const brandAt = await site.evaluate(() => {
		const r = document.querySelector('#blp-dock .blp-dock-brand').getBoundingClientRect();
		return {x: r.left + r.width / 2, y: r.top + r.height / 2, w: document.documentElement.clientWidth, h: innerHeight};
	});
	await site.mouse.move(brandAt.x, brandAt.y);
	await site.mouse.down();
	for (let i = 1; i <= 10; i++) await site.mouse.move(brandAt.x + ((brandAt.w - 4 - brandAt.x) * i) / 10, brandAt.y + ((brandAt.h * 0.35 - brandAt.y) * i) / 10);
	await site.mouse.up();
	await sleep(500);
	const dockMoved = await dockState();
	const dockSaved = (await sw.evaluate(() => chrome.storage.local.get('blp_site_ui'))).blp_site_ui;
	check('dragged to the right edge, the dock turns vertical and stays on screen', dockMoved.vertical && dockMoved.inside && dockMoved.right < 30 && dockSaved && dockSaved.dock.edge === 'right', [dockMoved, dockSaved]);
	check('dragging does not open or close the dock', dockMoved.open === dockBefore.open, [dockBefore.open, dockMoved.open]);
	await site.dblclick('#blp-dock .blp-dock-brand');
	await sleep(500);
	const dockReset = await dockState();
	check('double-click puts the dock back along the bottom', !dockReset.vertical && dockReset.edge === 'bottom' && dockReset.bottom < 30 && dockReset.open === dockBefore.open, dockReset);
	await opt.evaluate(() => window.BLP.storage.patchSettings({site: {dockSize: 100}}));
	await sleep(400);
	await site.click('#blp-dock >> text=Full combo');
	await sleep(300);
	const hidden = await site.evaluate(() => document.querySelectorAll('.player-score.blp-filtered-out').length);
	check('quick filter (FC) hides non-matching rows', hidden === 2, hidden);
	await site.click('#blp-dock >> text=Full combo');
	await site.keyboard.press('Alt+Shift+ArrowRight');
	await sleep(200);
	check('next page hotkey clicks pagination', (await site.evaluate(() => window.__page)) === 2);
	check('no "Open in Enhanced Replayer" button', await site.evaluate(() => !document.querySelector('.blp-enh, [title*="Enhanced"]')));
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
	await site.click('#blp-dock .blp-dock-brand');
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
