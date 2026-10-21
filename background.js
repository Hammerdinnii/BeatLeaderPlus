/*
 * BeatLeaderPlus – background service worker (Manifest V3).
 *
 * Responsibilities
 *   - storage initialisation and schema migration on install/update
 *   - message hub for content scripts, popup and options page
 *   - CORS-free JSON fetches from the BeatLeader API (allow-listed hosts only)
 *   - .bsor downloads via chrome.downloads
 *   - followed-player polling (chrome.alarms) with badge + desktop notifications
 *   - context menu entries on replay links
 *   - fallback MAIN-world script injection (chrome.scripting) when a page's CSP blocks the
 *     <script src="chrome-extension://…"> injection used by the replay bridge
 */
'use strict';

importScripts('lib/i18n.js', 'lib/defaults.js', 'lib/utils.js', 'lib/storage.js');

const {utils: U, storage, defaults: D, i18n} = self.BLP;

let debugEnabled = false;
const log = U.createLogger('[BLP:bg]', () => debugEnabled);

const FOLLOW_ALARM = 'blp-follow-poll';
const FETCH_ALLOW = /^https:\/\/(api\.beatleader\.(com|xyz|net)|cdn\.scorestats\.beatleader\.(com|xyz|net))\//i;
const OPEN_ALLOW = /^https:\/\/([a-z0-9-]+\.)*beatleader\.(com|xyz|net)\//i;
const INJECT_ALLOW = /^(injected\/[a-z0-9-]+\.js|injected-replay\.js|lib\/(i18n|utils)\.js)$/i;
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

function notify(id, title, message, opts = {}) {
	return new Promise(resolve => {
		try {
			chrome.notifications.create(id || '', Object.assign({type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0}, opts), resolve);
		} catch (e) {
			log.warn('notification failed', e);
			resolve(null);
		}
	});
}

/* ------------------------------------------------------------------ follow polling */

async function getFollowState() {
	return storage.getLocal(D.KEYS.follow, D.DEFAULT_FOLLOW_STATE);
}

async function updateBadge(settings) {
	settings = settings || (await loadSettings());
	const state = await getFollowState();
	const n = (state.newScores || []).length;
	const show = settings.general.enabled && settings.site.follow.enabled && settings.site.follow.badge && n > 0;
	await chrome.action.setBadgeBackgroundColor({color: '#ff3d9a'});
	await chrome.action.setBadgeText({text: show ? (n > 99 ? '99+' : String(n)) : ''});
}

async function scheduleFollowAlarm(settings) {
	settings = settings || (await loadSettings());
	const state = await getFollowState();
	const want = settings.general.enabled && settings.site.follow.enabled && Object.keys(state.players || {}).length > 0;
	const period = Math.max(5, Number(settings.site.follow.intervalMinutes) || 15);
	const existing = await chrome.alarms.get(FOLLOW_ALARM);
	if (!want) {
		if (existing) await chrome.alarms.clear(FOLLOW_ALARM);
		return;
	}
	if (!existing || existing.periodInMinutes !== period) {
		await chrome.alarms.create(FOLLOW_ALARM, {delayInMinutes: 1, periodInMinutes: period});
		log.info('follow alarm scheduled every', period, 'min');
	}
}

function scoreSummary(score, player) {
	const lb = score.leaderboard || {};
	const song = lb.song || score.song || {};
	const diff = lb.difficulty || score.difficulty || {};
	return {
		scoreId: score.id,
		playerId: player.id,
		playerName: player.name || (score.player && score.player.name) || player.id,
		avatar: player.avatar || '',
		song: song.name || '?',
		mapper: song.mapper || '',
		cover: song.coverImage || song.cover || '',
		difficulty: diff.difficultyName || diff.value || '',
		accuracy: typeof score.accuracy === 'number' ? score.accuracy : null,
		pp: typeof score.pp === 'number' ? score.pp : null,
		rank: score.rank || null,
		leaderboardId: lb.id || score.leaderboardId || null,
		time: Number(score.timepost || score.timeset) || Math.floor(Date.now() / 1000),
	};
}

async function fetchLatestScores(playerId) {
	const url = `${U.API_BASE}/player/${encodeURIComponent(playerId)}/scores?sortBy=date&order=desc&page=1&count=10`;
	const data = await fetchJson(url, {fresh: true});
	return (data && (data.data || data.scores)) || [];
}

