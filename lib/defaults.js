/*
 * BeatLeaderPlus – default settings, presets and storage key constants.
 *
 * The settings object is split into top-level sections. Each section is persisted as its own
 * chrome.storage.sync item (see lib/storage.js) so we stay under the 8 KB per-item sync quota.
 * Large or high-churn data (camera paths, bookmarks, hitsound packs, saber models,
 * runtime values such as the last playback speed) lives in chrome.storage.local instead.
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.defaults) return;

	const SCHEMA_VERSION = 9;

	/* ---------------------------------------------------------------- theme presets */

	const THEME_PRESETS = {
		darkplus: {
			primary: '#ff3d9a',
			secondary: '#7c4dff',
			background: '#14141c',
			surface: '#1d1d28',
			text: '#ececf4',
			textMuted: '#9a9ab0',
			accent: '#40c4ff',
			link: '#82b1ff',
			border: '#2c2c3a',
			success: '#4cd964',
			danger: '#ff5370',
			rank1: '#d4a017',
			rank2: '#9ea7b3',
			rank3: '#b0672d',
		},
		oled: {
			primary: '#ff2d8a',
			secondary: '#6c3bff',
			background: '#000000',
			surface: '#08080a',
			text: '#f4f4f4',
			textMuted: '#8a8a8a',
			accent: '#00e5ff',
			link: '#7ab4ff',
			border: '#1a1a1a',
			success: '#39d353',
			danger: '#ff4060',
			rank1: '#ffc400',
			rank2: '#c0c0c0',
			rank3: '#cd7f32',
		},
		light: {
			primary: '#d1006f',
			secondary: '#5b3cc4',
			background: '#f5f6fa',
			surface: '#ffffff',
			text: '#1d1e26',
			textMuted: '#5f6372',
			accent: '#0077cc',
			link: '#2457d6',
			border: '#dcdfe8',
			success: '#1e9e48',
			danger: '#d32f45',
			rank1: '#b8860b',
			rank2: '#7d8794',
			rank3: '#8b4513',
		},
		contrast: {
			primary: '#ffff00',
			secondary: '#00ffff',
			background: '#000000',
			surface: '#000000',
			text: '#ffffff',
			textMuted: '#e0e0e0',
			accent: '#00ff00',
			link: '#00ffff',
			border: '#ffffff',
			success: '#00ff00',
			danger: '#ff3030',
			rank1: '#ffff00',
			rank2: '#ffffff',
			rank3: '#ff9900',
		},
	};

	/* ---------------------------------------------------------------- camera presets */

	// Built-in presets are stored in settings.camera.presets on first run so users can edit,
	// rename, re-hotkey or delete them like their own presets ("Restore built-ins" re-adds them).
	// Modes: static (pose for the official camera), orbit, follow, pov (the official first person).
	const BUILTIN_CAMERA_PRESETS = [
		{
			id: 'builtin_cinematic_low',
			name: 'Cinematic Low',
			builtin: true,
			hotkey: 'Shift+1',
			mode: 'static',
			pose: {x: 1.6, y: 0.55, z: 1.4, pitch: 8, yaw: 38, roll: 0},
			fov: 50,
		},
		{
			id: 'builtin_top_down',
			name: 'Top Down',
			builtin: true,
			hotkey: 'Shift+2',
			mode: 'static',
			pose: {x: 0, y: 6.5, z: -1.5, pitch: -89, yaw: 0, roll: 0},
			fov: 60,
		},
		{
			id: 'builtin_side_follow',
			name: 'Side Follow',
			builtin: true,
			hotkey: 'Shift+3',
			mode: 'follow',
			fov: 60,
			follow: {target: 'head', offset: {x: 2.4, y: 0.2, z: 0.2}, relative: 'world', lag: 0.45, lookAhead: 0.6},
		},
		{
			id: 'builtin_fp_strict',
			name: 'First Person',
			builtin: true,
			hotkey: 'Shift+4',
			mode: 'pov',
		},
		{
			id: 'builtin_orbit',
			name: 'Orbit Showcase',
			builtin: true,
			hotkey: 'Shift+5',
			mode: 'orbit',
			fov: 55,
			orbit: {target: 'head', radius: 3.2, height: 1.9, speed: 12, startAngle: 25},
		},
	];

	/* ---------------------------------------------------------------- settings */

	const DEFAULT_SETTINGS = {
		schemaVersion: SCHEMA_VERSION,

		general: {
			enabled: true,
			debug: false,
			language: 'auto',
			perDomain: false,
			showToasts: true,
		},

		theme: {
			enabled: false,
			preset: 'darkplus',
			colors: Object.assign({}, THEME_PRESETS.darkplus),
			font: {family: '', size: 100, weight: 0},
			density: 100,
			compact: false,
			radius: 8,
			customCssEnabled: true,
			customCss: '',
			hide: {
				header: false,
				footer: false,
				sidebars: false,
				social: false,
				ads: true,
				banners: false,
				avatars: false,
				hmdIcons: false,
				flags: false,
				backgroundImages: false,
				cinematics: false,
			},
			hideSelectors: '',
			applyToReplay: false,
		},

		hotkeys: {
			enabled: true,
			bindings: {
				// Global (website + replay viewer)
				openOptions: 'Alt+Shift+O',
				toggleTheme: 'Alt+Shift+T',
				toggleOverlays: 'Alt+Shift+H',
				nextMap: 'Alt+Shift+ArrowRight',
				prevMap: 'Alt+Shift+ArrowLeft',
				// Replay viewer (chosen to avoid the replayer's own keys, incl. W A S D X C camera keys)
				togglePanel: '`',
				cycleCamera: 'V',
				pathPlay: 'G',
				pathRecord: 'Shift+G',
				pathKeyframe: 'Alt+G',
				frameBack: '[',
				frameForward: ']',
				reverse: 'Z',
				loopCycle: 'T',
				loopClear: 'Shift+T',
				addBookmark: 'B',
				nextBookmark: 'Shift+B',
				screenshot: 'F9',
				recordClip: 'F8',
				copyLink: 'Alt+Shift+C',
				toggleHeat: 'Alt+Shift+A',
			},
		},

		// Replay settings only cover what the official replayer does not already offer. Anything it
		// has (saber colors, saber width, trail length, environment colors, lasers/floor/lights,
		// headset opacity, score HUD, slow-mo around mistakes, hitsound file, FPV camera) stays in
		// the replayer's own menus; BeatLeaderPlus builds on those features instead.
		camera: {
			mode: 'default', // camera on load: default (official) | orbit | follow | pov
			rememberMode: false,
			fov: 80, // A-Frame's default camera FOV, so the official view is unchanged until edited
			smoothing: 0.25,
			// Additions to the official free camera (WASD to move, X/C down/up, drag to look).
			free: {speed: 3.25, sprint: 3, pointerLock: false},
			// Additions to the official first-person camera (its FOV / offsets stay the replayer's own).
			fpv: {smoothing: 50, height: 0, side: 0, levelHorizon: false},
			orbit: {target: 'head', radius: 3, height: 1.8, speed: 10, startAngle: 30},
			follow: {target: 'head', offset: {x: 0, y: 0.4, z: 2.4}, relative: 'headYaw', lag: 0.35, lookAhead: 1.2},
			presets: BUILTIN_CAMERA_PRESETS.map(p => JSON.parse(JSON.stringify(p))),
			defaultPreset: '',
			path: {sampleRate: 20, timeBase: 'song', loop: false, smooth: true, autoPlayShared: true},
		},

		visuals: {
			sabers: {
				trailOverride: false,
				trailMatchSaber: true,
				leftTrailColor: '#ff2e63',
				rightTrailColor: '#2e9bff',
				trailWidth: 90,
				trailOpacity: 100,
				glowIntensity: 100,
				style: 'default', // default | neon | particle | custom
				customModel: {left: '', right: '', scale: 1, rotX: 0, rotY: 0, rotZ: 0, hideDefault: true, autoFit: true, unlit: true, tint: false},
				// Bloom on the glowing parts of custom models (strength and size in %).
				bloom: {enabled: false, strength: 100, size: 50},
			},
			notes: {
				override: false,
				left: '#ff2e63',
				right: '#2e9bff',
				chainOverride: false,
				chain: '#ffd166',
				arcOverride: false,
				arc: '#c77dff',
				size: 100, // notes, bombs and chains, %
				wallOpacity: 100,
			},
			// Brightness / contrast / saturation of the 3D view (also used for screenshots and clips).
			picture: {brightness: 100, contrast: 100, saturation: 100},
			effects: {
				missFlash: false,
				missColor: '#ff1744',
				badCutFlash: false,
				badCutColor: '#ff9100',
				bombFlash: false,
				bombColor: '#ffea00',
				flashIntensity: 35,
				markerStyle: 'none', // none | ring | cross | pillar
				markerLifetime: 1.5,
				hitParticles: false,
				particleColorMode: 'saber', // saber | custom | accuracy
				particleColor: '#ffffff',
				particleIntensity: 100,
			},
			visibility: {
				leftSaber: true,
				rightSaber: true,
				trails: true,
				notes: true,
				bombs: true,
				walls: true,
				arcs: true,
				chains: true,
			},
			accuracyHeat: {
				enabled: false,
				target: 'notes', // notes | particles | both
				c115: '#ffffff',
				c110: '#00e5ff',
				c105: '#00e676',
				c100: '#ffea00',
				low: '#ff9100',
				bad: '#ff1744',
			},
		},

		playback: {
			frameStepMode: 'replay', // replay (next recorded frame) | fixed
			frameStepMs: 16.7,
			persistSpeed: false,
			persistJd: false,
			reverseRate: 30,
			reverseSpeed: 1,
			loopPreRoll: 0,
			// Extends the replayer's own "Change speed around mistakes" with low-accuracy cuts.
			slowOnLowAcc: false,
			lowAccThreshold: 100,
			pauseOnMistakes: false,
			pauseOn: {miss: true, bad: true, bomb: true, wall: true},
			speedButtons: '0.5, 0.75, 1, 1.25',
			fpsLimit: 0, // frames drawn per second in the replayer, 0 = no limit
			bookmarksOnTimeline: true,
		},

		overlay: {
			ppInHud: true,
			lastCutInHud: false,
			// Size, height, color and parts of the replayer's 3D score HUD.
			hud: {
				scale: 100,
				height: 0,
				colorOverride: false,
				color: '#ffffff',
				show: {score: true, accuracy: true, combo: true, multiplier: true, misses: true, energy: true},
			},
			hideOfficial: {songInfo: false, playerInfo: false, socialCorners: false, playlist: false},
		},

		audio: {
			// Extra hitsounds for events the replayer is silent on; volume follows its hitsound slider.
			enabled: false,
			slots: {
				bad: {enabled: true, volume: 80, sound: 'builtin:buzz'},
				miss: {enabled: true, volume: 70, sound: 'builtin:thud'},
				bomb: {enabled: true, volume: 80, sound: 'builtin:boom'},
			},
		},

		export: {
			screenshot: {useWindowSize: false, width: 1920, height: 1080, format: 'png'},
			clip: {seconds: 10, fps: 60, width: 1280, height: 720, includeAudio: true, bitrateMbps: 8},
			link: {includeTime: true, includeSpeed: true, includeJd: true, includeCamera: true, includeColors: true},
		},

		site: {
			enabled: true,
			downloadButton: true,
			dockSize: 100, // BL+ dock button size, %; its position is kept per browser (KEYS.siteUi)
			compare: true,
			autoExpandDetails: false,
			quickFilters: true,
			highAccThreshold: 95,
			profileStats: true,
			extraBadges: false,
			myPlayerId: '',
			myClanTag: '',
		},

		popup: {
			quickToggles: [
				'general.enabled',
				'theme.enabled',
				'visuals.accuracyHeat.enabled',
				'visuals.effects.hitParticles',
				'overlay.ppInHud',
				'audio.enabled',
			],
			showReplayActions: true,
			compact: false,
			width: 360,
		},
	};

	/** Top-level sections persisted as individual sync items. */
	const SECTIONS = Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'schemaVersion');

	const KEYS = {
		meta: 'blp_meta',
		sectionPrefix: 'blp_s_',
		domainOverrides: 'blp_domain_overrides',
		runtime: 'blp_runtime',
		bookmarks: 'blp_bookmarks',
		cameraPaths: 'blp_camera_paths',
		hitsoundPack: 'blp_hitsound_pack',
		saberModels: 'blp_saber_models',
		siteUi: 'blp_site_ui',
	};


	BLP.defaults = {
		SCHEMA_VERSION,
		THEME_PRESETS,
		BUILTIN_CAMERA_PRESETS,
		DEFAULT_SETTINGS,
		SECTIONS,
		KEYS,
		/** Actions handled by the isolated-world hotkey module (everything else runs in the replay page). */
		GLOBAL_HOTKEY_ACTIONS: ['openOptions', 'toggleTheme', 'toggleOverlays', 'nextMap', 'prevMap'],
	};
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
