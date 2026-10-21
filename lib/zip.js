/*
 * BeatLeaderPlus – minimal, dependency-free ZIP reader.
 *
 * Supports "stored" and "deflate" entries (the two methods every common zip tool produces),
 * using the browser's native DecompressionStream('deflate-raw'). ZIP64 and encryption are not
 * supported – that is plenty for hitsound packs.
 */
(function (root) {
	'use strict';

	const BLP = (root.BLP = root.BLP || {});
	if (BLP.zip) return;

	const SIG_EOCD = 0x06054b50;
	const SIG_CENTRAL = 0x02014b50;
	const SIG_LOCAL = 0x04034b50;

	async function inflateRaw(bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	function findEocd(view) {
		const min = Math.max(0, view.byteLength - 65557);
		for (let i = view.byteLength - 22; i >= min; i--) {
			if (view.getUint32(i, true) === SIG_EOCD) return i;
		}
		return -1;
	}

	/**
	 * Read all file entries of a zip archive.
	 * @param {ArrayBuffer} buffer
	 * @param {(name: string) => boolean} [filter] only decompress entries for which this returns true
	 * @returns {Promise<Array<{name: string, size: number, data: Uint8Array}>>}
	 */
	async function readZip(buffer, filter) {
		const view = new DataView(buffer);
		const eocd = findEocd(view);
		if (eocd < 0) throw new Error('Not a zip file (end of central directory not found).');
		const count = view.getUint16(eocd + 10, true);
		let ptr = view.getUint32(eocd + 16, true);
		const decoder = new TextDecoder();
		const out = [];

		for (let i = 0; i < count; i++) {
			if (view.getUint32(ptr, true) !== SIG_CENTRAL) throw new Error('Corrupt zip central directory.');
			const flags = view.getUint16(ptr + 8, true);
			const method = view.getUint16(ptr + 10, true);
			const compSize = view.getUint32(ptr + 20, true);
			const size = view.getUint32(ptr + 24, true);
			const nameLen = view.getUint16(ptr + 28, true);
			const extraLen = view.getUint16(ptr + 30, true);
			const commentLen = view.getUint16(ptr + 32, true);
			const localOffset = view.getUint32(ptr + 42, true);
			const name = decoder.decode(new Uint8Array(buffer, ptr + 46, nameLen));
			ptr += 46 + nameLen + extraLen + commentLen;

			if (name.endsWith('/')) continue; // directory
			if (flags & 0x1) continue; // encrypted
			if (filter && !filter(name)) continue;
			if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error('Corrupt zip local header for ' + name);
			const lNameLen = view.getUint16(localOffset + 26, true);
			const lExtraLen = view.getUint16(localOffset + 28, true);
			const start = localOffset + 30 + lNameLen + lExtraLen;
			const raw = new Uint8Array(buffer, start, compSize);

			let data;
			if (method === 0) data = new Uint8Array(raw);
			else if (method === 8) data = await inflateRaw(raw);
			else continue; // unsupported compression
			out.push({name, size, data});
		}
		return out;
	}

	BLP.zip = {readZip};
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
