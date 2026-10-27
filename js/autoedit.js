// Auto edit: finds the best shots in the footage, then cuts them to the song's beats with a
// look, hits and the character's name — the user only picks the song and the character.

// look + matching title treatment (from the inspiration edits)
const STYLES = {
  dark:  { label: 'Dark', look: 'bw', glow: true, text: { style: 'serif', color: '#eef2ff', size: 8, anim: 'fade' } },
  noir:  { label: 'Noir', look: 'noir', glow: false, text: { style: 'big', color: '#ff2a3d', size: 30, anim: 'pop' } },
  cold:  { label: 'Cold', look: 'cool', glow: true, text: { style: 'caption', color: '#eef3ff', size: 6.5, anim: 'fade' } },
  warm:  { label: 'Warm', look: 'warm', glow: false, text: { style: 'bold', color: '#ffc94a', size: 12, anim: 'pop' } },
  vivid: { label: 'Vivid', look: 'vivid', glow: false, text: { style: 'big', color: '#c6ff3d', size: 30, anim: 'pop' } },
  clean: { label: 'Clean', look: 'none', glow: false, text: { style: 'serif', color: '#ffffff', size: 8, anim: 'fade' } },
};
const MONO_SAT = 15; // below this colour spread a shot is black-and-white or one-tint (manga panels, B&W film)

// Where to centre a crop of `frac` of the width so it holds the most detail/motion (0..1).
function bestPan(cols, frac) {
  if (!cols || frac >= 1) return 0.5;
  const n = cols.length, w = Math.max(1, Math.round(frac * n));
  let best = -Infinity, at = (n - w) / 2;
  for (let x = 0; x + w <= n; x++) {
    let s = 0;
    for (let i = x; i < x + w; i++) s += cols[i];
    const centre = (x + w / 2) / n;
    const off = Math.abs(centre - 0.5);
    s = s * (1 - off * 0.35) - off * 1e-6; // lean to the middle; flat frames stay centred
    if (s > best) { best = s; at = x; }
  }
  return (at + w / 2) / n;
}

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
  const sample = t => {
    g.drawImage(el, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data, gray = new Float32Array(64 * 36);
    let sum = 0, sq = 0, diff = 0, ra = 0, rb = 0, ra2 = 0, rb2 = 0;
    for (let i = 0; i < gray.length; i++) {
      const r = d[i * 4], gr = d[i * 4 + 1], b = d[i * 4 + 2];
      const v = r * 0.3 + gr * 0.59 + b * 0.11;
      gray[i] = v; sum += v; sq += v * v;
      const ca = r - gr, cb = (r + gr) / 2 - b; // opponent colour channels
      ra += ca; rb += cb; ra2 += ca * ca; rb2 += cb * cb;
      if (prev) diff += Math.abs(v - prev[i]);
    }
    // colour variety: a tinted manga panel is one hue (low spread) even when it isn't grey
    const n = gray.length;
    const sat = Math.sqrt(Math.max(0, ra2 / n - (ra / n) ** 2) + Math.max(0, rb2 / n - (rb / n) ** 2));
    // where the subject is, column by column: detail (edges) plus movement
    const cols = new Float32Array(64);
    for (let y = 0; y < 35; y++) {
      for (let x = 0; x < 63; x++) {
        const i = y * 64 + x;
        cols[x] += Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i + 64] - gray[i]) + (prev ? Math.abs(gray[i] - prev[i]) * 0.5 : 0);
      }
    }
    // colour fingerprint of the middle of the frame (12 hue bins, weighted by saturation):
    // used to keep the edit on the character the packs are mostly about
    const hist = new Float32Array(12);
    for (let y = 4; y < 32; y++) {
      for (let x = 16; x < 48; x++) {
        const i = (y * 64 + x) * 4, r = d[i], gr = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, gr, b), mn = Math.min(r, gr, b), c = mx - mn;
        if (c < 20) continue;
        let h = mx === r ? ((gr - b) / c) % 6 : mx === gr ? (b - r) / c + 2 : (r - gr) / c + 4;
        hist[Math.floor(((h + 6) % 6) * 2)] += c;
      }
    }
    const mean = sum / gray.length;
    samples.push({ t, lum: mean, contrast: Math.sqrt(Math.max(0, sq / gray.length - mean * mean)), diff: prev ? diff / gray.length : 0, sat, cols, hist, sig: signature(gray) });
    prev = gray;
    onProgress?.(t / m.duration);
  };
  if ('requestVideoFrameCallback' in el) {
    // play it muted at 16x and grab frames as they come: ~10x faster than seeking each sample
    await new Promise(resolve => {
      let last = -Infinity;
      const onFrame = (_, meta) => {
        if (meta.mediaTime - last >= step) { last = meta.mediaTime; sample(meta.mediaTime); }
        if (!el.ended) el.requestVideoFrameCallback(onFrame);
      };
      el.requestVideoFrameCallback(onFrame);
      el.onended = resolve;
      el.onerror = resolve;
      el.playbackRate = 16;
      el.play().catch(resolve);
    });
  } else {
    for (let t = 0.05; t < m.duration - 0.05; t += step) { await seekVideo(el, t); sample(t); }
  }
  el.pause();
  el.removeAttribute('src');
  if (samples.length < 4) throw new Error(`Couldn't read “${m.name}”`);
  // the pack's thumbnail is nearly always a frame of the character: find the shot it came from
  if (m.thumbUrl) {
    try {
      const im = await createImageBitmap(await (await fetch(m.thumbUrl)).blob());
      g.drawImage(im, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data, gray = new Float32Array(64 * 36);
      for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      const ref = signature(gray);
      for (const s of samples) s.thumbMatch = correlate(s.sig, ref);
    } catch { /* no thumbnail: no hero shot */ }
  }
  m.shots = shotsFromSamples(samples, step, m.duration);
  return m.shots;
}

