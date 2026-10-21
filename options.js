/*
 * BeatLeaderPlus – options page.
 *
 * Rendered from lib/schema.js. Every change is saved immediately (debounced) to
 * chrome.storage, and every open BeatLeader tab applies it live through storage.onChanged.
 *
 * Scope: "Global" edits the global settings; selecting a domain edits that domain's override
 * set (only the differences to the global settings are stored – see lib/storage.js).
 *
 * Custom renderers (camera presets, paths, bookmarks, hitsounds, saber models, favorites,
 * follows, popup toggles, backup tools, previews) are defined in RENDERERS below.
 */
(function () {
	'use strict';

	const {utils: U, storage, defaults: D, i18n, schema, zip} = window.BLP;
	const t = (k, v) => i18n.t(k, v);
	const h = U.h;
	const $ = id => document.getElementById(id);

	const DOMAINS = ['beatleader.com', 'replay.beatleader.com', 'beatleader.xyz', 'replay.beatleader.xyz', 'beatleader.net', 'replay.beatleader.net'];
	const GLOBAL_ONLY_SECTIONS = ['general', 'library', 'popup', 'data'];
	const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|webm)$/i;
	const MODEL_EXT = /\.(glb|gltf|obj|saber)$/i;
	const MAX_SOUND_BYTES = 2 * 1024 * 1024;
	const MAX_MODEL_BYTES = 32 * 1024 * 1024;
	const BUILTIN_SOUNDS = ['builtin:click', 'builtin:tick', 'builtin:chime', 'builtin:buzz', 'builtin:thud', 'builtin:boom'];

	/** Shortcuts used by the official replayer (shown as a hint when a BLP binding replaces one). */
	const OFFICIAL_KEYS = {
		Space: 'play / pause',
		K: 'play / pause',
		J: 'seek back',
		L: 'seek forward',
		F: 'fullscreen',
		'Shift+F': 'POV camera',
		'Shift+Q': 'left camera',
		'Shift+R': 'center camera',
		'Shift+E': 'right camera',
		ArrowLeft: 'seek back',
		ArrowRight: 'seek forward',
		ArrowUp: 'volume up',
		ArrowDown: 'volume down',
		',': 'beat step back',
		'.': 'beat step forward',
		'-': 'speed down',
		'=': 'speed up',
		U: 'slow-mo on mistakes',
		O: 'loop replays',
		M: 'mute',
		H: 'hide controls',
		I: 'skip intro',
		'Shift+N': 'next replay',
		'Shift+P': 'previous replay',
		W: 'camera forward',
		A: 'camera left',
		S: 'camera back',
		D: 'camera right',
		X: 'camera down',
		C: 'camera up',
		F2: 'hotkey help',
	};

	const state = {
		global: null,
		overrides: {},
		scope: 'global',
		view: null,
		query: '',
		capturing: null,
		audioCtx: null,
		previewBuffers: new Map(),
	};

	/* ------------------------------------------------------------------ state & saving */

	function computeView() {
		state.view = state.scope === 'global' ? state.global : U.withDefaults(U.deepMerge(state.global, state.overrides[state.scope] || {}), D.DEFAULT_SETTINGS);
	}

	const get = path => U.getPath(state.view, path);

	function setStatus(kind) {
		const el = $('saveStatus');
		el.textContent = kind === 'saving' ? t('opt.saving') : kind === 'saved' ? '✓ ' + t('opt.saved') : '';
		el.style.color = kind === 'error' ? 'var(--bad)' : '';
		if (kind === 'saved') {
			clearTimeout(setStatus.timer);
			setStatus.timer = setTimeout(() => (el.textContent = ''), 1800);
		}
	}

	const saveGlobal = U.debounce(async () => {
		try {
			await storage.saveSettings(state.global);
			setStatus('saved');
		} catch (e) {
			setStatus('error');
			alert(String(e.message || e));
		}
	}, 250);

	const saveOverrides = U.debounce(async () => {
		await storage.saveDomainOverrides(state.overrides);
		setStatus('saved');
	}, 250);

	function set(path, value, opts = {}) {
		setStatus('saving');
		if (state.scope === 'global') {
			U.setPath(state.global, path, value);
			saveGlobal();
		} else {
			U.setPath(state.view, path, value);
			const d = U.diff(state.global, state.view);
			delete d.general;
			delete d.schemaVersion;
			if (Object.keys(d).length) state.overrides[state.scope] = d;
			else delete state.overrides[state.scope];
			saveOverrides();
		}
		afterChange(path);
		if (opts.rerender) rerenderSection(sectionOfPath(path));
	}

	function afterChange(path) {
		if (path === 'general.language') {
			i18n.setLocale(get('general.language'));
			return render();
		}
		updateDependents();
		if (path.startsWith('theme.')) updateThemePreview();
		if (path.startsWith('visuals.')) updateVisualsPreview();
		if (path.startsWith('hotkeys.') || path.startsWith('camera.presets')) updateHotkeyWarnings();
	}

	function sectionOfPath(path) {
		const f = schema.allFields().find(x => x.path === path);
		return f ? f.section : path.split('.')[0];
	}

	/* ------------------------------------------------------------------ field rendering */

	function label(f) {
		const key = schema.labelKey(f);
		const desc = i18n.has(schema.descKey(f)) ? t(schema.descKey(f)) : null;
		return h('div', null, h('span', {class: 'label'}, t(key)), desc ? h('span', {class: 'desc'}, desc) : null);
	}

	function optionLabel(o) {
		return typeof o.label === 'string' && i18n.has(o.label) ? t(o.label) : String(o.label);
	}

	function selectOptions(f) {
		if (f.optionsFrom === 'cameraPresets') {
			return [{value: '', label: t('common.none')}].concat((get('camera.presets') || []).map(p => ({value: p.id, label: p.name})));
		}
		return f.options.map(o => ({value: o.value, label: optionLabel(o)}));
	}

	function control(f) {
		const value = get(f.path);
		switch (f.type) {
			case 'toggle': {
				const input = h('input', {type: 'checkbox', checked: !!value, onchange: e => set(f.path, e.target.checked)});
				return h('label', {class: 'switch'}, input, h('span', {class: 'slider'}));
			}
			case 'color': {
				const text = h('input', {type: 'text', value: value || '', spellcheck: false});
				const picker = h('input', {type: 'color', value: U.isHexColor(value) ? value.slice(0, 7) : '#000000'});
				picker.addEventListener('input', () => {
					text.value = picker.value;
					set(f.path, picker.value);
					runHook(f);
				});
				text.addEventListener('change', () => {
					const v = text.value.trim();
					if (!U.isHexColor(v)) return (text.value = get(f.path));
					picker.value = v.slice(0, 7);
					set(f.path, v);
					runHook(f);
				});
				return h('div', {class: 'control color-control'}, picker, text);
			}
			case 'range': {
				const out = h('span', {class: 'range-value'}, fmtValue(value, f));
				const input = h('input', {
					type: 'range',
					min: f.min,
					max: f.max,
					step: f.step,
					value,
					oninput: e => {
						const v = Number(e.target.value);
						out.textContent = fmtValue(v, f);
						set(f.path, v);
					},
				});
				return h('div', {class: 'control'}, input, out);
			}
			case 'number': {
				const input = h('input', {
					type: 'number',
					min: f.min,
					max: f.max,
					step: f.step,
					value,
					onchange: e => {
						let v = Number(e.target.value);
						if (!isFinite(v)) v = U.getPath(D.DEFAULT_SETTINGS, f.path);
						v = U.clamp(v, f.min, f.max);
						e.target.value = v;
						set(f.path, v);
					},
				});
				return h('div', {class: 'control'}, input, f.unit ? h('span', {class: 'muted'}, f.unit) : null);
			}
			case 'select': {
				const opts = selectOptions(f);
				const sel = h(
					'select',
					{
						onchange: e => {
							const raw = e.target.value;
							const orig = opts.find(o => String(o.value) === raw);
							set(f.path, orig ? orig.value : raw);
							runHook(f);
						},
					},
					opts.map(o => h('option', {value: o.value}, o.label))
				);
				sel.value = String(value);
				return h('div', {class: 'control'}, sel);
			}
			case 'text': {
				const input = h('input', {type: 'text', value: value || '', placeholder: f.placeholder || '', spellcheck: false});
				input.addEventListener('input', U.debounce(() => set(f.path, input.value.trim()), 400));
				return h('div', {class: 'control'}, input);
			}
			case 'textarea':
			case 'code': {
				const ta = h('textarea', {class: f.type === 'code' ? 'code' : '', placeholder: f.placeholder || '', spellcheck: false});
				ta.value = value || '';
				ta.addEventListener('input', U.debounce(() => set(f.path, ta.value), 500));
				ta.addEventListener('keydown', e => {
					if (e.key === 'Tab' && f.type === 'code') {
						e.preventDefault();
						const s = ta.selectionStart;
						ta.setRangeText('\t', s, ta.selectionEnd, 'end');
						ta.dispatchEvent(new Event('input'));
					}
				});
				return ta;
			}
			case 'hotkey':
			case 'key': {
				const btn = h('button', {class: 'btn hotkey-btn', type: 'button'}, U.formatHotkey(value));
				btn.addEventListener('click', () => startCapture(f, btn));
				const clear = h('button', {class: 'btn small', type: 'button', title: t('opt.clearHotkey'), onclick: () => (set(f.path, ''), (btn.textContent = U.formatHotkey('')))}, '✕');
				return h('div', {class: 'control'}, btn, clear);
			}
			default:
				return h('span', null, String(value));
		}
	}

	function fmtValue(v, f) {
		const n = Number(v);
		const digits = f.step && f.step < 1 ? Math.min(3, String(f.step).split('.')[1].length) : 0;
		return n.toFixed(digits) + (f.unit ? ' ' + f.unit : '');
	}

	function runHook(f) {
		if (f.onChange === 'applyThemePreset') {
			const preset = get('theme.preset');
			if (D.THEME_PRESETS[preset]) {
				set('theme.colors', Object.assign({}, D.THEME_PRESETS[preset]));
				rerenderSection('theme');
			}
		} else if (f.onChange === 'markThemeCustom' && get('theme.preset') !== 'custom') {
			set('theme.preset', 'custom');
			const sel = document.querySelector('[data-path="theme.preset"] select');
			if (sel) sel.value = 'custom';
		}
	}

	function renderField(f, section) {
		if (f.type === 'heading') return h('h3', {class: 'subhead', dataset: {heading: f.id, search: t('h.' + f.id).toLowerCase()}}, t('h.' + f.id));
		if (f.type === 'custom') {
			const box = h('div', {class: 'custom', dataset: {renderer: f.renderer, search: (section.id + ' ' + f.renderer + ' ' + t('s.' + section.id)).toLowerCase()}});
			fillCustom(box, f.renderer);
			return box;
		}
		const row = h('div', {class: 'row' + (f.type === 'code' || f.type === 'textarea' ? ' wide' : ''), dataset: {path: f.path}}, label(f), control(f));
		row.dataset.search = (t(schema.labelKey(f)) + ' ' + (i18n.has(schema.descKey(f)) ? t(schema.descKey(f)) : '') + ' ' + f.path).toLowerCase();
		if (f.type === 'hotkey') row.appendChild(h('span', {class: 'warn hidden', dataset: {warnFor: f.path}}));
		if (f.when) row.dataset.when = f.when;
		if (state.scope !== 'global' && GLOBAL_ONLY_SECTIONS.includes(section.id)) row.classList.add('disabled');
		return row;
	}

	function renderSection(section) {
		const body = h('div', {class: 'section-body'});
		for (const f of section.fields) body.appendChild(renderField(f, section));
		const reset = h(
			'button',
			{
				class: 'btn small',
				type: 'button',
				onclick: () => {
					if (!confirm(t('opt.resetSectionConfirm', {section: t('s.' + section.id)}))) return;
					if (state.scope === 'global') {
						state.global[section.id] = U.deepClone(D.DEFAULT_SETTINGS[section.id]);
						saveGlobal();
					} else {
						const o = state.overrides[state.scope];
						if (o) delete o[section.id];
						saveOverrides();
					}
					computeView();
					rerenderSection(section.id);
					afterChange(section.id + '.');
				},
			},
			t('opt.resetSection')
		);
		const el = h(
			'section',
			{class: 'section', id: section.id, dataset: {section: section.id}},
			h('header', {class: 'section-head'}, h('div', null, h('h2', null, section.icon + ' ' + t('s.' + section.id)), h('p', {class: 'muted'}, t('sd.' + section.id))), D.DEFAULT_SETTINGS[section.id] ? reset : null),
			state.scope !== 'global' && GLOBAL_ONLY_SECTIONS.includes(section.id) ? h('p', {class: 'notice'}, t('opt.globalOnly')) : null,
			body
		);
		el.dataset.title = t('s.' + section.id).toLowerCase();
		return el;
	}

	function rerenderSection(id) {
		const section = schema.SECTIONS.find(s => s.id === id);
		const old = $(id);
		if (!section || !old) return;
		old.replaceWith(renderSection(section));
		updateDependents();
		updateHotkeyWarnings();
		updateThemePreview();
		updateVisualsPreview();
		applySearch();
	}

	function render() {
		computeView();
		i18n.localizeDom(document);
		const content = $('content');
		content.textContent = '';
		for (const section of schema.SECTIONS) content.appendChild(renderSection(section));
		renderNav();
		renderScope();
		updateDependents();
		updateHotkeyWarnings();
		updateThemePreview();
		updateVisualsPreview();
		applySearch();
	}

	function updateDependents() {
		document.querySelectorAll('.row[data-when]').forEach(row => row.classList.toggle('dim', !get(row.dataset.when)));
	}

	/* ------------------------------------------------------------------ nav, scope, search */

	function renderNav() {
		const nav = $('nav');
		nav.textContent = '';
		for (const s of schema.SECTIONS) {
			nav.appendChild(
				h(
					'a',
					{
						href: '#' + s.id,
						dataset: {section: s.id},
						onclick: e => {
							e.preventDefault();
							$(s.id).scrollIntoView({behavior: 'smooth', block: 'start'});
							history.replaceState(null, '', '#' + s.id);
						},
					},
					h('span', null, s.icon),
					t('s.' + s.id)
				)
			);
		}
		const io = new IntersectionObserver(
			entries => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.section === entry.target.id));
				}
			},
			{rootMargin: '-80px 0px -70% 0px'}
		);
		document.querySelectorAll('.section').forEach(s => io.observe(s));
	}

	function renderScope() {
		const sel = $('scope');
		sel.textContent = '';
		sel.appendChild(h('option', {value: 'global'}, t('opt.scopeGlobal')));
		for (const d of DOMAINS) sel.appendChild(h('option', {value: d, disabled: !state.global.general.perDomain}, t('opt.scopeDomain', {domain: d}) + (state.overrides[d] ? ' •' : '')));
		sel.value = state.scope;
		$('scopeHint').textContent = state.scope === 'global' ? (state.global.general.perDomain ? '' : t('opt.scopeDisabled')) : t('opt.scopeHint', {domain: state.scope});
	}

	function applySearch() {
		const q = state.query.trim().toLowerCase();
		let any = false;
		document.querySelectorAll('.section').forEach(section => {
			const titleMatch = q && section.dataset.title.includes(q);
			let visible = 0;
			section.querySelectorAll('.section-body > .row, .section-body > .custom').forEach(row => {
				const match = !q || titleMatch || (row.dataset.search || '').includes(q);
				row.classList.toggle('hidden', !match);
				if (match) visible++;
			});
			section.querySelectorAll('.subhead').forEach(hd => hd.classList.toggle('hidden', !!q && !titleMatch));
			const show = !q || visible > 0;
			section.classList.toggle('hidden', !show);
			const navLink = document.querySelector(`#nav a[data-section="${section.id}"]`);
			if (navLink) navLink.classList.toggle('dim', !show);
			if (show) any = true;
		});
		$('noResults').classList.toggle('hidden', any);
		$('noResults').textContent = any ? '' : t('opt.noResults', {q: state.query});
	}

	/* ------------------------------------------------------------------ hotkey capture */

	function startCapture(f, btn) {
		if (state.capturing) state.capturing.btn.classList.remove('capturing');
		state.capturing = {f, btn};
		btn.classList.add('capturing');
		btn.textContent = t('opt.pressKeys');
	}

	function stopCapture(value) {
		const c = state.capturing;
		if (!c) return;
		state.capturing = null;
		c.btn.classList.remove('capturing');
		if (value !== undefined) set(c.f.path, value);
		c.btn.textContent = U.formatHotkey(get(c.f.path));
	}

	window.addEventListener(
		'keydown',
		e => {
			if (!state.capturing) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Escape') return stopCapture();
			if (e.key === 'Backspace' || e.key === 'Delete') return stopCapture('');
			if (U.isModifierEvent(e)) return;
			if (state.capturing.f.type === 'key') return stopCapture(U.codeToToken(e.code, e.key).toUpperCase());
			stopCapture(U.eventToHotkey(e));
		},
		true
	);
	window.addEventListener('mousedown', e => state.capturing && !e.target.closest('.hotkey-btn') && stopCapture());

	function updateHotkeyWarnings() {
		const bindings = get('hotkeys.bindings') || {};
		const presets = get('camera.presets') || [];
		const owners = {};
		for (const [action, combo] of Object.entries(bindings)) {
			const k = U.normalizeHotkey(combo);
			if (k) (owners[k] = owners[k] || []).push(t('hk.' + action));
		}
		for (const p of presets) {
			const k = U.normalizeHotkey(p.hotkey);
			if (k) (owners[k] = owners[k] || []).push(p.name);
		}
		document.querySelectorAll('[data-warn-for]').forEach(el => {
			const action = el.dataset.warnFor.split('.').pop();
			const k = U.normalizeHotkey(bindings[action]);
			const msgs = [];
			if (k && owners[k] && owners[k].length > 1) msgs.push(t('opt.hotkeyConflict', {other: owners[k].filter(n => n !== t('hk.' + action)).join(', ')}));
			if (k && OFFICIAL_KEYS[k] && !D.GLOBAL_HOTKEY_ACTIONS.includes(action)) msgs.push(t('opt.hotkeyOfficial', {what: OFFICIAL_KEYS[k]}));
			el.textContent = msgs.join(' · ');
			el.classList.toggle('hidden', !msgs.length);
		});
	}

	/* ------------------------------------------------------------------ previews */

	function updateThemePreview() {
		const el = document.querySelector('.theme-preview');
		if (!el) return;
		const c = get('theme.colors');
		const vars = {
			'--tp-primary': c.primary,
			'--tp-bg': c.background,
			'--tp-surface': c.surface,
			'--tp-text': c.text,
			'--tp-muted': c.textMuted,
			'--tp-accent': c.accent,
			'--tp-link': c.link,
			'--tp-border': c.border,
			'--tp-on-primary': U.contrastText(c.primary),
			'--tp-radius': (Number(get('theme.radius')) || 0) + 'px',
			'--tp-size': (Number(get('theme.font.size')) || 100) / 100,
			'--tp-density': ((Number(get('theme.density')) || 100) / 100) * (get('theme.compact') ? 0.6 : 1),
		};
		for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
		el.style.fontFamily = get('theme.font.family') || '';
		el.style.fontWeight = Number(get('theme.font.weight')) || '';
		el.style.opacity = get('theme.enabled') ? 1 : 0.5;
		el.querySelectorAll('.tp-badge').forEach((b, i) => (b.style.background = [c.rank1, c.rank2, c.rank3][i] || c.border));
		el.querySelector('.tp-up').style.cssText = `background:${U.withAlpha(c.success, 0.18)};color:${c.success}`;
		el.querySelector('.tp-down').style.cssText = `background:${U.withAlpha(c.danger, 0.18)};color:${c.danger}`;
	}

	function themePreview(box) {
		const rows = [
			['#1', 'Pink Cute', '98.71%', '612.4pp'],
			['#2', 'Saber Wizard', '98.12%', '587.9pp'],
			['#3', 'Acc Champ', '97.88%', '574.0pp'],
			['#4', 'You', '96.40%', '501.2pp'],
		];
		box.appendChild(h('h3', null, t('opt.themePreviewTitle')));
		box.appendChild(
			h(
				'div',
				{class: 'theme-preview'},
				h('div', {class: 'tp-nav'}, h('span', {class: 'tp-logo'}, 'BeatLeader'), h('span', null, t('opt.previewLeaderboard')), h('span', null, 'Ranking'), h('span', null, 'Clans')),
				h(
					'div',
					{class: 'tp-card'},
					h('div', {class: 'tp-title'}, t('opt.previewLeaderboard') + ' · Example Song (Expert+)'),
					rows.map(r => h('div', {class: 'tp-row'}, h('span', {class: 'tp-badge'}, r[0]), h('span', null, r[1]), h('span', {class: 'tp-acc'}, r[2]), h('span', {class: 'tp-pp'}, r[3]))),
					h('div', {class: 'tp-foot'}, h('a', {class: 'tp-link', href: '#'}, 'Show more'), h('span', {class: 'tp-chip tp-up'}, '▲ 12'), h('span', {class: 'tp-chip tp-down'}, '▼ 3'), h('span', {class: 'tp-btn'}, 'Replay'))
				)
			)
		);
	}

	function updateVisualsPreview() {
		const box = document.querySelector('.visuals-preview');
		if (!box) return;
		const v = get('visuals');
		// Saber colours come from the replayer's own Colors settings; preview its defaults.
		const leftSaber = '#bf2121';
		const rightSaber = '#335aff';
		const leftNote = v.notes.override ? v.notes.left : leftSaber;
		const rightNote = v.notes.override ? v.notes.right : rightSaber;
		const trailL = v.sabers.trailOverride && !v.sabers.trailMatchSaber ? v.sabers.leftTrailColor : leftSaber;
		const trailR = v.sabers.trailOverride && !v.sabers.trailMatchSaber ? v.sabers.rightTrailColor : rightSaber;
		const trailOp = v.sabers.trailOverride ? U.clamp(v.sabers.trailOpacity / 100, 0, 1) * 0.6 : 0.45;
		const trailW = 16 * (v.sabers.trailOverride ? v.sabers.trailWidth || 90 : 90) / 100;
		const chain = v.notes.chainOverride ? v.notes.chain : leftNote;
		const arc = v.notes.arcOverride ? v.notes.arc : rightNote;
		const thick = {neon: 0.85, particle: 0.6}[v.sabers.style] || 1;
		const glow = (v.sabers.glowIntensity / 100) * (v.sabers.style === 'neon' ? 4 : 1);
		const heat = v.accuracyHeat.enabled;
		const noteFill = (base, score) => (heat ? (score >= 115 ? v.accuracyHeat.c115 : score >= 110 ? v.accuracyHeat.c110 : score >= 105 ? v.accuracyHeat.c105 : v.accuracyHeat.c100) : base);
		const vis = v.visibility;
		const core = color => (v.sabers.style === 'neon' ? U.mixColors(color, '#ffffff', 0.35) : '#ffffff');
		box.innerHTML = `
<svg viewBox="0 0 600 220" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${2 + glow * 3}"/></filter>
		<radialGradient id="bg" cx="50%" cy="20%" r="80%"><stop offset="0" stop-color="#2851b8" stop-opacity="0.55"/><stop offset="1" stop-color="#000000"/></radialGradient>
	</defs>
	<rect width="600" height="220" fill="url(#bg)"/>
	<line x1="40" y1="0" x2="150" y2="220" stroke="#f01978" stroke-width="3" opacity="0.8"/>
	<line x1="560" y1="0" x2="450" y2="220" stroke="#2064a8" stroke-width="3" opacity="0.8"/>
	${vis.walls ? '<rect x="470" y="70" width="40" height="110" fill="#f01978" opacity="0.35" stroke="#f01978"/>' : ''}
	${vis.arcs ? `<path d="M 230 60 Q 300 10 380 60" stroke="${arc}" stroke-width="5" fill="none" opacity="0.8"/>` : ''}
	${vis.notes ? `<rect x="200" y="70" width="44" height="44" rx="6" fill="${noteFill(leftNote, 115)}"/><path d="M 210 80 L 234 80 L 222 92 Z" fill="#fff"/>` : ''}
	${vis.notes ? `<rect x="356" y="70" width="44" height="44" rx="6" fill="${noteFill(rightNote, 108)}"/><path d="M 366 104 L 390 104 L 378 92 Z" fill="#fff"/>` : ''}
	${vis.bombs ? '<circle cx="300" cy="92" r="18" fill="#1a1a1a" stroke="#666"/>' : ''}
	${vis.chains ? `<rect x="262" y="130" width="22" height="12" rx="3" fill="${chain}"/><rect x="288" y="140" width="22" height="12" rx="3" fill="${chain}"/>` : ''}
	${vis.trails ? `<path d="M 120 210 Q 150 150 210 140" stroke="${trailL}" stroke-width="${trailW}" fill="none" opacity="${trailOp}" stroke-linecap="round"/>` : ''}
	${vis.trails ? `<path d="M 480 210 Q 450 150 390 140" stroke="${trailR}" stroke-width="${trailW}" fill="none" opacity="${trailOp}" stroke-linecap="round"/>` : ''}
	${vis.leftSaber ? `<line x1="160" y1="215" x2="230" y2="135" stroke="${leftSaber}" stroke-width="${8 * thick}" filter="url(#glow)" opacity="${Math.min(1, 0.3 + glow * 0.3)}"/><line x1="160" y1="215" x2="230" y2="135" stroke="${core(leftSaber)}" stroke-width="${3 * thick}"/>` : ''}
	${vis.rightSaber ? `<line x1="440" y1="215" x2="370" y2="135" stroke="${rightSaber}" stroke-width="${8 * thick}" filter="url(#glow)" opacity="${Math.min(1, 0.3 + glow * 0.3)}"/><line x1="440" y1="215" x2="370" y2="135" stroke="${core(rightSaber)}" stroke-width="${3 * thick}"/>` : ''}
</svg>`;
	}

	/* ------------------------------------------------------------------ audio preview helpers */

	function audioCtx() {
		if (!state.audioCtx) state.audioCtx = new AudioContext();
		return state.audioCtx;
	}

	function synth(ac, seconds, fn) {
		const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
		const buf = ac.createBuffer(1, len, ac.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = fn(i / ac.sampleRate, i / len);
		return buf;
	}

	function builtinBuffer(ac, id) {
		const TAU = Math.PI * 2;
		const noise = () => Math.random() * 2 - 1;
		let last = 0;
		const defs = {
			'builtin:click': [0.06, (s, p) => (noise() * 0.5 + Math.sin(TAU * 2400 * s) * 0.6) * Math.exp(-p * 9)],
			'builtin:tick': [0.03, (s, p) => Math.sin(TAU * 3800 * s) * Math.exp(-p * 7)],
			'builtin:chime': [0.35, (s, p) => (Math.sin(TAU * 1318.5 * s) * 0.5 + Math.sin(TAU * 1975.5 * s) * 0.35) * Math.exp(-p * 6)],
			'builtin:buzz': [0.16, (s, p) => (Math.sin(TAU * 140 * s) > 0 ? 0.55 : -0.55) * Math.exp(-p * 3)],
			'builtin:thud': [0.22, (s, p) => Math.sin(TAU * (110 - 70 * p) * s) * Math.exp(-p * 5)],
			'builtin:boom': [0.45, (s, p) => ((last = last * 0.92 + noise() * 0.08) * 3 + Math.sin(TAU * (70 - 40 * p) * s) * 0.6) * Math.exp(-p * 4)],
		};
		const d = defs[id];
		return d ? synth(ac, d[0], d[1]) : null;
	}

	async function previewSound(ref, volume = 80) {
		if (!ref || ref === 'none') return;
		const ac = audioCtx();
		await ac.resume();
		let buffer = state.previewBuffers.get(ref);
		if (!buffer) {
			if (ref.startsWith('builtin:')) buffer = builtinBuffer(ac, ref);
			else if (ref.startsWith('pack:')) {
				const pack = await storage.getLocal(D.KEYS.hitsoundPack, null);
				const s = pack && pack.sounds.find(x => 'pack:' + x.id === ref);
				if (s) buffer = await ac.decodeAudioData(U.base64ToBytes(s.b64).buffer);
			}
			if (buffer) state.previewBuffers.set(ref, buffer);
		}
		if (!buffer) return;
		const src = ac.createBufferSource();
		const gain = ac.createGain();
		gain.gain.value = U.clamp(volume / 100, 0, 1.5);
		src.buffer = buffer;
		src.connect(gain).connect(ac.destination);
		src.start();
	}

	/* ------------------------------------------------------------------ file helpers */

	function pickFiles({accept = '', multiple = false, directory = false} = {}) {
		return new Promise(resolve => {
			const input = h('input', {type: 'file', accept, multiple});
			if (directory) input.webkitdirectory = true;
			input.addEventListener('change', () => resolve(Array.from(input.files || [])));
			input.click();
		});
	}

	async function fileToB64(file) {
		return U.bytesToBase64(new Uint8Array(await file.arrayBuffer()));
	}

	function mimeFor(name) {
		const ext = (name.split('.').pop() || '').toLowerCase();
		return (
			{mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain'}[ext] ||
			'application/octet-stream'
		);
	}

	function downloadJson(data, filename) {
		U.downloadBlob(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}), filename);
	}

	const fmtBytes = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');

	/* ------------------------------------------------------------------ custom renderers */

	const RENDERERS = {
		themePreview,

		visualsPreview(box) {
			box.appendChild(h('h3', null, t('opt.visualsPreviewTitle')));
			box.appendChild(h('div', {class: 'visuals-preview'}));
		},

		cameraPresets(box) {
			const presets = get('camera.presets') || [];
			box.appendChild(h('h3', null, t('opt.presets')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.presetsHint')));
			const list = h('div', {class: 'list'});
			const update = next => set('camera.presets', next, {rerender: true});
			if (!presets.length) list.appendChild(h('p', {class: 'muted'}, t('opt.presetEmpty')));
			presets.forEach((p, i) => {
				const name = h('input', {type: 'text', class: 'name', value: p.name});
				name.addEventListener('change', () => {
					const next = U.deepClone(presets);
					next[i].name = name.value.trim() || p.name;
					set('camera.presets', next);
				});
				const mode = h(
					'select',
					{
						onchange: e => {
							const next = U.deepClone(presets);
							next[i].mode = e.target.value;
							set('camera.presets', next);
						},
					},
					['static', 'orbit', 'follow', 'pov'].map(m => h('option', {value: m}, t('cam.mode.' + m)))
				);
				mode.value = p.mode;
				const hk = h('button', {class: 'btn small hotkey-btn', type: 'button'}, U.formatHotkey(p.hotkey));
				hk.addEventListener('click', () => startCapture({type: 'hotkey', path: `camera.presets.${i}.hotkey`}, hk));
				list.appendChild(
					h(
						'div',
						{class: 'list-item'},
						name,
						mode,
						hk,
						h('span', {class: 'muted'}, p.fov ? p.fov + '°' : ''),
						h('button', {class: 'btn small danger', type: 'button', onclick: () => update(presets.filter((_, j) => j !== i))}, '✕')
					)
				);
			});
			box.appendChild(list);
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: () => {
								const ids = new Set(presets.map(p => p.id));
								update(presets.concat(D.BUILTIN_CAMERA_PRESETS.filter(p => !ids.has(p.id)).map(p => U.deepClone(p))));
							},
						},
						t('opt.presetRestore')
					)
				)
			);
		},

		async cameraPaths(box) {
			const paths = await storage.getLocal(D.KEYS.cameraPaths, []);
			box.appendChild(h('h3', null, t('opt.paths')));
			const list = h('div', {class: 'list'});
			if (!paths.length) list.appendChild(h('p', {class: 'muted'}, t('opt.pathsEmpty')));
			for (const p of paths) {
				const k = p.keyframes || [];
				const dur = k.length ? (k[k.length - 1][0] - k[0][0]).toFixed(1) : '0';
				list.appendChild(
					h(
						'div',
						{class: 'list-item'},
						h('span', {class: 'grow', title: p.name}, '🛤 ' + p.name),
						h('span', {class: 'muted'}, t('opt.pathKeyframes', {n: k.length, d: dur}) + ' · ' + t('cam.timeBase.' + (p.timeBase || 'song'))),
						h(
							'button',
							{
								class: 'btn small',
								type: 'button',
								onclick: async () => {
									const name = prompt(t('r.pathName'), p.name);
									if (!name) return;
									await storage.updateLocal(D.KEYS.cameraPaths, [], l => l.map(x => (x.id === p.id ? Object.assign(x, {name: name.slice(0, 80)}) : x)));
								},
							},
							'✎'
						),
						h('button', {class: 'btn small', type: 'button', onclick: () => downloadJson({format: 'beatleaderplus-camera-path', version: 1, path: p}, U.sanitizeFilename('BLP camera path - ' + p.name) + '.json')}, '⬇'),
						h('button', {class: 'btn small danger', type: 'button', onclick: () => storage.updateLocal(D.KEYS.cameraPaths, [], l => l.filter(x => x.id !== p.id))}, '✕')
					)
				);
			}
			box.appendChild(list);
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const [file] = await pickFiles({accept: '.json,application/json'});
								if (!file) return;
								try {
									const data = JSON.parse(await file.text());
									const raw = data.path || data;
									const keyframes = (raw.keyframes || raw.k || []).filter(kf => Array.isArray(kf) && kf.length >= 8 && kf.every(n => typeof n === 'number' && isFinite(n)));
									if (keyframes.length < 2) throw new Error(t('r.pathTooShort'));
									const path = {id: U.uid('path'), name: String(raw.name || raw.n || file.name).slice(0, 80), created: Date.now(), timeBase: (raw.timeBase || raw.tb) === 'real' ? 'real' : 'song', keyframes: keyframes.sort((a, b) => a[0] - b[0])};
									await storage.updateLocal(D.KEYS.cameraPaths, [], l => [path].concat(l));
								} catch (e) {
									alert(t('opt.importFail', {error: e.message}));
								}
							},
						},
						t('opt.importPath')
					)
				)
			);
		},

		async bookmarks(box) {
			const all = await storage.getLocal(D.KEYS.bookmarks, {});
			box.appendChild(h('h3', null, t('opt.bookmarks')));
			const list = h('div', {class: 'list'});
			const entries = Object.entries(all).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
			if (!entries.length) list.appendChild(h('p', {class: 'muted'}, t('opt.bookmarksEmpty')));
			for (const [key, entry] of entries) {
				const items = (entry.items || []).map(b => U.formatTime(b.t, false) + (b.note ? ' – ' + b.note : '')).join('\n');
				list.appendChild(
					h(
						'div',
						{class: 'list-item'},
						h('span', {class: 'grow', title: items}, '🔖 ' + (entry.title || key)),
						h('span', {class: 'muted'}, t('opt.bookmarksFor', {n: (entry.items || []).length})),
						entry.url || entry.scoreId
							? h('a', {class: 'btn small', href: entry.url || U.buildEnhancedReplayUrl({scoreId: entry.scoreId}, state.global), target: '_blank', rel: 'noopener'}, t('common.open'))
							: null,
						h(
							'button',
							{
								class: 'btn small danger',
								type: 'button',
								onclick: () =>
									storage.updateLocal(D.KEYS.bookmarks, {}, m => {
										delete m[key];
										return m;
									}),
							},
							'✕'
						)
					)
				);
			}
			box.appendChild(list);
		},

		async hitsoundSlots(box) {
			const pack = await storage.getLocal(D.KEYS.hitsoundPack, null);
			const sounds = [{value: 'none', label: t('opt.sound.none')}]
				.concat(BUILTIN_SOUNDS.map(id => ({value: id, label: t('opt.sound.' + id)})))
				.concat(pack && pack.sounds ? pack.sounds.map(s => ({value: 'pack:' + s.id, label: '📦 ' + s.name})) : []);
			box.appendChild(h('h3', null, t('opt.hitsoundSlots')));
			for (const slot of ['bad', 'miss', 'bomb']) {
				const base = 'audio.slots.' + slot;
				const cur = get(base);
				const enabled = h('label', {class: 'switch'}, h('input', {type: 'checkbox', checked: !!cur.enabled, onchange: e => set(base + '.enabled', e.target.checked)}), h('span', {class: 'slider'}));
				const sel = h('select', {class: 'input', onchange: e => set(base + '.sound', e.target.value)}, sounds.map(s => h('option', {value: s.value}, s.label)));
				sel.value = sounds.some(s => s.value === cur.sound) ? cur.sound : 'none';
				const vol = h('input', {type: 'range', min: 0, max: 150, step: 1, value: cur.volume, oninput: e => set(base + '.volume', Number(e.target.value))});
				box.appendChild(
					h(
						'div',
						{class: 'sound-row row'},
						h('span', {class: 'label'}, t('opt.slot.' + slot)),
						enabled,
						sel,
						vol,
						h('button', {class: 'btn small', type: 'button', onclick: () => previewSound(get(base + '.sound'), Number(get(base + '.volume')))}, '▶')
					)
				);
			}
		},

		async hitsoundPack(box) {
			const pack = await storage.getLocal(D.KEYS.hitsoundPack, null);
			box.appendChild(h('h3', null, t('opt.hitsoundPack') + (pack && pack.name ? ' · ' + pack.name : '')));
			const list = h('div', {class: 'list'});
			if (!pack || !pack.sounds || !pack.sounds.length) list.appendChild(h('p', {class: 'muted'}, t('opt.packEmpty')));
			else
				for (const s of pack.sounds) {
					list.appendChild(
						h(
							'div',
							{class: 'list-item'},
							h('span', {class: 'grow'}, '🔊 ' + s.name),
							h('span', {class: 'muted'}, fmtBytes(s.size || 0)),
							h('button', {class: 'btn small', type: 'button', onclick: () => previewSound('pack:' + s.id)}, '▶')
						)
					);
				}
			box.appendChild(list);
			const importFiles = async (files, name) => {
				const sounds = [];
				const skipped = [];
				for (const f of files) {
					if (!AUDIO_EXT.test(f.name)) continue;
					if (f.size > MAX_SOUND_BYTES) {
						skipped.push(f.name);
						continue;
					}
					sounds.push({id: U.uid('snd'), name: f.name.split('/').pop(), mime: f.type || mimeFor(f.name), size: f.size, b64: await fileToB64(f)});
				}
				await savePack(sounds, name, skipped);
			};
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const files = await pickFiles({directory: true});
								if (files.length) importFiles(files, (files[0].webkitRelativePath || '').split('/')[0] || 'Folder');
							},
						},
						t('opt.packImportFolder')
					),
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const files = await pickFiles({accept: 'audio/*,.ogg,.mp3,.wav', multiple: true});
								if (files.length) importFiles(files, 'Files');
							},
						},
						t('opt.packImportFiles')
					),
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const [file] = await pickFiles({accept: '.zip,application/zip'});
								if (!file) return;
								try {
									const entries = await zip.readZip(await file.arrayBuffer(), n => AUDIO_EXT.test(n));
									const skipped = [];
									const sounds = [];
									for (const e of entries) {
										if (e.data.length > MAX_SOUND_BYTES) {
											skipped.push(e.name);
											continue;
										}
										const name = e.name.split('/').pop();
										sounds.push({id: U.uid('snd'), name, mime: mimeFor(name), size: e.data.length, b64: U.bytesToBase64(e.data)});
									}
									await savePack(sounds, file.name.replace(/\.zip$/i, ''), skipped);
								} catch (err) {
									alert(t('opt.importFail', {error: err.message}));
								}
							},
						},
						t('opt.packImportZip')
					),
					pack
						? h(
								'button',
								{
									class: 'btn danger',
									type: 'button',
									onclick: async () => {
										await storage.removeLocal(D.KEYS.hitsoundPack);
										for (const slot of ['bad', 'miss', 'bomb']) {
											if (String(get('audio.slots.' + slot + '.sound')).startsWith('pack:')) set('audio.slots.' + slot + '.sound', D.DEFAULT_SETTINGS.audio.slots[slot].sound);
										}
										rerenderSection('audio');
									},
								},
								t('opt.packClear')
							)
						: null
				)
			);
		},

		async saberModels(box) {
			const models = await storage.getLocal(D.KEYS.saberModels, {});
			box.appendChild(h('h3', null, t('opt.saberModels')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.saberModelsHint')));
			const list = h('div', {class: 'list'});
			const names = Object.keys(models);
			if (!names.length) list.appendChild(h('p', {class: 'muted'}, t('opt.saberModelsEmpty')));
			for (const name of names) {
				const ref = 'stored:' + name;
				const use = hand => () => {
					set('visuals.sabers.customModel.' + hand, ref);
					set('visuals.sabers.style', 'custom', {rerender: true});
				};
				list.appendChild(
					h(
						'div',
						{class: 'list-item'},
						h('span', {class: 'grow'}, '🗡 ' + name),
						h('span', {class: 'muted'}, fmtBytes(models[name].size || 0)),
						h('button', {class: 'btn small', type: 'button', onclick: use('left')}, t('opt.useLeft')),
						h('button', {class: 'btn small', type: 'button', onclick: use('right')}, t('opt.useRight')),
						h(
							'button',
							{
								class: 'btn small danger',
								type: 'button',
								onclick: () =>
									storage.updateLocal(D.KEYS.saberModels, {}, m => {
										delete m[name];
										return m;
									}),
							},
							'✕'
						)
					)
				);
			}
			box.appendChild(list);
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const files = await pickFiles({accept: '.saber,.glb,.gltf,.obj', multiple: true});
								for (const f of files) {
									if (!MODEL_EXT.test(f.name)) continue;
									if (f.size > MAX_MODEL_BYTES) {
										alert(t('opt.packTooBig', {name: f.name}));
										continue;
									}
									const b64 = await fileToB64(f);
									await storage.updateLocal(D.KEYS.saberModels, {}, m => Object.assign(m, {[f.name]: {name: f.name, mime: mimeFor(f.name), size: f.size, b64, added: Date.now()}}));
								}
							},
						},
						t('opt.saberModelUpload')
					)
				)
			);
		},

		async favorites(box) {
			const fav = U.withDefaults(await storage.getLocal(D.KEYS.favorites, D.DEFAULT_FAVORITES), D.DEFAULT_FAVORITES);
			for (const kind of ['players', 'maps']) {
				box.appendChild(h('h3', null, t(kind === 'players' ? 'opt.favPlayers' : 'opt.favMaps')));
				const list = h('div', {class: 'list'});
				const entries = Object.values(fav[kind]).sort((a, b) => (b.added || 0) - (a.added || 0));
				if (!entries.length) list.appendChild(h('p', {class: 'muted'}, t('opt.favEmpty')));
				for (const f of entries) {
					const url = kind === 'players' ? 'https://beatleader.com/u/' + encodeURIComponent(f.id) : 'https://beatleader.com' + (f.url || '/leaderboard/global/' + encodeURIComponent(f.id));
					const note = h('input', {type: 'text', value: f.note || '', placeholder: t('common.notes')});
					note.addEventListener('change', () =>
						storage.updateLocal(D.KEYS.favorites, D.DEFAULT_FAVORITES, m => {
							if (m[kind][f.id]) m[kind][f.id].note = note.value.trim();
							return m;
						})
					);
					list.appendChild(
						h(
							'div',
							{class: 'list-item'},
							kind === 'players' && f.avatar ? h('img', {src: f.avatar, alt: ''}) : null,
							h('a', {class: 'grow', href: url, target: '_blank', rel: 'noopener'}, '★ ' + f.name),
							note,
							h(
								'button',
								{
									class: 'btn small danger',
									type: 'button',
									onclick: () =>
										storage.updateLocal(D.KEYS.favorites, D.DEFAULT_FAVORITES, m => {
											delete m[kind][f.id];
											return m;
										}),
								},
								'✕'
							)
						)
					);
				}
				box.appendChild(list);
			}
		},

		async followed(box) {
			const st = await storage.getLocal(D.KEYS.follow, D.DEFAULT_FOLLOW_STATE);
			const send = (type, payload) =>
				new Promise((resolve, reject) =>
					chrome.runtime.sendMessage(Object.assign({type}, payload || {}), r => (chrome.runtime.lastError || !r || !r.ok ? reject(new Error((r && r.error) || 'failed')) : resolve(r.data)))
				);
			box.appendChild(h('h3', null, t('opt.followed')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.followLast', {time: st.lastCheck ? new Date(st.lastCheck).toLocaleString() : '—'})));
			const list = h('div', {class: 'list'});
			const players = Object.values(st.players || {});
			if (!players.length) list.appendChild(h('p', {class: 'muted'}, t('opt.followedEmpty')));
			for (const p of players) {
				list.appendChild(
					h(
						'div',
						{class: 'list-item'},
						p.avatar ? h('img', {src: p.avatar, alt: ''}) : null,
						h('a', {class: 'grow', href: 'https://beatleader.com/u/' + encodeURIComponent(p.id), target: '_blank', rel: 'noopener'}, '🔔 ' + (p.name || p.id)),
						h('span', {class: 'muted'}, p.id),
						h('button', {class: 'btn small danger', type: 'button', onclick: () => send('unfollow', {playerId: p.id}).catch(e => alert(e.message))}, t('site.unfollow'))
					)
				);
			}
			box.appendChild(list);
			const input = h('input', {type: 'text', class: 'input', placeholder: '76561198…', style: {maxWidth: '260px'}});
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					input,
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const id = input.value.trim();
								if (!id) return;
								try {
									await send('follow', {playerId: id});
									input.value = '';
								} catch (e) {
									alert(e.message);
								}
							},
						},
						t('opt.followAdd')
					),
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async e => {
								e.target.disabled = true;
								await send('checkFollowsNow').catch(err => alert(err.message));
								e.target.disabled = false;
							},
						},
						t('opt.followCheck')
					)
				)
			);
			const recent = (st.newScores || []).slice(0, 10);
			if (recent.length) {
				box.appendChild(h('h3', null, t('popup.follows')));
				const rl = h('div', {class: 'list'});
				for (const s of recent) {
					rl.appendChild(
						h(
							'a',
							{class: 'list-item', href: U.buildEnhancedReplayUrl({scoreId: s.scoreId}, state.global), target: '_blank', rel: 'noopener'},
							h('span', {class: 'grow'}, s.playerName + ' · ' + s.song + (s.difficulty ? ' (' + s.difficulty + ')' : '')),
							h('span', {class: 'muted'}, s.accuracy != null ? (s.accuracy * 100).toFixed(2) + '%' : '')
						)
					);
				}
				box.appendChild(rl);
			}
		},

		popupToggles(box) {
			box.appendChild(h('h3', null, t('opt.popupToggles')));
			const selected = new Set(get('popup.quickToggles') || []);
			const grid = h('div', {class: 'toggle-grid'});
			let lastSection = null;
			for (const f of schema.toggleFields()) {
				if (f.path === 'general.enabled' || f.path.startsWith('popup.')) continue;
				if (f.section !== lastSection) {
					grid.appendChild(h('div', {class: 'group-title'}, t('s.' + f.section)));
					lastSection = f.section;
				}
				grid.appendChild(
					h(
						'label',
						{class: 'check'},
						h('input', {
							type: 'checkbox',
							checked: selected.has(f.path),
							onchange: e => {
								const cur = (get('popup.quickToggles') || []).filter(p => p !== f.path);
								if (e.target.checked) cur.push(f.path);
								set('popup.quickToggles', cur);
							},
						}),
						t(schema.labelKey(f))
					)
				);
			}
			box.appendChild(grid);
		},

		async dataTools(box) {
			const incHits = h('input', {type: 'checkbox'});
			const incModels = h('input', {type: 'checkbox'});
			box.appendChild(h('h3', null, t('opt.exportConfig')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.exportHint')));
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h('label', {class: 'check'}, incHits, t('opt.includeHitsounds')),
					h('label', {class: 'check'}, incModels, t('opt.includeModels')),
					h(
						'button',
						{
							class: 'btn primary',
							type: 'button',
							onclick: async () => {
								const data = await storage.exportAll({includeHitsounds: incHits.checked, includeModels: incModels.checked});
								downloadJson(data, 'beatleaderplus-config-' + new Date().toISOString().slice(0, 10) + '.json');
							},
						},
						'⬇ ' + t('common.export')
					)
				)
			);
			box.appendChild(h('h3', null, t('opt.importConfig')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.importHint')));
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							onclick: async () => {
								const [file] = await pickFiles({accept: '.json,application/json'});
								if (!file) return;
								try {
									await storage.importAll(await file.text());
									await load();
									render();
									alert(t('opt.importOk'));
								} catch (e) {
									alert(t('opt.importFail', {error: e.message}));
								}
							},
						},
						'⬆ ' + t('common.import')
					)
				)
			);
			box.appendChild(h('h3', null, t('opt.resetAll')));
			box.appendChild(h('p', {class: 'muted'}, t('opt.resetAllHint')));
			box.appendChild(
				h(
					'div',
					{class: 'actions-row'},
					h(
						'button',
						{
							class: 'btn danger',
							type: 'button',
							onclick: async () => {
								if (!confirm(t('opt.resetConfirm'))) return;
								await storage.resetSettings();
								state.scope = 'global';
								await load();
								render();
								alert(t('opt.resetDone'));
							},
						},
						t('opt.resetAll')
					)
				)
			);
			const usage = h('p', {class: 'muted'});
			box.appendChild(usage);
			try {
				const [sync, local] = await Promise.all([chrome.storage.sync.getBytesInUse(null), chrome.storage.local.getBytesInUse(null)]);
				usage.textContent = t('opt.storageUsage', {sync: fmtBytes(sync), local: fmtBytes(local)});
			} catch (e) {
				/* getBytesInUse unsupported */
			}
		},
	};

	async function savePack(sounds, name, skipped) {
		if (!sounds.length) {
			alert(t('opt.packEmpty'));
			return;
		}
		await storage.setLocal(D.KEYS.hitsoundPack, {name, imported: Date.now(), sounds});
		const guess = {good: /good|hit|cut|slice/i, bad: /bad|wrong/i, miss: /miss/i, bomb: /bomb|mine|explo/i};
		for (const slot of Object.keys(guess)) {
			const match = sounds.find(s => guess[slot].test(s.name));
			if (match) set('audio.slots.' + slot + '.sound', 'pack:' + match.id);
		}
		state.previewBuffers.clear();
		rerenderSection('audio');
		alert(t('opt.packImported', {n: sounds.length}) + ' ' + t('opt.packAutoAssigned') + (skipped.length ? '\n' + skipped.map(n => t('opt.packTooBig', {name: n})).join('\n') : ''));
	}

	function fillCustom(box, renderer) {
		const fn = RENDERERS[renderer];
		if (!fn) return;
		Promise.resolve(fn(box)).then(() => {
			if (renderer === 'themePreview') updateThemePreview();
			if (renderer === 'visualsPreview') updateVisualsPreview();
			if (state.query) applySearch();
		});
	}

	function rerenderCustom(renderer) {
		document.querySelectorAll(`.custom[data-renderer="${renderer}"]`).forEach(box => {
			box.textContent = '';
			fillCustom(box, renderer);
		});
	}

	/* ------------------------------------------------------------------ boot */

	async function load() {
		state.global = await storage.loadSettings();
		state.overrides = await storage.loadDomainOverrides();
		if (!state.global.general.perDomain) state.scope = 'global';
		i18n.setLocale(state.global.general.language);
		computeView();
	}

	function isEditing() {
		const a = document.activeElement;
		return !!(a && a !== document.body && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) || !!state.capturing;
	}

	async function init() {
		await load();
		$('version').textContent = 'v' + chrome.runtime.getManifest().version;
		render();

		$('search').addEventListener('input', e => {
			state.query = e.target.value;
			applySearch();
		});
		$('scope').addEventListener('change', e => {
			state.scope = e.target.value;
			render();
		});

		// Changes made elsewhere (popup, replay panel, another options tab).
		storage.onSettingsChanged(async () => {
			const fresh = await storage.loadSettings();
			const overrides = await storage.loadDomainOverrides();
			if (JSON.stringify(fresh) === JSON.stringify(state.global) && JSON.stringify(overrides) === JSON.stringify(state.overrides)) return;
			state.global = fresh;
			state.overrides = overrides;
			computeView();
			if (!isEditing()) render();
		}, 300);
		storage.onLocalChanged(D.KEYS.cameraPaths, () => rerenderCustom('cameraPaths'));
		storage.onLocalChanged(D.KEYS.bookmarks, () => rerenderCustom('bookmarks'));
		storage.onLocalChanged(D.KEYS.favorites, () => rerenderCustom('favorites'));
		storage.onLocalChanged(D.KEYS.follow, () => rerenderCustom('followed'));
		storage.onLocalChanged(D.KEYS.saberModels, () => rerenderCustom('saberModels'));
		storage.onLocalChanged(D.KEYS.hitsoundPack, () => {
			rerenderCustom('hitsoundPack');
			rerenderCustom('hitsoundSlots');
		});

		const hash = decodeURIComponent(location.hash.slice(1));
		if (hash && $(hash)) setTimeout(() => $(hash).scrollIntoView({block: 'start'}), 50);
	}

	init().catch(err => {
		console.error(err);
		document.body.appendChild(h('pre', {style: {color: 'var(--bad)', padding: '20px'}}, String(err.stack || err)));
	});
})();
