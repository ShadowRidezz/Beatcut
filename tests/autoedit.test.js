// node tests/autoedit.test.js — the edit generator on a synthetic song + shot list
const assert = require('assert');
global.uid = (() => { let n = 0; return () => `id${n++}`; })();
const { buildEdit, shotsFromSamples, songWindow } = require('../js/autoedit.js');

// shots: hard cuts every 2 s, one dark shot that must be dropped
const samples = [];
for (let t = 0; t < 12; t += 0.5) {
  const cut = t > 0 && t % 2 === 0;
  samples.push({ t, diff: cut ? 80 : 6, lum: t >= 8 && t < 10 ? 5 : 100, contrast: 30 });
}
const shots = shotsFromSamples(samples, 0.5, 12);
assert.strictEqual(shots.length, 5, `expected 5 shots, got ${shots.length}`);
assert(shots.every(s => s.start < 8 || s.start >= 10), 'dark shot was kept');

// song: 30 s at 120 BPM, quiet first half, loud second half
const dur = 30, beats = [], peaks = new Float32Array(dur * 60);
for (let b = 0.5; b < dur; b += 0.5) beats.push(b);
for (let i = 0; i < peaks.length; i++) peaks[i] = i < peaks.length / 2 ? 0.2 : 0.9;
const song = { duration: dur, beats, peaks };
const pool = [{ id: 'a', shots }, { id: 'b', shots }];
const r = buildEdit({ song, pool, name: 'Levi', style: 'dark', seed: 42, length: 20 });

let t = 0;
for (const c of r.clips) {
  t += (c.out - c.in) / c.speed;
  assert(beats.some(b => Math.abs(b - t) < 1e-6), `cut at ${t} is not on a beat`);
  const shot = shots.find(s => c.in >= s.start - 1e-9 && c.out <= s.end + 1e-9);
  assert(shot, `clip ${c.in}-${c.out} crosses a shot cut`);
}
const quiet = r.clips.filter((c, i) => i > 0 && i < 4), loud = r.clips.slice(-4);
const avg = l => l.reduce((a, c) => a + (c.out - c.in) / c.speed, 0) / l.length;
assert(avg(loud) < avg(quiet), 'loud part should be cut faster than the quiet part');
assert(r.clips.some(c => c.trans === 'flash'), 'the drop should get a flash');
assert.strictEqual(r.texts[0].text, 'Levi');
assert.deepStrictEqual(buildEdit({ song, pool, name: '', style: 'dark', seed: 42, length: 20 }).texts, []);

// long song: picks the loud stretch
const long = { duration: 120, beats: [], peaks: new Float32Array(120 * 60) };
for (let i = 0; i < long.peaks.length; i++) long.peaks[i] = i >= 60 * 60 && i < 85 * 60 ? 1 : 0.1;
const [w0] = songWindow(long, 20);
assert(w0 >= 60 && w0 <= 65, `window starts at ${w0}`);
console.log(`ok: ${shots.length} shots, ${r.clips.length} cuts, all on beats; window ${w0}s`);