async function pollFollowed({manual = false} = {}) {
	const settings = await loadSettings();
	if (!settings.general.enabled || (!settings.site.follow.enabled && !manual)) return {checked: 0, found: 0};
	const state = await getFollowState();
	const ids = Object.keys(state.players || {});
	let found = [];
	for (const id of ids) {
		const player = state.players[id];
		try {
			const scores = await fetchLatestScores(id);
			if (!scores.length) continue;
			const newestTime = Number(scores[0].timepost || scores[0].timeset) || 0;
			if (!player.lastScoreId) {
				// First check after following: remember the newest score without notifying.
				player.lastScoreId = scores[0].id;
				player.lastTime = newestTime;
				continue;
			}
			const fresh = [];
			for (const s of scores) {
				const t = Number(s.timepost || s.timeset) || 0;
				if (String(s.id) === String(player.lastScoreId) || (player.lastTime && t <= player.lastTime)) break;
				fresh.push(scoreSummary(s, player));
			}
			if (fresh.length) {
				player.lastScoreId = scores[0].id;
				player.lastTime = newestTime;
				found = found.concat(fresh);
			}
		} catch (e) {
			log.warn('follow poll failed for', id, e && e.message);
		}
		await U.sleep(350); // be gentle with the API
	}
	if (found.length) {
		const known = new Set((state.newScores || []).map(s => String(s.scoreId)));
		state.newScores = found.filter(s => !known.has(String(s.scoreId))).concat(state.newScores || []).slice(0, 60);
		if (settings.site.follow.desktop) {
			if (found.length <= 3) {
				for (const s of found) {
					await notify(
						'blp-score-' + s.scoreId,
						i18n.t('bg.newScoreTitle', {name: s.playerName}),
						i18n.t('bg.newScoreBody', {
							song: s.song + (s.difficulty ? ' (' + s.difficulty + ')' : ''),
							acc: s.accuracy != null ? (s.accuracy * 100).toFixed(2) : '?',
							pp: s.pp != null ? s.pp.toFixed(1) : '0',
						})
					);
				}
			} else {
				await notify('blp-scores-' + Date.now(), i18n.t('bg.newScoresTitle', {n: found.length}), found.map(s => s.playerName + ': ' + s.song).slice(0, 4).join('\n'));
			}
		}
	}
	state.lastCheck = Date.now();
	await storage.setLocal(D.KEYS.follow, state);
	await updateBadge(settings);
	return {checked: ids.length, found: found.length};
}

/**
 * The player behind an ID or a profile alias. BeatLeader profile links use either
 * (/u/<id> or /u/<alias>); the API resolves both and returns the real ID.
 */
async function resolvePlayer(key) {
	const k = String(key || '').trim();
	if (!k) throw new Error('Missing player id');
	const info = await fetchJson(`${U.API_BASE}/player/${encodeURIComponent(k)}`);
	if (!info || info.id === undefined || info.id === null || info.id === '') throw new Error('Player not found: ' + k);
	return {id: String(info.id), name: info.name || '', avatar: info.avatar || '', alias: info.alias || ''};
}

async function followPlayer({playerId, name, avatar}) {
	if (!playerId) throw new Error('Missing player id');
	let info = null;
	try {
		info = await resolvePlayer(playerId);
	} catch (e) {
		log.debug('player info unavailable', e && e.message);
	}
	const id = info ? info.id : String(playerId);
	const state = await getFollowState();
	state.players = state.players || {};
	// Follows used to be stored under whatever the page link said, which can be an alias.
	if (id !== String(playerId) && state.players[playerId]) {
		state.players[id] = Object.assign({}, state.players[playerId], state.players[id] || {}, {id});
		delete state.players[playerId];
	}
	state.players[id] = Object.assign({id, name: name || id, avatar: avatar || '', since: Date.now()}, state.players[id] || {});
	if (name) state.players[id].name = name;
	// Prefer the canonical name/avatar from the API over whatever the page showed.
	if (info && info.name) state.players[id].name = info.name;
	if (info && info.avatar) state.players[id].avatar = info.avatar;
	if (info && info.alias) state.players[id].alias = info.alias;
	try {
		const scores = await fetchLatestScores(id);
		if (scores.length) {
			state.players[id].lastScoreId = scores[0].id;
			state.players[id].lastTime = Number(scores[0].timepost || scores[0].timeset) || 0;
			if (!name && scores[0].player && scores[0].player.name) state.players[id].name = scores[0].player.name;
		}
	} catch (e) {
		log.warn('could not prime follow state', e && e.message);
	}
	await storage.setLocal(D.KEYS.follow, state);
	await scheduleFollowAlarm();
	return state.players[id];
}

