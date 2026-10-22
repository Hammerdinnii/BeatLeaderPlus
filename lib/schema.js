/*
 * BeatLeaderPlus – declarative settings schema.
 *
 * The options page renders itself entirely from this schema and the popup uses it to build its
 * (user-configurable) quick toggles. To add a new setting:
 *   1. add the default value in lib/defaults.js
 *   2. add a field here (label key is "f.<path>", optional description key "d.<path>")
 *   3. add the strings to lib/i18n.js
 *   4. read the value wherever the feature lives (content module or injected replay module)
 *
 * Field types: toggle | color | range | number | select | text | textarea | code | hotkey | key
 * `when` is an optional path to a boolean setting; the field is dimmed while that setting is off.
 * `custom` entries are rendered by named renderers in options.js (lists, file imports, ...).
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.schema) return;

	const tog = (path, extra) => Object.assign({type: 'toggle', path}, extra);
	const col = (path, extra) => Object.assign({type: 'color', path}, extra);
	const rng = (path, min, max, step, unit, extra) => Object.assign({type: 'range', path, min, max, step, unit: unit || ''}, extra);
	const num = (path, min, max, step, unit, extra) => Object.assign({type: 'number', path, min, max, step, unit: unit || ''}, extra);
	const sel = (path, options, extra) => Object.assign({type: 'select', path, options}, extra);
	const txt = (path, extra) => Object.assign({type: 'text', path}, extra);
	const area = (path, extra) => Object.assign({type: 'textarea', path}, extra);
	const code = (path, extra) => Object.assign({type: 'code', path}, extra);
	const hk = (path, extra) => Object.assign({type: 'hotkey', path}, extra);
	const head = id => ({type: 'heading', id});
	const custom = (renderer, extra) => Object.assign({type: 'custom', renderer}, extra);
	const opts = (prefix, values) => values.map(v => ({value: v, label: prefix + v}));

	const themeColors = ['primary', 'secondary', 'background', 'surface', 'text', 'textMuted', 'accent', 'link', 'border', 'success', 'danger', 'rank1', 'rank2', 'rank3'];
	const hideGroups = ['header', 'footer', 'sidebars', 'social', 'ads', 'banners', 'avatars', 'hmdIcons', 'flags', 'backgroundImages', 'cinematics'];
	const hotkeyActions = [
		'openOptions',
		'toggleTheme',
		'toggleOverlays',
		'nextMap',
		'prevMap',
		'togglePanel',
		'cycleCamera',
		'pathPlay',
		'pathRecord',
		'pathKeyframe',
		'frameBack',
		'frameForward',
		'reverse',
		'loopCycle',
		'loopClear',
		'addBookmark',
		'nextBookmark',
		'screenshot',
		'recordClip',
		'copyLink',
		'toggleHeat',
	];
	const visibility = ['leftSaber', 'rightSaber', 'trails', 'notes', 'bombs', 'walls', 'arcs', 'chains'];
	const hideOfficial = ['songInfo', 'playerInfo', 'socialCorners', 'playlist'];
	const hudParts = ['score', 'accuracy', 'combo', 'multiplier', 'misses', 'energy'];
	const cameraModes = ['default', 'orbit', 'follow', 'pov'];

	const SECTIONS = [
		{
			id: 'general',
			fields: [
				tog('general.enabled'),
				sel('general.language', [
					{value: 'auto', label: 'lang.auto'},
					{value: 'en', label: 'lang.en'},
					{value: 'de', label: 'lang.de'},
				]),
				tog('general.perDomain'),
				tog('general.showToasts'),
				tog('general.debug'),
			],
		},
		{
			id: 'theme',
			fields: [
				tog('theme.enabled'),
				sel('theme.preset', opts('preset.', ['darkplus', 'oled', 'light', 'contrast', 'custom']), {when: 'theme.enabled', onChange: 'applyThemePreset'}),
				custom('themePreview'),
				head('themeColors'),
				...themeColors.map(c => col('theme.colors.' + c, {when: 'theme.enabled', onChange: 'markThemeCustom'})),
				head('themeTypography'),
				txt('theme.font.family', {when: 'theme.enabled', placeholder: 'Inter, Segoe UI, system-ui'}),
				rng('theme.font.size', 70, 150, 1, '%', {when: 'theme.enabled'}),
				sel('theme.font.weight', [0, 300, 400, 500, 600, 700, 800].map(v => ({value: v, label: v ? String(v) : 'common.default'})), {when: 'theme.enabled'}),
				rng('theme.density', 60, 130, 1, '%', {when: 'theme.enabled'}),
				tog('theme.compact', {when: 'theme.enabled'}),
				rng('theme.radius', 0, 24, 1, 'px', {when: 'theme.enabled'}),
				head('themeHide'),
				...hideGroups.map(g => tog('theme.hide.' + g)),
				area('theme.hideSelectors', {placeholder: '.some-banner\n#promo-box'}),
				head('themeAdvanced'),
				tog('theme.customCssEnabled'),
				code('theme.customCss', {placeholder: '/* Your CSS here. Variables: --blp-primary, --blp-bg, ... */'}),
				tog('theme.applyToReplay'),
			],
		},
		{
			id: 'hotkeys',
			fields: [
				tog('hotkeys.enabled'),
				head('hotkeysGlobal'),
				...hotkeyActions.slice(0, 5).map(a => hk('hotkeys.bindings.' + a, {label: 'hk.' + a})),
				head('hotkeysReplay'),
				...hotkeyActions.slice(5).map(a => hk('hotkeys.bindings.' + a, {label: 'hk.' + a})),
			],
		},
		{
			id: 'camera',
			fields: [
				sel('camera.mode', opts('cam.mode.', cameraModes)),
				tog('camera.rememberMode'),
				sel('camera.defaultPreset', [], {optionsFrom: 'cameraPresets'}),
				rng('camera.fov', 20, 130, 1, '°'),
				rng('camera.smoothing', 0, 1, 0.05),
				custom('cameraPresets'),
				head('cameraFpv'),
				rng('camera.fpv.height', -1, 1, 0.05, 'm'),
				rng('camera.fpv.side', -1, 1, 0.05, 'm'),
				rng('camera.fpv.smoothing', 0, 100, 1, '%'),
				tog('camera.fpv.levelHorizon'),
				head('cameraFree'),
				rng('camera.free.speed', 0.5, 15, 0.25, 'm/s'),
				rng('camera.free.sprint', 1, 8, 0.5, '×'),
				tog('camera.free.pointerLock'),
				head('cameraOrbit'),
				sel('camera.orbit.target', opts('cam.target.', ['head', 'center'])),
				rng('camera.orbit.radius', 0.5, 12, 0.1, 'm'),
				rng('camera.orbit.height', -1, 8, 0.1, 'm'),
				rng('camera.orbit.speed', -90, 90, 1, '°/s'),
				rng('camera.orbit.startAngle', 0, 360, 1, '°'),
				head('cameraFollow'),
				sel('camera.follow.target', opts('cam.target.', ['head', 'center'])),
				sel('camera.follow.relative', opts('cam.relative.', ['world', 'headYaw'])),
				rng('camera.follow.offset.x', -6, 6, 0.05, 'm'),
				rng('camera.follow.offset.y', -3, 6, 0.05, 'm'),
				rng('camera.follow.offset.z', -6, 8, 0.05, 'm'),
				rng('camera.follow.lag', 0, 1, 0.05),
				rng('camera.follow.lookAhead', 0, 5, 0.1, 'm'),
				head('cameraPath'),
				rng('camera.path.sampleRate', 5, 60, 1, 'Hz'),
				sel('camera.path.timeBase', opts('cam.timeBase.', ['song', 'real'])),
				tog('camera.path.loop'),
				tog('camera.path.smooth'),
				tog('camera.path.autoPlayShared'),
				custom('cameraPaths'),
			],
		},
		{
			id: 'visuals',
			fields: [
				custom('visualsPreview'),
				head('visNotes'),
				tog('visuals.notes.override'),
				col('visuals.notes.left', {when: 'visuals.notes.override'}),
				col('visuals.notes.right', {when: 'visuals.notes.override'}),
				tog('visuals.notes.chainOverride'),
				col('visuals.notes.chain', {when: 'visuals.notes.chainOverride'}),
				tog('visuals.notes.arcOverride'),
				col('visuals.notes.arc', {when: 'visuals.notes.arcOverride'}),
				rng('visuals.notes.size', 50, 150, 5, '%'),
				rng('visuals.notes.wallOpacity', 0, 100, 5, '%'),
				head('visSabers'),
				sel('visuals.sabers.style', opts('saber.style.', ['default', 'neon', 'particle', 'custom'])),
				rng('visuals.sabers.glowIntensity', 0, 600, 10, '%'),
				head('visTrails'),
				tog('visuals.sabers.trailOverride'),
				tog('visuals.sabers.trailMatchSaber', {when: 'visuals.sabers.trailOverride'}),
				col('visuals.sabers.leftTrailColor', {when: 'visuals.sabers.trailOverride'}),
				col('visuals.sabers.rightTrailColor', {when: 'visuals.sabers.trailOverride'}),
				rng('visuals.sabers.trailWidth', 10, 100, 1, '%', {when: 'visuals.sabers.trailOverride'}),
				rng('visuals.sabers.trailOpacity', 0, 200, 5, '%', {when: 'visuals.sabers.trailOverride'}),
				head('visModels'),
				txt('visuals.sabers.customModel.left', {placeholder: 'https://…/saber.glb  or  stored:my-saber.glb'}),
				txt('visuals.sabers.customModel.right', {placeholder: 'https://…/saber.obj'}),
				rng('visuals.sabers.customModel.scale', 0.05, 5, 0.05, '×'),
				rng('visuals.sabers.customModel.rotX', -180, 180, 1, '°'),
				rng('visuals.sabers.customModel.rotY', -180, 180, 1, '°'),
				rng('visuals.sabers.customModel.rotZ', -180, 180, 1, '°'),
				tog('visuals.sabers.customModel.hideDefault'),
				tog('visuals.sabers.customModel.autoFit'),
				tog('visuals.sabers.customModel.unlit'),
				tog('visuals.sabers.customModel.tint'),
				tog('visuals.sabers.bloom.enabled'),
				rng('visuals.sabers.bloom.strength', 0, 300, 5, '%', {when: 'visuals.sabers.bloom.enabled'}),
				rng('visuals.sabers.bloom.size', 0, 100, 5, '%', {when: 'visuals.sabers.bloom.enabled'}),
				custom('saberModels'),
				head('visEffects'),
				tog('visuals.effects.missFlash'),
				col('visuals.effects.missColor', {when: 'visuals.effects.missFlash'}),
				tog('visuals.effects.badCutFlash'),
				col('visuals.effects.badCutColor', {when: 'visuals.effects.badCutFlash'}),
				tog('visuals.effects.bombFlash'),
				col('visuals.effects.bombColor', {when: 'visuals.effects.bombFlash'}),
				rng('visuals.effects.flashIntensity', 5, 100, 1, '%'),
				sel('visuals.effects.markerStyle', opts('marker.', ['none', 'ring', 'cross', 'pillar'])),
				rng('visuals.effects.markerLifetime', 0.2, 6, 0.1, 's'),
				tog('visuals.effects.hitParticles'),
				sel('visuals.effects.particleColorMode', opts('particle.', ['saber', 'custom', 'accuracy']), {when: 'visuals.effects.hitParticles'}),
				col('visuals.effects.particleColor', {when: 'visuals.effects.hitParticles'}),
				rng('visuals.effects.particleIntensity', 10, 400, 10, '%', {when: 'visuals.effects.hitParticles'}),
				head('visVisibility'),
				...visibility.map(v => tog('visuals.visibility.' + v)),
				head('visPicture'),
				rng('visuals.picture.brightness', 50, 150, 5, '%'),
				rng('visuals.picture.contrast', 50, 150, 5, '%'),
				rng('visuals.picture.saturation', 0, 200, 5, '%'),
				head('visHeat'),
				tog('visuals.accuracyHeat.enabled'),
				sel('visuals.accuracyHeat.target', opts('heat.target.', ['notes', 'particles', 'both']), {when: 'visuals.accuracyHeat.enabled'}),
				...['c115', 'c110', 'c105', 'c100', 'low', 'bad'].map(c => col('visuals.accuracyHeat.' + c, {when: 'visuals.accuracyHeat.enabled'})),
			],
		},
		{
			id: 'playback',
			fields: [
				sel('playback.frameStepMode', opts('frameStep.', ['replay', 'fixed'])),
				num('playback.frameStepMs', 1, 200, 0.1, 'ms'),
				tog('playback.persistSpeed'),
				tog('playback.persistJd'),
				rng('playback.reverseRate', 5, 60, 1, 'Hz'),
				rng('playback.reverseSpeed', 0.1, 2, 0.05, '×'),
				rng('playback.loopPreRoll', 0, 3, 0.1, 's'),
				txt('playback.speedButtons', {placeholder: '0.5, 0.75, 1, 1.25'}),
				head('playMistakes'),
				tog('playback.pauseOnMistakes'),
				...['miss', 'bad', 'bomb', 'wall'].map(k => tog('playback.pauseOn.' + k, {when: 'playback.pauseOnMistakes'})),
				head('playPerformance'),
				sel('playback.fpsLimit', [0, 30, 45, 60, 72, 90, 120, 144, 165, 240].map(v => ({value: v, label: v ? v + ' fps' : 'r.fpsOff'}))),
				head('playSlowMo'),
				tog('playback.slowOnLowAcc'),
				rng('playback.lowAccThreshold', 60, 115, 1, '', {when: 'playback.slowOnLowAcc'}),
				head('playTimeline'),
				tog('playback.bookmarksOnTimeline'),
				custom('bookmarks'),
			],
		},
		{
			id: 'overlay',
			fields: [
				tog('overlay.ppInHud'),
				tog('overlay.lastCutInHud'),
				head('ovHud'),
				rng('overlay.hud.scale', 50, 200, 5, '%'),
				rng('overlay.hud.height', -2, 2, 0.05, 'm'),
				tog('overlay.hud.colorOverride'),
				col('overlay.hud.color', {when: 'overlay.hud.colorOverride'}),
				...hudParts.map(k => tog('overlay.hud.show.' + k)),
				head('ovHideOfficial'),
				...hideOfficial.map(h => tog('overlay.hideOfficial.' + h)),
			],
		},
		{
			id: 'audio',
			fields: [tog('audio.enabled'), custom('hitsoundSlots'), custom('hitsoundPack')],
		},
		{
			id: 'export',
			fields: [
				head('expScreenshot'),
				tog('export.screenshot.useWindowSize'),
				num('export.screenshot.width', 320, 7680, 1, 'px'),
				num('export.screenshot.height', 240, 4320, 1, 'px'),
				sel('export.screenshot.format', opts('fmt.', ['png', 'jpeg', 'webp'])),
				head('expClip'),
				rng('export.clip.seconds', 2, 120, 1, 's'),
				sel('export.clip.fps', [24, 30, 60].map(v => ({value: v, label: v + ' fps'}))),
				num('export.clip.width', 320, 3840, 1, 'px'),
				num('export.clip.height', 240, 2160, 1, 'px'),
				tog('export.clip.includeAudio'),
				rng('export.clip.bitrateMbps', 1, 50, 1, 'Mbps'),
				head('expLink'),
				...['includeTime', 'includeSpeed', 'includeJd', 'includeCamera', 'includeColors'].map(k => tog('export.link.' + k)),
			],
		},
		{
			id: 'site',
			fields: [
				tog('site.enabled'),
				txt('site.myPlayerId', {placeholder: '76561198…'}),
				txt('site.myClanTag', {placeholder: 'BSFR'}),
				head('siteButtons'),
				tog('site.downloadButton'),
				head('siteDock'),
				rng('site.dockSize', 60, 200, 5, '%'),
				head('siteLists'),
				tog('site.compare'),
				tog('site.autoExpandDetails'),
				tog('site.quickFilters'),
				rng('site.highAccThreshold', 80, 100, 0.5, '%'),
				tog('site.profileStats'),
				tog('site.extraBadges'),
			],
		},
		{
			id: 'popup',
			fields: [
				custom('popupToggles'),
				tog('popup.showReplayActions'),
				tog('popup.compact'),
				rng('popup.width', 300, 520, 10, 'px'),
			],
		},
		{
			id: 'data',
			fields: [custom('dataTools')],
		},
	];

	/** Flat list of all value fields (excludes headings/custom). */
	function allFields() {
		const out = [];
		for (const s of SECTIONS) for (const f of s.fields) if (f.path) out.push(Object.assign({section: s.id}, f));
		return out;
	}

	BLP.schema = {
		SECTIONS,
		allFields,
		findField: path => allFields().find(f => f.path === path),
		/** Boolean fields that can be offered as popup quick toggles. */
		toggleFields: () => allFields().filter(f => f.type === 'toggle'),
		labelKey: f => f.label || 'f.' + f.path,
		descKey: f => 'd.' + f.path,
	};
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
