// Beat detection + waveform peaks. Pure functions: used by the app and by tests/beats.test.js (node).

// Onset envelope (rise in log energy) -> tempo by autocorrelation -> best-phase beat grid,
// then each beat nudged to the strongest onset nearby so the grid follows small drifts.
function detectBeats(samples, sampleRate) {
  const hop = Math.round(sampleRate / 86), win = hop * 2; // ~86 envelope frames per second
  const n = Math.floor((samples.length - win) / hop);
  if (n < 172) return { bpm: 0, beats: [] }; // under ~2 s: nothing reliable
  const fps = sampleRate / hop;
  const loud = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * hop, end = j + win; j < end; j++) e += samples[j] * samples[j];
    loud[i] = Math.log(1 + 1000 * e / win);
  }
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, loud[i] - loud[i - 1]);
  // remove the slow local average so quiet and loud passages count alike
  const half = Math.round(fps / 4), flat = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n + half; i++) {
    if (i < n) sum += env[i];
    if (i - 2 * half - 1 >= 0) sum -= env[i - 2 * half - 1];
    const c = i - half;
    if (c >= 0) flat[c] = Math.max(0, env[c] - sum / (2 * half + 1));
  }

  const minLag = Math.floor(60 * fps / 190), maxLag = Math.ceil(60 * fps / 65);
  // ±1 frame tolerance: a period that falls between frames would otherwise lose to its double
  const score = lag => {
    let r = 0;
    for (let i = 0; i + lag + 1 < n; i++) r += flat[i] * Math.max(flat[i + lag - 1], flat[i + lag], flat[i + lag + 1]);
    return r / (n - lag);
  };
  let bestLag = 0, best = -1;
  const ac = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2)); // mild pull toward 120 against octave errors
    ac[lag] = score(lag);
    if (ac[lag] * w > best) { best = ac[lag] * w; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return { bpm: 0, beats: [] };
  // parabolic refinement for a fractional period
  let lag = bestLag;
  const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
  if (a !== undefined && c !== undefined && a - 2 * b + c !== 0) lag += 0.5 * (a - c) / (a - 2 * b + c);

  let phase = 0, bestP = -1;
  for (let p = 0; p < lag; p++) {
    let s = 0;
    for (let k = p; k < n; k += lag) s += flat[Math.round(k)] || 0;
    if (s > bestP) { bestP = s; phase = p; }
  }
  const beats = [], reach = Math.max(1, Math.round(lag * 0.1));
  for (let k = phase; k < n; k += lag) {
    let at = Math.round(k), top = flat[at] || 0;
    for (let j = at - reach; j <= at + reach; j++) if ((flat[j] || 0) > top) { top = flat[j]; at = j; }
    beats.push(+(at / fps).toFixed(3));
  }
  return { bpm: Math.round(60 * fps / lag), beats };
}

// Max-abs per bucket, for drawing the waveform.
function computePeaks(samples, count) {
  const out = new Float32Array(count), step = samples.length / count;
  for (let i = 0; i < count; i++) {
    let m = 0;
    for (let j = Math.floor(i * step), end = Math.floor((i + 1) * step); j < end; j++) {
      const v = Math.abs(samples[j]); if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { detectBeats, computePeaks };