async function unfollowPlayer({playerId}) {
	const key = String(playerId);
	let id = key;
	try {
		id = (await resolvePlayer(key)).id;
	} catch (e) {
		/* unknown alias: remove what matches the key */
	}
	const state = await getFollowState();
	const players = state.players || {};
	for (const k of Object.keys(players)) {
		const p = players[k];
		if (k === key || k === id || (p.alias && p.alias.toLowerCase() === key.toLowerCase())) delete players[k];
	}
	state.newScores = (state.newScores || []).filter(s => String(s.playerId) !== id && String(s.playerId) !== key);
	await storage.setLocal(D.KEYS.follow, state);
	await scheduleFollowAlarm();
	await updateBadge();
	return true;
}

/* ------------------------------------------------------------------ context menus */

function setupContextMenus() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'blp-open-enhanced',
			title: i18n.t('bg.ctxEnhanced'),
			contexts: ['link'],
			targetUrlPatterns: REPLAY_LINK_PATTERNS,
		});
		chrome.contextMenus.create({
			id: 'blp-download-bsor',
			title: i18n.t('bg.ctxDownload'),
			contexts: ['link'],
			targetUrlPatterns: REPLAY_LINK_PATTERNS,
		});
	});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	const parsed = U.parseReplayUrl(info.linkUrl || '');
	if (!parsed) return;
	try {
		if (info.menuItemId === 'blp-open-enhanced') {
			const settings = await loadSettings();
			await chrome.tabs.create({url: U.buildEnhancedReplayUrl(parsed, settings), index: tab ? tab.index + 1 : undefined});
		} else if (info.menuItemId === 'blp-download-bsor') {
			await downloadReplay(parsed);
		}
	} catch (e) {
		log.error('context menu action failed', e);
		notify('', 'BeatLeaderPlus', String(e.message || e));
	}
});

/* ------------------------------------------------------------------ notifications */

chrome.notifications.onClicked.addListener(async id => {
	const match = /^blp-score-(.+)$/.exec(id);
	const settings = await loadSettings();
	if (match) {
		await chrome.tabs.create({url: U.buildEnhancedReplayUrl({scoreId: match[1]}, settings)});
	} else if (id.startsWith('blp-scores-')) {
		try {
			await chrome.action.openPopup();
		} catch (e) {
			await handlers.openOptions({section: 'library'});
		}
	}
	chrome.notifications.clear(id);
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
	async openTab(msg, sender) {
		if (!OPEN_ALLOW.test(msg.url || '')) throw new Error('URL not allowed');
		const opts = {url: msg.url, active: msg.active !== false};
		if (sender.tab) opts.index = sender.tab.index + 1;
		await chrome.tabs.create(opts);
		return true;
	},
	async fetchJson(msg) {
		return fetchJson(msg.url, {fresh: !!msg.fresh});
	},
	async resolveScore(msg) {
		return fetchScore(msg.scoreId);
	},
	async resolvePlayer(msg) {
		return resolvePlayer(msg.player);
	},
	async downloadReplay(msg) {
		return downloadReplay(msg);
	},
	async follow(msg) {
		return followPlayer(msg);
	},
	async unfollow(msg) {
		return unfollowPlayer(msg);
	},
	async getFollowState() {
		return getFollowState();
	},
	async checkFollowsNow() {
		return pollFollowed({manual: true});
	},
	async clearNewScores() {
		const state = await getFollowState();
		state.newScores = [];
		await storage.setLocal(D.KEYS.follow, state);
		await updateBadge();
		return true;
	},
	async notify(msg) {
		const settings = await loadSettings();
		if (!settings.general.showToasts) return false;
		await notify('', msg.title || 'BeatLeaderPlus', msg.message || '');
		return true;
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
	const fav = await storage.getLocal(D.KEYS.favorites, null);
	if (!fav) await storage.setLocal(D.KEYS.favorites, U.deepClone(D.DEFAULT_FAVORITES));
	const follow = await storage.getLocal(D.KEYS.follow, null);
	if (!follow) await storage.setLocal(D.KEYS.follow, U.deepClone(D.DEFAULT_FOLLOW_STATE));
	setupContextMenus();
	await scheduleFollowAlarm(settings);
	await updateBadge(settings);
	if (details.reason === 'install') chrome.tabs.create({url: chrome.runtime.getURL('options.html#general')});
	log.info('installed/updated', details.reason);
});

chrome.runtime.onStartup.addListener(async () => {
	const settings = await loadSettings();
	await scheduleFollowAlarm(settings);
	await updateBadge(settings);
});

chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === FOLLOW_ALARM) pollFollowed().catch(e => log.warn('poll failed', e));
});

storage.onSettingsChanged(async () => {
	const settings = await loadSettings();
	await scheduleFollowAlarm(settings);
	await updateBadge(settings);
	setupContextMenus(); // refresh titles if the language changed
});

storage.onLocalChanged(D.KEYS.follow, () => updateBadge().catch(() => {}));
