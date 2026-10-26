// node tests/beats.test.js — synthetic drum loops with known tempo
const assert = require('assert');
const { detectBeats, computePeaks } = require('../js/beats.js');

function clickTrack(bpm, seconds, sr, start) {
  const s = new Float32Array(seconds * sr);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < s.length; i++) s[i] = rnd() * 0.02; // noise floor
  for (let t = start; t < seconds; t += 60 / bpm) {
    const at = Math.round(t * sr);
    for (let j = 0; j < sr * 0.05 && at + j < s.length; j++) s[at + j] += Math.sin(j / 6) * Math.exp(-j / (sr * 0.01));
  }
  return s;
}

for (const [bpm, start] of [[120, 0.25], [95, 0.6], [150, 0.1]]) {
  const sr = 22050;
  const { bpm: got, beats } = detectBeats(clickTrack(bpm, 20, sr, start), sr);
  assert(Math.abs(got - bpm) <= 2, `tempo ${bpm}: got ${got}`);
  const period = 60 / bpm;
  const off = beats.map(b => { const k = (b - start) / period; return Math.abs(k - Math.round(k)) * period; });
  assert(Math.max(...off.slice(1)) < 0.03, `beats ${bpm} off grid by ${Math.max(...off)}`);
  assert(beats.length >= Math.floor(20 / period) - 2, `beats ${bpm}: only ${beats.length}`);
  console.log(`ok ${bpm} bpm -> ${got}, ${beats.length} beats`);
}
assert.deepStrictEqual(detectBeats(new Float32Array(100), 22050), { bpm: 0, beats: [] });
const p = computePeaks(Float32Array.from([0, -1, 0.5, 0.25]), 2);
assert.deepStrictEqual(Array.from(p), [1, 0.5]);
console.log('all beat tests passed');
