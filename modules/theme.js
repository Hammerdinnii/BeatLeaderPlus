/*
 * BeatLeaderPlus – website theme engine (content script, isolated world).
 *
 * Generates one <style> element from the settings and keeps it up to date. Runs at
 * document_start so the custom palette is applied before first paint.
 *
 * The BeatLeader website is themed through CSS custom properties (--background, --foreground,
 * --textColor, --beatleader-primary, ...). We re-map those to our --blp-* palette so every
 * component picks up the theme without per-component rules. Everything BLP adds to the page
 * uses the --blp-* variables directly (see styles/theme.css).
 */
(function () {
	'use strict';

	const BLP = (globalThis.BLP = globalThis.BLP || {});
	if (BLP.theme) return;
	const U = BLP.utils;

	const STYLE_ID = 'blp-theme-style';
	const CUSTOM_ID = 'blp-custom-css';

	/** Named groups of selectors for the "hide page elements" switches. */
	const HIDE_GROUPS = {
		header: ['nav.ssr-page-container', 'body > nav', '.navbar', 'header.site-header'],
		footer: ['footer', '.footer'],
		sidebars: ['aside', '.aside', '.sidebar', '.side-bar', '.maps-aside-container', '.aside-box'],
		social: [
			'a[href*="twitter.com"]',
			'a[href*="//x.com"]',
			'a[href*="discord.gg"]',
			'a[href*="discord.com/invite"]',
			'a[href*="patreon.com"]',
			'a[href*="youtube.com"]',
			'a[href*="twitch.tv"]',
			'.followers-and-socials',
			'.social-buttons',
			'.socials',
		],
		ads: ['ins.adsbygoogle', '[id^="google_ads"]', 'iframe[src*="doubleclick"]', '.ad-container', '[class*="advert"]', '[data-ad-slot]'],
		banners: ['.announcement', '.announcements', '[class*="announcement"]', '.event-banner', '.banner-container', '.notification-bar'],
		avatars: ['.player-avatar', 'img.avatar', '.avatar img', '.avatar'],
		hmdIcons: ['.hmd-image-container', '.hmd-icon'],
		flags: ['img[src*="/flags/"]', 'img[src*="flagcdn"]', '.country-flag', '.flag'],
		cinematics: ['.cinematics', '.cinematics-canvas'],
	};

	function cssVars(c, settings) {
		const t = settings.theme;
		const hover = U.mixColors(c.surface, c.text, 0.07);
		const highlight = U.mixColors(c.surface, c.primary, 0.18);
		return `
:root {
	--blp-primary: ${c.primary};
	--blp-secondary: ${c.secondary};
	--blp-bg: ${c.background};
	--blp-surface: ${c.surface};
	--blp-text: ${c.text};
	--blp-muted: ${c.textMuted};
	--blp-accent: ${c.accent};
	--blp-link: ${c.link};
	--blp-border: ${c.border};
	--blp-success: ${c.success};
	--blp-danger: ${c.danger};
	--blp-rank1: ${c.rank1};
	--blp-rank2: ${c.rank2};
	--blp-rank3: ${c.rank3};
	--blp-radius: ${Number(t.radius) || 0}px;
	--blp-hover: ${hover};
	--blp-on-primary: ${U.contrastText(c.primary)};
}
/* html:root has higher specificity than the site's :root rules, so we win even against
   site themes that also use !important, regardless of stylesheet order. */
html:root, html:root body, html:root main {
	--background: ${c.background} !important;
	--foreground: ${c.surface} !important;
	--textColor: ${c.text} !important;
	--color: ${c.text} !important;
	--linkColor: ${c.link} !important;
	--linkHoverColor: ${U.mixColors(c.link, c.text, 0.3)} !important;
	--alternate: ${c.accent} !important;
	--selected: ${c.primary} !important;
	--hover: ${hover} !important;
	--highlight: ${highlight} !important;
	--increase: ${c.success} !important;
	--decrease: ${c.danger} !important;
	--dimmed: ${c.border} !important;
	--row-separator: ${c.border} !important;
	--faded: ${c.textMuted} !important;
	--ppColour: ${c.accent} !important;
	--beatleader-primary: ${c.primary} !important;
	--beatleader-secondary: ${c.secondary} !important;
	--customizable-color-1: ${U.withAlpha(c.surface, 0.55)} !important;
	--customizable-color-2: ${U.withAlpha(c.text, 0.06)} !important;
	--bg-color: ${c.primary} !important;
	--accent-color: ${c.accent} !important;
}
html, body {
	background-color: ${c.background} !important;
	color: ${c.text} !important;
}
.main-background { background-color: ${c.background} !important; }
:where(html.blp-themed) :where(a:not([class])) { color: ${c.link}; }
.darkened-background, .bottom-container-background, .leaderboard-header-box, .map-card-wrapper {
	background-color: ${c.surface} !important;
}
::selection { background: ${U.withAlpha(c.primary, 0.45)}; }
[style*="--background-color:darkgoldenrod"], [style*="--background-color: darkgoldenrod"] { --background-color: ${c.rank1} !important; --color: ${U.contrastText(c.rank1)} !important; }
[style*="--background-color:#888"], [style*="--background-color: #888"] { --background-color: ${c.rank2} !important; --color: ${U.contrastText(c.rank2)} !important; }
[style*="--background-color:saddlebrown"], [style*="--background-color: saddlebrown"] { --background-color: ${c.rank3} !important; --color: ${U.contrastText(c.rank3)} !important; }
`;
	}

	function typographyCss(settings) {
		const f = settings.theme.font || {};
		let css = '';
		if (f.family && f.family.trim()) {
			const family = f.family.replace(/[;{}<>]/g, '');
			css += `body, button, input, select, textarea, .title, .subtitle { font-family: ${family}, system-ui, sans-serif !important; }\n`;
		}
		if (f.size && Number(f.size) !== 100) css += `html { font-size: ${Number(f.size)}% !important; }\n`;
		if (f.weight && Number(f.weight) > 0) css += `body { font-weight: ${Number(f.weight)} !important; }\n`;
		return css;
	}

	function densityCss(settings) {
		const t = settings.theme;
		let css = '';
		const d = Number(t.density) || 100;
		if (d !== 100) css += `main { zoom: ${(d / 100).toFixed(3)}; }\n`;
		if (t.compact) {
			css += `
.player-score, .song-score, .score-row, .ranking-item { padding-top: 0.2em !important; padding-bottom: 0.2em !important; min-height: 0 !important; }
.box, .content-box { padding: 0.6em !important; margin-bottom: 0.6em !important; }
.player-score .player, .song-score .song { gap: 0.3em !important; }
body { line-height: 1.3 !important; }
.cinematics { display: none !important; }
`;
		}
		const r = Number(t.radius);
		if (!isNaN(r) && r !== 8) css += `.box, .content-box, .button, .player-score, .song-score { border-radius: ${r}px !important; }\n`;
		return css;
	}

	function hideCss(settings) {
		const t = settings.theme;
		const selectors = [];
		for (const group of Object.keys(HIDE_GROUPS)) {
			if (t.hide && t.hide[group]) selectors.push(...HIDE_GROUPS[group]);
		}
		let css = selectors.length ? selectors.join(',\n') + ' { display: none !important; }\n' : '';
		if (t.hide && t.hide.backgroundImages) {
			css += `.main-background, .cinematics, [class*="background-image"], [class*="cover-background"] { background-image: none !important; }\n`;
		}
		const custom = String(t.hideSelectors || '')
			.split('\n')
			.map(s => s.trim())
			.filter(s => s && !/[{}<>]/.test(s));
		// One rule per selector so a single invalid selector does not disable the others.
		for (const sel of custom) css += `${sel} { display: none !important; }\n`;
		return css;
	}

	function upsertStyle(id, css) {
		let el = document.getElementById(id);
		if (!css) {
			if (el) el.remove();
			return;
		}
		if (!el) {
			el = document.createElement('style');
			el.id = id;
			el.setAttribute('data-blp', '');
		}
		if (el.textContent !== css) el.textContent = css;
		// Keep our styles last so they win over late-loaded site styles.
		const parent = document.head || document.documentElement;
		if (el.parentNode !== parent || el.nextElementSibling) parent.appendChild(el);
	}

	const theme = {
		HIDE_GROUPS,

		/** Build the full CSS for a settings object (also used by the options page live preview). */
		buildCss(settings, {isReplay = false} = {}) {
			if (!settings || !settings.general.enabled) return '';
			const t = settings.theme;
			let css = '';
			if (isReplay) {
				if (t.applyToReplay) css += typographyCss(settings);
				return css;
			}
			if (t.enabled) {
				css += cssVars(t.colors, settings);
				css += typographyCss(settings);
				css += densityCss(settings);
			}
			css += hideCss(settings);
			return css;
		},

		buildCustomCss(settings, {isReplay = false} = {}) {
			if (!settings || !settings.general.enabled) return '';
			const t = settings.theme;
			if (!t.customCssEnabled || !t.customCss) return '';
			if (isReplay && !t.applyToReplay) return '';
			return t.customCss;
		},

		apply(settings) {
			const isReplay = !!(BLP.page && BLP.page.isReplayHost);
			// Content scripts also match CDN subdomains (raw JSON / files); only style real pages.
			if (BLP.page && !BLP.page.isSiteHost && !isReplay) return theme.remove();
			const run = () => {
				upsertStyle(STYLE_ID, theme.buildCss(settings, {isReplay}));
				upsertStyle(CUSTOM_ID, theme.buildCustomCss(settings, {isReplay}));
				document.documentElement.classList.toggle('blp-themed', !!(settings.general.enabled && settings.theme.enabled && !isReplay));
			};
			run();
			// At document_start <head> may not exist yet; re-append once it does so we stay last.
			if (!document.head) {
				document.addEventListener('DOMContentLoaded', run, {once: true});
			}
		},

		remove() {
			upsertStyle(STYLE_ID, '');
			upsertStyle(CUSTOM_ID, '');
			document.documentElement.classList.remove('blp-themed');
		},
	};

	BLP.theme = theme;
})();
