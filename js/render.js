// Draws one frame of the project. Shared by the live preview and the MP4 export, so what you
// see is what you export. Sizes are relative to the canvas, so any resolution works.

const ASPECTS = { '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] };

const LOOKS = {
  none:  { label: 'None' },
  bw:    { label: 'B&W', css: 'grayscale(1) contrast(1.2)' },
  noir:  { label: 'Noir', css: 'grayscale(1) contrast(1.7) brightness(.85)' },
  warm:  { label: 'Warm', css: 'saturate(1.3) contrast(1.08)', tint: 'rgba(255,110,20,.35)' },
  cool:  { label: 'Cool', css: 'saturate(.85) contrast(1.12)', tint: 'rgba(30,110,255,.4)' },
  vivid: { label: 'Vivid', css: 'saturate(1.7) contrast(1.15)' },
  faded: { label: 'Faded', css: 'contrast(.85) brightness(1.08) saturate(.7)' },
};
const TRANSITIONS = { none: 'Cut', flash: 'Flash', fade: 'Fade in', zoom: 'Zoom punch', blur: 'Blur in', whip: 'Whip' };
const TRANSITION_LEN = 0.3;

const TEXT_STYLES = {
  caption: { label: 'Caption', font: '600 {s}px Inter', lower: true, size: 4.5, shadow: true },
  big:     { label: 'Big word', font: '{s}px Anton', upper: true, size: 28, stroke: 0.05, fit: true },
  serif:   { label: 'Serif', font: '600 {s}px "Playfair Display"', size: 8, glow: true },
  comic:   { label: 'Comic', font: '{s}px Bangers', size: 13, stroke: 0.09, fit: true },
};
const TEXT_ANIMS = { none: 'None', type: 'Typewriter', pop: 'Pop', fade: 'Fade', shake: 'Shake' };

const clipDur = c => (c.out - c.in) / c.speed;
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
  const hit = clipAt(project.clips, t);
  const src = hit && getSource(hit.clip);
  if (src && src.videoWidth) drawClip(ctx, W, H, hit.clip, t - hit.start, src, t);
  for (const tx of project.texts) {
    if (t >= tx.start && t < tx.start + tx.dur) drawText(ctx, W, H, tx, t - tx.start);
  }
  ctx.restore();
}

function drawClip(ctx, W, H, c, local, src, t) {
  const p = Math.min(1, local / TRANSITION_LEN), inv = 1 - p;
  const tr = local < TRANSITION_LEN ? c.trans : 'none';
  let scale = Math.max(W / src.videoWidth, H / src.videoHeight) * c.zoom;
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
  const x = (W - w) / 2 + dx, y = (H - h) / 2 + dy;
  ctx.filter = css || 'none';
  ctx.drawImage(src, x, y, w, h);
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
  ctx.font = st.font.replace('{s}', size);
  if (st.fit) {
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    if (widest > W * 0.94) { size *= W * 0.94 / widest; ctx.font = st.font.replace('{s}', size); }
  }
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(W / 2 + dx, tx.y / 100 * H + dy);
  ctx.scale(scale, scale);
  const lh = size * 1.1;
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * lh;
    if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.4; }
    if (st.glow) { ctx.shadowColor = 'rgba(255,255,255,.7)'; ctx.shadowBlur = size * 0.5; }
    if (st.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = size * st.stroke * 2;
      ctx.strokeStyle = tx.stroke || '#000';
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = tx.color;
    ctx.fillText(line, 0, y);
  });
  ctx.restore();
}
