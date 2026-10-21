/*
 * BeatLeaderPlus – shared utilities.
 *
 * This file is intentionally free of any chrome.* API usage so it can be loaded in every
 * JavaScript context the extension touches:
 *   - the background service worker (importScripts)
 *   - content scripts (isolated world, via manifest)
 *   - extension pages (popup / options, via <script>)
 *   - the replay page itself (page/MAIN world, injected as a web_accessible_resource)
 *
 * Everything is attached to the `BLP.utils` namespace on the global object.
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.utils) return;

	const utils = {};

	/* ------------------------------------------------------------------ objects */

	utils.isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

	utils.deepClone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

	/**
	 * Deep merge plain objects into a new object. Arrays and primitives from later sources
	 * replace earlier values. `undefined` values in sources are ignored.
	 */
	utils.deepMerge = function deepMerge(...sources) {
		const out = {};
		for (const src of sources) {
			if (!utils.isObject(src)) continue;
			for (const key of Object.keys(src)) {
				const value = src[key];
				if (value === undefined) continue;
				if (utils.isObject(value) && utils.isObject(out[key])) {
					out[key] = deepMerge(out[key], value);
				} else if (utils.isObject(value)) {
					out[key] = deepMerge(value);
				} else if (Array.isArray(value)) {
					out[key] = utils.deepClone(value);
				} else {
					out[key] = value;
				}
			}
		}
		return out;
	};

	/**
	 * Fill missing keys of `target` from `defaults` (recursively). Keys present in target are kept
	 * even if they don't exist in defaults, so user data (e.g. preset lists) survives upgrades.
	 */
	utils.withDefaults = function withDefaults(target, defaults) {
		if (!utils.isObject(defaults)) return target === undefined ? utils.deepClone(defaults) : target;
		const out = utils.isObject(target) ? Object.assign({}, target) : {};
		for (const key of Object.keys(defaults)) {
			if (out[key] === undefined) {
				out[key] = utils.deepClone(defaults[key]);
			} else if (utils.isObject(defaults[key])) {
				out[key] = withDefaults(out[key], defaults[key]);
			}
		}
		return out;
	};

	/** Minimal structural diff: returns the parts of `obj` that differ from `base`. */
	utils.diff = function diff(base, obj) {
		if (!utils.isObject(obj)) return obj;
		const out = {};
		for (const key of Object.keys(obj)) {
			const a = base ? base[key] : undefined;
			const b = obj[key];
			if (utils.isObject(b) && utils.isObject(a)) {
				const d = diff(a, b);
				if (Object.keys(d).length) out[key] = d;
			} else if (JSON.stringify(a) !== JSON.stringify(b)) {
				out[key] = utils.deepClone(b);
			}
		}
		return out;
	};

	utils.getPath = function (obj, path, fallback) {
		const parts = String(path).split('.');
		let cur = obj;
		for (const p of parts) {
			if (cur == null) return fallback;
			cur = cur[p];
		}
		return cur === undefined ? fallback : cur;
	};

	utils.setPath = function (obj, path, value) {
		const parts = String(path).split('.');
		let cur = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			// Arrays are valid containers too (e.g. "camera.presets.2.hotkey").
			if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
			cur = cur[parts[i]];
		}
		cur[parts[parts.length - 1]] = value;
		return obj;
	};

	/** Build a nested object containing only `path` = value (useful for partial patches). */
	utils.pathPatch = (path, value) => utils.setPath({}, path, value);

	/* ------------------------------------------------------------------ functions */

	utils.debounce = function (fn, ms) {
		let timer = null;
		const wrapped = function (...args) {
			clearTimeout(timer);
			timer = setTimeout(() => fn.apply(this, args), ms);
		};
		wrapped.flush = function (...args) {
			clearTimeout(timer);
			fn.apply(this, args);
		};
		wrapped.cancel = () => clearTimeout(timer);
		return wrapped;
	};

	utils.throttle = function (fn, ms) {
		let last = 0;
		let timer = null;
		return function (...args) {
			const now = Date.now();
			const remaining = ms - (now - last);
			if (remaining <= 0) {
				last = now;
				fn.apply(this, args);
			} else if (!timer) {
				timer = setTimeout(() => {
					timer = null;
					last = Date.now();
					fn.apply(this, args);
				}, remaining);
			}
		};
	};

	utils.sleep = ms => new Promise(r => setTimeout(r, ms));

	/* ------------------------------------------------------------------ math */

	utils.clamp = (v, min, max) => Math.min(max, Math.max(min, v));
	utils.lerp = (a, b, t) => a + (b - a) * t;
	utils.round = (v, digits = 3) => {
		const m = Math.pow(10, digits);
		return Math.round(v * m) / m;
	};
	/** Frame-rate independent smoothing factor. strength 0 => instant, 1 => very slow. */
	utils.smoothFactor = (strength, dtSeconds) => {
		if (!strength || strength <= 0) return 1;
		const tau = 0.02 + Math.pow(utils.clamp(strength, 0, 1), 1.6) * 1.2;
		return 1 - Math.exp(-dtSeconds / tau);
	};

	utils.uid = (prefix = 'id') => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

	/* ------------------------------------------------------------------ logging */

	/**
	 * Create a namespaced logger. `isEnabled` is evaluated on each call so debug logging can be
	 * toggled at runtime from the options page.
	 */
	utils.createLogger = function (prefix, isEnabled) {
		const enabled = () => {
			try {
				return typeof isEnabled === 'function' ? !!isEnabled() : !!isEnabled;
			} catch (e) {
				return false;
			}
		};
		const style = 'color:#ff3d9a;font-weight:bold';
		return {
			debug: (...a) => enabled() && console.debug('%c' + prefix, style, ...a),
			info: (...a) => enabled() && console.info('%c' + prefix, style, ...a),
			warn: (...a) => console.warn('%c' + prefix, style, ...a),
			error: (...a) => console.error('%c' + prefix, style, ...a),
		};
	};

	/* ------------------------------------------------------------------ hotkeys */

	const CODE_TO_TOKEN = {
		Backquote: '`',
		Minus: '-',
		Equal: '=',
		BracketLeft: '[',
		BracketRight: ']',
		Backslash: '\\',
		Semicolon: ';',
		Quote: "'",
		Comma: ',',
		Period: '.',
		Slash: '/',
		Space: 'Space',
		IntlBackslash: '\\',
	};
	const MODIFIER_CODES = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'];
	const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

	utils.codeToToken = function (code, key) {
		if (!code) return key && key.length === 1 ? key.toUpperCase() : key || '';
		if (code.startsWith('Key')) return code.slice(3).toUpperCase();
		if (code.startsWith('Digit')) return code.slice(5);
		if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
		if (CODE_TO_TOKEN[code]) return CODE_TO_TOKEN[code];
		return code;
	};

	utils.isModifierEvent = e => MODIFIER_CODES.includes(e.code) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key);

	/** Convert a KeyboardEvent into a canonical hotkey string such as "Ctrl+Shift+Z". */
	utils.eventToHotkey = function (e) {
		const parts = [];
		if (e.ctrlKey) parts.push('Ctrl');
		if (e.altKey) parts.push('Alt');
		if (e.shiftKey) parts.push('Shift');
		if (e.metaKey) parts.push('Meta');
		if (!utils.isModifierEvent(e)) parts.push(utils.codeToToken(e.code, e.key));
		return parts.join('+');
	};

	/** Normalise user-entered hotkey strings ("shift + z" -> "Shift+Z"). */
	utils.normalizeHotkey = function (str) {
		if (!str || typeof str !== 'string') return '';
		const raw = str.trim();
		if (!raw) return '';
		// Allow a literal "+" or "=" as the main key, e.g. "Alt++".
		const tokens = raw.split('+').map(s => s.trim());
		let main = tokens.pop();
		if (main === '' && tokens.length && tokens[tokens.length - 1] === '') {
			tokens.pop();
			main = '=';
		}
		const mods = new Set();
		for (const t of tokens) {
			const l = t.toLowerCase();
			if (l === 'ctrl' || l === 'control' || l === 'cmdorctrl') mods.add('Ctrl');
			else if (l === 'alt' || l === 'option') mods.add('Alt');
			else if (l === 'shift') mods.add('Shift');
			else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'win') mods.add('Meta');
		}
		if (main.length === 1) main = main.toUpperCase();
		else {
			const aliases = {space: 'Space', esc: 'Escape', escape: 'Escape', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown'};
			const l = main.toLowerCase();
			if (aliases[l]) main = aliases[l];
			else if (/^f\d{1,2}$/i.test(main)) main = main.toUpperCase();
			else if (/^arrow/i.test(main)) main = 'Arrow' + main.slice(5, 6).toUpperCase() + main.slice(6).toLowerCase();
			else if (/^num/i.test(main)) main = 'Num' + main.slice(3);
			else main = main.charAt(0).toUpperCase() + main.slice(1);
		}
		const parts = MOD_ORDER.filter(m => mods.has(m));
		if (['Shift', 'Ctrl', 'Alt', 'Meta'].includes(main)) return parts.join('+') || main;
		parts.push(main);
		return parts.join('+');
	};

	utils.hotkeyMatches = function (e, binding) {
		if (!binding) return false;
		return utils.eventToHotkey(e) === utils.normalizeHotkey(binding);
	};

	utils.formatHotkey = str => (str ? utils.normalizeHotkey(str).replace(/\+/g, ' + ') : '—');

	/** True when the user is typing into a field and hotkeys should be ignored. */
	utils.isTypingTarget = function (el) {
		if (!el) return false;
		if (el.isContentEditable) return true;
		const tag = (el.tagName || '').toLowerCase();
		if (tag === 'textarea' || tag === 'select') return true;
		if (tag === 'input') {
			const type = (el.type || 'text').toLowerCase();
			return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(type);
		}
		return false;
	};

	/* ------------------------------------------------------------------ colors */

	utils.hexToRgb = function (hex) {
		if (!hex || typeof hex !== 'string') return {r: 0, g: 0, b: 0};
		let h = hex.trim().replace('#', '');
		if (h.length === 3) h = h.split('').map(c => c + c).join('');
		if (h.length === 8) h = h.slice(0, 6);
		const n = parseInt(h, 16);
		if (isNaN(n)) return {r: 0, g: 0, b: 0};
		return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
	};

	utils.rgbToHex = ({r, g, b}) =>
		'#' + [r, g, b].map(v => utils.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

	utils.mixColors = function (a, b, t) {
		const ca = utils.hexToRgb(a);
		const cb = utils.hexToRgb(b);
		return utils.rgbToHex({r: utils.lerp(ca.r, cb.r, t), g: utils.lerp(ca.g, cb.g, t), b: utils.lerp(ca.b, cb.b, t)});
	};

	utils.withAlpha = function (hex, alpha) {
		const c = utils.hexToRgb(hex);
		return `rgba(${c.r}, ${c.g}, ${c.b}, ${utils.clamp(alpha, 0, 1)})`;
	};

	utils.luminance = function (hex) {
		const c = utils.hexToRgb(hex);
		const f = v => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};

	utils.contrastText = hex => (utils.luminance(hex) > 0.45 ? '#111111' : '#ffffff');

	utils.isHexColor = v => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());

	/* ------------------------------------------------------------------ encoding */

	utils.bytesToBase64 = function (bytes) {
		let binary = '';
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	};

	utils.base64ToBytes = function (b64) {
		const binary = atob(b64);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	};

	utils.base64UrlEncode = function (input) {
		const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
		return utils.bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	};

	utils.base64UrlDecodeBytes = function (str) {
		let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4) b64 += '=';
		return utils.base64ToBytes(b64);
	};

	utils.base64UrlDecode = str => new TextDecoder().decode(utils.base64UrlDecodeBytes(str));

	async function streamThrough(bytes, stream) {
		const blob = new Blob([bytes]);
		const out = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
		return new Uint8Array(out);
	}

	/** Compress a string with deflate-raw and return URL-safe base64 ("z" prefix marks compression). */
	utils.packForUrl = async function (str) {
		try {
			if (typeof CompressionStream === 'function') {
				const bytes = await streamThrough(new TextEncoder().encode(str), new CompressionStream('deflate-raw'));
				return 'z' + utils.base64UrlEncode(bytes);
			}
		} catch (e) {
			/* fall through to uncompressed */
		}
		return 'p' + utils.base64UrlEncode(str);
	};

	utils.unpackFromUrl = async function (packed) {
		if (!packed) return '';
		const kind = packed.charAt(0);
		const body = packed.slice(1);
		if (kind === 'z') {
			const bytes = await streamThrough(utils.base64UrlDecodeBytes(body), new DecompressionStream('deflate-raw'));
			return new TextDecoder().decode(bytes);
		}
		if (kind === 'p') return utils.base64UrlDecode(body);
		return utils.base64UrlDecode(packed);
	};

	/* ------------------------------------------------------------------ formatting */

	utils.formatTime = function (sec, withMs = true) {
		if (!isFinite(sec)) return '0:00';
		const neg = sec < 0;
		sec = Math.abs(sec);
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		const ms = Math.floor((sec % 1) * 1000);
		return (neg ? '-' : '') + m + ':' + String(s).padStart(2, '0') + (withMs ? '.' + String(ms).padStart(3, '0') : '');
	};

	utils.formatNumber = (n, digits = 0) =>
		isFinite(n) ? Number(n).toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits}) : '—';

	utils.escapeHtml = s =>
		String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

	utils.sanitizeFilename = s => String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);

	/* ------------------------------------------------------------------ BeatLeader helpers */

	utils.REPLAY_HOST_RE = /^replay\.beatleader\.(com|xyz|net)$/i;
	utils.SITE_HOST_RE = /^(www\.)?beatleader\.(com|xyz|net)$/i;

	/** Parse a replay viewer URL. Returns {scoreId, link, host} or null. */
	utils.parseReplayUrl = function (href) {
		try {
			const u = new URL(href, typeof location !== 'undefined' ? location.href : undefined);
			if (!utils.REPLAY_HOST_RE.test(u.hostname)) return null;
			const scoreId = u.searchParams.get('scoreId');
			const link = u.searchParams.get('link');
			if (!scoreId && !link) return null;
			return {scoreId: scoreId || null, link: link || null, host: u.hostname, url: u};
		} catch (e) {
			return null;
		}
	};

	/** Domain key used for per-domain settings. */
	utils.domainKey = host => String(host || '').toLowerCase().replace(/^www\./, '');

	utils.API_BASE = 'https://api.beatleader.com';

	/** Link to a replay in the official replayer (BeatLeaderPlus extends it wherever it is opened). */
	utils.replayUrl = function ({scoreId, link}) {
		const u = new URL('https://replay.beatleader.com/');
		if (scoreId) u.searchParams.set('scoreId', scoreId);
		else if (link) u.searchParams.set('link', link);
		return u.toString();
	};

	/**
	 * BeatLeader PP estimate (modern ranking system: pass/acc/tech ratings).
	 * This mirrors the public formula used by the BeatLeader server; modifiers are ignored,
	 * so the value is labelled as an estimate in the UI.
	 */
	const PP_CURVE = [
		[1.0, 7.424],
		[0.999, 6.241],
		[0.9975, 5.158],
		[0.995, 4.01],
		[0.9925, 3.241],
		[0.99, 2.7],
		[0.9875, 2.303],
		[0.985, 2.007],
		[0.9825, 1.786],
		[0.98, 1.618],
		[0.9775, 1.49],
		[0.975, 1.392],
		[0.9725, 1.315],
		[0.97, 1.256],
		[0.965, 1.167],
		[0.96, 1.094],
		[0.955, 1.039],
		[0.95, 1.0],
		[0.94, 0.931],
		[0.93, 0.867],
		[0.92, 0.813],
		[0.91, 0.768],
		[0.9, 0.729],
		[0.875, 0.65],
		[0.85, 0.581],
		[0.825, 0.522],
		[0.8, 0.473],
		[0.75, 0.404],
		[0.7, 0.345],
		[0.65, 0.296],
		[0.6, 0.256],
		[0.0, 0.0],
	];

	function ppCurve(acc) {
		let i = 0;
		for (; i < PP_CURVE.length; i++) if (PP_CURVE[i][0] <= acc) break;
		if (i === 0) i = 1;
		if (i >= PP_CURVE.length) return 0;
		const [x1, y1] = PP_CURVE[i - 1];
		const [x2, y2] = PP_CURVE[i];
		const t = (acc - x2) / (x1 - x2);
		return utils.lerp(y2, y1, t);
	}

	utils.estimatePP = function (accuracy01, ratings) {
		if (!ratings || !(ratings.accRating > 0) || !isFinite(accuracy01)) return null;
		const acc = utils.clamp(accuracy01, 0, 1);
		let passPP = 15.2 * Math.exp(Math.pow(ratings.passRating || 0, 1 / 2.62)) - 30;
		if (!isFinite(passPP) || passPP < 0) passPP = 0;
		const accPP = ppCurve(acc) * ratings.accRating * 34;
		const techPP = Math.exp(1.9 * acc) * 1.08 * (ratings.techRating || 0);
		const sum = passPP + accPP + techPP;
		return (650 * Math.pow(sum, 1.3)) / Math.pow(650, 1.3);
	};

	/* ------------------------------------------------------------------ DOM helper */

	/**
	 * Tiny hyperscript helper: h('div', {class: 'x', onclick: fn}, 'text', child).
	 * Works in any document (content script, page, extension page).
	 */
	utils.h = function h(tag, props, ...children) {
		const el = document.createElement(tag);
		if (props) {
			for (const key of Object.keys(props)) {
				const v = props[key];
				if (v === undefined || v === null || v === false) continue;
				if (key === 'class' || key === 'className') el.className = v;
				else if (key === 'style' && typeof v === 'object') Object.assign(el.style, v);
				else if (key === 'dataset') Object.assign(el.dataset, v);
				else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2), v);
				else if (key === 'text') el.textContent = v;
				else if (key === 'html') el.innerHTML = v;
				else if (key in el && typeof v !== 'string') el[key] = v;
				else el.setAttribute(key, v === true ? '' : v);
			}
		}
		for (const child of children.flat(Infinity)) {
			if (child === null || child === undefined || child === false) continue;
			el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return el;
	};

	/** Trigger a browser download of a Blob or data URL from the current document. */
	utils.downloadBlob = function (blobOrUrl, filename) {
		const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.style.display = 'none';
		(document.body || document.documentElement).appendChild(a);
		a.click();
		setTimeout(() => {
			a.remove();
			if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
		}, 4000);
	};

	utils.copyText = async function (text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (e) {
			try {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand('copy');
				ta.remove();
				return ok;
			} catch (err) {
				return false;
			}
		}
	};

	BLP.utils = utils;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
