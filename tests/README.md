# BeatLeaderPlus tests

`tests/e2e/run-tests.js` loads the unpacked extension in Chromium (via Playwright) and drives:

- the **real BeatLeader web replayer**: a checkout of [BeatLeader/BeatSaber-Web-Replays](https://github.com/BeatLeader/BeatSaber-Web-Replays), built with its own build script and otherwise unmodified, served at `https://replay.beatleader.com/`. Nothing of the replayer is copied into this repository.
- a **small leaderboard page** (`site.html`) served at `https://beatleader.com/` for the website features
- the **popup** and **options** pages

The replayer needs a replay and a map. `fixtures.js` takes the test map that ships with the replayer's repository (`assets/test.zip`) and generates a `.bsor` replay for it, using the field layout of the replayer's own decoder (`src/open-replay-decoder.js`). It also answers the few API requests the replayer makes for that score. Every request is answered locally through Playwright routing, so no network access is needed. Requests made by the extension's service worker can't be routed, so the test stubs `fetch` inside the worker for the API-dependent checks (PP estimate, comparison, profile stats).

## .saber reader unit tests

```sh
node --test tests/unit/*.test.js
```

`tests/fixtures/*.saber` are small custom sabers written by `tests/tools/make_saber.py` for Unity 2018.1 (LZMA), 2019.4 (LZ4) and 2021.3 (LZ4, vertex data in a separate `.resS` resource). The script builds every object from UnityPy's database of Unity type trees, so the files have the exact field layouts real Unity builds of those versions write. It then loads each file back with [UnityPy](https://github.com/K0lb3/UnityPy), an independent Unity asset reader, and saves what UnityPy decodes as `*.expected.json`. The tests compare the reader's meshes and textures with that, and check how the sabers are placed (blade direction, transforms, hidden and disabled parts, triangle winding, saber-color materials). To regenerate the fixtures:

```sh
python3 -m pip install UnityPy==1.25.4
python3 tests/tools/make_saber.py tests/fixtures
```

## Running the end-to-end tests

1. Get and build the replayer:

   ```sh
   git clone --depth 1 https://github.com/BeatLeader/BeatSaber-Web-Replays.git /tmp/bl-replays
   cd /tmp/bl-replays && npm ci && npm run build && cd -
   ```

2. Install Playwright and Chromium (skip this if you already have them):

   ```sh
   npm i -D playwright && npx playwright install chromium
   ```

3. Run the tests from the repository root:

   ```sh
   BL_REPLAYER_DIR=/tmp/bl-replays node tests/e2e/run-tests.js
   ```

The script prints one `PASS`/`FAIL` line per check, then any console errors that mention BeatLeaderPlus. It exits with a non-zero status if a check fails.

Headless Chromium renders the replayer with software WebGL, which can be as slow as a few frames per second, so the checks that depend on frames allow for that.
