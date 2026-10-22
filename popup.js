/*
 * BeatLeaderPlus – toolbar popup.
 *
 * Shows (configurable in options → Popup):
 *   - master on/off switch
 *   - replay actions for the active tab (copy link with settings, screenshot, clip, open the
 *     BL+ tab of the replayer's Settings menu, camera mode / preset) – sent to the tab's content
 *     script, which forwards them to the replay page runtime
 *   - user-selected quick toggles (any boolean setting from lib/schema.js)
 */
(function () {
	'use strict';

	const {utils: U, storage, i18n, schema} = window.BLP;
	const t = (k, v) => i18n.t(k, v);
	const h = U.h;
	const $ = id => document.getElementById(id);

	let settings = null;
	let activeTab = null;

	/* ------------------------------------------------------------------ helpers */

	function status(text, ms = 2500) {
		$('status').textContent = text || '';
		clearTimeout(status.timer);
		if (text) status.timer = setTimeout(() => ($('status').textContent = ''), ms);
	}

	function sendToTab(msg) {
		return new Promise((resolve, reject) => {
			if (!activeTab) return reject(new Error('No tab'));
			chrome.tabs.sendMessage(activeTab.id, msg, {frameId: 0}, res => {
				if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
				if (!res || !res.ok) return reject(new Error((res && res.error) || 'Failed'));
				resolve(res.data);
			});
		});
	}

	const replayCommand = (action, payload, timeout) => sendToTab({type: 'blp:replay', action, payload, timeout});

	async function patch(path, value) {
		U.setPath(settings, path, value);
		await storage.saveSettings(settings);
	}

	function applyTheme() {
		const root = document.documentElement.style;
		if (settings.theme.enabled) {
			const c = settings.theme.colors;
			root.setProperty('--primary', c.primary);
			root.setProperty('--accent', c.accent);
			root.setProperty('--bg', c.background);
			root.setProperty('--surface', c.surface);
			root.setProperty('--surface-2', U.mixColors(c.surface, c.text, 0.06));
			root.setProperty('--border', c.border);
			root.setProperty('--text', c.text);
			root.setProperty('--muted', c.textMuted);
			document.documentElement.style.colorScheme = U.luminance(c.background) > 0.4 ? 'light' : 'dark';
		}
		document.body.style.width = U.clamp(Number(settings.popup.width) || 360, 280, 600) + 'px';
		document.body.classList.toggle('compact', !!settings.popup.compact);
	}

	/* ------------------------------------------------------------------ sections */

	function renderToggles() {
		const box = $('toggles');
		box.textContent = '';
		for (const path of settings.popup.quickToggles || []) {
			const field = schema.findField(path);
			if (!field || field.type !== 'toggle' || path === 'general.enabled') continue;
			const input = h('input', {
				type: 'checkbox',
				checked: !!U.getPath(settings, path),
				onchange: async e => {
					await patch(path, e.target.checked);
					status(t('opt.saved'));
				},
			});
			box.appendChild(h('label', {class: 'toggle-row'}, h('span', null, t(schema.labelKey(field))), h('span', {class: 'switch'}, input, h('span', {class: 'slider'}))));
		}
		$('toggleSection').classList.toggle('hidden', !box.childNodes.length);
	}

	async function renderReplay(pageInfo) {
		const section = $('replaySection');
		const body = $('replayBody');
		body.textContent = '';
		if (!settings.popup.showReplayActions) return section.classList.add('hidden');
		section.classList.remove('hidden');
		if (!pageInfo || pageInfo.type !== 'replay') {
			body.appendChild(h('p', {class: 'empty'}, t('popup.notReplay')));
			return;
		}
		let st = null;
		try {
			st = await replayCommand('status');
		} catch (e) {
			body.appendChild(h('p', {class: 'empty'}, t('popup.failed')));
			return;
		}
		const run = (action, okText) => async () => {
			try {
				await replayCommand(action, {}, 30000);
				status(okText || t('popup.sent'));
			} catch (e) {
				status(t('popup.failed'));
			}
		};
		const copyBtn = h(
			'button',
			{
				class: 'btn primary',
				onclick: async () => {
					try {
						const link = await replayCommand('buildLink');
						await navigator.clipboard.writeText(link);
						status(t('popup.linkCopied'));
					} catch (e) {
						status(t('popup.failed'));
					}
				},
			},
			t('popup.copyLink')
		);
		body.appendChild(
			h(
				'div',
				{class: 'actions'},
				copyBtn,
				h('button', {class: 'btn', onclick: run('screenshot', t('r.screenshotSaved'))}, t('popup.screenshot')),
				h('button', {class: 'btn', onclick: run('recordClip')}, t('popup.recordClip')),
				h('button', {class: 'btn', onclick: run('togglePanel')}, t('popup.togglePanel'))
			)
		);
		copyBtn.style.gridColumn = '1 / -1';
		const cam = st && st.camera;
		if (cam) {
			const modeSel = h(
				'select',
				{onchange: e => replayCommand('setCameraMode', {mode: e.target.value}).catch(() => status(t('popup.failed')))},
				(cam.modes || []).map(m => h('option', {value: m}, t('cam.mode.' + m)))
			);
			modeSel.value = cam.mode;
			body.appendChild(h('div', {class: 'field'}, h('label', null, t('popup.cameraMode')), modeSel));
			const presetSel = h(
				'select',
				{
					onchange: e => {
						if (e.target.value) replayCommand('applyPreset', {id: e.target.value}).catch(() => status(t('popup.failed')));
					},
				},
				h('option', {value: ''}, t('popup.choosePreset')),
				(cam.presets || []).map(p => h('option', {value: p.id}, p.name))
			);
			body.appendChild(h('div', {class: 'field'}, h('label', null, t('popup.cameraPreset')), presetSel));
		}
	}

	/* ------------------------------------------------------------------ init */

	async function init() {
		settings = await storage.loadSettings();
		i18n.setLocale(settings.general.language);
		i18n.localizeDom(document);
		applyTheme();
		$('version').textContent = 'v' + chrome.runtime.getManifest().version;

		const master = $('masterToggle');
		master.checked = settings.general.enabled;
		master.addEventListener('change', async () => {
			await patch('general.enabled', master.checked);
			$('disabledHint').classList.toggle('hidden', master.checked);
			status(t('opt.saved'));
		});
		$('disabledHint').classList.toggle('hidden', settings.general.enabled);

		$('openOptions').addEventListener('click', () => {
			chrome.runtime.openOptionsPage();
			window.close();
		});
		renderToggles();

		[activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
		let pageInfo = null;
		try {
			pageInfo = await sendToTab({type: 'blp:pageInfo'});
		} catch (e) {
			/* not a BeatLeader tab */
		}
		renderReplay(pageInfo);
	}

	init().catch(err => {
		console.error(err);
		status(String(err.message || err), 10000);
	});
})();
