# BeatLeaderPlus

A Manifest V3 Chrome extension that adds a customizable enhancement layer to [BeatLeader](https://beatleader.com) and, above all, to its **web replay viewer** (`replay.beatleader.com` / `replay.beatleader.xyz`, including replays embedded in iframes).

In the replay viewer, BeatLeaderPlus **extends the replayer's own interface** instead of adding a second one. There is no floating panel or extra HUD. New options appear as a **BL+ tab** in the replayer's Settings menu, as an extra block and a **BL+ tab** in its Camera menu, and as extra entries in its right-click menu. Features build on what the replayer already does (its free camera, saber colors, "slow down on mistakes", hitsound volume and score HUD) rather than duplicating it.

The additions include orbit and follow cameras, camera presets and recorded camera paths; note, trail and saber-style visuals; frame stepping, reverse playback, A-B loops and bookmarks; a PP estimate in the score HUD; extra hitsounds; and screenshots and clip recording. On the website it adds a theme editor and extras such as `.bsor` downloads, favorites, follows, filters, score comparison and profile statistics. Almost everything is configurable, and changes apply to open tabs straight away.

> BeatLeaderPlus is an unofficial, fan-made extension. It is not affiliated with or endorsed by BeatLeader. The popup and the options page say so too.

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

### Replay viewer: where things are

| Replayer menu | What BeatLeaderPlus adds |
| --- | --- |
| **Settings → BL+** tab (`` ` `` opens it) | Notes, Sabers & trails, Effects, Show/hide, Playback, Timeline, Extra hitsounds, Export and Interface sections |
| **Camera → Main** tab | A BeatLeaderPlus block under the official left/center/right buttons: Orbit, Smooth follow, a preset picker, "save as preset" and the camera path picker |
| **Camera → BL+** tab | Free camera tuning, orbit/follow options, the preset list and camera path tools |
| **Right-click menu** | "Copy URL with BL+ camera and colors", "Screenshot" and "Record clip", next to the official "Copy URL" entries |
| **Score HUD** (3D) | A PP estimate line under the accuracy, and an optional last-cut line, in the HUD's own font. Both follow the replayer's "Show HUD" setting. |
| **Timeline** | Bookmark flags and the A-B loop region, next to the replayer's own accuracy graph and mistake markers |

Everything the replayer already offers stays where it is: saber colors, saber width, trail type and length, environment colors, lasers/floor/lights, headset opacity, the score HUD, "change speed around mistakes", the hitsound file and volume, and the FPV camera.

### Replay viewer: camera

- **Official free camera, tuned**: the replayer's own WASD camera (`W` `A` `S` `D`, `X`/`C` down/up, drag to look) gets an adjustable move speed, a `Shift` sprint multiplier and optional mouse capture (pointer lock).
- **Orbit** around the player's head or the play-space center, with radius, height, speed and start angle.
- **Smooth follow**: follows the head or the play-space center, with lag, look-ahead and a world-space or head-relative offset.
- **First person** uses the replayer's own POV camera.
- **Field of view** slider and **camera smoothing** strength.
- **Camera presets** with names and hotkeys. Five built-ins ship by default (Cinematic Low, Top Down, Side Follow, First Person, Orbit Showcase), and you can save the live camera as a new preset. Static presets glide the official camera into place and then hand control back to it.
- **Camera paths**: record position, rotation and FOV over song time (`Shift+G`), add keyframes manually (`Alt+G`), then play back with spline interpolation (`G`). Paths can be renamed, exported or imported as JSON, or **shared via a URL**.
- **URL parameters** force a preset, mode or path on load (see below).

### Replay viewer: visuals and sabers

- **Note colors** independent of the saber colors, plus **chain** and **arc** overrides.
- **Trails**: color (follow the saber or custom), width (how much of the blade the trail covers) and brightness, layered on the official trail.
- **Glow intensity** and **saber styles**: neon, particle, or a **custom saber model**. Saber colors always come from the replayer's own color pickers.
- **Custom saber models**: choose "Custom model" in Settings → BL+ and drop a Beat Saber **`.saber`** file, or a `.glb`, self-contained `.gltf` or `.obj` model, on the drop zone (or click it to pick one), for both sabers or one hand. The model is saved, shown spinning in the drop zone and put on the sabers right away. Scale, rotation, saber-color tint and hiding the default blade are adjustable, and saved models can be reused or managed on the options page.
  - **`.saber` files** are read directly: their left and right sabers, meshes, materials, textures, name and author. They are placed exactly as in the game, and materials marked for custom colors (`_CustomColors`, or glowing ones without that flag) take the replay's saber colors. Shaders can't run outside Unity, so materials are drawn with their base color and main texture (flat shading by default); trails, particles and other scripted effects aren't shown. Files are read in a background worker so the replay keeps playing.
  - **3D models** are fitted to the blade automatically (longest side along the blade, grip at the hilt).
- **Mistake effects**: screen flashes for misses, bad cuts and bombs, 3D markers (ring, cross or pillar) and hit particles (saber color, custom, or colored by accuracy).
- **Show or hide** each saber, the trails, notes, bombs, walls, arcs and chains. This uses three.js layers, so the replayer's object pools are left alone.
- **Accuracy heat** (`Alt+Shift+A`): tints each note with the cut score it receives in this replay (115 / 110+ / 105+ / 100+ / lower / mistake).

### Replay viewer: playback

- **Frame-by-frame stepping** (`[` / `]`), using either the next recorded replay frame or a fixed step.
- **Reverse playback** (`Z`), with a configurable scrub rate and speed.
- **A-B section loop** (`T` sets A, then B, then clears it; `Shift+T` clears), with optional pre-roll.
- **Bookmarks with notes** (`B` to add, `Shift+B` to jump to the next one). They're saved per replay, shown on the timeline and listed in Settings → BL+ and on the options page.
- **Low-accuracy cuts in the official slow motion**: when the replayer's "change speed around mistakes" is on, cuts below a score threshold get the same slow-down windows as misses and bad cuts.
- **Remember speed and jump distance** across sessions (whatever you set with the replayer's own controls).
- **Bookmark flags and the loop region on the timeline**, alongside the replayer's own accuracy graph and markers.

### Replay viewer: HUD and interface

- **PP estimate** in the replayer's 3D score HUD, from the map's BeatLeader ratings (ranked maps only).
- Optional **last-cut line**: score with its pre-swing / post-swing / accuracy points.
- **Hide replayer elements** one by one: song info, player info, the Discord/Patreon corners and the playlist panel.
- **Toggle overlays** (`Alt+Shift+H`) hides everything BeatLeaderPlus draws in one go.

### Replay viewer: extra hitsounds

- The replayer plays a hitsound for good cuts. BeatLeaderPlus adds sounds for **bad cuts, misses and bomb hits**, each with its own sound and volume.
- Built-in synthesized sounds (click, tick, chime, buzz, thud, boom).
- **Hitsound pack import** from a folder, a set of files, or a `.zip` of `.mp3`/`.ogg`/`.wav` files. Slots are auto-assigned from file names.
- Volumes are relative to the replayer's hitsound slider, so its mixer still controls everything. Sounds are scheduled ahead on the audio clock, so they stay in time at any speed.

### Replay viewer: export and sharing

- **Copy URL with BL+ camera and colors** (`Alt+Shift+C`, or the right-click menu). The link uses the replayer's own `time`, `speed`, `jd` and camera parameters (which work for everyone), plus the orbit/follow mode and BeatLeaderPlus visuals packed into `blpCfg`. Those are applied for that session only.
- **Screenshot** (`F9`) at any resolution.
- **Clip recording** (`F8`) using MediaRecorder: configurable length, resolution, fps and bitrate, with optional song audio, saved as `.webm`.
- **Export** the current camera path or the full settings as JSON.

### Website enhancements

- **Download .bsor**, **Open in Enhanced Replayer** and **compare** buttons next to every replay link. In BeatLeader's score icon grid they appear as extra icons in the same style, and the download icon is left out when the site already shows its own. Replay links also get a right-click menu.
- **Favorite players and maps**, with notes, listed in the popup and the options page. Add them from the BL+ dock on a profile or leaderboard page. Optional stars next to every player and map link (off by default) favorite with one click. Players are looked up on BeatLeader when you favorite them and saved under their player ID with their current name, so profile aliases (`/u/<alias>`) and links the site reuses while you browse always favorite the right person.
- **Followed players**: background polling for new scores, a toolbar badge counter and optional desktop notifications.
- **Score comparison**: pick two scores (scales icon) to see accuracy, PP, rank, mistakes, pauses, combo, per-hand accuracy, modifiers, headset and date side by side, with the better value highlighted.
- **Auto-expand score details**.
- **Quick filters**: my scores, clan, high accuracy (threshold is configurable), favorites and full combo.
- The **BL+ dock** at the bottom of profile and leaderboard pages holds favorite, follow, statistics, filter and comparison controls. It stays collapsed to a small **BL+** button until you click it; a dot on the button means a filter or comparison is active.
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
| Toggle overlays (site UI / BeatLeaderPlus additions in the replay) | `Alt+Shift+H` | everywhere |
| Next / previous page (site) or replay (playlist) | `Alt+Shift+→` / `Alt+Shift+←` | everywhere |
| Open / close Settings → BL+ | `` ` `` | replay |
| Cycle camera mode (official → orbit → follow → first person) | `V` | replay |
| Play / stop camera path | `G` | replay |
| Record camera path | `Shift+G` | replay |
| Add camera keyframe | `Alt+G` | replay |
| Frame back / forward | `[` / `]` | replay |
| Reverse playback | `Z` | replay |
| Loop: set A → set B → clear | `T` | replay |
| Clear loop | `Shift+T` | replay |
| Add bookmark / next bookmark | `B` / `Shift+B` | replay |
| Screenshot / record clip | `F9` / `F8` | replay |
| Copy URL with BL+ camera and colors | `Alt+Shift+C` | replay |
| Toggle accuracy heat | `Alt+Shift+A` | replay |
| Camera presets | `Shift+1` … `Shift+5` | replay |
| Sprint with the official free camera | hold `Shift` while moving | replay |

The defaults avoid the replayer's own shortcuts (`Space` `K` `J` `L` `F` `H` `M` `I` `U` `O` `,` `.` `-` `=` arrows, `Shift+F/Q/R/E/N/P`, `F2` and the `W` `A` `S` `D` `X` `C` camera keys). Speed, seeking and volume are left to the replayer.

## URL parameters

BeatLeaderPlus reads these on replay pages:

| Parameter | Effect |
| --- | --- |
| `blpCam=<preset id or name>` | Apply a camera preset on load |
| `blpMode=orbit\|follow\|pov` | Start in a camera mode |
| `blpPath=<packed path>` | Load (and optionally auto-play) a shared camera path |
| `blpCfg=<packed config>` | Session-only overrides for camera and visuals (from "Copy URL with BL+ camera and colors") |
| `blpPanel=1` | Open Settings → BL+ |

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
  ui.js                  BL+ tabs in the replayer's Settings/Camera menus, right-click menu
                         items, controls in the replayer's style, hiding replayer elements
  camera.js              official free camera tuning, orbit/follow, presets, paths, URL params
  visuals.js             note/trail colors, saber styles, models, effects, visibility, heat
  playback.js            stepping, reverse, loop, bookmarks, low-acc slow-mo, speed/JD memory
  hud.js                 PP estimate and last-cut lines in the replayer's score HUD
  audio.js               extra hitsounds: synthesis, pack decoding, look-ahead scheduling
  export.js              share links, screenshots, clip recording
lib/
  i18n.js                all user-facing strings (en + partial de)
  defaults.js            default settings, theme and camera presets, storage keys
  utils.js               shared helpers (also injected into the page)
  storage.js             sync/local persistence, migration, per-domain overrides, import/export
  schema.js              declarative settings schema used by options and popup
  zip.js                 dependency-free zip reader for hitsound packs
  unity-saber.js         .saber reader: Unity asset bundles (LZ4/LZMA), serialized files and
                         type trees, meshes, materials, textures; runs in a worker in the page
popup.* / options.*      extension UI
styles/theme.css         styles for UI added to the website
styles/replay-ui.css     styles for the additions to the replayer's menus and timeline
```

### Replay viewer injection

The web replayer is built with A-Frame. Content scripts run in an isolated world and can't see `window.AFRAME` or the scene's components, so `modules/replay-bridge.js` injects the runtime into the page's own world:

1. **Primary:** `<script src="chrome-extension://…/injected/…">` tags (listed in `web_accessible_resources`), loaded in order.
2. **Fallback:** if a page's CSP blocks those tags, the background worker runs `chrome.scripting.executeScript({world: 'MAIN'})` for that frame.

`injected/core.js` waits for `AFRAME`, the `<a-scene>` and the replay components, using a MutationObserver plus polling. It then registers a `blp-runtime` A-Frame component whose `tick`/`tock` drive every module, after the official components and before rendering. It talks to the official components directly:

- `song`: `getCurrentTime`, `setPlaybackRate`
- `song-controls`: `seek`, `baseSongSpeed`, `computeMissWindows` / `missWindows` (wrapped to add low-accuracy windows)
- `replay-loader`: `replay`, `allStructs`
- `camera-mover` (POV), `look-controls` / `wasd-controls` on the main camera, `beat-generator`, `settings`
- the `state` system and events such as `replayloaded`, `timechanged`, `colorChanged`, `contextmenuopen` and `showHotkeyNotification`

`injected/ui.js` adds its tab buttons and panes next to the replayer's own (`.settings-tab-button` / `.settings-tab-pane`, `.camera-tab-button` / `.camera-tab-pane`) and switches tabs through the page's own `changeTab` / `changeCameraTab`, so the BL+ tabs behave like the built-in ones. Controls reuse the replayer's markup and classes (`.toggleButton`, `.switch`, `.settingRange`, `.settingButton`, `.menuitem`), so they look native.

The page runtime has no `chrome.*` access, so it uses `window.postMessage` to talk to the bridge. The bridge only accepts an allow-list of requests (bookmarks, camera paths, hitsounds, models, runtime values). Settings patches from the page are restricted to replay-related sections.

### Storage

| Key | Area | Content |
| --- | --- | --- |
| `blp_meta`, `blp_s_<section>` | sync (local fallback) | settings, one item per section |
| `blp_domain_overrides` | local | per-domain differences to the global settings |
| `blp_runtime` | local | last speed / JD / camera mode / camera path, … |
| `blp_bookmarks` | local | bookmarks per replay |
| `blp_camera_paths` | local | recorded camera paths |
| `blp_hitsound_pack`, `blp_saber_models` | local | imported audio and models (base64) |
| `blp_favorites`, `blp_follow_state` | local | favorites, followed players, unseen new scores |

---

## Contributing

There is no build step: edit the files and reload the extension.

- **New setting:** add the default in `lib/defaults.js`, a field in `lib/schema.js` and its label (`f.<path>`) in `lib/i18n.js`. Then read it where the feature lives. The options page and popup pick it up automatically.
- **New replay feature:** create `injected/my-feature.js` that calls `BLPR.register({name, init(ctx), onSettings(s), onReplay(info), tick(frame), maintain()})`. Put its controls in the replayer's menus with `BLPR.ui.addSettingsSection`, `BLPR.ui.addCameraSection` or `BLPR.ui.addMenuItem`. Add the file to the `FILES` list in `modules/replay-bridge.js` (before `injected-replay.js`). The modules shipped with BeatLeaderPlus are good examples.
- **New language:** add a table to `STRINGS` in `lib/i18n.js` (missing keys fall back to English) and an option in the language select in `lib/schema.js`.
- **Tests:** `node --test tests/unit/*.test.js` checks the `.saber` reader against reference data from UnityPy. `tests/e2e/run-tests.js` drives the extension in Chromium against the real BeatLeader web replayer (built unmodified from its repository) and a small leaderboard page. See [tests/README.md](tests/README.md).
- Use tabs, single quotes and short comments that explain *why*, and avoid external dependencies.

### Known limitations

- The replay features hook into the official replayer's internals (component names, events, element IDs). If the replayer changes significantly, a module may need updating. Each module fails on its own without breaking the others.
- Website features rely on the site's markup (replay links, `/u/` and `/leaderboard/` links, `.player-score` rows, pagination). They only add elements and never move site nodes.
- Reverse playback works by repeatedly seeking backwards while paused, so it's silent and its frame rate depends on the update rate setting.
- "Trail width" controls how much of the blade the trail covers. The PP estimate uses the map's pass, accuracy and tech ratings and ignores modifiers.
- Low-accuracy slow motion only works while the replayer's own "change speed around mistakes" is on, because it adds to that feature's windows.
- Custom saber models and some exports depend on what the replayer page's Content Security Policy allows. The replayer has no body avatar to hide.
- Clip audio includes the song, not hitsounds.
- Settings → BL+ needs the replayer's tabbed Settings menu. If a future replayer version drops it, the options page still has every setting.

### Privacy

BeatLeaderPlus only talks to the BeatLeader API, through the background worker and only for the features you use (score details, follows, statistics). All data stays in your browser's extension storage and is never sent anywhere else.

