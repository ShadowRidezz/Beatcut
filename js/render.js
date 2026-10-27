// Draws one frame of the project. Shared by the live preview and the MP4 export, so what you
// see is what you export. Sizes are relative to the canvas, so any resolution works.

const ASPECTS = { '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] };

const LOOKS = {
  none:  { label: 'None' },
  bw:    { label: 'B&W', css: 'grayscale(1) contrast(1.2)' },
  noir:  { label: 'Noir', css: 'grayscale(1) contrast(1.55) brightness(1.02)' },
  warm:  { label: 'Warm', css: 'saturate(1.3) contrast(1.08)', tint: 'rgba(255,110,20,.35)' },
  cool:  { label: 'Cool', css: 'saturate(.85) contrast(1.12)', tint: 'rgba(30,110,255,.4)' },
  vivid: { label: 'Vivid', css: 'saturate(1.7) contrast(1.15)' },
  faded: { label: 'Faded', css: 'contrast(.85) brightness(1.08) saturate(.7)' },
};
const TRANSITIONS = { none: 'Cut', flash: 'Flash', smear: 'Smear', zoomblur: 'Zoom blur', fade: 'Fade in', zoom: 'Zoom punch', blur: 'Blur in', whip: 'Whip' };
const TRANSITION_LEN = 0.3;
// motion transitions smear a few frames on BOTH sides of the cut, like the reference edits
const MOTION = { smear: true, zoomblur: true }, SMEAR_IN = 0.12, SMEAR_OUT = 0.08;

// Matched to the inspiration edits: thin lowercase captions with a dark glow, classic serif with a
// white glow, huge hollow neon outlines, and a filled condensed word with a drop shadow.
const TEXT_STYLES = {
  caption: { label: 'Caption', font: '300 {s}px Oswald', lower: true, size: 4.2, shadow: true, spacing: 0.02 },
  serif:   { label: 'Serif', font: '500 {s}px "Cormorant Garamond"', size: 7, glow: true, spacing: 0.02, fit: true, stretch: 1.6 },
  big:     { label: 'Outline', font: '{s}px Anton', upper: true, size: 30, hollow: 0.012, fit: true, spacing: 0.04 },
  bold:    { label: 'Bold', font: '{s}px Anton', upper: true, size: 9, drop: true, fit: true, spacing: 0.01 },
};
const TEXT_ANIMS = { none: 'None', type: 'Typewriter', pop: 'Pop', fade: 'Fade', shake: 'Shake' };

const clipDur = c => (c.out - c.in) / c.speed;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function layoutClips(clips) {
  let s = 0;
  return clips.map(clip => { const r = { clip, start: s, dur: clipDur(clip) }; s += r.dur; return r; });
}
function clipAt(clips, t) {
  return layoutClips(clips).find(r => t >= r.start && t < r.start + r.dur);
}

// smooth pseudo-random wobble for shake
const wobble = (t, f) => (Math.sin(t * f) + Math.sin(t * f * 1.73 + 1.3) * 0.6) / 1.6;

function drawFrame(ctx, W, H, t, project, getSource) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const L = layoutClips(project.clips), i = L.findIndex(r => t >= r.start && t < r.start + r.dur);
  const hit = L[i], src = hit && getSource(hit.clip);
  const next = L[i + 1]?.clip;
  const out = next && MOTION[next.trans] ? { trans: next.trans, remain: hit.start + hit.dur - t } : null;
  if (src && src.videoWidth) drawClip(ctx, W, H, hit.clip, t - hit.start, src, t, project.song, out, hit.dur);
  for (const tx of project.texts) {
    if (t >= tx.start && t < tx.start + tx.dur) drawText(ctx, W, H, tx, t - tx.start);
  }
  ctx.restore();
}

// seconds since the last beat at timeline time t (Infinity with no song)
function sinceBeat(song, t) {
  if (!song?.beats.length) return Infinity;
  const b = song.beats, x = t - song.offset;
  let lo = 0, hi = b.length - 1;
  if (x < b[0]) return Infinity;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= x) lo = mid; else hi = mid - 1; }
  return x - b[lo];
}

