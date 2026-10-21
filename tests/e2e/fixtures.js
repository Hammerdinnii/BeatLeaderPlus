// Test data for running the real BeatLeader web replayer offline: a replay (.bsor) generated for
// the test map that ships with the replayer's repository (assets/test.zip), plus the API answers
// the replayer asks for. The replayer itself is used unmodified; see tests/README.md.
const fs = require('fs');
const path = require('path');

const PLAYER_ID = '76561198000000001';
const SCORE_ID = 1001;
const DIFFICULTY = 'Expert';
const DIFFICULTY_VALUE = 7; // Easy 1, Normal 3, Hard 5, Expert 7, ExpertPlus 9

/* ------------------------------------------------------------------ BSOR writer */

// Field order and types follow the replayer's own decoder (src/open-replay-decoder.js).
class Writer {
	constructor() {
		this.chunks = [];
	}
	u8(v) {
		this.chunks.push(Buffer.from([v & 255]));
	}
	bool(v) {
		this.u8(v ? 1 : 0);
	}
	i32(v) {
		const b = Buffer.alloc(4);
		b.writeInt32LE(v);
		this.chunks.push(b);
	}
	f32(v) {
		const b = Buffer.alloc(4);
		b.writeFloatLE(v);
		this.chunks.push(b);
	}
	str(s) {
		const b = Buffer.from(s, 'utf8');
		this.i32(b.length);
		this.chunks.push(b);
	}
	vec(v) {
		this.f32(v.x);
		this.f32(v.y);
		this.f32(v.z);
	}
	quat(q) {
		this.vec(q);
		this.f32(q.w);
	}
	buffer() {
		return Buffer.concat(this.chunks);
	}
}

const quatY = a => ({x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2)});
const quatX = a => ({x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2)});

/** Map notes with the song time and note ID the replayer computes for a v2 map without BPM changes. */
function mapNotes(map, bpm) {
	return map._notes
		.filter(n => n._type === 0 || n._type === 1)
		.map(n => ({
			id: n._lineIndex * 1000 + n._lineLayer * 100 + n._type * 10 + n._cutDirection,
			time: (n._time * 60) / bpm,
			type: n._type,
			x: (n._lineIndex - 1.5) * 0.6,
			y: 0.8 + n._lineLayer * 0.55,
		}))
		.sort((a, b) => a.time - b.time);
}

function buildReplay(info, map, hash) {
	const bpm = info._beatsPerMinute;
	const notes = mapNotes(map, bpm);
	const duration = notes[notes.length - 1].time + 3;
	const w = new Writer();
	w.i32(0x442d3d69);
	w.u8(1);

	w.u8(0); // info
	w.str('0.9.0');
	w.str('1.29.1');
	w.str('1700000000');
	w.str(PLAYER_ID);
	w.str('Test Player');
	w.str('steam'); // the decoder finds the end of the name by this field's length (5, 6 or 8)
	w.str('Oculus');
	w.str('Rift S');
	w.str('Touch');
	w.str(hash);
	w.str(info._songName);
	w.str(info._levelAuthorName);
	w.str(DIFFICULTY);
	w.i32(500000);
	w.str('Standard');
	w.str(info._environmentName);
	w.str('');
	w.f32(0); // jump distance: map default
	w.bool(false);
	w.f32(1.75);
	w.f32(0);
	w.f32(0);
	w.f32(0);

	w.u8(1); // frames: 90 fps, sabers swinging up and down
	const frames = Math.floor(duration * 90);
	w.i32(frames);
	for (let i = 1; i <= frames; i++) {
		const t = i / 90;
		const swing = Math.sin(t * Math.PI * 2 * (bpm / 120));
		w.f32(t);
		w.i32(90);
		w.vec({x: Math.sin(t * 0.7) * 0.05, y: 1.7, z: 0});
		w.quat(quatY(Math.sin(t * 0.5) * 0.15));
		w.vec({x: -0.3, y: 1.1 + swing * 0.2, z: 0.2});
		w.quat(quatX(-0.6 + swing * 0.7));
		w.vec({x: 0.3, y: 1.1 - swing * 0.2, z: 0.2});
		w.quat(quatX(-0.6 - swing * 0.7));
	}

	w.u8(2); // notes: mostly good cuts, with some misses, bad cuts and low-accuracy cuts
	w.i32(notes.length);
	const missTimes = [];
	notes.forEach((n, i) => {
		const kind = i % 23 === 7 ? 'miss' : i % 31 === 11 ? 'bad' : 'good';
		if (kind === 'miss') missTimes.push(n.time);
		w.i32(n.id);
		w.f32(n.time + (kind === 'miss' ? 0.15 : 0));
		w.f32(n.time);
		w.i32(kind === 'good' ? 0 : kind === 'bad' ? 1 : 2);
		if (kind === 'miss') return;
		const low = i % 9 === 4; // cut score well under 100
		w.bool(true);
		w.bool(true);
		w.bool(kind === 'good');
		w.bool(false);
		w.f32(5 + (i % 4));
		w.vec({x: 0, y: -1, z: 0.1});
		w.i32(kind === 'good' ? n.type : 1 - n.type);
		w.f32(((i % 5) - 2) * 0.004);
		w.f32(i % 7);
		w.vec({x: n.x, y: n.y, z: 0});
		w.vec({x: 1, y: 0, z: 0});
		w.f32(low ? 0.25 : 0.02 + (i % 6) * 0.01);
		w.f32(100);
		w.f32(low ? 0.7 : 1);
		w.f32(low ? 0.5 : 1);
	});

	for (const type of [3, 4, 5]) {
		w.u8(type); // walls, heights, pauses
		w.i32(0);
	}
	return {buffer: w.buffer(), missTimes, firstNote: notes[0].time, duration};
}

