/*
 * BeatLeaderPlus – toolbar popup.
 *
 * Shows (configurable in options → Popup):
 *   - master on/off switch
 *   - replay actions for the active tab (copy link with settings, screenshot, clip, open the
 *     BL+ tab of the replayer's Settings menu, camera mode / preset) – sent to the tab's content
 *     script, which forwards them to the replay page runtime
 *   - user-selected quick toggles (any boolean setting from lib/schema.js)
 *   - new scores from followed players and the favorites list
 */
(function () {
	'use strict';

	const {utils: U, storage, defaults: D, i18n, schema} = window.BLP;
	const t = (k, v) => i18n.t(k, v);
	const h = U.h;
	const $ = id => document.getElementById(id);

	let settings = null;
	let activeTab = null;
	let favTab = 'players';

	/* ------------------------------------------------------------------ helpers */

	function status(text, ms = 2500) {
		$('status').textContent = text || '';
		clearTimeout(status.timer);
		if (text) status.timer = setTimeout(() => ($('status').textContent = ''), ms);
	}

	function send(type, payload) {
		return new Promise((resolve, reject) => {
			chrome.runtime.sendMessage(Object.assign({type}, payload || {}), res => {
				if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
				if (!res || !res.ok) return reject(new Error((res && res.error) || 'Failed'));
				resolve(res.data);
			});
		});
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

	async function renderFollows() {
		const section = $('followSection');
		if (!settings.popup.showFollows || !settings.site.follow.enabled) return section.classList.add('hidden');
		section.classList.remove('hidden');
		const list = $('followList');
		list.textContent = '';
		let state;
		try {
			state = await send('getFollowState');
		} catch (e) {
			state = D.DEFAULT_FOLLOW_STATE;
		}
		const scores = (state.newScores || []).slice(0, 12);
		if (!scores.length) {
			list.appendChild(h('p', {class: 'empty'}, t('popup.noNewScores')));
			return;
		}
		for (const s of scores) {
			const url = U.replayUrl({scoreId: s.scoreId});
			list.appendChild(
				h(
					'a',
					{class: 'item', href: url, target: '_blank', title: s.song + (s.difficulty ? ' (' + s.difficulty + ')' : '')},
					h('img', {src: s.cover || s.avatar || 'icons/icon48.png', alt: ''}),
					h('div', {class: 'meta'}, h('span', null, s.playerName), h('span', {class: 'muted'}, s.song + (s.difficulty ? ' · ' + s.difficulty : ''))),
					h('span', {class: 'value'}, s.accuracy != null ? (s.accuracy * 100).toFixed(2) + '%' : '', s.pp ? h('div', {class: 'muted'}, s.pp.toFixed(1) + 'pp') : null)
				)
			);
		}
	}

	async function renderFavorites() {
		const section = $('favSection');
		if (!settings.popup.showFavorites || !settings.site.favorites) return section.classList.add('hidden');
		section.classList.remove('hidden');
		const fav = await storage.getLocal(D.KEYS.favorites, D.DEFAULT_FAVORITES);
		const list = $('favList');
		list.textContent = '';
		const entries = Object.values(favTab === 'players' ? fav.players || {} : fav.maps || {}).sort((a, b) => (b.added || 0) - (a.added || 0));
		if (!entries.length) {
			list.appendChild(h('p', {class: 'empty'}, t('popup.noFavorites')));
			return;
		}
		for (const f of entries.slice(0, 30)) {
			const url = favTab === 'players' ? 'https://beatleader.com/u/' + encodeURIComponent(f.id) : 'https://beatleader.com' + (f.url || '/leaderboard/global/' + encodeURIComponent(f.id));
			list.appendChild(
				h(
					'a',
					{class: 'item', href: url, target: '_blank', title: f.note || f.name},
					favTab === 'players' ? h('img', {src: f.avatar || 'icons/icon48.png', alt: ''}) : null,
					h('div', {class: 'meta'}, h('span', null, f.name), f.note ? h('span', {class: 'muted'}, f.note) : null)
				)
			);
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
		$('clearNew').addEventListener('click', async () => {
			await send('clearNewScores').catch(() => {});
			renderFollows();
		});
		$('checkNow').addEventListener('click', async () => {
			status(t('common.loading'), 20000);
			try {
				const res = await send('checkFollowsNow');
				status(res.found ? '+' + res.found : t('popup.noNewScores'));
			} catch (e) {
				status(e.message);
			}
			renderFollows();
		});
		document.querySelectorAll('#favSection .tab').forEach(btn =>
			btn.addEventListener('click', () => {
				favTab = btn.dataset.tab;
				document.querySelectorAll('#favSection .tab').forEach(b => b.classList.toggle('active', b === btn));
				renderFavorites();
			})
		);

		renderToggles();
		renderFollows();
		renderFavorites();

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