// 16x9 zero-mean, unit-length brightness pattern of a 64x36 frame (for matching frames)
function signature(gray) {
  const sig = new Float32Array(144);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) sig[(y >> 2) * 16 + (x >> 2)] += gray[y * 64 + x] / 16;
  const mean = sig.reduce((a, v) => a + v, 0) / 144;
  let n = 0;
  for (let i = 0; i < 144; i++) { sig[i] -= mean; n += sig[i] * sig[i]; }
  n = Math.sqrt(n) || 1;
  return sig.map(v => v / n);
}
const correlate = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

function shotsFromSamples(samples, step, duration) {
  // a cut is a jump well above its neighbours (so flicker and fast action aren't cuts)
  const isCut = i => {
    const around = samples.slice(Math.max(0, i - 4), i + 5).filter(s => s !== samples[i]).map(s => s.diff).sort((a, b) => a - b);
    const med = around[around.length >> 1] || 0;
    return samples[i].diff > 20 && samples[i].diff > med * 2.2 + 5;
  };
  const shots = [];
  let cur = [];
  // clip packs open with an intro card and end with an end screen: skip those seconds
  const lo = duration > 30 ? 1.5 : 0, hi = duration > 30 ? duration - 3 : duration;
  const avg = (list, k) => list.reduce((a, s) => a + (s[k] || 0), 0) / list.length;
  const close = end => {
    const part = cur.filter(s => s.t >= lo && s.t <= hi);
    const start = Math.max(lo, cur[0]?.t ?? 0), len = Math.min(end, hi) - start;
    if (part.length) {
      const motion = avg(part.slice(1).length ? part.slice(1) : part, 'diff');
      const lum = avg(part, 'lum'), contrast = avg(part, 'contrast');
      const cols = new Float32Array(64), hist = new Float32Array(12);
      for (const s of part) {
        if (s.cols) s.cols.forEach((v, i) => { cols[i] += v; });
        if (s.hist) s.hist.forEach((v, i) => { hist[i] += v; });
      }
      // detail = edges per pixel: faces and characters are busy, empty sky and black frames aren't
      const detail = part[0].cols ? cols.reduce((a, v) => a + v, 0) / (part.length * 64 * 35) : 10;
      const score = Math.min(motion, 25) / 25 + contrast / 70 + Math.min(detail, 30) / 15;
      if (len >= 0.6 && lum > 28 && lum < 235 && contrast > 9 && detail > 4) {
        // long shots become several ~2.5 s pieces so one scene doesn't fill the edit
        const parts = Math.max(1, Math.floor(len / 2.5));
        for (let p = 0; p < parts; p++) {
          const a = start + p * len / parts, b = start + (p + 1) * len / parts;
          const thumbMatch = Math.max(0, ...part.filter(s => s.t >= a && s.t <= b).map(s => s.thumbMatch || 0));
          shots.push({ start: a, end: b, motion, detail, score, sat: avg(part, 'sat'), cols, hist, thumbMatch });
        }
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

// Frames the edit like the reference edits: find the drop (biggest jump in loudness), start a
// calm intro before it (~35% of the length), and run the rest of the length after it.
// Returns [start, end, drop] in song seconds; drop is relative to start (0 = no build-up).
function songWindow(song, length) {
  const per = song.peaks.length / song.duration;
  const energy = (a, b) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, Math.floor(a * per)); i < Math.min(song.peaks.length, b * per); i++) { s += song.peaks[i]; n++; }
    return n ? s / n : 0;
  };
  let drop = 0, rise = 0;
  for (let t = 2; t < song.duration - 2; t += 0.1) {
    const r = energy(t, t + 2) - energy(t - 2, t);
    if (r > rise) { rise = r; drop = t; }
  }
  const top = song.peaks.reduce((a, v) => Math.max(a, v), 0) || 1;
  if (rise / top > 0.12 && drop > 1) {
    drop = song.beats.reduce((a, b) => (Math.abs(b - drop) < Math.abs(a - drop) ? b : a), drop);
    let w0 = Math.max(0, drop - Math.min(length * 0.35, 8));
    const w1 = Math.min(song.duration, w0 + length);
    if (w1 - w0 < length * 0.6) w0 = Math.max(0, w1 - length * 0.6); // drop near the end: shorter edit, not a longer intro
    return [w0, w1, drop - w0];
  }
  // no clear drop: the loudest stretch, cut fast from the start
  if (song.duration <= length + 0.5) return [0, song.duration, 0];
  const win = Math.round(length * per);
  let best = 0, bestAt = 0, run = 0;
  for (let i = 0; i < song.peaks.length; i++) {
    run += song.peaks[i] ** 2;
    if (i >= win) run -= song.peaks[i - win] ** 2;
    if (i >= win - 1 && run > best) { best = run; bestAt = i - win + 1; }
  }
  const s0 = bestAt / per;
  const w0 = Math.max(0, song.beats.reduce((a, b) => (Math.abs(b - s0) < Math.abs(a - s0) ? b : a), s0));
  return [w0, Math.min(song.duration, w0 + length), 0];
}

const cosine = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

// Scores how much each shot looks like the character most of the footage is about (packs named
// after a character show them in most shots; other characters have other hair/clothes colours).
function focusScores(shots) {
  const coloured = shots.filter(s => s.hist && s.hist.some(v => v > 0));
  if (coloured.length < 6) return;
  const addTo = (centre, h) => { const t = h.reduce((a, b) => a + b, 0) || 1; h.forEach((v, i) => { centre[i] += v / t; }); };
  let centre = new Float32Array(12);
  coloured.forEach(s => addTo(centre, s.hist));
  for (let round = 0; round < 3; round++) {
    const ranked = coloured.map(s => [cosine(s.hist, centre), s]).sort((a, b) => b[0] - a[0]);
    centre = new Float32Array(12);
    ranked.slice(0, Math.ceil(ranked.length / 2)).forEach(([, s]) => addTo(centre, s.hist));
  }
  for (const s of shots) s.focus = s.hist ? cosine(s.hist, centre) : 0.5;
}

const TITLE_SIZE = { serif: 13, big: 30, bold: 15, caption: 7 };

// Builds clips + texts. Pure: needs the song, the shot list per media, and options.
function buildEdit({ song, pool, name, title, style, seed, length, aspect = 9 / 16 }) {
  const rand = rng(seed);
  const st = STYLES[style] || STYLES.dark;
  const [w0, w1, dropAt] = songWindow(song, length);
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
  const dropIdx = dropAt > 1 ? marks.reduce((a, b, i) => (Math.abs(b - dropAt) < Math.abs(marks[a] - dropAt) ? i : a), 0) : 0;

  // cut lengths in seconds, rounded to whole beats: intro ~2.4 s (calm, long shots);
  // after the drop loud ~0.5 s, medium ~1 s, calm ~2 s
  const beatLen = (beats.at(-1) - beats[0]) / Math.max(1, beats.length - 1);
  const beatsFor = sec => Math.max(1, Math.round(sec / beatLen));
  // the hardest-hitting ~15% of beats after the drop always get a cut, with a flash + hard shake
  const top = punch.slice(dropIdx + 1).filter(p => p > 0).sort((a, b) => b - a);
  const hitAt = top[Math.max(0, Math.floor(top.length * 0.15) - 1)] ?? Infinity;
  const isHit = i => i > dropIdx && punch[i] > 0 && punch[i] >= hitAt;
  const words = (title || name || '').trim().split(/\s+/).filter(Boolean);
  // the title sits on one shot: words.length beats (2 for a single word) right before the drop
  const titleIdx = words.length && dropIdx >= 2 ? dropIdx - Math.min(Math.max(words.length, 2), dropIdx) : dropIdx;
  let cuts = [];
  for (let i = 0; i < marks.length - 1;) {
    const e = energy[i], intro = i < dropIdx;
    const n = intro ? beatsFor(2.4) : e > 0.75 ? beatsFor(0.5) : e > 0.5 ? beatsFor(1) : beatsFor(2);
    let j = Math.min(i + n, marks.length - 1);
    if (intro) j = Math.min(j, dropIdx);
    if (i < titleIdx && j > titleIdx) j = titleIdx;
    for (let k = i + 1; k < j; k++) if (isHit(k)) { j = k; break; }
    cuts.push({ start: marks[i], end: marks[j], e, punch: punch[i], hit: isHit(i), intro, drop: dropIdx > 0 && i === dropIdx });
    i = j;
  }

  let shots = pool.flatMap(p => p.shots.map(s => ({
    ...s, mediaId: p.id, len: s.end - s.start, mono: p.manga || (s.sat ?? 99) < MONO_SAT,
    panX: p.w && p.h ? bestPan(s.cols, aspect / (p.w / p.h)) : 0.5,
  })));
  if (!shots.length) throw new Error('No usable shots found in the footage (too dark or too short).');
  // never mix manga / black-and-white shots with colour anime: keep whichever there's more of
  const monoLen = shots.reduce((a, s) => a + (s.mono ? s.len : 0), 0);
  const totalLen = shots.reduce((a, s) => a + s.len, 0);
  shots = shots.filter(s => s.mono === monoLen > totalLen / 2);
  // stay on the character: drop the shots that look least like them, if there are enough left
  focusScores(shots);
  if (shots[0].focus !== undefined) {
    const ranked = shots.map(s => s.focus).sort((a, b) => a - b);
    const cutoff = ranked[Math.floor(ranked.length * 0.35)];
    const kept = shots.filter(s => s.focus >= cutoff);
    if (kept.length >= Math.min(8, cuts.length * 0.3)) shots = kept; // reusing their shots beats showing someone else
  }
  shots.forEach(s => { s.order = s.score + (s.focus ?? 0) * 1.5 + rand() * 0.4; });
  shots.sort((a, b) => b.order - a.order);
  // hero shots = the ones the pack thumbnails were taken from (best match per video): these are
  // surely the character, so they open the edit and carry the title before the drop
  const heroes = [];
  for (const id of new Set(shots.map(s => s.mediaId))) {
    const best = shots.filter(s => s.mediaId === id).reduce((a, s) => ((s.thumbMatch || 0) > (a?.thumbMatch || 0) ? s : a), null);
    if (best && best.thumbMatch > 0.55) heroes.push(best);
  }
  heroes.sort((a, b) => b.thumbMatch - a.thumbMatch);
  // with two hero shots the intro is just two long shots, like the reference: opening + title
  const before = cuts.filter(c => c.intro && c.end <= marks[titleIdx] + 1e-9);
  if (heroes.length >= 2 && before.length > 1) {
    cuts = [{ ...before[0], end: before.at(-1).end }, ...cuts.slice(before.length)];
  }
  const introCuts = cuts.filter(c => c.intro);
  const heroFor = new Map(); // cut -> hero shot: the title cut (last intro cut) first, then the opening
  [introCuts.at(-1), introCuts[0], ...introCuts.slice(1, -1)].filter(Boolean).forEach(c => { if (heroes.length && !heroFor.has(c)) heroFor.set(c, heroes.shift()); });

  const used = new Set(), reserved = new Set(heroFor.values());
  let lastMedia = null, motionFlip = rand() < 0.5;
  const clips = cuts.map((cut, k) => {
    const dur = cut.end - cut.start;
    let speed = cut.intro ? 0.85 : cut.e < 0.4 && rand() < 0.5 ? 0.7 : 1;
    let need = dur * speed;
    let free = shots.filter(s => !used.has(s) && !reserved.has(s));
    if (!free.length) { used.clear(); free = shots.filter(s => !reserved.has(s)); }
    if (!free.length) free = shots;
    // intro shots are held long: the best shots that can fill it, slowed down to as little as 0.6x
    const minLen = cut.intro ? dur * 0.6 : need;
    const shot = heroFor.get(cut) || free.find(s => s.len >= minLen && s.mediaId !== lastMedia) || free.find(s => s.len >= minLen)
      || free.reduce((a, s) => (s.len > a.len ? s : a));
    if (shot.len < need) { speed = Math.max(cut.intro ? 0.6 : 0.5, shot.len / dur); need = dur * speed; } // too short: slow it down to fit
    used.add(shot);
    reserved.delete(shot);
    lastMedia = shot.mediaId;
    const room = Math.max(0, shot.len - need);
    const from = shot.start + room * (0.3 + rand() * 0.4);
    const big = cut.hit || cut.drop;
    let trans = 'none';
    if (k === 0) trans = 'blur';
    else if (big) trans = 'flash';
    else if (cut.intro || rand() < 0.7) { trans = motionFlip ? 'smear' : 'zoomblur'; motionFlip = !motionFlip; }
    return {
      id: uid(), mediaId: shot.mediaId, in: from, out: from + need, speed, volume: 0, panX: shot.panX,
      look: st.look, glow: st.glow, zoom: 1 + (big ? 0.05 : rand() * 0.04), pulse: !cut.intro && cut.e > 0.5,
      shake: big ? 'hard' : !cut.intro && cut.e > 0.6 && rand() < 0.4 ? 'soft' : 'off',
      trans, fadeOut: k === cuts.length - 1,
    };
  });

  const texts = [];
  const size = TITLE_SIZE[st.text.style] || st.text.size;
  if (words.length && dropIdx >= 2) {
    // build-up title: one word per beat, the last word holds right up to the drop
    const n = Math.min(Math.max(words.length, 2), dropIdx);
    const list = words.slice(-n);
    const first = dropIdx - n;
    list.forEach((w, i) => {
      const a = marks[first + i], b = i === list.length - 1 ? marks[dropIdx] : marks[first + i + 1];
      texts.push({ id: uid(), text: w.toUpperCase(), ...st.text, size, anim: 'none', y: 50, start: a, dur: b - a });
    });
  } else if (words.length) {
    // no build-up: the name lands on the biggest hit in the middle of the edit
    const mid = cuts.filter(c => c.start > (w1 - w0) * 0.2 && c.start < (w1 - w0) * 0.8);
    const drop = (mid.length ? mid : cuts).reduce((a, c) => (c.punch > a.punch ? c : a));
    const end = (cuts.find(c => c.end >= drop.start + 1) || cuts.at(-1)).end;
    texts.push({ id: uid(), text: words.join(' '), ...st.text, y: 50, start: drop.start, dur: end - drop.start });
  }
  return { clips, texts, offset: -w0 };
}

if (typeof module !== 'undefined') module.exports = { buildEdit, shotsFromSamples, songWindow, bestPan, focusScores, STYLES };