function drawClip(ctx, W, H, c, local, src, t, song, out = null, dur = Infinity) {
  const p = Math.min(1, local / TRANSITION_LEN), inv = 1 - p;
  const tr = local < TRANSITION_LEN ? c.trans : 'none';
  let scale = Math.max(W / src.videoWidth, H / src.videoHeight) * c.zoom;
  if (c.pulse) scale *= 1 + 0.05 * Math.exp(-sinceBeat(song, t) / 0.08); // punch-in on every beat
  let dx = 0, dy = 0, blur = 0;
  if (tr === 'zoom') scale *= 1 + 0.35 * inv * inv;
  if (tr === 'blur') blur = inv * 18;
  if (tr === 'whip') { dx = -inv * inv * W * 0.6; blur = inv * 14; }
  if (c.shake !== 'off') {
    const a = (c.shake === 'hard' ? 0.025 : 0.01) * W;
    dx += wobble(t, 41) * a; dy += wobble(t + 9, 37) * a;
    scale *= 1 + (c.shake === 'hard' ? 0.06 : 0.025); // overscan so edges never show
  }
  const look = LOOKS[c.look] || LOOKS.none;
  const css = [look.css, blur ? `blur(${blur * W / 1080}px)` : ''].filter(Boolean).join(' ');
  const w = src.videoWidth * scale, h = src.videoHeight * scale;
  // panX = which part of the source sits in the middle of the frame (0.5 = centre), never showing an edge
  const x = clamp(W / 2 - w * (c.panX ?? 0.5), W - w, 0) + dx, y = (H - h) / 2 + dy;
  // motion transition strength: coming in from the cut, or going out into the next one
  let motion = null, amt = 0;
  if (MOTION[c.trans] && local < SMEAR_IN) { motion = c.trans; amt = 1 - local / SMEAR_IN; }
  if (out && out.remain < SMEAR_OUT) { motion = out.trans; amt = Math.max(amt, 1 - out.remain / SMEAR_OUT); }
  ctx.filter = [css, motion ? `blur(${amt * 5 * W / 1080}px)` : ''].filter(Boolean).join(' ') || 'none';
  ctx.drawImage(src, x, y, w, h);
  if (motion) { // ghost copies = motion blur (sideways smear or a radial zoom streak)
    ctx.globalAlpha = 0.24;
    for (let k = 1; k <= 5; k++) {
      const f = amt * k / 5;
      if (motion === 'smear') ctx.drawImage(src, x + f * W * 0.18, y, w, h);
      else { const s = 1 + f * 0.3; ctx.drawImage(src, W / 2 - (W / 2 - x) * s, H / 2 - (H / 2 - y) * s, w * s, h * s); }
    }
    ctx.globalAlpha = 1;
  }
  if (c.glow) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.45;
    ctx.filter = `${look.css || ''} blur(${W / 60}px) brightness(1.15)`;
    ctx.drawImage(src, x, y, w, h);
    ctx.globalAlpha = 1;
  }
  ctx.filter = 'none';
  if (look.tint) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = look.tint;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (tr === 'flash') { ctx.fillStyle = `rgba(255,255,255,${inv})`; ctx.fillRect(0, 0, W, H); }
  if (tr === 'fade') { ctx.fillStyle = `rgba(0,0,0,${inv})`; ctx.fillRect(0, 0, W, H); }
  if (c.fadeOut && dur - local < 0.6) { ctx.fillStyle = `rgba(0,0,0,${1 - (dur - local) / 0.6})`; ctx.fillRect(0, 0, W, H); }
}

function drawText(ctx, W, H, tx, local) {
  const st = TEXT_STYLES[tx.style] || TEXT_STYLES.caption;
  let str = st.upper ? tx.text.toUpperCase() : st.lower ? tx.text.toLowerCase() : tx.text;
  let alpha = 1, scale = 1, dx = 0, dy = 0;
  if (tx.anim === 'type') {
    // words appear one by one over the first 70% (max 0.3 s per word)
    const words = str.split(/(\s+)/);
    const count = words.filter(w => w.trim()).length;
    const shown = Math.ceil(count * Math.min(1, local / Math.min(tx.dur * 0.7, count * 0.3)));
    let seen = 0;
    str = words.filter(w => (w.trim() ? ++seen <= shown : seen < shown)).join('');
  }
  if (tx.anim === 'pop') { const k = Math.min(1, local / 0.15); scale = 1.5 - 0.5 * (1 - (1 - k) * (1 - k)); }
  if (tx.anim === 'fade') alpha = Math.min(1, local / 0.2, (tx.dur - local) / 0.2);
  if (tx.anim === 'shake') { dx = wobble(local, 53) * W * 0.012; dy = wobble(local + 4, 47) * W * 0.012; }
  if (!str.trim()) return;

  let size = tx.size / 100 * H;
  const lines = str.split('\n');
  ctx.save();
  const setFont = () => {
    ctx.font = st.font.replace('{s}', size);
    ctx.letterSpacing = `${(st.spacing || 0) * size}px`;
  };
  setFont();
  if (st.fit) {
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    if (widest > W * 0.92) { size *= W * 0.92 / widest; setFont(); }
  }
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(W / 2 + dx, tx.y / 100 * H + dy);
  ctx.scale(scale, scale * (st.stretch || 1));
  const lh = size * 1.05;
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * lh;
    if (st.hollow) { // outline only, glowing in its own colour
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, H * st.hollow);
      ctx.strokeStyle = tx.color;
      ctx.shadowColor = tx.color;
      ctx.shadowBlur = size * 0.25;
      ctx.strokeText(line, 0, y);
      ctx.shadowBlur = 0;
      ctx.strokeText(line, 0, y);
      return;
    }
    if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = size * 0.6; }
    if (st.glow) { // dark halo first so it reads on bright frames, then the white glow
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.5;
      ctx.fillStyle = tx.color; ctx.fillText(line, 0, y);
      ctx.shadowColor = 'rgba(200,215,255,.7)'; ctx.shadowBlur = size * 0.35;
    }
    if (st.drop) { ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowOffsetY = size * 0.06; ctx.shadowBlur = size * 0.15; }
    ctx.fillStyle = tx.color;
    ctx.fillText(line, 0, y);
    if (st.glow) { ctx.shadowBlur = size * 0.12; ctx.fillText(line, 0, y); } // tight inner glow on top of the wide one
  });
  ctx.restore();
}
