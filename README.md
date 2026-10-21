# BeatLeaderPlus

A Chrome extension that adds more options to the [BeatLeader](https://beatleader.com) website and its web replay viewer. In the replayer it adds to the menus that are already there instead of adding a second interface.

> Unofficial, fan-made extension. Not affiliated with or endorsed by BeatLeader.

## Install

1. Download this repository (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.

Works in Chrome 111 or newer and other Chromium browsers (Edge, Brave, Opera). To update, replace the folder and click the reload icon on the extension's card.

## How to use it

**Replay viewer:** open any replay, then press `` ` `` or open Settings and pick the **BL+** tab. Camera options are in the camera menu's **BL+** tab. Screenshots and clips are in the right-click menu.

**Website:** click the **BL+** button on profile and leaderboard pages. Drag it to any edge of the window to move it.

**All settings:** click the extension icon, then **All options**. Changes apply right away.

## Features

### Replay viewer

| Area | What you get |
| --- | --- |
| Camera | First-person tuning (height and side offset, head smoothing, level horizon), the replayer's ortho views, orbit and smooth-follow cameras, presets with hotkeys, recorded and shareable camera paths |
| Look | Note, chain, arc and trail colors, note size, wall opacity, saber styles, custom saber models (including Beat Saber `.saber` files), mistake flashes and markers, hit particles, accuracy heat, brightness, contrast and saturation, show or hide sabers, notes, walls and more |
| Playback | Frame stepping, reverse, A-B loop, bookmarks, pause at mistakes, speed buttons, extra slow motion on low-accuracy cuts |
| Score HUD | PP estimate, last cut score, and the HUD's size, height, color and which parts show |
| Sound | Extra hitsounds for bad cuts, misses and bombs |
| Export | Screenshots, clip recording, and links that keep your camera and colors |

### Website

| Area | What you get |
| --- | --- |
| Theme | Colors and presets (Dark+, OLED, Light, High Contrast), fonts, density, hiding page elements, custom CSS |
| Scores | Replay download and compare buttons, quick filters, auto-expanded details, extra badges |
| Players and maps | Favorites, followed players with new-score notifications, profile statistics |

## Shortcuts

| Action | Key |
| --- | --- |
| Open Settings → BL+ | `` ` `` |
| Cycle camera | `V` |
| Frame back / forward | `[` / `]` |
| Reverse playback | `Z` |
| A-B loop (set A, set B, clear) | `T` |
| Add bookmark | `B` |
| Screenshot / record clip | `F9` / `F8` |
| Hide BL+ overlays | `Alt+Shift+H` |
| Open the popup / options | `Alt+Shift+B` / `Alt+Shift+O` |

Every shortcut can be changed in **Options → Keyboard shortcuts**.

## Privacy

BeatLeaderPlus only talks to the BeatLeader API, and only for the features you use. Your settings and data stay in your browser.

## More

Every option, URL parameters, how the extension works and how to contribute are in the [full documentation](README-old.md).