/* ------------------------------------------------------------------ fixture set */

/**
 * Reads the test map from a replayer checkout and returns everything the tests serve:
 * the replay, the map zip, and the BeatLeader / BeatSaver API answers.
 */
async function load(replayerDir) {
	const JSZip = require(path.join(replayerDir, 'node_modules', 'jszip'));
	const source = await JSZip.loadAsync(fs.readFileSync(path.join(replayerDir, 'assets', 'test.zip')));
	const info = JSON.parse(await source.file('info.dat').async('string'));
	const map = JSON.parse(await source.file(DIFFICULTY + '.dat').async('string'));
	const hash = 'B1E0C1A2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8';

	// The test map declares its audio as "<song>.egg" while the file is named ".ogg"; repackage
	// it under the declared name so the replayer finds it.
	const zip = new JSZip();
	for (const name of Object.keys(source.files)) {
		const entry = source.files[name];
		if (entry.dir) continue;
		const isAudio = /\.(ogg|egg)$/i.test(name);
		zip.file(isAudio ? info._songFilename : name, await entry.async('nodebuffer'));
	}
	const mapZip = await zip.generateAsync({type: 'nodebuffer'});

	const {buffer: replay, missTimes, firstNote} = buildReplay(info, map, hash);
	const replayUrl = `https://cdn.replays.beatleader.xyz/${SCORE_ID}-${PLAYER_ID}-${DIFFICULTY}-Standard-${hash}.bsor`;
	const zipUrl = `https://r2cdn.beatsaver.com/${hash.toLowerCase()}.zip`;
	const player = {id: PLAYER_ID, name: 'Test Player', alias: null, avatar: '', country: 'US', profileSettings: null};
	const score = {
		id: SCORE_ID,
		playerId: PLAYER_ID,
		player,
		leaderboardId: 'test-leaderboard',
		validContexts: 2,
		song: {hash, name: info._songName, subName: info._songSubName, author: info._songAuthorName, mapper: info._levelAuthorName},
		difficulty: {value: DIFFICULTY_VALUE, difficultyName: DIFFICULTY, modeName: 'Standard', stars: 7.1, accRating: 8.4, passRating: 6.2, techRating: 5.1},
		accuracy: 0.95,
		pp: 250.5,
		rank: 1,
		replay: replayUrl,
		timepost: 1700000000,
	};
	const beatSaverMap = {
		id: 'test',
		name: info._songName,
		metadata: {songName: info._songName, songSubName: info._songSubName, songAuthorName: info._songAuthorName, levelAuthorName: info._levelAuthorName, bpm: info._beatsPerMinute},
		versions: [{hash: hash.toLowerCase(), downloadURL: zipUrl, coverURL: '', previewURL: ''}],
	};
	return {hash, replay, replayUrl, mapZip, zipUrl, score, player, beatSaverMap, missTimes, firstNote, scoreId: SCORE_ID, songName: info._songName, difficulty: DIFFICULTY};
}

module.exports = {load};
