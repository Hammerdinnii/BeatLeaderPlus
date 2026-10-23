# BeatLeaderPlus
<img width="640" height="320" alt="BEATLEADERPLUS" src="https://github.com/user-attachments/assets/d06b41cd-b3ac-42cb-b1be-afbde0104760" />

A Chrome extension that adds options to [BeatLeader](https://beatleader.com) and its web replay viewer.

In the replay viewer it doesn't add a second interface: its options appear as a **BL+ tab** in the replayer's own Settings and Camera menus, and in its right-click menu.

> Unofficial and fan-made. Not affiliated with or endorsed by BeatLeader.

## Install

1. Download this repository (**Code → Download ZIP**, then unzip it) or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `BeatLeaderPlus` folder (the one with `manifest.json`).

Works in Chrome 111+ and other Chromium browsers (Edge, Brave). To update, replace the folder and click the reload icon on the extension's card.

## Features

### Replay viewer

| | |
| --- | --- |
| **Camera** | First person tuning (height, side offset, smoothing, level horizon), orthographic top/right/back views, orbit and smooth-follow cameras, camera presets with hotkeys, recorded camera paths you can share as a link |
| **Sabers** | Load a Beat Saber **`.saber`** file or a `.glb` / `.gltf` / `.obj` model as your sabers, with adjustable **bloom**. Neon and particle styles, trail color, width and brightness |
| **Visuals** | Note, chain and arc colors, note size, wall opacity, brightness / contrast / saturation, accuracy heat on notes, mistake flashes and markers, show or hide any object |
| **Playback** | Frame-by-frame stepping, reverse playback, A-B loop, bookmarks, pause at mistakes, slow motion on low-accuracy cuts, speed buttons, FPS limit |
| **HUD and sound** | PP estimate in the score HUD, resizable and recolorable HUD, extra hitsounds for bad cuts, misses and bombs (or your own sound pack) |
| **Export** | Screenshots, clip recording (`.webm`), share links that keep your camera and colors |

### Website

| | |
| --- | --- |
| **Look** | Theme editor with presets (Dark+, OLED, Light, High Contrast), fonts, density, hide page elements, custom CSS |
| **Scores** | Download `.bsor` and compare buttons on every score, side-by-side score comparison, quick filters (my scores, clan, high accuracy, full combo), extra score badges |
| **Profile stats** | Accuracy, FC rate, stars, top play, mistakes and per-hand accuracy; charts of accuracy vs stars, accuracy distribution, and accuracy and PP over time, with details when you hover; a sortable table of every score |
| **BL+ dock** | One button holding the page's BL+ tools; drag it to any edge of the window |

### Settings

Everything is set on the options page or in the popup (`Alt+Shift+B`), applies to open tabs right away, syncs with your browser, and can be exported or imported as a file. Every keyboard shortcut can be changed.

## Main shortcuts

| Key | Action |
| --- | --- |
| `` ` `` | Open Settings → BL+ in the replay viewer |
| `V` | Cycle camera: official → orbit → follow → first person |
| `[` / `]` | Previous / next frame |
| `Z` | Reverse playback |
| `T` | Loop: set A, set B, clear |
| `B` | Add a bookmark |
| `F9` / `F8` | Screenshot / record a clip |
| `Alt+Shift+O` | Open the options |

## More

- [Guide](docs/GUIDE.md): every feature in detail, all shortcuts, URL parameters, how it works, and how to contribute.
- Privacy: BeatLeaderPlus only talks to the BeatLeader API, for the features you use. Your settings and data stay in your browser.
