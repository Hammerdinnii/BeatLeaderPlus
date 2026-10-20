# BeatLeaderPlus tests

`tests/e2e/run-tests.js` loads the unpacked extension in Chromium (via Playwright) and drives:

- a **mock replay viewer** (`replay.html` + `mock-replayer.js`) served at `https://replay.beatleader.com/`. It runs on the replayer's own A-Frame build and registers stand-ins for the official components (`song`, `song-controls`, `replay-loader`, `replay-player`, `camera-mover`, `beat-generator`, `colors`, `settings`, `trail`, `beat`, ...). They mirror the names and the behaviour BeatLeaderPlus hooks into.
- a **mock leaderboard page** (`site.html`) served at `https://beatleader.com/`
- the **popup** and **options** pages

Requests are intercepted with Playwright routing, so no network access is needed. Requests made by the extension's service worker can't be routed, so the test stubs `fetch` inside the worker for the API-dependent checks (comparison, follows, profile stats).

## Running

1. Get the replayer's A-Frame build (MIT licensed):

   ```sh
   git clone --depth 1 https://github.com/BeatLeader/BeatSaber-Web-Replays.git /tmp/bl-replays
   ```

2. Install Playwright and Chromium (skip this if you already have them):

   ```sh
   npm i -D playwright && npx playwright install chromium
   ```

3. Run the tests from the repository root:

   ```sh
   AFRAME_PATH=/tmp/bl-replays/vendor/aframe-master.js node tests/e2e/run-tests.js
   ```

The script prints one `PASS`/`FAIL` line per check, then any console errors that mention BeatLeaderPlus. It exits with a non-zero status if a check fails.
