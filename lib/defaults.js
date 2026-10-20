/*
 * BeatLeaderPlus – default settings, presets and storage key constants.
 *
 * The settings object is split into top-level sections. Each section is persisted as its own
 * chrome.storage.sync item (see lib/storage.js) so we stay under the 8 KB per-item sync quota.
 * Large or high-churn data (camera paths, bookmarks, hitsound packs, favorites, follow state,
 * runtime values such as the last playback speed) lives in chrome.storage.local instead.
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.defaults) return;

	const SCHEMA_VERSION = 3;

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
			name: 'First Person Strict',
			builtin: true,
			hotkey: 'Shift+4',
			mode: 'pov',
		},
		{
			id: 'builtin_fp_smooth',
			name: 'First Person Smooth',
			builtin: true,
			hotkey: 'Shift+5',
			mode: 'fpvSmooth',
			fov: 75,
			fpv: {smoothing: 0.55, offsetY: 0.05, offsetZ: 0.15, lockRoll: true},
		},
		{
			id: 'builtin_orbit',
			name: 'Orbit Showcase',
			builtin: true,
			hotkey: 'Shift+6',
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
				// Replay viewer
				togglePanel: '`',
				toggleHud: 'T',
				cycleCamera: 'V',
				freeCamera: 'C',
				pathPlay: 'G',
				pathRecord: 'Shift+G',
				pathKeyframe: 'Alt+G',
				frameBack: '[',
				frameForward: ']',
				reverse: 'Z',
				loopCycle: 'X',
				loopClear: 'Shift+X',
				addBookmark: 'B',
				nextBookmark: 'Shift+B',
				speedUp: 'Alt+=',
				speedDown: 'Alt+-',
				speedReset: 'Alt+0',
				screenshot: 'F9',
				recordClip: 'F8',
				copyLink: 'Alt+Shift+C',
				toggleHeat: 'Alt+Shift+A',
			},
		},

		camera: {
			mode: 'default', // default | pov | free | orbit | follow | fpvSmooth | static | path
			rememberMode: false,
			fov: 80, // A-Frame's default camera FOV, so the official view is unchanged until edited
			applyFovToPov: false,
			smoothing: 0.25,
			free: {
				speed: 3,
				sprint: 3,
				sensitivity: 0.12,
				invertY: false,
				keys: {forward: 'W', back: 'S', left: 'A', right: 'D', up: 'E', down: 'Q'},
			},
			orbit: {target: 'head', radius: 3, height: 1.8, speed: 10, startAngle: 30},
			follow: {target: 'head', offset: {x: 0, y: 0.4, z: 2.4}, relative: 'headYaw', lag: 0.35, lookAhead: 1.2},
			fpv: {smoothing: 0.5, offsetY: 0, offsetZ: 0, lockRoll: true},
			presets: BUILTIN_CAMERA_PRESETS.map(p => JSON.parse(JSON.stringify(p))),
			defaultPreset: '',
			replaceOfficialUi: false,
			path: {sampleRate: 20, timeBase: 'song', loop: false, smooth: true, autoPlayShared: true},
		},

		visuals: {
			sabers: {
				override: false,
				leftColor: '#ff2e63',
				rightColor: '#2e9bff',
				trailOverride: false,
				trailMatchSaber: true,
				leftTrailColor: '#ff2e63',
				rightTrailColor: '#2e9bff',
				trailLength: 20,
				trailWidth: 90,
				trailOpacity: 100,
				glowIntensity: 100,
				style: 'default', // default | thin | thick | neon | particle | custom
				thickness: 100,
				customModel: {left: '', right: '', scale: 1, rotX: 0, rotY: 0, rotZ: 0, hideDefault: true},
			},
			notes: {
				override: false,
				left: '#ff2e63',
				right: '#2e9bff',
				bombOverride: false,
				bomb: '#2b2b2b',
				chainOverride: false,
				chain: '#ffd166',
				arcOverride: false,
				arc: '#c77dff',
			},
			environment: {
				override: false,
				background: '#000000',
				lightLeft: '#f01978',
				lightRight: '#2064a8',
				backglow: '#2851b8',
				walls: '#f01978',
			},
			effects: {
				missFlash: true,
				missColor: '#ff1744',
				badCutFlash: true,
				badCutColor: '#ff9100',
				bombFlash: false,
				bombColor: '#ffea00',
				flashIntensity: 35,
				markerStyle: 'none', // none | ring | cross | pillar
				markerLifetime: 1.5,
				slowMoBurst: false,
				slowMoSpeed: 0.3,
				slowMoDuration: 0.6,
				hitParticles: false,
				particleColorMode: 'saber', // saber | custom | accuracy
				particleColor: '#ffffff',
				particleIntensity: 100,
			},
			visibility: {
				headset: true,
				leftSaber: true,
				rightSaber: true,
				trails: true,
				notes: true,
				bombs: true,
				walls: true,
				arcs: true,
				chains: true,
				lasers: true,
				lighting: true,
				floor: true,
				environment: true,
				hud3d: true,
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
			speedStep: 0.05,
			wheelSpeed: true,
			wheelModifier: 'Alt',
			persistSpeed: true,
			persistJd: false,
			reverseRate: 30,
			reverseSpeed: 1,
			loopPreRoll: 0,
			autoSlowMo: {
				enabled: false,
				onMiss: true,
				onBadCut: true,
				onBomb: false,
				onLowAcc: false,
				lowAccThreshold: 100,
				speed: 0.25,
				before: 0.45,
				after: 0.5,
			},
			bookmarksOnTimeline: true,
			timelineGraph: true,
			timelineGraphOpacity: 70,
		},

		overlay: {
			enabled: true,
			position: 'top-left', // top-left | top-right | bottom-left | bottom-right | custom
			x: 16,
			y: 16,
			scale: 1,
			opacity: 92,
			style: 'glass', // glass | solid | minimal
			stats: {
				score: true,
				accuracy: true,
				fcAccuracy: true,
				combo: true,
				multiplier: false,
				misses: true,
				pp: true,
				lastCut: true,
				timeDeviation: true,
				saberSpeed: true,
				handAcc: true,
				energy: false,
				notes: true,
				time: false,
			},
			graph: {enabled: true, window: 20, height: 56, showCuts: true},
			swing: {enabled: true},
			hideOfficial: {
				controls: false,
				scoreHud: false,
				songInfo: false,
				playerInfo: false,
				cameraButtons: false,
				settingsButton: false,
				socialCorners: false,
				playlist: false,
			},
		},

		audio: {
			enabled: false,
			master: 80,
			muteOfficial: false,
			latencyMs: 0,
			slots: {
				good: {enabled: true, volume: 70, sound: 'builtin:click'},
				bad: {enabled: true, volume: 80, sound: 'builtin:buzz'},
				miss: {enabled: true, volume: 70, sound: 'builtin:thud'},
				bomb: {enabled: true, volume: 80, sound: 'builtin:boom'},
			},
		},

		export: {
			screenshot: {useWindowSize: false, width: 1920, height: 1080, includeOverlay: true, format: 'png'},
			clip: {seconds: 10, fps: 60, width: 1280, height: 720, includeOverlay: true, includeAudio: true, bitrateMbps: 8},
			link: {includeTime: true, includeSpeed: true, includeJd: true, includeCamera: true, includeColors: true, includeOverlay: false},
		},

		site: {
			enabled: true,
			downloadButton: true,
			enhancedReplayButton: true,
			enhancedReplay: {host: 'replay.beatleader.com', openPanel: true, cameraPreset: '', newTab: true},
			favorites: true,
			compare: true,
			autoExpandDetails: false,
			quickFilters: true,
			highAccThreshold: 95,
			profileStats: true,
			extraBadges: false,
			myPlayerId: '',
			myClanTag: '',
			follow: {enabled: true, intervalMinutes: 15, desktop: true, badge: true},
		},

		popup: {
			quickToggles: [
				'general.enabled',
				'theme.enabled',
				'overlay.enabled',
				'visuals.accuracyHeat.enabled',
				'playback.autoSlowMo.enabled',
				'audio.enabled',
				'visuals.effects.hitParticles',
				'site.favorites',
			],
			showReplayActions: true,
			showFavorites: true,
			showFollows: true,
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
		favorites: 'blp_favorites',
		follow: 'blp_follow_state',
	};

	const DEFAULT_FAVORITES = {players: {}, maps: {}};
	const DEFAULT_FOLLOW_STATE = {players: {}, newScores: [], lastCheck: 0};

	BLP.defaults = {
		SCHEMA_VERSION,
		THEME_PRESETS,
		BUILTIN_CAMERA_PRESETS,
		DEFAULT_SETTINGS,
		SECTIONS,
		KEYS,
		DEFAULT_FAVORITES,
		DEFAULT_FOLLOW_STATE,
		/** Actions handled by the isolated-world hotkey module (everything else runs in the replay page). */
		GLOBAL_HOTKEY_ACTIONS: ['openOptions', 'toggleTheme', 'toggleOverlays', 'nextMap', 'prevMap'],
	};
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
