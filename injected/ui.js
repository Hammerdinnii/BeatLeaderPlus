/*
 * BeatLeaderPlus – replay page UI toolkit (PAGE world).
 *
 *   BLPR.ui.toast(text)                       transient message
 *   BLPR.ui.makeDraggable(el, handle, onEnd)  drag a fixed-position element
 *   BLPR.ui.toggle/slider/color/select/button small form controls used by panel tabs
 *   BLPR.ui.addTab({id, icon, title, order, render(body)})
 *   BLPR.ui.openPanel(tab) / closePanel() / togglePanel() / refreshPanel()
 *   BLPR.ui.applyOfficialVisibility()         hide parts of the official replayer UI
 *
 * Styling lives in styles/replay-ui.css (injected by the manifest as a content-script CSS file,
 * so it applies to these page-created elements as well).
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.ui) return;
	const U = window.BLP.utils;
	const h = U.h;
	const t = (k, v) => R.t(k, v);

	const ui = (R.ui = {h});

	/* ------------------------------------------------------------------ toast & flash */

	ui.toast = function (text, kind = 'info') {
		let box = document.getElementById('blp-r-toasts');
		if (!box) {
			box = h('div', {id: 'blp-r-toasts', class: 'blp-r-toasts'});
			document.body.appendChild(box);
		}
		const el = h('div', {class: 'blp-r-toast blp-r-toast-' + kind}, text);
		box.appendChild(el);
		setTimeout(() => el.classList.add('blp-r-out'), 2400);
		setTimeout(() => el.remove(), 2900);
	};

	/* ------------------------------------------------------------------ drag */

	ui.makeDraggable = function (el, handle, onEnd) {
		let start = null;
		const down = e => {
			if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) return;
			const rect = el.getBoundingClientRect();
			start = {x: e.clientX, y: e.clientY, left: rect.left, top: rect.top};
			el.classList.add('blp-r-dragging');
			handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
			e.preventDefault();
			e.stopPropagation();
		};
		const move = e => {
			if (!start) return;
			const x = U.clamp(start.left + e.clientX - start.x, 0, window.innerWidth - 40);
			const y = U.clamp(start.top + e.clientY - start.y, 0, window.innerHeight - 30);
			Object.assign(el.style, {left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto'});
		};
		const up = () => {
			if (!start) return;
			start = null;
			el.classList.remove('blp-r-dragging');
			const rect = el.getBoundingClientRect();
			onEnd && onEnd(Math.round(rect.left), Math.round(rect.top));
		};
		handle.addEventListener('pointerdown', down);
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	};

	/* ------------------------------------------------------------------ controls */

	const stop = e => e.stopPropagation();
	const guard = el => {
		// Keep keyboard/mouse input inside BLP controls away from the replayer's own shortcuts.
		['keydown', 'keyup', 'wheel', 'pointerdown', 'mousedown', 'click'].forEach(ev => el.addEventListener(ev, stop));
		return el;
	};

	ui.button = function (text, onClick, opts = {}) {
		return h(
			'button',
			{
				type: 'button',
				class: 'blp-r-btn' + (opts.primary ? ' blp-r-primary' : '') + (opts.active ? ' blp-r-active' : '') + (opts.className ? ' ' + opts.className : ''),
				title: opts.title || '',
				disabled: !!opts.disabled,
				onclick: e => {
					e.preventDefault();
					e.stopPropagation();
					onClick(e);
				},
			},
			text
		);
	};

	ui.toggle = function (label, checked, onChange) {
		const input = h('input', {type: 'checkbox', checked: !!checked, onchange: e => onChange(e.target.checked)});
		return guard(h('label', {class: 'blp-r-toggle'}, input, h('span', {class: 'blp-r-switch'}), h('span', {class: 'blp-r-label'}, label)));
	};

	ui.slider = function (label, opts, onInput) {
		const fmt = opts.format || (v => (Math.round(v * 100) / 100).toString() + (opts.unit || ''));
		const out = h('span', {class: 'blp-r-value'}, fmt(opts.value));
		const input = h('input', {
			type: 'range',
			min: opts.min,
			max: opts.max,
			step: opts.step,
			value: opts.value,
			oninput: e => {
				const v = Number(e.target.value);
				out.textContent = fmt(v);
				onInput(v);
			},
		});
		const el = guard(h('label', {class: 'blp-r-slider'}, h('span', {class: 'blp-r-label'}, label), out, input));
		el.set = v => {
			input.value = v;
			out.textContent = fmt(v);
		};
		return el;
	};

	ui.color = function (label, value, onInput) {
		return guard(
			h(
				'label',
				{class: 'blp-r-color'},
				h('input', {type: 'color', value: U.isHexColor(value) ? value.slice(0, 7) : '#ffffff', oninput: e => onInput(e.target.value)}),
				h('span', {class: 'blp-r-label'}, label)
			)
		);
	};

	ui.select = function (label, options, value, onChange) {
		const sel = h(
			'select',
			{onchange: e => onChange(e.target.value)},
			options.map(o => h('option', {value: o.value}, o.label))
		);
		sel.value = value;
		return guard(h('label', {class: 'blp-r-select'}, label ? h('span', {class: 'blp-r-label'}, label) : null, sel));
	};

	ui.input = function (value, opts = {}) {
		return guard(
			h('input', {
				type: 'text',
				class: 'blp-r-input',
				value: value || '',
				placeholder: opts.placeholder || '',
				onchange: e => opts.onChange && opts.onChange(e.target.value),
				oninput: e => opts.onInput && opts.onInput(e.target.value),
			})
		);
	};

	ui.row = (...children) => h('div', {class: 'blp-r-row'}, ...children);
	ui.section = (title, ...children) => h('section', {class: 'blp-r-section'}, title ? h('h4', null, title) : null, ...children);
	ui.hint = text => h('p', {class: 'blp-r-hint'}, text);

	/* ------------------------------------------------------------------ panel */

	const tabs = [];
	let panel = null;
	let body = null;
	let activeTab = null;
	let pointerInside = false;

	ui.addTab = function (tab) {
		if (tabs.some(x => x.id === tab.id)) return;
		tabs.push(tab);
		tabs.sort((a, b) => (a.order || 0) - (b.order || 0));
		if (panel) renderTabs();
	};

	function renderTabs() {
		const bar = panel.querySelector('.blp-r-tabs');
		bar.textContent = '';
		for (const tab of tabs) {
			bar.appendChild(
				h(
					'button',
					{
						type: 'button',
						class: 'blp-r-tab' + (tab.id === activeTab ? ' blp-r-active' : ''),
						title: tab.title,
						onclick: e => {
							e.stopPropagation();
							ui.openPanel(tab.id);
						},
					},
					tab.icon + ' ',
					h('span', null, tab.title)
				)
			);
		}
	}

	function renderBody() {
		if (!body) return;
		const tab = tabs.find(x => x.id === activeTab) || tabs[0];
		if (!tab) return;
		activeTab = tab.id;
		const scroll = body.scrollTop;
		body.textContent = '';
		try {
			tab.render(body);
		} catch (e) {
			R.log.error('panel tab failed', tab.id, e);
			body.appendChild(ui.hint(String(e.message || e)));
		}
		body.scrollTop = scroll;
	}

	function buildPanel() {
		body = h('div', {class: 'blp-r-panel-body'});
		const head = h(
			'div',
			{class: 'blp-r-panel-head'},
			h('span', {class: 'blp-r-brand'}, 'BL+'),
			h('strong', null, t('r.panel')),
			h('span', {class: 'blp-r-spacer'}),
			ui.button('⚙', () => R.request('openOptions', {section: activeTab === 'export' ? 'export' : activeTab || 'camera'}), {title: t('popup.openOptions'), className: 'blp-r-icon'}),
			ui.button('✕', () => ui.closePanel(), {title: t('common.close'), className: 'blp-r-icon'})
		);
		panel = guard(h('div', {id: 'blp-r-panel', class: 'blp-r-panel'}, head, h('div', {class: 'blp-r-tabs'}), body));
		panel.addEventListener('pointerenter', () => (pointerInside = true));
		panel.addEventListener('pointerleave', () => (pointerInside = false));
		const pos = R.runtime.panelPos;
		if (pos && isFinite(pos.x) && isFinite(pos.y)) {
			Object.assign(panel.style, {left: U.clamp(pos.x, 0, window.innerWidth - 120) + 'px', top: U.clamp(pos.y, 0, window.innerHeight - 60) + 'px', right: 'auto'});
		}
		ui.makeDraggable(panel, head, (x, y) => R.setRuntime('panelPos', {x, y}));
		document.body.appendChild(panel);
		renderTabs();
	}

	ui.isOpen = () => !!(panel && panel.classList.contains('blp-r-open'));

	ui.openPanel = function (tabId) {
		if (!panel) buildPanel();
		if (tabId) activeTab = tabId;
		panel.classList.add('blp-r-open');
		renderTabs();
		renderBody();
		R.setRuntime('panelOpen', true);
	};

	ui.closePanel = function () {
		if (panel) panel.classList.remove('blp-r-open');
		R.setRuntime('panelOpen', false);
	};

	ui.togglePanel = tabId => (ui.isOpen() && (!tabId || tabId === activeTab) ? ui.closePanel() : ui.openPanel(tabId));

	/** Re-render the active tab (skipped while the user is interacting with the panel). */
	ui.refreshPanel = function (force) {
		if (!ui.isOpen()) return;
		const focused = panel.contains(document.activeElement) && document.activeElement !== document.body;
		if (!force && (pointerInside || focused)) return;
		renderBody();
	};
	const refreshSoon = U.debounce(() => ui.refreshPanel(false), 300);
	R.on('settings', refreshSoon);

	/* ------------------------------------------------------------------ launcher */

	ui.installLauncher = function () {
		let btn = document.getElementById('blp-r-launch');
		const replaceCamera = R.get('camera.replaceOfficialUi');
		const controlsHidden = R.get('overlay.hideOfficial.controls');
		if (!btn) {
			btn = h(
				'div',
				{
					id: 'blp-r-launch',
					class: 'blp-r-launch',
					title: t('r.panel') + ' (' + U.formatHotkey(R.get('hotkeys.bindings.togglePanel')) + ')',
					onclick: e => {
						e.stopPropagation();
						ui.togglePanel(R.get('camera.replaceOfficialUi') ? 'camera' : null);
					},
				},
				h('span', null, 'BL+')
			);
		}
		const anchor = document.querySelector('.controlsSettings.desktopControl');
		if (anchor && !controlsHidden) {
			btn.classList.remove('blp-r-floating');
			if (btn.parentNode !== anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
		} else {
			btn.classList.add('blp-r-floating');
			if (btn.parentNode !== document.body) document.body.appendChild(btn);
		}
		btn.classList.toggle('blp-r-camera-mode', !!replaceCamera);
		btn.firstChild.textContent = replaceCamera ? '🎥 BL+' : 'BL+';
	};

	/* ------------------------------------------------------------------ official UI visibility */

	const OFFICIAL_SELECTORS = {
		controls: ['#controls'],
		songInfo: ['#songInfoOverlay', '#songLink'],
		playerInfo: ['#playerInfoOverlay', '#playerLink'],
		cameraButtons: ['.controlsCamera', '.povswitch', '#cameraSettingsContainer'],
		settingsButton: ['.controlsSettings', '#settingsContainer'],
		socialCorners: ['#discord-corner', '#patreon-corner'],
		playlist: ['#playlistPanel'],
	};

	ui.applyOfficialVisibility = function () {
		const active = R.active();
		const hide = (active && R.get('overlay.hideOfficial')) || {};
		const selectors = [];
		for (const key of Object.keys(OFFICIAL_SELECTORS)) if (hide[key]) selectors.push(...OFFICIAL_SELECTORS[key]);
		if (active && R.get('camera.replaceOfficialUi')) selectors.push(...OFFICIAL_SELECTORS.cameraButtons);
		let style = document.getElementById('blp-r-official-hide');
		if (!style) {
			style = h('style', {id: 'blp-r-official-hide'});
			document.head.appendChild(style);
		}
		style.textContent = selectors.length ? Array.from(new Set(selectors)).join(',\n') + ' { display: none !important; }' : '';
		document.documentElement.classList.toggle('blp-r-overlays-hidden', !!R.overlaysHidden);
		if (active) ui.installLauncher();
		else {
			const btn = document.getElementById('blp-r-launch');
			if (btn) btn.remove();
			ui.closePanel();
		}
	};

	R.on('settings', () => R.ctx && ui.applyOfficialVisibility());
	R.on('ready', () => {
		ui.applyOfficialVisibility();
		// The control bar may be re-rendered; keep the launcher attached.
		setInterval(() => R.active() && !document.getElementById('blp-r-launch') && ui.installLauncher(), 2000);
	});
})();
