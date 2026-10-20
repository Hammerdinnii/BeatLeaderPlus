/* Test double for the BeatLeader web replayer: registers components with the official names and
 * the subset of behaviour BeatLeaderPlus relies on. Runs on the real vendored A-Frame build. */
(function () {
	const DURATION = 120;
	window.__notifications = [];
	window.__colorEvents = [];

	AFRAME.registerSystem('state', {
		init() {
			this.state = {isPlaying: false, isPaused: true, score: {score: 0, accuracy: '0.00', fcAccuracy: '100.00', combo: 0, multiplier: 1, misses: 0, energy: 0.5}};
		},
	});

	AFRAME.registerComponent('settings', {
		init() {
			this.settings = {bombColor: '#000000', wallColor: '#f01978', backgroundColor: '#000000', redEventColor: '#f01978', blueEventColor: '#2064a8', redBGColor: '#ff1f81', blueBGColor: '#2851b8', trailLength: 20, soundDelay: 0, fov: 60};
			this.syncCount = 0;
		},
		sync() {
			this.syncCount++;
			window.__lastSyncedSettings = JSON.parse(JSON.stringify(this.settings));
		},
	});

	AFRAME.registerComponent('song', {
		init() {
			this.speed = 1;
			this.isPlaying = false;
			this.base = 0;
			this.startedAt = null;
			this.source = {};
			this.audio = {};
		},
		getCurrentTime() {
			const st = this.el.sceneEl.systems.state.state;
			if (st.isPlaying && this.startedAt !== null) return Math.min(DURATION, this.base + ((performance.now() - this.startedAt) / 1000) * this.speed);
			return this.base;
		},
		getDuration() {
			return DURATION;
		},
		setPlaybackRate(r) {
			this.base = this.getCurrentTime();
			this.startedAt = performance.now();
			this.speed = r;
		},
	});

	AFRAME.registerComponent('song-controls', {
		init() {
			this.song = this.el.components.song;
			this.baseSongSpeed = 1;
			const scene = this.el;
			scene.addEventListener('pausegame', () => {
				this.song.base = this.song.getCurrentTime();
				scene.systems.state.state.isPlaying = false;
				scene.systems.state.state.isPaused = true;
			});
			scene.addEventListener('gamemenuresume', () => {
				this.song.startedAt = performance.now();
				scene.systems.state.state.isPlaying = true;
				scene.systems.state.state.isPaused = false;
			});
			window.__seeks = [];
		},
		seek(t) {
			window.__seeks.push(t);
			this.song.base = t;
			this.song.startedAt = performance.now();
			setTimeout(() => this.el.emit('timechanged', {newTime: t}), 5);
		},
		tick() {
			// mirrors updateAutoSpeedState(): re-applies baseSongSpeed every frame
			if (this.song.speed !== this.baseSongSpeed) this.song.setPlaybackRate(this.baseSongSpeed);
		},
	});

	function makeReplay() {
		const frames = [];
		for (let t = 0.011; t < DURATION; t += 1 / 90) {
			const s = Math.sin(t * 2);
			frames.push({
				time: t,
				fps: 90,
				head: {position: {x: s * 0.1, y: 1.7, z: 0}, rotation: {x: 0, y: Math.sin(t) * 0.2, z: 0, w: 1}},
				left: {position: {x: -0.3 + s * 0.2, y: 1.2, z: -0.3}, rotation: {x: 0, y: 0, z: 0, w: 1}},
				right: {position: {x: 0.3 - s * 0.2, y: 1.2, z: -0.3}, rotation: {x: 0, y: 0, z: 0, w: 1}},
			});
		}
		const notes = [];
		let total = 0;
		let max = 0;
		let misses = 0;
		for (let i = 0, t = 2; t < DURATION - 2; t += 0.5, i++) {
			const kind = i % 23 === 7 ? 'miss' : i % 31 === 11 ? 'bad' : 'good';
			const score = kind === 'good' ? 95 + ((i * 7) % 21) : kind === 'miss' ? -3 : -2;
			if (kind !== 'good') misses++;
			total += Math.max(0, score);
			max += 115;
			const hand = i % 2;
			notes.push({
				eventType: kind === 'good' ? 0 : kind === 'bad' ? 1 : 2,
				time: t,
				spawnTime: t - 1,
				id: 10000 + hand * 10 + 1,
				score,
				isBlock: true,
				accuracy: (total / max) * 100,
				fcAccuracy: 98,
				totalScore: total,
				combo: 0,
				misses,
				cutInfo:
					kind === 'miss'
						? undefined
						: {saberType: hand, timeDeviation: ((i % 5) - 2) * 0.004, saberSpeed: 5 + (i % 4), saberDir: {x: 0.2, y: -1, z: 0.1}, cutPoint: {x: hand ? 0.3 : -0.3, y: 1.0, z: -0.2}, beforeCutRating: 1, afterCutRating: 0.9, cutDistanceToCenter: 0.05, cutDirDeviation: 4},
			});
		}
		return {
			info: {playerID: '76561198000000001', playerName: 'Test Player', hash: 'ABCDEF', songName: 'Mock Song', difficulty: 'ExpertPlus', mode: 'Standard', timestamp: '1700000000', height: 1.8, speed: 0},
			frames,
			heights: [],
			notes: [],
			allStructs: notes,
		};
	}

	AFRAME.registerComponent('replay-loader', {
		init() {
			this.replay = null;
			this.allStructs = null;
			setTimeout(() => {
				const r = makeReplay();
				this.replay = r;
				this.allStructs = r.allStructs;
				this.el.sceneEl.emit('replayloaded', {notes: r.allStructs, replay: r}, null);
			}, 400);
		},
	});

	AFRAME.registerComponent('replay-player', {
		tock() {
			const rl = this.el.sceneEl.components['replay-loader'];
			const song = this.el.sceneEl.components.song;
			if (!rl.replay) return;
			const t = song.getCurrentTime();
			const f = rl.replay.frames[Math.min(rl.replay.frames.length - 1, Math.max(0, Math.floor(t * 90)))];
			const hs = this.el.sceneEl.querySelector('.headset');
			hs.object3D.position.set(f.head.position.x, f.head.position.y, -f.head.position.z);
			// Same conversion as the official replay-player.js
			const hr = f.head.rotation;
			const q = new THREE.Quaternion(hr.w, hr.z, hr.y, hr.x).normalize();
			const e = new THREE.Euler().setFromQuaternion(q);
			hs.object3D.rotation.set(e.x, e.y + Math.PI, -e.z + Math.PI);
			const l = this.el.sceneEl.querySelector('#leftHand').object3D;
			const r = this.el.sceneEl.querySelector('#rightHand').object3D;
			l.position.set(f.left.position.x, f.left.position.y, -f.left.position.z);
			r.position.set(f.right.position.x, f.right.position.y, -f.right.position.z);
			this.el.sceneEl.systems.state.state.score.accuracy = (95 + (t % 3)).toFixed(2);
			this.el.sceneEl.systems.state.state.score.score = Math.round(t * 1000);
		},
	});

	AFRAME.registerComponent('camera-mover', {
		init() {
			this.pov = false;
			this.defaultCamera = this.el.sceneEl.querySelector('.mainCamera');
			this.povCamera = this.el.sceneEl.querySelector('.povCamera');
		},
		play() {
			document.querySelectorAll('.povswitch').forEach(el =>
				el.addEventListener('click', e => {
					e.preventDefault();
					this.pov = !this.pov;
					this.defaultCamera.setAttribute('camera', 'active', !this.pov);
					this.povCamera.setAttribute('camera', 'active', this.pov);
				})
			);
		},
		disablePovIfNeeded() {
			if (this.pov) {
				this.pov = false;
				this.povCamera.setAttribute('camera', 'active', false);
				this.defaultCamera.setAttribute('camera', 'active', true);
			}
		},
	});

	AFRAME.registerComponent('beat-generator', {
		init() {
			this.colors = {};
			this.el.sceneEl.addEventListener('colorChanged', e => {
				window.__colorEvents.push(e.detail);
				if (e.detail.color) this.colors[e.detail.hand] = e.detail.color;
			});
		},
		setNewJD(v) {
			window.__jd = v;
		},
	});

	AFRAME.registerComponent('colors', {
		init() {
			window.__updateColors = 0;
		},
		updateColors() {
			window.__updateColors++;
		},
	});

	AFRAME.registerComponent('hotkey-notification', {
		init() {
			this.el.addEventListener('showHotkeyNotification', e => window.__notifications.push(e.detail.text));
		},
	});

	AFRAME.registerComponent('playlist', {
		next() {
			window.__playlist = 'next';
		},
		previous() {
			window.__playlist = 'prev';
		},
	});

	AFRAME.registerComponent('beat-hit-sound', {
		init() {
			this.gainNode = {gain: {value: 0.09}};
		},
		setVolume(v) {
			this.gainNode.gain.value = v * 0.3;
		},
	});

	AFRAME.registerComponent('saber-controls', {
		schema: {hand: {default: 'right'}},
		init() {
			this.el.sceneEl.addEventListener('colorChanged', e => {
				if (e.detail.hand === this.data.hand && e.detail.color) {
					this.el.components.trail.data.color = e.detail.color;
					this.el.components.trail.updateColor();
				}
			});
		},
	});

	AFRAME.registerComponent('trail', {
		schema: {color: {type: 'color'}, hand: {type: 'string'}, lifetime: {default: 20}, trailType: {default: 'bright'}},
		update() {
			this.material = new THREE.ShaderMaterial({
				transparent: true,
				vertexShader: 'varying vec2 uv0;\nvoid main() {\n float forward_offset = 0.1 + 0.9 * uv.x;\n uv0 = uv;\n gl_Position = projectionMatrix * modelViewMatrix * vec4(position * forward_offset, 1.0);\n}',
				fragmentShader: 'uniform vec4 bladeColor;\nvarying vec2 uv0;\nvoid main() { gl_FragColor = bladeColor; }',
				uniforms: {bladeColor: {value: {x: 0, y: 0, z: 0, w: 0}}},
			});
			this.mesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(0.1, 0.5), this.material);
			this.el.sceneEl.setObject3D('trail__' + this.data.hand, this.mesh);
			this.updateColor();
		},
		updateColor() {
			const c = new THREE.Color(this.data.color);
			this.material.uniforms.bladeColor.value = {x: c.r, y: c.g, z: c.b, w: 1};
		},
	});

	AFRAME.registerComponent('beat', {
		schema: {type: {default: 'arrow'}, color: {default: 'red'}, red: {default: '#bf2121'}, blue: {default: '#335aff'}},
		init() {
			this.blockEl = this.el.querySelector('.block');
		},
		tick() {
			const rl = this.el.sceneEl.components['replay-loader'];
			if (!rl.allStructs) return;
			const idx = Number(this.el.dataset.idx);
			this.replayNote = rl.allStructs[idx];
		},
	});

	AFRAME.registerComponent('wall', {});
})();
