# BeatLeaderPlus

A Manifest V3 Chrome extension that adds a customizable enhancement layer to [BeatLeader](https://beatleader.com) and, above all, to its **web replay viewer** (`replay.beatleader.com` / `replay.beatleader.xyz`, including replays embedded in iframes).

It adds features the site doesn't have: a camera system with free fly, orbit, follow, presets and recorded camera paths; saber, trail, note and environment visuals; frame stepping, reverse playback, A-B loops and bookmarks; a live stats HUD; custom hitsounds; screenshots and clip recording; and website extras such as `.bsor` downloads, favorites, follows, filters, score comparison and profile statistics. Almost everything is configurable, and changes apply to open tabs straight away.

> BeatLeaderPlus is a community project and is not affiliated with BeatLeader.

---

## Installation (load unpacked)

1. Download or clone this repository:
   ```sh
   git clone https://github.com/hammerdinnii/BeatLeaderPlus.git
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `BeatLeaderPlus` folder, the one that contains `manifest.json`.
5. Optional: pin the extension from the puzzle-piece menu. `Alt+Shift+B` opens the popup.

On first install the options page opens. There is no build step and there are no runtime dependencies. The files in this folder are the extension.

To update, pull the latest changes and click the reload icon on the extension's card in `chrome://extensions`.

Requires Chrome 111 or newer (or another Chromium-based browser).

---

## Features

### Website: theme and UI

- **Theme editor**: primary, secondary, background, surface, text, muted text, accent, links, borders, positive/negative and the rank #1/#2/#3 colors. BeatLeaderPlus remaps the site's own CSS variables, so every component follows the theme.
- **Presets**: Dark+, OLED Black, Light, High Contrast and Custom. The options page shows a live preview.
- **Typography**: font family, size and weight overrides.
- **Density slider** and **compact mode**, plus a corner-radius setting.
- **Hide elements**: named groups (header, footer, sidebars, social links, ads, banners, avatars, headset icons, flags, background images, cinematics) or your own CSS selectors.
- **Custom CSS** box. You can also apply your font and custom CSS inside the replay viewer.
- **Customizable keyboard shortcuts** for everything (see below).

### Replay viewer: camera

- **Free camera** (`C`): pointer-lock mouse look (or right-drag), `WASD` + `E`/`Q` to fly, `Shift` to sprint, with adjustable speed, sensitivity and invert-Y.
- **Orbit** around the player's head or the play-space center, with radius, height, speed and start angle.
- **Smooth follow**: follows the head or the play-space center, with lag, look-ahead and a world-space or head-relative offset.
- **First person**: strict (the official POV), or smooth with roll removal and offsets.
- **Field of view** slider and **camera smoothing** strength.
- **Camera presets** with names and hotkeys. Six built-ins ship by default (Cinematic Low, Top Down, Side Follow, First Person Strict, First Person Smooth, Orbit Showcase), and you can save the live camera as a new preset.
- **Camera paths**: record position, rotation and FOV over song time (`Shift+G`), add keyframes manually (`Alt+G`), then play back with spline interpolation (`G`). Paths can be renamed, exported or imported as JSON, or **shared via a URL**.
- **Replace the official camera UI** with the BeatLeaderPlus panel.
- **URL parameters** force a preset, mode or path on load (see below).

### Replay viewer: visuals and sabers

- **Saber colors** for each hand (applied through the replayer's own color pipeline, so handles, glow and trails all follow).
- **Trails**: color (follow the saber or custom), length, thickness (blade coverage), and opacity/brightness.
- **Glow intensity** and **blade thickness**.
- **Saber styles**: thin, thick, neon, particle, or a **custom GLTF/GLB/OBJ model** (from a URL or uploaded in options).
- **Note colors** independent of saber colors, plus **bomb**, **chain** and **arc** overrides.
- **Environment colors**: lights, back glow, walls and background. These stay in memory and are never written into the replayer's own saved settings.
- **Mistake effects**: screen flashes for misses, bad cuts and bombs; 3D markers (ring, cross or pillar); optional slow-motion bursts.
- **Hit particles**: saber color, a custom color, or colored by accuracy.
- **Show or hide** the headset, each saber, trails, notes, bombs, walls, arcs, chains, lasers, light fixtures, floor, environment geometry and the in-scene score. This uses three.js layers, so the replayer's object pools are left alone.
- **Accuracy heat** (`Alt+Shift+A`): tints each note with the cut score it receives in this replay (115 / 110+ / 105+ / 100+ / lower / mistake).

### Replay viewer: playback

- **Frame-by-frame stepping** (`[` / `]`), using either the next recorded replay frame or a fixed step.
- **Reverse playback** (`Z`), with a configurable scrub rate and speed.
- **A-B section loop** (`X` sets A, then B, then clears it), with optional pre-roll.
- **Bookmarks with notes** (`B` to add, `Shift+B` to jump to the next one). They're saved per replay, shown on the timeline and listed in the panel and the options page.
- **Automatic slow motion** around misses, bad cuts, bomb hits and low-accuracy cuts, with configurable threshold, speed and window.
- **Fine speed control**: `Alt+=` / `Alt+-` / `Alt+0`, `Alt` + mouse wheel, configurable step size.
- **Persistent speed and jump distance** across sessions.
- **Accuracy graph above the timeline**, with mistake ticks, bookmark flags and the loop region.

### Replay viewer: overlay and HUD

- A draggable **stats HUD** (`T`): score, accuracy, FC accuracy, **PP estimate** (from the map's BeatLeader ratings), combo, multiplier, mistakes, energy, notes cut, left/right averages, last-cut breakdown (pre/post/accuracy points), cut timing (early/late in ms), saber speed and song time.
- **Mini accuracy graph** (rolling window or the whole song) with each cut plotted.
- **Swing direction indicators** for each hand, with angle deviation.
- Position presets or free placement, plus scale, opacity and style (glass, solid, minimal), and a choice of which stats to show.
- **Hide official UI elements** one by one: control bar, 3D score HUD, song info, player info, camera buttons, settings button, Discord/Patreon corners and the playlist panel.

### Replay viewer: audio

- **Custom hitsounds** with four slots (good cut, bad cut, miss, bomb), each with its own sound and volume.
- Built-in synthesized sounds (click, tick, chime, buzz, thud, boom).
- **Hitsound pack import** from a folder, a set of files, or a `.zip` of `.mp3`/`.ogg`/`.wav` files. Slots are auto-assigned from file names.
- Master volume, latency compensation and an option to mute the official hitsound. Hitsounds are scheduled ahead on the audio clock, so they stay in time at any speed.

### Replay viewer: export and sharing

- **Copy replay link with my settings** (`Alt+Shift+C`). The link includes the time, speed, jump distance and camera (official parameters that work for everyone), plus BeatLeaderPlus colors, camera mode and overlay layout packed into `blpCfg`. Those are applied for that session only.
- **Screenshot** (`F9`) at any resolution, optionally with the HUD painted in.
- **Clip recording** (`F8`) using MediaRecorder: configurable length, resolution, fps and bitrate, optional HUD and song audio, saved as `.webm`.
- **Export** the current camera path or the full settings as JSON.

### Website enhancements

- **Download .bsor** and **Open in Enhanced Replayer** buttons next to every replay link. Replay links also get a right-click menu.
- **Favorite players and maps** (☆ next to links), with notes, listed in the popup and the options page.
- **Followed players**: background polling for new scores, a toolbar badge counter and optional desktop notifications.
- **Score comparison**: pick two scores (⚖) to see accuracy, PP, rank, mistakes, pauses, combo, per-hand accuracy, modifiers, headset and date side by side, with the better value highlighted.
- **Auto-expand score details**.
- **Quick filters**: my scores, clan, high accuracy (threshold is configurable), favorites and full combo.
- **Profile statistics drawer**: average and median accuracy, FC rate, average stars, an accuracy distribution, personal bests over time and a recent accuracy trend.
- Optional **extra badges** on scores (misses, bad cuts, pauses, max combo), fetched lazily and cached.

### Settings

- All settings live in `chrome.storage.sync`, one item per section. They fall back to `chrome.storage.local` for anything larger than the sync quota or when sync is unavailable.
- **Per-domain overrides**, for example a different theme on `beatleader.xyz`, or different camera defaults on `replay.beatleader.com`.
- **Import and export** the whole configuration as JSON, optionally including hitsound packs and saber models.
- **Reset** a single section or everything (with confirmation).
- **Live apply**: open tabs, including a running replay, update as soon as you change something.
- The **popup** is configurable too: choose its quick toggles, which sections to show, compact mode and width.

---

## Default shortcuts

All shortcuts can be changed in **Options → Keyboard shortcuts**. The options page warns when a key collides with another binding or with one of the replayer's own shortcuts. BeatLeaderPlus handles its keys first.

| Action | Default | Where |
| --- | --- | --- |
| Open options | `Alt+Shift+O` | everywhere |
| Toggle custom theme | `Alt+Shift+T` | everywhere |
| Toggle overlays (site UI / replay HUD, panel, timeline) | `Alt+Shift+H` | everywhere |
| Next / previous page (site) or replay (playlist) | `Alt+Shift+→` / `Alt+Shift+←` | everywhere |
| Toggle BLP panel | `` ` `` | replay |
| Toggle stats HUD | `T` | replay |
| Cycle camera mode | `V` | replay |
| Free camera on/off | `C` | replay |
| Play / stop camera path | `G` | replay |
| Record camera path | `Shift+G` | replay |
| Add camera keyframe | `Alt+G` | replay |
| Frame back / forward | `[` / `]` | replay |
| Reverse playback | `Z` | replay |
| Loop: set A → set B → clear | `X` | replay |
| Clear loop | `Shift+X` | replay |
| Add bookmark / next bookmark | `B` / `Shift+B` | replay |
| Speed up / down / reset | `Alt+=` / `Alt+-` / `Alt+0` | replay |
| Screenshot / record clip | `F9` / `F8` | replay |
| Copy link with my settings | `Alt+Shift+C` | replay |
| Toggle accuracy heat | `Alt+Shift+A` | replay |
| Camera presets | `Shift+1` … `Shift+6` | replay |
| Free camera movement | `W` `A` `S` `D`, `E` up, `Q` down, `Shift` sprint | replay (free camera) |

## URL parameters

BeatLeaderPlus reads these on replay pages:

| Parameter | Effect |
| --- | --- |
| `blpCam=<preset id or name>` | Apply a camera preset on load |
| `blpMode=free\|orbit\|follow\|fpvSmooth\|pov` | Start in a camera mode |
| `blpPath=<packed path>` | Load (and optionally auto-play) a shared camera path |
| `blpCfg=<packed config>` | Session-only overrides for colors, camera and overlay (from "Copy link with my settings") |
| `blpPanel=1` | Open the BeatLeaderPlus panel |

Shared links also set the replayer's own `time`, `speed`, `jd`, `cpx/cpy/cpz/crx/cry` and `forceFpv` parameters, so they work without the extension too.

---

## How it works

```
manifest.json            MV3 manifest (content scripts, web-accessible resources, permissions)
background.js            service worker: migration, messaging, API fetches, downloads,
                         follow polling (alarms), badge, notifications, context menu,
                         MAIN-world injection fallback
content-early.js         document_start: loads settings, applies the site theme before first paint
content.js               document_idle: detects the page type and starts the right modules
modules/
  theme.js               theme engine (CSS variables, typography, density, hide rules, custom CSS)
  hotkeys.js             global shortcuts (isolated world)
  site-enhancements.js   buttons, favorites, filters, comparison, dock
  site-profile-stats.js  profile statistics drawer (canvas charts)
  replay-bridge.js       injects the replay runtime and relays messages + storage
injected-replay.js       page-world bootstrap
injected/
  core.js                runtime core: bridge, scene discovery, frame loop, API, hotkeys, events
  ui.js                  panel, controls, launcher, toasts, official-UI hiding
  camera.js              camera modes, presets, paths, URL params
  visuals.js             colors, trails, styles, models, effects, particles, visibility, heat
  playback.js            stepping, reverse, loop, bookmarks, slow-mo, speed/JD, timeline graph
  overlays.js            stats HUD, mini graph, swing indicators, PP estimate
  audio.js               hitsound synthesis, pack decoding, look-ahead scheduling
  export.js              share links, screenshots, clip recording, settings export
lib/
  i18n.js                all user-facing strings (en + partial de)
  defaults.js            default settings, theme and camera presets, storage keys
  utils.js               shared helpers (also injected into the page)
  storage.js             sync/local persistence, migration, per-domain overrides, import/export
  schema.js              declarative settings schema used by options and popup
  zip.js                 dependency-free zip reader for hitsound packs
popup.* / options.*      extension UI
styles/theme.css         styles for UI added to the website
styles/replay-ui.css     styles for the replay panel / HUD / timeline
```

### Replay viewer injection

The web replayer is built with A-Frame. Content scripts run in an isolated world and can't see `window.AFRAME` or the scene's components, so `modules/replay-bridge.js` injects the runtime into the page's own world:

1. **Primary:** `<script src="chrome-extension://…/injected/…">` tags (listed in `web_accessible_resources`), loaded in order.
2. **Fallback:** if a page's CSP blocks those tags, the background worker runs `chrome.scripting.executeScript({world: 'MAIN'})` for that frame.

`injected/core.js` waits for `AFRAME`, the `<a-scene>` and the replay components, using a MutationObserver plus polling. It then registers a `blp-runtime` A-Frame component whose `tick`/`tock` drive every module, after the official components and before rendering. It talks to the official components directly:

- `song`: `getCurrentTime`, `setPlaybackRate`
- `song-controls`: `seek`, `baseSongSpeed`
- `replay-loader`: `replay`, `allStructs`
- `camera-mover`, `beat-generator`, `colors`, `settings`
- the `state` system and events such as `replayloaded`, `timechanged`, `colorChanged` and `showHotkeyNotification`

The page runtime has no `chrome.*` access, so it uses `window.postMessage` to talk to the bridge. The bridge only accepts an allow-list of requests (bookmarks, camera paths, hitsounds, models, runtime values). Settings patches from the page are restricted to replay-related sections.

### Storage

| Key | Area | Content |
| --- | --- | --- |
| `blp_meta`, `blp_s_<section>` | sync (local fallback) | settings, one item per section |
| `blp_domain_overrides` | local | per-domain differences to the global settings |
| `blp_runtime` | local | last speed / JD / camera mode, panel position, … |
| `blp_bookmarks` | local | bookmarks per replay |
| `blp_camera_paths` | local | recorded camera paths |
| `blp_hitsound_pack`, `blp_saber_models` | local | imported audio and models (base64) |
| `blp_favorites`, `blp_follow_state` | local | favorites, followed players, unseen new scores |

---

## Contributing

There is no build step: edit the files and reload the extension.

- **New setting:** add the default in `lib/defaults.js`, a field in `lib/schema.js` and its label (`f.<path>`) in `lib/i18n.js`. Then read it where the feature lives. The options page and popup pick it up automatically.
- **New replay feature:** create `injected/my-feature.js` that calls `BLPR.register({name, init(ctx), onSettings(s), onReplay(info), tick(frame), maintain()})`. Add it to the `FILES` list in `modules/replay-bridge.js` (before `injected-replay.js`). The modules shipped with BeatLeaderPlus are good examples.
- **New language:** add a table to `STRINGS` in `lib/i18n.js` (missing keys fall back to English) and an option in the language select in `lib/schema.js`.
- **Tests:** `tests/e2e/run-tests.js` drives the extension in Chromium against a mock replayer and a mock leaderboard page. See [tests/README.md](tests/README.md).
- Use tabs, single quotes and short comments that explain *why*, and avoid external dependencies.

### Known limitations

- The replay features hook into the official replayer's internals (component names, events, element IDs). If the replayer changes significantly, a module may need updating. Each module fails on its own without breaking the others.
- Website features rely on the site's markup (replay links, `/u/` and `/leaderboard/` links, `.player-score` rows, pagination). They only add elements and never move site nodes.
- Reverse playback works by repeatedly seeking backwards while paused, so it's silent and its frame rate depends on the update rate setting.
- "Trail thickness" controls how much of the blade the trail covers. The PP estimate uses the map's pass, accuracy and tech ratings and ignores modifiers.
- Custom saber models and some exports depend on what the replayer page's Content Security Policy allows. The replayer has no body avatar to hide.
- Clip audio includes the song, not hitsounds.

### Privacy

BeatLeaderPlus only talks to the BeatLeader API, through the background worker and only for the features you use (score details, follows, statistics). All data stays in your browser's extension storage and is never sent anywhere else.

