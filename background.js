/*
 * BeatLeaderPlus – background service worker (Manifest V3).
 *
 * Responsibilities
 *   - storage initialisation and schema migration on install/update
 *   - message hub for content scripts, popup and options page
 *   - CORS-free JSON fetches from the BeatLeader API (allow-listed hosts only)
 *   - .bsor downloads via chrome.downloads
 *   - context menu entries on replay links
 *   - fallback MAIN-world script injection (chrome.scripting) when a page's CSP blocks the
 *     <script src="chrome-extension://…"> injection used by the replay bridge
 */
'use strict';

importScripts('lib/i18n.js', 'lib/defaults.js', 'lib/utils.js', 'lib/storage.js');

const {utils: U, storage, i18n} = self.BLP;

let debugEnabled = false;
const log = U.createLogger('[BLP:bg]', () => debugEnabled);

const FETCH_ALLOW = /^https:\/\/(api\.beatleader\.(com|xyz|net)|cdn\.scorestats\.beatleader\.(com|xyz|net))\//i;
const INJECT_ALLOW = /^(injected\/[a-z0-9-]+\.js|injected-replay\.js|lib\/(i18n|utils|unity-saber)\.js)$/i;
const REPLAY_LINK_PATTERNS = ['*://replay.beatleader.com/*', '*://replay.beatleader.xyz/*', '*://replay.beatleader.net/*'];

/* ------------------------------------------------------------------ helpers */

async function loadSettings() {
	const s = await storage.loadSettings();
	debugEnabled = !!s.general.debug;
	i18n.setLocale(s.general.language);
	return s;
}

const fetchCache = new Map();
const FETCH_TTL = 60 * 1000;

async function fetchJson(url, {fresh = false} = {}) {
	if (!FETCH_ALLOW.test(url)) throw new Error('URL not allowed: ' + url);
	const now = Date.now();
	const cached = fetchCache.get(url);
	if (!fresh && cached && now - cached.time < FETCH_TTL) return cached.promise;
	const promise = fetch(url, {credentials: 'omit'}).then(async res => {
		if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
		return res.json();
	});
	fetchCache.set(url, {time: now, promise});
	promise.catch(() => fetchCache.delete(url));
	if (fetchCache.size > 200) fetchCache.delete(fetchCache.keys().next().value);
	return promise;
}

async function fetchScore(scoreId) {
	return fetchJson(`${U.API_BASE}/score/${encodeURIComponent(scoreId)}`);
}

function replayFilename(score, fallbackId) {
	const player = (score && score.player && score.player.name) || 'player';
	const song = (score && score.song && score.song.name) || 'song';
	const diff = (score && score.difficulty && (score.difficulty.difficultyName || score.difficulty.value)) || '';
	const id = (score && score.id) || fallbackId || Date.now();
	return 'BeatLeader/' + U.sanitizeFilename(`${player} - ${song}${diff ? ' (' + diff + ')' : ''} [${id}]`) + '.bsor';
}

async function downloadUrl(url, filename) {
	if (!/^https:\/\//i.test(url)) throw new Error('Only https downloads are allowed.');
	return chrome.downloads.download({url, filename, conflictAction: 'uniquify', saveAs: false});
}

async function downloadReplay({scoreId, link}) {
	let url = link || null;
	let score = null;
	if (scoreId) {
		score = await fetchScore(scoreId);
		url = score && score.replay ? score.replay : url;
	}
	if (!url) throw new Error('No replay URL available for this score.');
	return downloadUrl(url, replayFilename(score, scoreId || (url.split('/').pop() || '').replace(/\.bsor$/i, '')));
}

/* ------------------------------------------------------------------ context menus */

function setupContextMenus() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'blp-download-bsor',
			title: i18n.t('bg.ctxDownload'),
			contexts: ['link'],
			targetUrlPatterns: REPLAY_LINK_PATTERNS,
		});
	});
}

chrome.contextMenus.onClicked.addListener(async info => {
	const parsed = U.parseReplayUrl(info.linkUrl || '');
	if (!parsed) return;
	try {
		if (info.menuItemId === 'blp-download-bsor') {
			await downloadReplay(parsed);
		}
	} catch (e) {
		log.error('context menu action failed', e);
	}
});

/* ------------------------------------------------------------------ messages */

const handlers = {
	async getSettings(msg) {
		return storage.loadEffective(msg.host);
	},
	async openOptions(msg) {
		const url = chrome.runtime.getURL('options.html') + (msg.section ? '#' + encodeURIComponent(msg.section) : '');
		const existing = await chrome.tabs.query({url: chrome.runtime.getURL('options.html') + '*'});
		if (existing.length) {
			await chrome.tabs.update(existing[0].id, {active: true, url});
			await chrome.windows.update(existing[0].windowId, {focused: true});
		} else {
			await chrome.tabs.create({url});
		}
		return true;
	},
	async fetchJson(msg) {
		return fetchJson(msg.url, {fresh: !!msg.fresh});
	},
	async resolveScore(msg) {
		return fetchScore(msg.scoreId);
	},
	async downloadReplay(msg) {
		return downloadReplay(msg);
	},
	/**
	 * Fallback injection into the page's MAIN world for the sender frame. Only extension-owned,
	 * allow-listed files can be injected.
	 */
	async injectMain(msg, sender) {
		if (!sender.tab) throw new Error('No tab');
		const files = (msg.files || []).filter(f => INJECT_ALLOW.test(f));
		if (!files.length) throw new Error('Nothing to inject');
		await chrome.scripting.executeScript({
			target: {tabId: sender.tab.id, frameIds: [sender.frameId || 0]},
			files,
			world: 'MAIN',
			injectImmediately: true,
		});
		return true;
	},
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	const handler = msg && handlers[msg.type];
	if (!handler) return false;
	Promise.resolve()
		.then(() => handler(msg, sender))
		.then(
			data => sendResponse({ok: true, data}),
			err => {
				log.warn('handler failed', msg.type, err);
				sendResponse({ok: false, error: String((err && err.message) || err)});
			}
		);
	return true; // async response
});

/* ------------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(async details => {
	const settings = await loadSettings(); // runs migrations
	await storage.saveSettings(settings, {force: details.reason === 'install'});
	setupContextMenus();
	// Earlier versions showed new scores from followed players on the toolbar icon.
	await chrome.action.setBadgeText({text: ''});
	if (details.reason === 'install') chrome.tabs.create({url: chrome.runtime.getURL('options.html#general')});
	log.info('installed/updated', details.reason);
});

storage.onSettingsChanged(() => setupContextMenus()); // refresh titles if the language changed

