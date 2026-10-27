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
// structure like the reference: calm intro, flash on the drop (15 s), title one word per beat
// before it, fade out at the end
const layout = []; let at = 0 - r.offset;
for (const c of r.clips) { layout.push({ c, start: at }); at += (c.out - c.in) / c.speed; }
const dropClip = layout.find(x => Math.abs(x.start - 15) < 1e-6);
assert(dropClip, 'no cut exactly on the drop');
assert.strictEqual(dropClip.c.trans, 'flash');
assert.strictEqual(r.clips[0].trans, 'blur');
assert(r.clips.at(-1).fadeOut && r.clips.slice(0, -1).every(c => !c.fadeOut), 'only the last clip fades out');
assert(r.clips.some(c => c.trans === 'smear') && r.clips.some(c => c.trans === 'zoomblur'), 'motion transitions missing');
const titled = buildEdit({ song, pool, name: 'Levi', title: 'a true warrior', style: 'dark', seed: 42, length: 20 });
assert.deepStrictEqual(titled.texts.map(x => x.text), ['A', 'TRUE', 'WARRIOR']);
const last = titled.texts.at(-1);
assert(Math.abs(last.start + last.dur - (15 + titled.offset)) < 1e-6, 'title must end on the drop');
assert(titled.texts.every((x, i) => i === 0 || Math.abs(titled.texts[i - 1].start + titled.texts[i - 1].dur - x.start) < 1e-6), 'title words should follow each other beat by beat');
assert.strictEqual(r.texts[0].text, 'LEVI');
assert.deepStrictEqual(buildEdit({ song, pool, name: '', style: 'dark', seed: 42, length: 20 }).texts, []);

// manga (black-and-white) shots never mix with colour ones: the bigger group wins
const colour = shots.map(s => ({ ...s, sat: 40 }));
const manga = shots.slice(0, 2).map(s => ({ ...s, sat: 3 }));
const mixed = buildEdit({ song, pool: [{ id: 'anime', shots: colour }, { id: 'manga', shots: manga }], name: '', style: 'dark', seed: 1, length: 20 });
assert(mixed.clips.every(c => c.mediaId === 'anime'), 'a manga shot slipped into a colour edit');

// framing: the crop centres on the busy side of the frame
const { bestPan } = require('../js/autoedit.js');
const cols = new Float32Array(64); for (let i = 46; i < 56; i++) cols[i] = 10;
const pan = bestPan(cols, (9 / 16) / (16 / 9));
assert(pan > 0.7 && pan < 0.85, `pan ${pan}`);
assert(Math.abs(bestPan(new Float32Array(64), 0.3) - 0.5) < 0.02, "flat frame should stay centred");
const framed = buildEdit({ song, pool: [{ id: 'w', w: 1280, h: 720, shots: shots.map(s => ({ ...s, cols })) }], name: '', style: 'dark', seed: 3, length: 20 });
assert(framed.clips.every(c => c.panX > 0.7), 'clips were not framed on the subject');

// focus: shots that look like the character most footage shows win over the odd ones out
const hero = Float32Array.from([0, 9, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0]); // blond / brown
const other = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 9, 9, 0, 0, 0]); // blue
const cast = [];
for (let i = 0; i < 12; i++) cast.push({ start: i * 3, end: i * 3 + 2.5, score: 1, sat: 40, hist: i < 4 ? other : hero });
const focused = buildEdit({ song, pool: [{ id: 'p', shots: cast }], name: '', style: 'dark', seed: 5, length: 20 });
const usedOther = focused.clips.filter(c => cast.find(s => c.in >= s.start - 1e-9 && c.in < s.end && s.hist === other));
assert(usedOther.length === 0, `${usedOther.length} clips of the other character`);

// hero shot (the one the pack thumbnail came from) carries the title right before the drop
const withHero = shots.map((s, i) => ({ ...s, sat: 40, thumbMatch: i === 3 ? 0.9 : 0.1 }));
const heroEdit = buildEdit({ song, pool: [{ id: 'h', shots: withHero }], name: 'Levi', style: 'dark', seed: 9, length: 20 });
let tt = -heroEdit.offset, titleClip = null;
for (const c of heroEdit.clips) { const d = (c.out - c.in) / c.speed; if (tt < 15 - 1e-6 && tt + d > 15 - 1e-3) titleClip = c; tt += d; }
assert(titleClip && titleClip.in >= withHero[3].start - 1e-9 && titleClip.in < withHero[3].end, 'the title cut should use the hero shot');
assert.strictEqual(heroEdit.clips.filter(c => c.in >= withHero[3].start - 1e-9 && c.in < withHero[3].end).length >= 1, true);

// long song: frames the edit around the drop
const long = { duration: 120, beats: [], peaks: new Float32Array(120 * 60) };
for (let i = 0; i < long.peaks.length; i++) long.peaks[i] = i >= 60 * 60 && i < 85 * 60 ? 1 : 0.1;
const [w0, , dropAt] = songWindow(long, 20);
assert(Math.abs(w0 + dropAt - 60) < 0.5 && dropAt >= 6 && dropAt <= 8, `window ${w0}, drop at ${dropAt}`);
console.log(`ok: ${shots.length} shots, ${r.clips.length} cuts, all on beats; window ${w0}s`);
