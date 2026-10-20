/*
 * BeatLeaderPlus – website enhancements (content script, isolated world).
 *
 * Features (each individually switchable in options → Website enhancements):
 *   - "Download .bsor" and "Open in Enhanced Replayer" buttons next to every replay link
 *   - favorite stars on player and map links (stored locally with notes)
 *   - score comparison (select two scores → side-by-side modal)
 *   - auto-expand score details
 *   - quick filters (my scores, clan, high accuracy, favorites, full combo)
 *   - optional extra badges (misses / bad cuts / pauses / max combo) fetched from the API
 *   - a floating "dock" with page-specific actions (favorite/follow a player or map, filters,
 *     comparison tray, profile statistics)
 *
 * The BeatLeader website is a Svelte SPA. To stay robust against its re-renders we never move
 * or remove site nodes: we only add small sibling elements (marked with [data-blp-ui]) and use a
 * MutationObserver to process new content. Large UI (dock, modal, drawer) lives in fixed
 * containers appended to <body>, outside Svelte-managed trees.
 */
(function () {
	'use strict';

	const BLP = globalThis.BLP;
	if (!BLP || BLP.site) return;
	const {utils: U, storage, defaults: D} = BLP;
	const t = (k, v) => BLP.i18n.t(k, v);
	const h = U.h;

	const HMD_NAMES = {
		1: 'Rift CV1',
		2: 'Vive',
		4: 'Vive Pro',
		8: 'Windows MR',
		16: 'Rift S',
		32: 'Quest',
		60: 'Pico 4',
		61: 'Quest Pro',
		64: 'Valve Index',
		65: 'Controllable',
		70: 'PS VR2',
		75: 'Steam Frame',
		256: 'Quest 2',
		512: 'Quest 3',
		513: 'Quest 3S',
	};

	const ROW_SELECTOR = '.player-score, .song-scores > *, .score-row, .ranking-item, .player-row';

	const state = {
		started: false,
		observer: null,
		favorites: U.deepClone(D.DEFAULT_FAVORITES),
		followed: {},
		compare: [],
		filter: 'all',
		lastUrl: location.href,
		scoreCache: new Map(),
		badgeObserver: null,
		badgeQueue: [],
		badgeActive: 0,
		hidden: false,
	};

	const settings = () => BLP.state.settings;
	const enabled = () => {
		const s = settings();
		return !!(s && s.general.enabled && s.site.enabled);
	};

	/* ------------------------------------------------------------------ small UI helpers */

	function toast(message, kind = 'info') {
		const s = settings();
		if (s && !s.general.showToasts && kind !== 'error') return;
		let box = document.getElementById('blp-toasts');
		if (!box) {
			box = h('div', {id: 'blp-toasts', class: 'blp-toasts', 'data-blp-ui': ''});
			document.body.appendChild(box);
		}
		const el = h('div', {class: 'blp-toast blp-toast-' + kind}, message);
		box.appendChild(el);
		setTimeout(() => el.classList.add('blp-toast-out'), 2800);
		setTimeout(() => el.remove(), 3300);
	}

	function iconButton(icon, title, onClick, extraClass = '') {
		return h(
			'button',
			{
				type: 'button',
				class: 'blp-btn blp-icon-btn ' + extraClass,
				title,
				'aria-label': title,
				'data-blp-ui': '',
				onclick: e => {
					e.preventDefault();
					e.stopPropagation();
					onClick(e);
				},
				onmousedown: e => e.stopPropagation(),
			},
			icon
		);
	}

	function pageInfo() {
		const path = location.pathname;
		let m;
		if ((m = path.match(/^\/u\/([^/?#]+)/))) return {type: 'profile', playerId: decodeURIComponent(m[1])};
		if ((m = path.match(/^\/leaderboard\/([^/]+)\/([^/?#]+)/))) return {type: 'leaderboard', context: m[1], leaderboardId: decodeURIComponent(m[2])};
		if (/^\/clan\//.test(path)) return {type: 'clan'};
		if (/^\/ranking/.test(path)) return {type: 'ranking'};
		if (/^\/(leaderboards|maps)/.test(path)) return {type: 'maps'};
		return {type: path === '/' ? 'home' : 'other'};
	}

	function isInChrome(el) {
		return !!el.closest('nav, header, footer, [data-blp-ui], .pagination');
	}

	/* ------------------------------------------------------------------ data */

	async function loadFavorites() {
		state.favorites = U.withDefaults(await storage.getLocal(D.KEYS.favorites, D.DEFAULT_FAVORITES), D.DEFAULT_FAVORITES);
	}

	async function loadFollowed() {
		const st = await storage.getLocal(D.KEYS.follow, D.DEFAULT_FOLLOW_STATE);
		state.followed = st.players || {};
	}

	async function saveFavorites() {
		await storage.setLocal(D.KEYS.favorites, state.favorites);
	}

	function isFavorite(kind, id) {
		const bucket = kind === 'player' ? state.favorites.players : state.favorites.maps;
		return !!bucket[String(id)];
	}

	async function toggleFavorite(kind, id, name, extra = {}) {
		await loadFavorites();
		const bucket = kind === 'player' ? state.favorites.players : state.favorites.maps;
		id = String(id);
		if (bucket[id]) {
			delete bucket[id];
			toast(t('site.favRemoved'));
		} else {
			bucket[id] = Object.assign({id, name: name || id, note: '', added: Date.now()}, extra);
			toast(t(kind === 'player' ? 'site.favPlayerAdded' : 'site.favMapAdded', {name: name || id}), 'success');
		}
		await saveFavorites();
		refreshStars();
		renderDock();
	}

	async function editFavoriteNote(kind, id) {
		await loadFavorites();
		const bucket = kind === 'player' ? state.favorites.players : state.favorites.maps;
		const fav = bucket[String(id)];
		if (!fav) return;
		const note = window.prompt(t('site.favNotePrompt', {name: fav.name}), fav.note || '');
		if (note === null) return;
		fav.note = note.trim();
		await saveFavorites();
		renderDock();
	}

	/** Fetch a score from the API (through the background worker, cached). */
	function getScore(scoreId) {
		const key = String(scoreId);
		if (!state.scoreCache.has(key)) {
			const p = BLP.send('resolveScore', {scoreId: key});
			p.catch(() => state.scoreCache.delete(key));
			state.scoreCache.set(key, p);
		}
		return state.scoreCache.get(key);
	}

	/* ------------------------------------------------------------------ replay links */

	async function downloadReplay(parsed, btn) {
		btn && btn.classList.add('blp-busy');
		toast(t('site.downloading'));
		try {
			await BLP.send('downloadReplay', {scoreId: parsed.scoreId, link: parsed.link});
		} catch (e) {
			BLP.log.warn('download failed', e);
			toast(t('site.downloadFailed') + ' ' + e.message, 'error');
		} finally {
			btn && btn.classList.remove('blp-busy');
		}
	}

	function openEnhanced(parsed, e) {
		const s = settings();
		const url = U.buildEnhancedReplayUrl(parsed, s);
		const newTab = s.site.enhancedReplay.newTab || e.ctrlKey || e.metaKey || e.button === 1;
		if (newTab) BLP.send('openTab', {url, active: !(e.ctrlKey || e.metaKey)}).catch(() => window.open(url, '_blank'));
		else location.href = url;
	}

	function processReplayLinks() {
		const s = settings().site;
		document.querySelectorAll('a[href*="replay.beatleader."]').forEach(a => {
			if (a.dataset.blpDone || a.closest('[data-blp-ui]')) return;
			const parsed = U.parseReplayUrl(a.href);
			if (!parsed) return;
			a.dataset.blpDone = '1';
			const group = h('span', {class: 'blp-actions', 'data-blp-ui': ''});
			if (s.downloadButton) {
				const b = iconButton('⬇', t('site.download'), () => downloadReplay(parsed, b), 'blp-dl');
				group.appendChild(b);
			}
			if (s.enhancedReplayButton) group.appendChild(iconButton('✦', t('site.enhanced'), e => openEnhanced(parsed, e), 'blp-enh'));
			if (s.compare && parsed.scoreId) {
				const b = iconButton('⚖', t('site.compare'), () => toggleCompare(parsed.scoreId), 'blp-cmp');
				b.dataset.scoreId = parsed.scoreId;
				group.appendChild(b);
			}
			if (s.extraBadges && parsed.scoreId) {
				const badges = h('span', {class: 'blp-badges', 'data-blp-ui': '', dataset: {scoreId: parsed.scoreId}});
				group.appendChild(badges);
				observeBadges(badges);
			}
			if (group.childNodes.length) a.insertAdjacentElement('afterend', group);
		});
		refreshCompareButtons();
	}

	/* ------------------------------------------------------------------ favorites (stars) */

	function starButton(kind, id, name, extra) {
		const b = iconButton('☆', t('site.favorite'), () => toggleFavorite(kind, id, name, extra), 'blp-star');
		b.dataset.kind = kind;
		b.dataset.favId = String(id);
		updateStar(b);
		return b;
	}

	function updateStar(b) {
		const on = isFavorite(b.dataset.kind, b.dataset.favId);
		b.textContent = on ? '★' : '☆';
		b.classList.toggle('blp-star-on', on);
		b.title = on ? t('site.unfavorite') : t('site.favorite');
	}

	function refreshStars() {
		document.querySelectorAll('.blp-star').forEach(updateStar);
	}

	function processFavoriteLinks() {
		document.querySelectorAll('a[href*="/u/"]').forEach(a => {
			if (a.dataset.blpFav) return;
			a.dataset.blpFav = '1';
			if (isInChrome(a) || !U.SITE_HOST_RE.test(a.hostname)) return;
			const m = a.pathname.match(/^\/u\/([^/?#]+)\/?$/);
			const name = (a.textContent || '').trim();
			if (!m || !name || name.length > 64) return;
			const id = decodeURIComponent(m[1]);
			const avatar = (a.closest(ROW_SELECTOR) || a.parentElement || a).querySelector('img');
			a.insertAdjacentElement('afterend', starButton('player', id, name, {avatar: avatar ? avatar.src : ''}));
		});
		document.querySelectorAll('a[href*="/leaderboard/"]').forEach(a => {
			if (a.dataset.blpFav) return;
			a.dataset.blpFav = '1';
			if (isInChrome(a) || !U.SITE_HOST_RE.test(a.hostname)) return;
			const m = a.pathname.match(/^\/leaderboard\/[^/]+\/([^/?#]+)/);
			const name = (a.textContent || '').trim().replace(/\s+/g, ' ');
			if (!m || !name || name.length > 120) return;
			const id = decodeURIComponent(m[1]);
			a.insertAdjacentElement('afterend', starButton('map', id, name, {url: a.pathname}));
		});
	}

	/* ------------------------------------------------------------------ auto expand */

	function autoExpand() {
		document.querySelectorAll('.beat-savior-reveal:not(.opened)').forEach(el => {
			if (el.dataset.blpExpanded) return;
			el.dataset.blpExpanded = '1';
			el.click();
		});
		document.querySelectorAll('.score-options-section.tablet-and-up').forEach(el => {
			if (el.dataset.blpExpanded || el.offsetParent === null) return;
			el.dataset.blpExpanded = '1';
			el.click();
		});
	}

	/* ------------------------------------------------------------------ quick filters */

	function rows() {
		return Array.from(document.querySelectorAll(ROW_SELECTOR)).filter(r => !r.closest('[data-blp-ui]'));
	}

	function rowAccuracy(row) {
		const text = row.textContent || '';
		const re = /(\d{1,3}(?:[.,]\d+)?)\s*%/g;
		let m;
		while ((m = re.exec(text))) {
			const v = parseFloat(m[1].replace(',', '.'));
			if (v > 0 && v <= 100) return v;
		}
		return null;
	}

	function rowMatches(row, filter) {
		const s = settings().site;
		const info = pageInfo();
		switch (filter) {
			case 'mine': {
				if (!s.myPlayerId) return true;
				if (info.type === 'profile' && info.playerId === s.myPlayerId) return true;
				return !!row.querySelector(`a[href$="/u/${CSS.escape(s.myPlayerId)}"], a[href*="/u/${CSS.escape(s.myPlayerId)}/"]`);
			}
			case 'clan': {
				const tag = (s.myClanTag || '').trim().toLowerCase();
				if (!tag) return true;
				if (Array.from(row.querySelectorAll('a[href*="/clan/"]')).some(a => a.pathname.toLowerCase().replace(/\/$/, '').endsWith('/clan/' + tag))) return true;
				return Array.from(row.querySelectorAll('.clan-badges .label, .clan-badges span')).some(el => (el.textContent || '').trim().toLowerCase() === tag);
			}
			case 'highAcc': {
				const acc = rowAccuracy(row);
				return acc !== null && acc >= Number(s.highAccThreshold);
			}
			case 'favorites': {
				const players = Array.from(row.querySelectorAll('a[href*="/u/"]')).some(a => {
					const m = a.pathname.match(/^\/u\/([^/?#]+)/);
					return m && isFavorite('player', decodeURIComponent(m[1]));
				});
				const maps = Array.from(row.querySelectorAll('a[href*="/leaderboard/"]')).some(a => {
					const m = a.pathname.match(/^\/leaderboard\/[^/]+\/([^/?#]+)/);
					return m && isFavorite('map', decodeURIComponent(m[1]));
				});
				return players || maps || (info.type === 'leaderboard' && isFavorite('map', info.leaderboardId));
			}
			case 'fc':
				return /\bFC\b/.test(row.textContent || '');
			default:
				return true;
		}
	}

	function applyFilters() {
		const active = settings().site.quickFilters ? state.filter : 'all';
		for (const row of rows()) row.classList.toggle('blp-filtered-out', active !== 'all' && !rowMatches(row, active));
	}

	function setFilter(filter) {
		const s = settings().site;
		if ((filter === 'mine' && !s.myPlayerId) || (filter === 'clan' && !s.myClanTag)) toast(t('site.filterNeedId'), 'error');
		state.filter = state.filter === filter ? 'all' : filter;
		applyFilters();
		renderDock();
	}

	/* ------------------------------------------------------------------ extra badges */

	function observeBadges(el) {
		if (!state.badgeObserver) {
			state.badgeObserver = new IntersectionObserver(
				entries => {
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						state.badgeObserver.unobserve(entry.target);
						state.badgeQueue.push(entry.target);
					}
					pumpBadges();
				},
				{rootMargin: '200px'}
			);
		}
		state.badgeObserver.observe(el);
	}

	function pumpBadges() {
		while (state.badgeActive < 2 && state.badgeQueue.length) {
			const el = state.badgeQueue.shift();
			if (!el.isConnected) continue;
			state.badgeActive++;
			getScore(el.dataset.scoreId)
				.then(score => renderBadges(el, score))
				.catch(() => {})
				.finally(() => {
					state.badgeActive--;
					pumpBadges();
				});
		}
	}

	function renderBadges(el, score) {
		if (!score) return;
		el.textContent = '';
		const add = (label, value, cls) => {
			if (value === undefined || value === null) return;
			el.appendChild(h('span', {class: 'blp-badge ' + (cls || ''), title: label}, label.charAt(0) + ' ' + value));
		};
		add(t('site.badgeMisses'), score.missedNotes, score.missedNotes ? 'blp-badge-bad' : 'blp-badge-good');
		add(t('site.badgeBad'), score.badCuts, score.badCuts ? 'blp-badge-bad' : '');
		add(t('site.badgePauses'), score.pauses, score.pauses ? 'blp-badge-warn' : '');
		add(t('site.badgeCombo'), score.maxCombo);
	}

	/* ------------------------------------------------------------------ comparison */

	function toggleCompare(scoreId) {
		const id = String(scoreId);
		const i = state.compare.indexOf(id);
		if (i >= 0) state.compare.splice(i, 1);
		else {
			state.compare.push(id);
			if (state.compare.length > 2) state.compare.shift();
		}
		refreshCompareButtons();
		renderDock();
		if (state.compare.length === 2) showComparison(state.compare.slice());
		else toast(t('site.compareSelected', {n: state.compare.length}));
	}

	function refreshCompareButtons() {
		document.querySelectorAll('.blp-cmp').forEach(b => b.classList.toggle('blp-active', state.compare.includes(b.dataset.scoreId)));
	}

	async function fetchStats(scoreId) {
		try {
			return await BLP.send('fetchJson', {url: `https://cdn.scorestats.beatleader.com/${encodeURIComponent(scoreId)}.json`});
		} catch (e) {
			return null;
		}
	}

	function openModal(title, body) {
		closeModal();
		const modal = h(
			'div',
			{class: 'blp-modal-backdrop', id: 'blp-modal', 'data-blp-ui': '', onclick: e => e.target.id === 'blp-modal' && closeModal()},
			h('div', {class: 'blp-modal', role: 'dialog', 'aria-label': title}, h('div', {class: 'blp-modal-head'}, h('strong', null, title), iconButton('✕', t('common.close'), closeModal)), body)
		);
		document.body.appendChild(modal);
		document.addEventListener('keydown', escClose, true);
		return modal;
	}

	function escClose(e) {
		if (e.key === 'Escape') closeModal();
	}

	function closeModal() {
		const m = document.getElementById('blp-modal');
		if (m) m.remove();
		document.removeEventListener('keydown', escClose, true);
	}

	async function showComparison(ids) {
		const body = h('div', {class: 'blp-modal-body'}, h('p', {class: 'blp-muted'}, t('site.compareLoading')));
		openModal(t('site.compareTitle'), body);
		try {
			const [a, b] = await Promise.all(ids.map(getScore));
			const [sa, sb] = await Promise.all(ids.map(fetchStats));
			body.textContent = '';
			body.appendChild(buildComparisonTable([a, b], [sa, sb]));
		} catch (e) {
			body.textContent = t('site.loadFailed') + ' ' + e.message;
		}
	}

	function buildComparisonTable(scores, stats) {
		const pct = v => (typeof v === 'number' ? (v <= 1.0001 ? v * 100 : v).toFixed(2) + '%' : '—');
		const num = (v, d = 0) => (typeof v === 'number' ? U.formatNumber(v, d) : '—');
		const hand = (score, st, side) => {
			const direct = score && score['acc' + side];
			const tracked = st && st.accuracyTracker && st.accuracyTracker['acc' + side];
			const v = typeof direct === 'number' && direct > 0 ? direct : tracked;
			return typeof v === 'number' ? v : null;
		};
		const rowsDef = [
			[t('site.statAcc'), s => s.accuracy, pct, 'high'],
			[t('site.statPP'), s => s.pp, v => num(v, 2), 'high'],
			[t('site.statRank'), s => s.rank, v => (v ? '#' + v : '—'), 'low'],
			[t('site.statScore'), s => s.modifiedScore || s.baseScore, v => num(v), 'high'],
			[t('site.statFcAcc'), s => s.fcAccuracy, pct, 'high'],
			[t('site.statMisses'), s => s.missedNotes, v => num(v), 'low'],
			[t('site.statBadCuts'), s => s.badCuts, v => num(v), 'low'],
			[t('site.statBombs'), s => s.bombCuts, v => num(v), 'low'],
			[t('site.statWalls'), s => s.wallsHit, v => num(v), 'low'],
			[t('site.statPauses'), s => s.pauses, v => num(v), 'low'],
			[t('site.statMaxCombo'), s => s.maxCombo, v => num(v), 'high'],
			[t('site.statFc'), s => s.fullCombo, v => (v ? '✔' : '✘'), null],
			[t('site.statAccLeft'), (s, st) => hand(s, st, 'Left'), v => num(v, 2), 'high'],
			[t('site.statAccRight'), (s, st) => hand(s, st, 'Right'), v => num(v, 2), 'high'],
			[t('site.statModifiers'), s => s.modifiers || '', v => v || '—', null],
			[t('site.statHmd'), s => s.hmd, v => HMD_NAMES[v] || (v !== undefined ? '#' + v : '—'), null],
			[t('site.statDate'), s => Number(s.timepost || s.timeset), v => (v ? new Date(v * 1000).toLocaleString() : '—'), null],
		];
		const header = scores.map(s =>
			h(
				'th',
				null,
				h('div', {class: 'blp-cmp-player'}, s && s.player && s.player.avatar ? h('img', {src: s.player.avatar, alt: ''}) : null, h('span', null, (s && s.player && s.player.name) || '?')),
				h('div', {class: 'blp-muted'}, (s && s.song && s.song.name) || '', s && s.difficulty ? ' · ' + (s.difficulty.difficultyName || '') : '')
			)
		);
		const table = h('table', {class: 'blp-cmp-table'}, h('thead', null, h('tr', null, h('th', null, ''), header, h('th', null, 'Δ'))));
		const tbody = h('tbody');
		for (const [label, get, fmt, better] of rowsDef) {
			const va = scores[0] ? get(scores[0], stats[0]) : null;
			const vb = scores[1] ? get(scores[1], stats[1]) : null;
			const cells = [va, vb].map((v, i) => {
				const other = i === 0 ? vb : va;
				let cls = '';
				if (better && typeof v === 'number' && typeof other === 'number' && v !== other) {
					const wins = better === 'high' ? v > other : v < other;
					cls = wins ? 'blp-win' : 'blp-lose';
				}
				return h('td', {class: cls}, fmt(v));
			});
			let delta = '';
			if (typeof va === 'number' && typeof vb === 'number' && better) {
				let d = vb - va;
				if (label === t('site.statAcc') || label === t('site.statFcAcc')) d = d * (Math.abs(va) <= 1.0001 ? 100 : 1);
				delta = (d > 0 ? '+' : '') + (Math.abs(d) < 10 ? d.toFixed(2) : Math.round(d));
			}
			tbody.appendChild(h('tr', null, h('th', null, label), cells, h('td', {class: 'blp-muted'}, delta)));
		}
		table.appendChild(tbody);
		const links = h(
			'div',
			{class: 'blp-row-actions'},
			scores.map(s =>
				s && s.id
					? h('a', {class: 'blp-btn', href: U.buildEnhancedReplayUrl({scoreId: s.id}, settings()), target: '_blank', rel: 'noopener'}, '✦ ' + ((s.player && s.player.name) || s.id))
					: null
			),
			h(
				'button',
				{
					class: 'blp-btn',
					type: 'button',
					onclick: () => {
						state.compare = [];
						refreshCompareButtons();
						renderDock();
						closeModal();
					},
				},
				t('site.compareClear')
			)
		);
		return h('div', null, table, links);
	}

	/* ------------------------------------------------------------------ dock */

	function dockEl() {
		let dock = document.getElementById('blp-dock');
		if (!dock) {
			dock = h('div', {id: 'blp-dock', class: 'blp-dock', 'data-blp-ui': ''});
			document.body.appendChild(dock);
		}
		return dock;
	}

	function profileNameGuess() {
		const title = (document.title || '').split(/\s[|–-]\s/)[0].trim();
		const heading = document.querySelector('.player-name, .player-card .name, h1');
		return (heading && heading.textContent.trim()) || title || '';
	}

	function renderDock() {
		if (!enabled() || state.hidden) {
			const d = document.getElementById('blp-dock');
			if (d) d.remove();
			return;
		}
		const s = settings().site;
		const info = pageInfo();
		const dock = dockEl();
		dock.textContent = '';
		const items = [];

		if (info.type === 'profile') {
			const id = info.playerId;
			const name = profileNameGuess() || id;
			if (s.favorites) {
				const fav = isFavorite('player', id);
				items.push(h('button', {class: 'blp-chip' + (fav ? ' blp-active' : ''), type: 'button', onclick: () => toggleFavorite('player', id, name)}, (fav ? '★ ' : '☆ ') + t(fav ? 'site.unfavorite' : 'site.favorite')));
				if (fav) items.push(h('button', {class: 'blp-chip', type: 'button', title: state.favorites.players[id].note || '', onclick: () => editFavoriteNote('player', id)}, '✎ ' + (state.favorites.players[id].note ? state.favorites.players[id].note.slice(0, 24) : t('common.notes'))));
			}
			if (s.follow.enabled) {
				const following = !!state.followed[id];
				items.push(
					h(
						'button',
						{
							class: 'blp-chip' + (following ? ' blp-active' : ''),
							type: 'button',
							onclick: async () => {
								try {
									if (following) {
										await BLP.send('unfollow', {playerId: id});
										toast(t('site.unfollowed', {name}));
									} else {
										await BLP.send('follow', {playerId: id, name});
										toast(t('site.followed', {name}), 'success');
									}
									await loadFollowed();
									renderDock();
								} catch (e) {
									toast(e.message, 'error');
								}
							},
						},
						(following ? '🔕 ' : '🔔 ') + t(following ? 'site.unfollow' : 'site.follow')
					)
				);
			}
			if (s.profileStats && BLP.profileStats) {
				items.push(h('button', {class: 'blp-chip', type: 'button', onclick: () => BLP.profileStats.open(id, name)}, '📊 ' + t('site.profileStats')));
			}
		}

		if (info.type === 'leaderboard' && s.favorites) {
			const id = info.leaderboardId;
			const name = (document.title || '').split('|')[0].trim() || id;
			const fav = isFavorite('map', id);
			items.push(h('button', {class: 'blp-chip' + (fav ? ' blp-active' : ''), type: 'button', onclick: () => toggleFavorite('map', id, name, {url: location.pathname})}, (fav ? '★ ' : '☆ ') + t(fav ? 'site.unfavorite' : 'site.favorite')));
			if (fav) items.push(h('button', {class: 'blp-chip', type: 'button', onclick: () => editFavoriteNote('map', id)}, '✎ ' + (state.favorites.maps[id].note ? state.favorites.maps[id].note.slice(0, 24) : t('common.notes'))));
		}

		if (s.quickFilters && rows().length) {
			const chip = (key, label) => h('button', {class: 'blp-chip' + (state.filter === key ? ' blp-active' : ''), type: 'button', title: t('site.filterHint'), onclick: () => setFilter(key)}, label);
			items.push(
				h(
					'span',
					{class: 'blp-dock-group'},
					h('span', {class: 'blp-dock-label'}, t('site.filters')),
					chip('mine', t('site.filterMine')),
					chip('clan', t('site.filterClan')),
					chip('highAcc', t('site.filterHighAcc', {acc: s.highAccThreshold})),
					s.favorites ? chip('favorites', t('site.filterFavorites')) : null,
					chip('fc', t('site.filterFc'))
				)
			);
		}

		if (s.compare && state.compare.length) {
			items.push(
				h(
					'span',
					{class: 'blp-dock-group'},
					h('span', {class: 'blp-dock-label'}, t('site.compareSelected', {n: state.compare.length})),
					state.compare.length === 2 ? h('button', {class: 'blp-chip blp-active', type: 'button', onclick: () => showComparison(state.compare.slice())}, '⚖ ' + t('site.compare')) : null,
					h(
						'button',
						{
							class: 'blp-chip',
							type: 'button',
							onclick: () => {
								state.compare = [];
								refreshCompareButtons();
								renderDock();
							},
						},
						'✕'
					)
				)
			);
		}

		if (!items.length) {
			dock.remove();
			return;
		}
		dock.appendChild(h('span', {class: 'blp-dock-brand', title: 'BeatLeaderPlus'}, 'BL+'));
		items.forEach(i => dock.appendChild(i));
	}

	/* ------------------------------------------------------------------ pagination (hotkeys) */

	function clickPager(direction) {
		const icon = direction > 0 ? '.fa-chevron-right' : '.fa-chevron-left';
		const btn = Array.from(document.querySelectorAll('nav.pagination button.pagination-link, nav.pagination a.pagination-link')).find(b => b.querySelector(icon));
		if (btn) {
			btn.click();
			return true;
		}
		const rel = document.querySelector(direction > 0 ? 'a[rel="next"]' : 'a[rel="prev"]');
		if (rel) {
			rel.click();
			return true;
		}
		return false;
	}

	/* ------------------------------------------------------------------ lifecycle */

	function teardown() {
		document.querySelectorAll('[data-blp-ui]').forEach(el => {
			if (el.id !== 'blp-toasts') el.remove();
		});
		document.querySelectorAll('[data-blp-done],[data-blp-fav],[data-blp-expanded]').forEach(el => {
			delete el.dataset.blpDone;
			delete el.dataset.blpFav;
		});
		document.querySelectorAll('.blp-filtered-out').forEach(el => el.classList.remove('blp-filtered-out'));
		if (state.badgeObserver) {
			state.badgeObserver.disconnect();
			state.badgeObserver = null;
		}
		state.badgeQueue = [];
	}

	function scan() {
		if (!enabled()) {
			teardown();
			return;
		}
		if (location.href !== state.lastUrl) {
			state.lastUrl = location.href;
			state.filter = 'all';
			closeModal();
			if (BLP.profileStats) BLP.profileStats.close();
		}
		const s = settings().site;
		if (!state.hidden) {
			processReplayLinks();
			if (s.favorites) processFavoriteLinks();
		}
		if (s.autoExpandDetails) autoExpand();
		applyFilters();
		renderDock();
	}

	const scheduleScan = U.debounce(scan, 200);

	BLP.site = {
		async start() {
			if (state.started) return;
			state.started = true;
			await Promise.all([loadFavorites(), loadFollowed()]);
			storage.onLocalChanged(D.KEYS.favorites, async () => {
				await loadFavorites();
				refreshStars();
				renderDock();
			});
			storage.onLocalChanged(D.KEYS.follow, async () => {
				await loadFollowed();
				renderDock();
			});
			state.observer = new MutationObserver(mutations => {
				// Ignore mutations caused only by our own UI.
				for (const m of mutations) {
					const target = m.target;
					if (target.nodeType === 1 && target.closest && target.closest('[data-blp-ui]')) continue;
					const onlyOurs = Array.from(m.addedNodes).every(n => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-blp-ui'));
					if (m.addedNodes.length && onlyOurs) continue;
					scheduleScan();
					return;
				}
			});
			state.observer.observe(document.body, {childList: true, subtree: true});
			window.addEventListener('popstate', scheduleScan);
			// SPA route changes don't always produce DOM mutations quickly; poll the URL as a fallback.
			setInterval(() => location.href !== state.lastUrl && scheduleScan(), 700);
			scan();
		},

		/** Re-render after a settings change. */
		refresh() {
			teardown();
			scan();
		},

		/** Toggle visibility of everything BLP injected into the website (overlay hotkey). */
		toggleUi() {
			state.hidden = !state.hidden;
			document.documentElement.classList.toggle('blp-ui-hidden', state.hidden);
			renderDock();
			return !state.hidden;
		},

		nextPage: () => clickPager(1),
		prevPage: () => clickPager(-1),
		toast,
		pageInfo,
		openModal,
		closeModal,
		iconButton,
	};
})();
