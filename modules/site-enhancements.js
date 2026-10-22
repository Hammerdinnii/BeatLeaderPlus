/*
 * BeatLeaderPlus – website enhancements (content script, isolated world).
 *
 * Features (each individually switchable in options → Website enhancements):
 *   - "Download .bsor" and compare buttons next to every replay link
 *   - score comparison (select two scores → side-by-side modal)
 *   - auto-expand score details
 *   - quick filters (my scores, clan, high accuracy, full combo)
 *   - optional extra badges (misses / bad cuts / pauses / max combo) fetched from the API
 *   - a floating "dock" with page-specific actions (filters, comparison tray, profile statistics)
 *
 * Following and favoriting players and maps are BeatLeader's own: its follow button and
 * "Add to playlist".
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
		compare: [],
		filter: 'all',
		dockOpen: false,
		dockPos: {edge: 'bottom', pos: 0.5}, // the edge it sits on and where along it (0–1)
		dockDragged: false,
		dockBrand: null,
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

	/** icon: Font Awesome classes (the site loads Font Awesome) or plain text such as ✕. */
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
			/^fa[srb]? /.test(icon) ? h('i', {class: icon, 'aria-hidden': 'true'}) : icon
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

	/* ------------------------------------------------------------------ data */

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

	function processReplayLinks() {
		const s = settings().site;
		document.querySelectorAll('a[href*="replay.beatleader."]').forEach(a => {
			if (a.dataset.blpDone || a.closest('[data-blp-ui]')) return;
			const parsed = U.parseReplayUrl(a.href);
			if (!parsed) return;
			a.dataset.blpDone = '1';
			// Score rows put their icons in a grid that forces every item into a 22px cell
			// (.buttons-container > span > *). There our buttons join the grid one by one, styled
			// like the site's own, instead of as one group squeezed into a single cell.
			const grid = a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.classList.contains('buttons-container') ? a.closest('.buttons-container') : null;
			const buttons = [];
			// The site reuses link elements for other scores, so read the link when clicked.
			const current = () => U.parseReplayUrl(a.href) || parsed;
			// The site has its own .bsor download icon, if the user turned it on.
			const siteDownload = grid && Array.from(grid.querySelectorAll('a[href]')).some(x => /\.bsor(\?|$)/i.test(x.getAttribute('href')) && !/replay\.beatleader\./.test(x.href));
			if (s.downloadButton && !siteDownload) {
				const b = iconButton('fas fa-download', t('site.download'), () => downloadReplay(current(), b), 'blp-dl');
				buttons.push(b);
			}
			if (s.compare && parsed.scoreId) {
				const b = iconButton('fas fa-balance-scale', t('site.compare'), () => toggleCompare(current().scoreId), 'blp-cmp');
				b.dataset.scoreId = parsed.scoreId;
				b.__blpScore = current;
				buttons.push(b);
			}
			let badges = null;
			if (s.extraBadges && parsed.scoreId) {
				badges = h('span', {class: 'blp-badges', 'data-blp-ui': '', dataset: {scoreId: parsed.scoreId}});
				observeBadges(badges);
			}
			if (grid) {
				buttons.forEach(b => b.classList.add('blp-site-icon'));
				a.after(...buttons);
				// Badges are wider than a grid cell: put them after the whole button layout.
				if (badges) (grid.closest('.score-action-buttons-layout, .score-action-icons-layout') || grid).after(badges);
			} else {
				const group = h('span', {class: 'blp-actions', 'data-blp-ui': ''}, ...buttons);
				if (badges) group.appendChild(badges);
				if (group.childNodes.length) a.insertAdjacentElement('afterend', group);
			}
		});
		refreshCompareButtons();
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
		document.querySelectorAll('.blp-cmp').forEach(b => {
			if (b.__blpScore) b.dataset.scoreId = b.__blpScore().scoreId || '';
			b.classList.toggle('blp-active', state.compare.includes(b.dataset.scoreId));
		});
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
			[t('site.statFc'), s => s.fullCombo, v => t(v ? 'common.yes' : 'common.no'), null],
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
					? h('a', {class: 'blp-btn', href: U.replayUrl({scoreId: s.id}), target: '_blank', rel: 'noopener'}, h('i', {class: 'fas fa-play', 'aria-hidden': 'true'}), ' ' + ((s.player && s.player.name) || s.id))
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

	/* ------------------------------------------------------------------ dock position (drag to move) */

	const DOCK_EDGES = ['top', 'bottom', 'left', 'right'];
	const DOCK_MARGIN = 8;
	const DOCK_GAP = 14; // distance from the edge it sits on

	const viewport = () => ({w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight});

	function cleanDockPos(p) {
		const edge = p && DOCK_EDGES.includes(p.edge) ? p.edge : 'bottom';
		const pos = p && isFinite(p.pos) ? U.clamp(Number(p.pos), 0, 1) : 0.5;
		return {edge, pos};
	}

	/** The nearest edge to a point, and how far along that edge it is. */
	function dockPosAt(x, y) {
		const {w, h: hgt} = viewport();
		const dist = {left: x, right: w - x, top: y, bottom: hgt - y};
		const edge = DOCK_EDGES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
		const vertical = edge === 'left' || edge === 'right';
		return {edge, pos: U.clamp(vertical ? y / hgt : x / w, 0, 1)};
	}

	/**
	 * Vertical along the left and right edges, horizontal along the top and bottom, so the open dock
	 * runs along the edge instead of across the page. The BL+ button stays where it was put and the
	 * other controls open towards the middle of the window.
	 */
	function setDockOrientation(dock, p) {
		const vertical = p.edge === 'left' || p.edge === 'right';
		dock.classList.toggle('blp-dock-v', vertical);
		dock.classList.toggle('blp-dock-h', !vertical);
		dock.classList.toggle('blp-dock-rev', p.pos > 0.5);
		dock.dataset.edge = p.edge;
	}

	/** Offset of the BL+ button's centre inside the dock. */
	function brandCenter(dock) {
		const r = dock.getBoundingClientRect();
		const brand = dock.querySelector('.blp-dock-brand');
		const b = brand ? brand.getBoundingClientRect() : r;
		return {x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height / 2, w: r.width, h: r.height};
	}

	function placeDock(dock, left, top, size) {
		const {w, h: hgt} = viewport();
		dock.style.left = Math.round(U.clamp(left, DOCK_MARGIN, Math.max(DOCK_MARGIN, w - size.w - DOCK_MARGIN))) + 'px';
		dock.style.top = Math.round(U.clamp(top, DOCK_MARGIN, Math.max(DOCK_MARGIN, hgt - size.h - DOCK_MARGIN))) + 'px';
	}

	function layoutDock(dock) {
		if (!dock || !dock.isConnected) return;
		const p = state.dockPos;
		const {w, h: hgt} = viewport();
		setDockOrientation(dock, p);
		dock.style.left = '0px'; // measure at the origin, where nothing squeezes it
		dock.style.top = '0px';
		const c = brandCenter(dock);
		if (p.edge === 'top' || p.edge === 'bottom') placeDock(dock, p.pos * w - c.x, p.edge === 'top' ? DOCK_GAP : hgt - c.h - DOCK_GAP, c);
		else placeDock(dock, p.edge === 'left' ? DOCK_GAP : w - c.w - DOCK_GAP, p.pos * hgt - c.y, c);
	}

	function saveDockPos() {
		storage.updateLocal(D.KEYS.siteUi, {}, ui => Object.assign(ui, {dock: state.dockPos})).catch(() => {});
	}

	function startDockDrag(e) {
		if (e.button !== 0) return;
		const dock = document.getElementById('blp-dock');
		if (!dock) return;
		const start = {x: e.clientX, y: e.clientY};
		const c0 = brandCenter(dock);
		const r0 = dock.getBoundingClientRect();
		const grab = {x: start.x - (r0.left + c0.x), y: start.y - (r0.top + c0.y)}; // pointer vs. button centre
		let dragging = false;
		const move = ev => {
			if (!dragging) {
				if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
				dragging = true;
				dock.classList.add('blp-dock-dragging');
			}
			ev.preventDefault();
			// Follow the pointer, switching between vertical and horizontal as it nears another edge.
			setDockOrientation(dock, dockPosAt(ev.clientX, ev.clientY));
			const c = brandCenter(dock);
			placeDock(dock, ev.clientX - grab.x - c.x, ev.clientY - grab.y - c.y, c);
		};
		const end = ev => {
			window.removeEventListener('pointermove', move, true);
			window.removeEventListener('pointerup', end, true);
			window.removeEventListener('pointercancel', end, true);
			if (!dragging) return;
			dock.classList.remove('blp-dock-dragging');
			state.dockPos = dockPosAt(ev.clientX, ev.clientY);
			state.dockDragged = true; // the click that ends a drag doesn't open or close the dock
			setTimeout(() => (state.dockDragged = false), 0);
			layoutDock(dock);
			saveDockPos();
		};
		window.addEventListener('pointermove', move, true);
		window.addEventListener('pointerup', end, true);
		window.addEventListener('pointercancel', end, true);
	}

	function resetDockPos() {
		state.dockPos = cleanDockPos(null);
		layoutDock(document.getElementById('blp-dock'));
		saveDockPos();
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
			if (s.profileStats && BLP.profileStats) {
				items.push(h('button', {class: 'blp-chip', type: 'button', onclick: () => BLP.profileStats.open(id, name)}, t('site.profileStats')));
			}
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
					state.compare.length === 2 ? h('button', {class: 'blp-chip blp-active', type: 'button', onclick: () => showComparison(state.compare.slice())}, t('site.compare')) : null,
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
		// Collapsed to the BL+ button until clicked. A dot marks an active filter or comparison.
		const busy = state.filter !== 'all' || state.compare.length > 0;
		dock.classList.toggle('blp-dock-open', state.dockOpen);
		dock.style.setProperty('--blp-dock-scale', U.clamp(Number(s.dockSize) || 100, 60, 200) / 100);
		// The same button every time, so it keeps keyboard focus and double-clicks reach it.
		const brand = (state.dockBrand =
			state.dockBrand ||
			h(
				'button',
				{
					class: 'blp-dock-brand',
					type: 'button',
					onpointerdown: startDockDrag,
					ondblclick: resetDockPos,
					onclick: () => {
						if (state.dockDragged) return;
						state.dockOpen = !state.dockOpen;
						renderDock();
					},
				},
				'BL+',
				h('span', {class: 'blp-dock-dot'})
			));
		brand.title = t('site.dockToggle');
		brand.setAttribute('aria-expanded', String(state.dockOpen));
		brand.querySelector('.blp-dock-dot').hidden = !(busy && !state.dockOpen);
		dock.appendChild(brand);
		if (state.dockOpen) items.forEach(i => dock.appendChild(i));
		layoutDock(dock);
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
		document.querySelectorAll('[data-blp-done]').forEach(el => delete el.dataset.blpDone);
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
		if (!state.hidden) processReplayLinks();
		if (s.autoExpandDetails) autoExpand();
		applyFilters();
		renderDock();
	}

	const scheduleScan = U.debounce(scan, 200);

	BLP.site = {
		async start() {
			if (state.started) return;
			state.started = true;
			state.dockPos = cleanDockPos(((await storage.getLocal(D.KEYS.siteUi, {})) || {}).dock);
			// Moved in another tab: follow it here too.
			storage.onLocalChanged(D.KEYS.siteUi, ui => {
				state.dockPos = cleanDockPos(ui && ui.dock);
				layoutDock(document.getElementById('blp-dock'));
			});
			window.addEventListener('resize', U.debounce(() => layoutDock(document.getElementById('blp-dock')), 100));
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
			// href changes too: the site reuses link elements for other players and scores.
			state.observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['href']});
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
