/*
 * BeatLeaderPlus – integration with the replayer's own interface (PAGE world).
 *
 * BeatLeaderPlus does not add a UI of its own to the replay viewer. Instead it extends the
 * replayer's existing menus, using the replayer's own markup and CSS classes so additions look
 * native:
 *
 *   Settings menu (#settingsContainer)    + a "BL+" tab (button/pane pair driven by the page's
 *                                           own changeTab(index) function)
 *   Camera menu (#cameraSettingsContainer) + a compact BeatLeaderPlus block under "Main camera"
 *                                           + a "BL+" camera tab for the detailed options
 *   Right-click menu (#ctxMenu)            + extra menu items next to "Copy URL …"
 *
 * Modules contribute content with addSettingsSection / addCameraSection / addMenuItem.
 *
 *   BLPR.ui.toggle / range / color / select / button / input   controls in the replayer's style
 *   BLPR.ui.openSettings(sectionId)                            open Settings → BL+ (hotkey, popup)
 *   BLPR.ui.refresh()                                          re-render after state changes
 */
(function () {
	'use strict';

	const R = window.BLPR;
	if (!R || R.ui) return;
	const U = window.BLP.utils;
	const h = U.h;
	const t = (k, v) => R.t(k, v);

	const ui = (R.ui = {h});

	/* ------------------------------------------------------------------ toast (errors only) */

	ui.toast = function (text, kind = 'info') {
		let box = document.getElementById('blp-r-toasts');
		if (!box) {
			box = h('div', {id: 'blp-r-toasts', class: 'blp-r-toasts'});
			document.body.appendChild(box);
		}
		const el = h('div', {class: 'blp-r-toast blp-r-toast-' + kind}, text);
		box.appendChild(el);
		setTimeout(() => el.classList.add('blp-r-out'), 2600);
		setTimeout(() => el.remove(), 3100);
	};

	/* ------------------------------------------------------------------ controls (replayer style) */

	// The replayer's keyboard shortcuts don't ignore text fields, so keep typing inside our inputs.
	const isolateKeys = el => {
		['keydown', 'keyup', 'keypress'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
		return el;
	};
	const label = text => h('label', {class: 'toggleButtonLabel'}, h('nobr', null, text));

	ui.header = text => h('div', {class: 'settingHeader blp-r-header'}, text);
	ui.hint = text => h('p', {class: 'blp-r-hint'}, text);
	ui.row = (...children) => h('div', {class: 'blp-r-row'}, ...children);

	ui.toggle = function (text, checked, onChange, title) {
		return h(
			'div',
			{class: 'toggleButton blp-r-toggle', title: title || ''},
			h('label', {class: 'switch'}, h('input', {type: 'checkbox', checked: !!checked, onchange: e => onChange(e.target.checked)}), h('span', {class: 'slider round'})),
			label(text)
		);
	};

	ui.range = function (text, opts, onInput, title) {
		const fmt = opts.format || (v => U.round(v, 2) + (opts.unit || ''));
		const value = h('label', {class: 'toggleButtonLabel blp-r-value'}, fmt(opts.value));
		const input = h('input', {
			class: 'settingRange',
			type: 'range',
			min: opts.min,
			max: opts.max,
			step: opts.step,
			value: opts.value,
			oninput: e => {
				const v = Number(e.target.value);
				value.textContent = fmt(v);
				onInput(v);
			},
		});
		return h('div', {class: 'toggleButton blp-r-range', title: title || ''}, h('label', null, h('div', {class: 'toggleButtonContainer'}, text ? label(text + ':') : null, value), input));
	};

	ui.color = function (text, current, onInput, title) {
		return h(
			'div',
			{class: 'toggleButton blp-r-color', title: title || ''},
			h('input', {type: 'color', value: U.isHexColor(current) ? current.slice(0, 7) : '#ffffff', oninput: e => onInput(e.target.value)}),
			label(text)
		);
	};

	ui.select = function (text, options, current, onChange, title) {
		const sel = h('select', {class: 'settingButton', onchange: e => onChange(e.target.value)}, options.map(o => h('option', {value: o.value}, o.label)));
		sel.value = current;
		return h('div', {class: 'toggleButton blp-r-select', title: title || ''}, h('label', null, text ? h('div', {class: 'toggleButtonContainer'}, label(text + ':')) : null, sel));
	};

	/** opts.icon: Font Awesome classes (the replayer loads FA 6) shown before the text. */
	ui.button = function (text, onClick, opts = {}) {
		return h(
			'button',
			{
				type: 'button',
				class: 'settingButton blp-r-btn' + (opts.active ? ' blp-r-active' : '') + (opts.className ? ' ' + opts.className : ''),
				title: opts.title || '',
				'aria-label': !text && opts.title ? opts.title : null,
				disabled: !!opts.disabled,
				onclick: e => {
					e.preventDefault();
					onClick(e);
				},
			},
			opts.icon ? h('i', {class: opts.icon + (text ? ' blp-r-icon blp-r-icon-text' : ' blp-r-icon'), 'aria-hidden': 'true'}) : null,
			text || null
		);
	};

	/* Controls for the replayer's own settings (BLPR.official): they change the same setting as its
	   own menu, so either one can be used and both always show the same value. */

	ui.officialToggle = (key, text, title) => ui.toggle(text, !!R.official.get(key), v => R.official.set(key, v), title);

	ui.officialRange = function (key, text, opts = {}, title) {
		const input = R.official.input(key);
		const num = (v, fallback) => (isFinite(parseFloat(v)) ? parseFloat(v) : fallback);
		const el = ui.range(
			text,
			{
				min: num(input && input.min, opts.min),
				max: num(input && input.max, opts.max),
				step: num(input && input.step, opts.step),
				value: num(R.official.get(key), num(opts.value, opts.min)),
				unit: opts.unit,
			},
			v => R.official.set(key, v),
			title
		);
		// e.g. "X rotation offset" is unused while "Force look upright" is on.
		if (input && input.disabled) el.querySelector('input').disabled = true;
		return el;
	};

	ui.input = function (value, opts = {}) {
		return isolateKeys(
			h('input', {
				type: 'text',
				class: 'blp-r-input',
				value: value || '',
				placeholder: opts.placeholder || '',
				onchange: e => opts.onChange && opts.onChange(e.target.value),
			})
		);
	};

	/* ------------------------------------------------------------------ tab helpers */

	/** Activate `button` among the menu's tab buttons, using the page's own tab function if present. */
	function selectTab(buttonClass, paneClass, button, pageFnName) {
		const buttons = Array.from(document.getElementsByClassName(buttonClass));
		const index = buttons.indexOf(button);
		if (index < 0) return;
		if (typeof window[pageFnName] === 'function') {
			window[pageFnName](index);
			return;
		}
		const panes = Array.from(document.getElementsByClassName(paneClass));
		buttons.forEach((b, i) => {
			b.classList.toggle('active', i === index);
			if (panes[i]) panes[i].classList.toggle('active', i === index);
		});
	}

	/**
	 * The replayer hides its control bar (and the menus in it) while a replay plays and the mouse is
	 * idle. Menus opened from a hotkey or the popup report user activity the way its own
	 * user-gesture component does, so they are visible; its normal idle timer takes over again on
	 * the next mouse movement.
	 */
	function revealControls() {
		if (document.body.classList.contains('showControls')) return;
		const scene = R.ctx && R.ctx.scene;
		const gesture = scene && scene.components && scene.components['user-gesture'];
		if (gesture && typeof gesture.changeUserActive === 'function') gesture.changeUserActive(true);
		else if (scene) scene.emit('useractive', {isActive: true}, false);
	}

	/* ------------------------------------------------------------------ Settings → BL+ tab */

	const settingsSections = [];
	const settingsTab = {button: null, pane: null};

	ui.addSettingsSection = function (section) {
		if (settingsSections.some(s => s.id === section.id)) return;
		settingsSections.push(section);
		settingsSections.sort((a, b) => (a.order || 0) - (b.order || 0));
		renderSettingsPane();
	};

	function installSettingsTab() {
		if (settingsTab.button && settingsTab.button.isConnected) return true;
		const container = document.getElementById('settingsContainer');
		const buttons = container && container.querySelector('.tab-buttons');
		const content = container && container.querySelector('.tab-content');
		if (!buttons || !content) return false;
		settingsTab.button = h(
			'button',
			{
				id: 'blpSettingsTab',
				type: 'button',
				class: 'settings-tab-button tab-button blp-r-tab-button',
				title: 'BeatLeaderPlus',
				onclick: () => {
					selectTab('settings-tab-button', 'settings-tab-pane', settingsTab.button, 'changeTab');
					renderSettingsPane();
				},
			},
			h('i', {class: 'fas fa-plus'}),
			' ' + t('r.tab')
		);
		settingsTab.pane = h('div', {id: 'blpSettingsPane', class: 'settings-tab-pane tab-pane blp-r-pane'});
		trackInteraction(settingsTab.pane);
		buttons.appendChild(settingsTab.button);
		content.appendChild(settingsTab.pane);
		renderSettingsPane();
		return true;
	}

	function renderSettingsPane() {
		const pane = settingsTab.pane;
		if (!pane) return;
		const scroll = pane.scrollTop;
		pane.textContent = '';
		pane.appendChild(ui.hint(t('r.officialHint')));
		for (const section of settingsSections) {
			const body = h('div', {class: 'blp-r-section', id: 'blp-sec-' + section.id});
			body.appendChild(ui.header(section.title()));
			try {
				section.render(body);
			} catch (e) {
				R.log.error('settings section failed', section.id, e);
				body.appendChild(ui.hint(String(e.message || e)));
			}
			pane.appendChild(body);
		}
		pane.appendChild(ui.row(ui.button(t('r.allOptions'), () => R.request('openOptions', {section: 'visuals'}).catch(() => {}))));
		pane.scrollTop = scroll;
	}

	/** Open Settings → BL+ (optionally scrolled to a section). */
	ui.openSettings = function (sectionId) {
		if (!installSettingsTab()) return false;
		revealControls();
		document.getElementById('settingsContainer').classList.add('settingsActive');
		selectTab('settings-tab-button', 'settings-tab-pane', settingsTab.button, 'changeTab');
		renderSettingsPane();
		if (sectionId) {
			const el = document.getElementById('blp-sec-' + sectionId);
			if (el) el.scrollIntoView({block: 'start'});
		}
		return true;
	};

	ui.toggleSettings = function () {
		const container = document.getElementById('settingsContainer');
		const open = container && container.classList.contains('settingsActive') && settingsTab.pane && settingsTab.pane.classList.contains('active');
		if (open) container.classList.remove('settingsActive');
		else ui.openSettings();
	};

	/* ------------------------------------------------------------------ Camera menu */

	const cameraSections = [];
	const cameraUi = {quick: null, button: null, pane: null};

	/** placement: 'quick' (under the official "Main camera" controls) or 'tab' (BL+ camera tab). */
	ui.addCameraSection = function (section) {
		if (cameraSections.some(s => s.id === section.id)) return;
		cameraSections.push(section);
		cameraSections.sort((a, b) => (a.order || 0) - (b.order || 0));
		renderCamera();
	};

	function installCameraUi() {
		if (cameraUi.quick && cameraUi.quick.isConnected && cameraUi.button && cameraUi.button.isConnected) return true;
		const container = document.getElementById('cameraSettingsContainer');
		const mainPane = container && container.querySelector('.camera-tab-pane');
		const buttons = container && container.querySelector('.tab-buttons');
		const content = container && container.querySelector('.tab-content');
		if (!mainPane || !buttons || !content) return false;
		cameraUi.quick = h('div', {id: 'blpCameraQuick', class: 'blp-r-camera-quick'});
		trackInteraction(cameraUi.quick);
		mainPane.appendChild(cameraUi.quick);
		cameraUi.button = h(
			'button',
			{
				id: 'blpCameraTab',
				type: 'button',
				class: 'camera-tab-button tab-button blp-r-tab-button',
				onclick: () => {
					selectTab('camera-tab-button', 'camera-tab-pane', cameraUi.button, 'changeCameraTab');
					renderCamera();
				},
			},
			h('i', {class: 'fas fa-plus'}),
			' ' + t('r.tab')
		);
		cameraUi.pane = h('div', {id: 'blpCameraPane', class: 'camera-tab-pane tab-pane blp-r-pane blp-r-camera-pane'});
		trackInteraction(cameraUi.pane);
		buttons.appendChild(cameraUi.button);
		content.appendChild(cameraUi.pane);
		renderCamera();
		return true;
	}

	function renderCamera() {
		for (const [el, placement] of [
			[cameraUi.quick, 'quick'],
			[cameraUi.pane, 'tab'],
		]) {
			if (!el) continue;
			const scroll = el.scrollTop;
			el.textContent = '';
			if (placement === 'quick') el.appendChild(h('div', {class: 'settingHeader'}, t('r.cameraHeader')));
			for (const section of cameraSections.filter(s => (s.placement || 'tab') === placement)) {
				const body = h('div', {class: 'blp-r-section'});
				if (section.title) body.appendChild(ui.header(section.title()));
				try {
					section.render(body);
				} catch (e) {
					R.log.error('camera section failed', section.id, e);
				}
				el.appendChild(body);
			}
			el.scrollTop = scroll;
		}
	}

	ui.openCameraTab = function () {
		if (!installCameraUi()) return false;
		revealControls();
		document.getElementById('cameraSettingsContainer').classList.add('settingsActive');
		selectTab('camera-tab-button', 'camera-tab-pane', cameraUi.button, 'changeCameraTab');
		renderCamera();
		return true;
	};

	/* ------------------------------------------------------------------ right-click menu */

	const menuItems = [];

	/** item: {id, icon ('fas fa-…'), label() → string, onClick(), order} */
	ui.addMenuItem = function (item) {
		if (menuItems.some(m => m.id === item.id)) return;
		menuItems.push(item);
		menuItems.sort((a, b) => (a.order || 0) - (b.order || 0));
		installMenuItems();
	};

	function installMenuItems() {
		const menu = document.querySelector('#ctxMenu .panel-menu');
		if (!menu) return false;
		for (const item of menuItems) {
			let el = document.getElementById(item.id);
			if (!el) {
				el = h(
					'div',
					{id: item.id, class: 'menuitem blp-r-menuitem', role: 'menuitem', tabindex: '0', onclick: () => item.onClick()},
					h('div', {class: 'menuitem-icon'}, h('i', {class: item.icon})),
					h('div', {class: 'menuitem-label'}),
					h('div', {class: 'menuitem-content'})
				);
				const playlistItem = document.getElementById('addToPlaylist');
				if (playlistItem && playlistItem.parentNode === menu) menu.insertBefore(el, playlistItem);
				else menu.appendChild(el);
			}
			el.querySelector('.menuitem-label').textContent = item.label();
			el.style.display = R.active() ? '' : 'none';
		}
		return true;
	}

	/* ------------------------------------------------------------------ refresh */

	// Re-renders wait while the user drags a slider in one of our blocks or types in a text field,
	// and run once that interaction ends.
	const pressed = new Set();
	let refreshTimer = 0;
	let refreshForced = false;
	let refreshPending = false;

	function busy(el, force) {
		if (!el) return false;
		if (pressed.has(el)) return true;
		if (force) return false;
		const a = document.activeElement;
		return !!(a && el.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text')));
	}

	function trackInteraction(el) {
		el.addEventListener('pointerdown', () => pressed.add(el));
		el.addEventListener('focusout', () => refreshPending && ui.refresh(false));
	}

	const release = () => {
		if (!pressed.size) return;
		pressed.clear();
		if (refreshPending) ui.refresh(false);
	};
	window.addEventListener('pointerup', release, true);
	window.addEventListener('pointercancel', release, true);

	/**
	 * Re-render BL+ menus. Always deferred to a new task: re-rendering inside a click handler would
	 * detach the clicked element, and the replayer's document click handler would then see a click
	 * "outside" its menu and close it. `force` re-renders even while a text field has focus.
	 */
	ui.refresh = function (force) {
		refreshForced = refreshForced || !!force;
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			const forced = refreshForced;
			refreshTimer = 0;
			refreshForced = false;
			refreshPending = false;
			if (!busy(settingsTab.pane, forced)) renderSettingsPane();
			else refreshPending = true;
			if (!busy(cameraUi.quick, forced) && !busy(cameraUi.pane, forced)) renderCamera();
			else refreshPending = true;
			installMenuItems();
		}, 0);
	};
	const refreshSoon = U.debounce(() => ui.refresh(false), 250);
	R.on('settings', () => R.ctx && refreshSoon());

	/* ------------------------------------------------------------------ hiding replayer elements */

	const OFFICIAL_SELECTORS = {
		songInfo: ['#songInfoOverlay', '#songLink'],
		playerInfo: ['#playerInfoOverlay', '#playerLink'],
		socialCorners: ['#discord-corner', '#patreon-corner'],
		playlist: ['#playlistPanel'],
	};

	ui.applyOfficialVisibility = function () {
		const hide = (R.active() && R.get('overlay.hideOfficial')) || {};
		const selectors = [];
		for (const key of Object.keys(OFFICIAL_SELECTORS)) if (hide[key]) selectors.push(...OFFICIAL_SELECTORS[key]);
		let style = document.getElementById('blp-r-official-hide');
		if (!style) {
			style = h('style', {id: 'blp-r-official-hide'});
			document.head.appendChild(style);
		}
		style.textContent = selectors.length ? selectors.join(',\n') + ' { display: none !important; }' : '';
		document.documentElement.classList.toggle('blp-r-overlays-hidden', !!R.overlaysHidden);
		document.documentElement.classList.toggle('blp-r-disabled', !R.active());
	};

	R.on('settings', () => R.ctx && ui.applyOfficialVisibility());
	R.on('ready', () => {
		installSettingsTab();
		installCameraUi();
		installMenuItems();
		ui.applyOfficialVisibility();
		const scene = R.ctx.scene;
		scene.addEventListener('contextmenuopen', installMenuItems);
		// The replayer's menus are static, but re-attach if anything replaced them.
		setInterval(() => {
			installSettingsTab();
			installCameraUi();
		}, 3000);
	});
})();
