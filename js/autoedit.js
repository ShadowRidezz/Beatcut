// Auto edit: finds the best shots in the footage, then cuts them to the song's beats with a
// look, hits and the character's name — the user only picks the song and the character.

const STYLES = {
  dark:  { label: 'Dark', look: 'bw', glow: true, text: '#ffffff' },
  noir:  { label: 'Noir', look: 'noir', glow: false, text: '#e0262b' },
  cold:  { label: 'Cold', look: 'cool', glow: true, text: '#dfe9ff' },
  warm:  { label: 'Warm', look: 'warm', glow: false, text: '#ffd28a' },
  vivid: { label: 'Vivid', look: 'vivid', glow: false, text: '#ffffff' },
  clean: { label: 'Clean', look: 'none', glow: false, text: '#ffffff' },
};

function rng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Samples the video, splits it into shots at hard cuts and scores each shot by motion and
// contrast (dark, flat and very short shots are dropped). Cached on the media item.
async function findShots(m, onProgress) {
  if (m.shots) return m.shots;
  const el = document.createElement('video');
  el.muted = true; el.preload = 'auto'; el.src = m.url;
  await new Promise(r => { el.onloadeddata = r; el.onerror = r; });
  const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
  c.width = 64; c.height = 36;
  const step = Math.max(0.2, m.duration / 600), samples = [];
  let prev = null;
  for (let t = 0.05; t < m.duration - 0.05; t += step) {
    await seekVideo(el, t);
    g.drawImage(el, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data, gray = new Float32Array(64 * 36);
    let sum = 0, sq = 0, diff = 0;
    for (let i = 0; i < gray.length; i++) {
      const v = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      gray[i] = v; sum += v; sq += v * v;
      if (prev) diff += Math.abs(v - prev[i]);
    }
    const mean = sum / gray.length;
    samples.push({ t, lum: mean, contrast: Math.sqrt(Math.max(0, sq / gray.length - mean * mean)), diff: prev ? diff / gray.length : 0 });
    prev = gray;
    onProgress?.(t / m.duration);
  }
  el.removeAttribute('src');
  m.shots = shotsFromSamples(samples, step, m.duration);
  return m.shots;
}

function shotsFromSamples(samples, step, duration) {
  // a cut is a jump well above its neighbours (so flicker and fast action aren't cuts)
  const isCut = i => {
    const around = samples.slice(Math.max(0, i - 4), i + 5).filter(s => s !== samples[i]).map(s => s.diff).sort((a, b) => a - b);
    const med = around[around.length >> 1] || 0;
    return samples[i].diff > 20 && samples[i].diff > med * 2.2 + 5;
  };
  const shots = [];
  let cur = [];
  const close = end => {
    if (cur.length) {
      const start = cur[0].t, len = end - start;
      const motion = cur.slice(1).reduce((a, s) => a + s.diff, 0) / Math.max(1, cur.length - 1);
      const lum = cur.reduce((a, s) => a + s.lum, 0) / cur.length;
      const contrast = cur.reduce((a, s) => a + s.contrast, 0) / cur.length;
      const score = Math.min(motion, 25) / 25 + contrast / 70;
      if (len >= 0.6 && lum > 16 && contrast > 9) {
        // long shots become several ~2.5 s pieces so one scene doesn't fill the edit
        const parts = Math.max(1, Math.floor(len / 2.5));
        for (let p = 0; p < parts; p++) shots.push({ start: start + p * len / parts, end: start + (p + 1) * len / parts, motion, score });
      }
    }
    cur = [];
  };
  samples.forEach((s, i) => {
    if (i > 0 && isCut(i)) close(s.t - step / 2);
    cur.push(s);
  });
  close(duration);
  return shots;
}

// Picks the loudest stretch of a long song (previews are used whole).
function songWindow(song, length) {
  if (song.duration <= length + 5) return [0, song.duration];
  const per = song.peaks.length / song.duration, win = Math.round(length * per);
  let best = 0, bestAt = 0, run = 0;
  for (let i = 0; i < song.peaks.length; i++) {
    run += song.peaks[i] ** 2;
    if (i >= win) run -= song.peaks[i - win] ** 2;
    if (i >= win - 1 && run > best) { best = run; bestAt = i - win + 1; }
  }
  let start = bestAt / per;
  const near = song.beats.reduce((a, b) => (Math.abs(b - start) < Math.abs(a - start) ? b : a), start);
  start = Math.max(0, near);
  return [start, Math.min(song.duration, start + length)];
}

// Builds clips + texts. Pure: needs the song, the shot list per media, and options.
function buildEdit({ song, pool, name, style, seed, length }) {
  const rand = rng(seed);
  const st = STYLES[style] || STYLES.dark;
  const [w0, w1] = songWindow(song, length);
  const beats = song.beats.map(b => b - w0).filter(b => b > 0.05 && b <= w1 - w0 + 0.01);
  if (beats.length < 4) throw new Error('This song has no clear beat to cut to — pick another one.');
  const per = song.peaks.length / song.duration;
  const energyAt = (a, b) => {
    let s = 0, n = 0;
    for (let i = Math.floor((a + w0) * per); i < Math.ceil((b + w0) * per); i++) { s += song.peaks[i] || 0; n++; }
    return n ? s / n : 0;
  };
  const marks = [0, ...beats];
  const raw = marks.slice(0, -1).map((b, i) => energyAt(b, marks[i + 1]));
  const hi = Math.max(...raw) || 1;
  const energy = raw.map(e => e / hi);
  // how hard each beat hits: loudness just after it vs just before
  const punch = marks.map(b => energyAt(b, b + 0.08) - energyAt(Math.max(0, b - 0.08), b));

  // cut lengths in seconds (loud ~0.6 s, medium ~1.2 s, calm ~2.4 s), rounded to whole beats
  const beatLen = (beats.at(-1) - beats[0]) / Math.max(1, beats.length - 1);
  const beatsFor = sec => Math.max(1, Math.round(sec / beatLen));
  // the hardest-hitting ~15% of beats always get a cut, with a flash + hard shake
  const top = punch.slice(1).filter(p => p > 0).sort((a, b) => b - a);
  const hitAt = top[Math.max(0, Math.floor(top.length * 0.15) - 1)] ?? Infinity;
  const isHit = i => i > 0 && punch[i] > 0 && punch[i] >= hitAt;
  const cuts = [];
  for (let i = 0; i < marks.length - 1;) {
    const e = energy[i];
    const n = i === 0 ? beatsFor(1.2) : e > 0.8 ? beatsFor(0.6) : e > 0.55 ? beatsFor(1.2) : beatsFor(2.4);
    let j = Math.min(i + n, marks.length - 1);
    for (let k = i + 1; k < j; k++) if (isHit(k)) { j = k; break; }
    cuts.push({ start: marks[i], end: marks[j], e, punch: punch[i], hit: isHit(i) });
    i = j;
  }

  const shots = pool.flatMap(p => p.shots.map(s => ({ ...s, mediaId: p.id, len: s.end - s.start })));
  if (!shots.length) throw new Error('No usable shots found in the footage (too dark or too short).');
  shots.forEach(s => { s.order = s.score + rand() * 0.6; });
  shots.sort((a, b) => b.order - a.order);
  const used = new Set();
  let lastMedia = null;
  const clips = cuts.map((cut, k) => {
    const dur = cut.end - cut.start;
    let speed = cut.e < 0.4 && rand() < 0.5 ? 0.7 : 1; // calm parts: a touch of slow motion
    let need = dur * speed;
    if (used.size >= shots.length) used.clear();
    const free = shots.filter(s => !used.has(s));
    const shot = free.find(s => s.len >= need && s.mediaId !== lastMedia) || free.find(s => s.len >= need)
      || free.reduce((a, s) => (s.len > a.len ? s : a));
    if (shot.len < need) { speed = Math.max(0.5, shot.len / dur); need = dur * speed; } // too short: slow it down to fit
    used.add(shot);
    lastMedia = shot.mediaId;
    const room = Math.max(0, shot.len - need);
    const from = shot.start + room * (0.3 + rand() * 0.4);
    const big = cut.hit;
    return {
      id: uid(), mediaId: shot.mediaId, in: from, out: from + need, speed, volume: 0,
      look: st.look, glow: st.glow, zoom: 1 + (big ? 0.05 : rand() * 0.04),
      shake: big ? 'hard' : cut.e > 0.6 && rand() < 0.4 ? 'soft' : 'off',
      trans: k === 0 ? 'fade' : big ? 'flash' : cut.e > 0.5 && rand() < 0.25 ? (rand() < 0.5 ? 'zoom' : 'whip') : 'none',
    };
  });

  const texts = [];
  if (name) {
    // the name lands on the biggest hit in the middle of the edit
    const mid = cuts.filter(c => c.start > (w1 - w0) * 0.2 && c.start < (w1 - w0) * 0.8);
    const drop = (mid.length ? mid : cuts).reduce((a, c) => (c.punch > a.punch ? c : a));
    const beat = (w1 - w0) / beats.length;
    texts.push({ id: uid(), text: name, style: 'big', color: st.text, size: 28, y: 50, anim: 'pop', start: drop.start, dur: Math.max(beat * 2, drop.end - drop.start) });
  }
  return { clips, texts, offset: -w0 };
}

if (typeof module !== 'undefined') module.exports = { buildEdit, shotsFromSamples, songWindow, STYLES };
