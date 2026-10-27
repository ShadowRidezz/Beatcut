// Beatcut — app state, preview playback, timeline, panels.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const refreshIcons = () => window.lucide?.createIcons();

const S = {
  media: [], clips: [], texts: [], song: null,
  aspect: '9:16', sel: null, t: 0, playing: false, step: 'song', exporting: false, pps: 80,
  style: 'auto', length: '20', making: false, musicOut: false, voice: null,
};
const mediaById = id => S.media.find(m => m.id === id);
// Clips alternate between two players per video, so the next shot can already be rolling
// when the cut hits (preview cuts land on the beat instead of a frame or two late).
const getSource = clip => { const m = mediaById(clip.mediaId); return m && (S.clips.indexOf(clip) % 2 ? m.el2 : m.el); };
const players = () => S.media.flatMap(m => [m.el, m.el2]);
function projectDuration() {
  const L = layoutClips(S.clips);
  const video = L.length ? L.at(-1).start + L.at(-1).dur : 0;
  const text = Math.max(0, ...S.texts.map(x => x.start + x.dur));
  return Math.max(video, text) || (S.song ? Math.max(0, S.song.offset + S.song.duration) : 0);
}
function selected() {
  const s = S.sel;
  if (!s) return null;
  const obj = s.type === 'clip' ? S.clips.find(c => c.id === s.id)
    : s.type === 'text' ? S.texts.find(x => x.id === s.id)
    : s.type === 'song' ? S.song : null;
  return obj ? { type: s.type, obj } : null;
}

// ---------- undo / redo ----------
const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify({
  clips: S.clips, texts: S.texts, aspect: S.aspect,
  song: S.song && { offset: S.song.offset, volume: S.song.volume, duckUntil: S.song.duckUntil || 0 }, voice: S.voice,
});
function restore(json) {
  const d = JSON.parse(json);
  S.clips = d.clips; S.texts = d.texts; S.aspect = d.aspect; S.voice = d.voice;
  if (S.song && d.song) Object.assign(S.song, d.song);
  if (!selected()) S.sel = null;
  renderAll();
}
function pushUndo(before) {
  undoStack.push(before);
  if (undoStack.length > 150) undoStack.shift();
  redoStack.length = 0;
}
function commit(fn) {
  const before = snapshot();
  fn();
  if (snapshot() !== before) pushUndo(before);
  renderAll();
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }

// ---------- toast / modal ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function openModal(html, onClose) {
  $('#modalCard').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal').onclose = onClose;
  refreshIcons();
}
function closeModal() {
  const m = $('#modal');
  if (m.hidden) return;
  $$('video, audio', m).forEach(v => v.pause());
  m.hidden = true;
  $('#modalCard').innerHTML = '';
  m.onclose?.();
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

// ---------- media import ----------
async function grabThumb(el) {
  await seekVideo(el, Math.min(1, el.duration * 0.2));
  const c = document.createElement('canvas');
  c.height = 90; c.width = Math.round(90 * el.videoWidth / el.videoHeight) || 160;
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

async function addMedia(blob, name, extra = {}) {
  const url = URL.createObjectURL(blob);
  const [el, el2] = [0, 1].map(() => {
    const v = document.createElement('video');
    v.preload = 'auto'; v.playsInline = true; v.preservesPitch = false; v.src = url;
    return v;
  });
  try {
    await new Promise((ok, fail) => {
      el.onloadeddata = ok;
      el.onerror = () => fail(new Error('this browser cannot play that video format'));
    });
  } catch (e) { URL.revokeObjectURL(url); throw e; }
  const m = { id: uid(), name, tags: '', source: 'My files', blob, url, el, el2, duration: el.duration, thumb: await grabThumb(el), ...extra };
  S.media.push(m);
  renderClipResults();
  updateSteps();
  return m;
}

async function importFiles(files) {
  files = [...files];
  const videos = files.filter(f => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name));
  const audio = files.find(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name));
  if (audio && !videos.length) return loadSongFile(audio);
  let added = 0;
  for (const f of videos) {
    try { await addMedia(f, f.name.replace(/\.[^.]+$/, ''), { tags: $('#clipQuery').value.trim() }); added++; }
    catch (e) { toast(`Couldn't open ${f.name}: ${e.message}`); }
  }
  if (added) toast(`Added ${added} video${added > 1 ? 's' : ''}`);
}

function addClip(m, index = S.clips.length, from = 0, len = 3) {
  commit(() => {
    const start = clamp(from, 0, Math.max(0, m.duration - 0.1));
    const c = {
      id: uid(), mediaId: m.id, in: start, out: Math.min(m.duration, start + len),
      speed: 1, volume: S.song ? 0 : 1, look: 'none', glow: false, zoom: 1, shake: 'off', trans: 'none',
    };
    S.clips.splice(index, 0, c);
    S.sel = { type: 'clip', id: c.id };
  });
}

// ---------- song ----------
let audioCtx;
const actx = () => (audioCtx ||= new AudioContext());

async function setSong(blob, meta) {
  toast('Analysing beats…');
  let buffer;
  try { buffer = await actx().decodeAudioData(await blob.arrayBuffer()); }
  catch { return toast('Could not read that audio file — try MP3 or WAV.'); }
  let mono = buffer.getChannelData(0);
  if (buffer.numberOfChannels > 1) {
    const r = buffer.getChannelData(1);
    mono = mono.map((v, i) => (v + r[i]) / 2);
  }
  const { bpm, beats } = detectBeats(mono, buffer.sampleRate);
  if (S.song) URL.revokeObjectURL(S.song.url);
  const url = URL.createObjectURL(blob);
  S.song = {
    ...meta, blob, url, buffer, duration: buffer.duration, offset: 0, volume: 1, bpm, beats,
    peaks: computePeaks(mono, Math.min(6000, Math.ceil(buffer.duration * 60))),
  };
  renderAll();
  toast(bpm ? `${bpm} BPM · ${beats.length} beats marked on the timeline` : 'Song added (no clear beat found)');
}
const loadSongFile = f => setSong(f, { name: f.name.replace(/\.[^.]+$/, ''), source: 'My files' });

// ---------- preview playback ----------
const cv = $('#preview'), cx = cv.getContext('2d');
function sizeCanvas() {
  const [w, h] = ASPECTS[S.aspect];
  if (cv.width !== w / 2 || cv.height !== h / 2) { cv.width = w / 2; cv.height = h / 2; }
  const box = $('#viewer').getBoundingClientRect();
  const k = Math.min((box.width - 32) / w, (box.height - 32) / h);
  cv.style.width = `${w * k}px`; cv.style.height = `${h * k}px`;
}
new ResizeObserver(sizeCanvas).observe($('#viewer'));

// The song plays through Web Audio and is the clock: the picture follows the moment the sound
// actually reaches the speakers (output latency included), so cuts look exactly on the beat.
let clock = { at: 0, t: 0, ctxAt: 0 }, songNode = null, songGain = null;
const maxTime = () => Math.max(projectDuration(), S.song ? S.song.offset + S.song.duration : 0);
const audioDelay = () => (audioCtx ? (audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0) : 0);
function stopSong() {
  try { songNode?.stop(); } catch { /* not started */ }
  songNode = null;
}
function startClock() {
  stopSong();
  const ctx = actx(), when = ctx.currentTime + 0.05;
  clock = { at: performance.now() + 50, t: S.t, ctxAt: when };
  if (!S.song) return;
  songGain ??= (() => { const g = ctx.createGain(); g.connect(ctx.destination); return g; })();
  songNode = ctx.createBufferSource();
  songNode.buffer = S.song.buffer;
  songNode.connect(songGain);
  const at = S.t - S.song.offset; // position in the song
  if (at >= 0) { if (at < S.song.duration) songNode.start(when, at); }
  else songNode.start(when - at, 0);
}
function play() {
  if (S.exporting || !projectDuration()) return;
  if (S.t >= projectDuration() - 0.05) S.t = 0;
  S.playing = true;
  actx().resume().then(() => { if (S.playing) startClock(); });
  startClock();
  document.body.classList.add('is-playing');
}
function pause() {
  S.playing = false;
  players().forEach(v => v.pause());
  stopSong();
  document.body.classList.remove('is-playing');
}
function seek(t) {
  S.t = clamp(t, 0, maxTime());
  if (S.playing) startClock();
}

const PREROLL = 0.6; // seconds before a cut the next shot starts rolling (muted), to lock onto the beat

function syncMedia() {
  const L = layoutClips(S.clips);
  const i = L.findIndex(r => S.t >= r.start && S.t < r.start + r.dur);
  const cur = L[i], next = L[i + 1];
  const active = cur && getSource(cur.clip), upcoming = next && getSource(next.clip);
  const toCut = next ? next.start - S.t : Infinity;
  const preroll = S.playing && upcoming && toCut < PREROLL;
  const voiceEl = S.voice && mediaById(S.voice.mediaId)?.el;
  for (const v of players()) if (v !== active && v !== voiceEl && !(preroll && v === upcoming) && !v.paused) v.pause();
  if (cur) {
    const c = cur.clip, el = active;
    const want = Math.min(c.in + (S.t - cur.start) * c.speed, el.duration - 0.05);
    el.volume = clamp(c.volume, 0, 1);
    el.muted = c.volume === 0;
    if (S.playing) {
      const drift = el.currentTime - want;
      if (Math.abs(drift) > 0.3) el.currentTime = want;
      // small drift: catch up by speeding/slowing a little instead of a stalling seek
      el.playbackRate = c.speed * (Math.abs(drift) > 0.025 ? (drift < 0 ? 1.12 : 0.9) : 1);
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
    }
  }
  if (upcoming && upcoming !== active) {
    const nc = next.clip;
    const nwant = nc.in - toCut * nc.speed; // where it should be right now to hit its first frame at the cut
    if (preroll && upcoming.paused && nwant >= 0) {
      upcoming.muted = true;
      upcoming.playbackRate = nc.speed;
      upcoming.currentTime = nwant + 0.08 * nc.speed; // ~start-up delay of play()
      upcoming.play().catch(() => {});
    } else if (preroll && !upcoming.paused) { // steer it onto the right frame before the cut
      const d = upcoming.currentTime - nwant;
      if (Math.abs(d) > 0.3) upcoming.currentTime = nwant;
      upcoming.playbackRate = nc.speed * (Math.abs(d) > 0.01 ? (d < 0 ? 1.25 : 0.8) : 1);
    } else if (!preroll && upcoming.paused && !upcoming.seeking && Math.abs(upcoming.currentTime - nc.in) > 0.05) {
      upcoming.currentTime = nc.in;
    }
  }
  if (songGain) {
    const level = S.song ? S.song.volume * (S.t < (S.song.duckUntil || 0) ? DUCK : 1) : 0;
    songGain.gain.setTargetAtTime(level, audioCtx.currentTime, 0.03);
  }
  if (voiceEl) { // the intro's dialogue, laid over the intro shots
    const v = S.voice, want = v.in + (S.t - v.at);
    voiceEl.volume = clamp(v.volume, 0, 1);
    voiceEl.muted = false;
    if (S.playing && S.t >= v.at && S.t < v.at + v.dur) {
      voiceEl.playbackRate = 1;
      if (Math.abs(voiceEl.currentTime - want) > 0.08) voiceEl.currentTime = want;
      if (voiceEl.paused) voiceEl.play().catch(() => {});
    } else if (!voiceEl.paused) voiceEl.pause();
  }
}

function tick() {
  if (S.playing) {
    S.t = songNode
      ? clock.t + Math.max(0, audioCtx.currentTime - clock.ctxAt - audioDelay())
      : clock.t + Math.max(0, performance.now() - clock.at) / 1000;
    if (S.t >= projectDuration()) { S.t = projectDuration(); pause(); }
  }
  if (!S.exporting) {
    syncMedia();
    drawFrame(cx, cv.width, cv.height, S.t, S, getSource);
  }
  const x = S.t * S.pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  $('#timeLabel').textContent = `${fmt(S.t)} / ${fmt(projectDuration())}`;
  if (S.playing) { // keep the playhead in view
    const sc = $('#tlScroll');
    if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft) sc.scrollLeft = x - 80;
  }
  requestAnimationFrame(tick);
}

// ---------- timeline ----------
const tl = { scroll: $('#tlScroll'), content: $('#tlContent') };
const xToTime = clientX => (clientX - tl.content.getBoundingClientRect().left) / S.pps;
let waveCache = {};

function waveSvg(song, pps) {
  const key = song.url + pps;
  if (waveCache.key === key) return waveCache.svg;
  const W = Math.max(1, Math.round(song.duration * pps)), H = 44;
  const n = Math.min(song.peaks.length, Math.floor(W / 3)), per = song.peaks.length / n;
  let d = '';
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) v = Math.max(v, song.peaks[j]);
    const h = Math.max(1, v * H);
    d += `M${(i * W / n).toFixed(1)} ${((H - h) / 2).toFixed(1)}v${h.toFixed(1)}`;
  }
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path class="wave" d="${d}"/></svg>`;
  waveCache = { key, svg };
  return svg;
}

function snapPoints(clipLimit = Infinity, textId = null) {
  const pts = [0, S.t];
  if (S.song) for (const b of S.song.beats) pts.push(b + S.song.offset);
  layoutClips(S.clips).forEach((r, i) => { if (i < clipLimit) pts.push(r.start, r.start + r.dur); });
  for (const x of S.texts) if (x.id !== textId) pts.push(x.start, x.start + x.dur);
  return pts;
}
function snapTime(t, clipLimit, textId) {
  if (!$('#snap').checked) return t;
  let best = t, bd = 8 / S.pps;
  for (const p of snapPoints(clipLimit, textId)) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  return best;
}

function renderTimeline() {
  const pps = S.pps, L = layoutClips(S.clips);
  const total = Math.max(maxTime(), 10) + 6;
  tl.content.style.width = `${total * pps}px`;
  tl.content.style.setProperty('--pps', `${pps}px`);

  const step = pps >= 120 ? 1 : pps >= 50 ? 2 : pps >= 25 ? 5 : 10;
  let ruler = '';
  for (let t = 0; t <= total; t += step) ruler += `<span style="left:${t * pps}px">${t < 60 ? `${t}s` : fmt(t).slice(0, -2)}</span>`;
  let beatPath = '';
  if (S.song) for (const b of S.song.beats) { const x = (b + S.song.offset) * pps; if (x >= 0) beatPath += `M${x.toFixed(1)} 0v1000`; }
  $('#ruler').innerHTML = ruler + (beatPath ? `<svg class="beatgrid" width="${total * pps}" height="1000"><path d="${beatPath}"/><path class="tick" d="${beatPath.replace(/v1000/g, 'v8').replace(/ 0v/g, ' 16v')}"/></svg>` : '');

  const sel = S.sel || {};
  $('#trackV').innerHTML = L.map(({ clip: c, start, dur }) => {
    const m = mediaById(c.mediaId);
    const tags = [c.speed !== 1 && `${+c.speed.toFixed(2)}×`, c.look !== 'none' && LOOKS[c.look].label, c.trans !== 'none' && TRANSITIONS[c.trans]].filter(Boolean);
    return `<div class="clip ${sel.id === c.id ? 'sel' : ''}" data-id="${c.id}" style="left:${start * pps}px;width:${dur * pps}px;background-image:url(${m.thumb})">
      <div class="h l"></div><span class="clip-name">${esc(m.name)} · ${dur.toFixed(1)}s${tags.length ? ` · ${esc(tags.join(' · '))}` : ''}</span><div class="h r"></div></div>`;
  }).join('') || '<div class="track-empty">Drag clips here, or press + on a clip</div>';

  $('#trackT').innerHTML = S.texts.map(x => `<div class="titem ${sel.id === x.id ? 'sel' : ''}" data-id="${x.id}" style="left:${x.start * pps}px;width:${x.dur * pps}px">
    <span>${esc(x.text.replace(/\n/g, ' '))}</span><div class="h r"></div></div>`).join('');

  const s = S.song;
  $('#trackA').innerHTML = s ? `<div class="song-block ${sel.type === 'song' ? 'sel' : ''}" style="left:${s.offset * pps}px;width:${s.duration * pps}px">
    ${waveSvg(s, pps)}<span class="song-name">${esc(s.name)}${s.bpm ? ` · ${s.bpm} BPM` : ''}</span></div>`
    : '<div class="track-empty">No song yet — step 1</div>';
}

function drag(e, onMove, onUp) {
  const x0 = e.clientX;
  e.preventDefault();
  const move = ev => onMove(ev.clientX - x0, ev);
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onUp?.(ev.clientX - x0, ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function select(sel) {
  S.sel = sel;
  if (sel && S.step !== 'edit') goStep('edit');
  renderTimeline();
  renderInspector();
}

function insertIndex(clientX, skipId) {
  const t = xToTime(clientX);
  return layoutClips(S.clips).filter(r => r.clip.id !== skipId && r.start + r.dur / 2 < t).length;
}
function showInsert(clientX, skipId) {
  const others = layoutClips(S.clips.filter(c => c.id !== skipId));
  const i = insertIndex(clientX, skipId);
  const x = i < others.length ? others[i].start : (others.length ? others.at(-1).start + others.at(-1).dur : 0);
  let line = $('#insertLine');
  if (!line) { line = document.createElement('div'); line.id = 'insertLine'; $('#trackV').append(line); }
  line.style.left = `${x * S.pps}px`;
}

tl.content.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const clipEl = e.target.closest('.clip'), textEl = e.target.closest('.titem'), songBlock = e.target.closest('.song-block');
  const before = snapshot();
  const finish = () => { if (snapshot() !== before) pushUndo(before); renderAll(); };

  if (clipEl) {
    const c = S.clips.find(x => x.id === clipEl.dataset.id), idx = S.clips.indexOf(c);
    const r = layoutClips(S.clips)[idx], m = mediaById(c.mediaId), in0 = c.in, out0 = c.out;
    select({ type: 'clip', id: c.id });
    if (e.target.classList.contains('r')) {
      drag(e, dx => {
        const end = snapTime(r.start + (out0 - in0) / c.speed + dx / S.pps, idx + 1);
        c.out = clamp(c.in + (end - r.start) * c.speed, c.in + 0.1, m.duration);
        renderTimeline();
      }, finish);
    } else if (e.target.classList.contains('l')) {
      drag(e, dx => { c.in = clamp(in0 + dx / S.pps * c.speed, 0, c.out - 0.1); renderTimeline(); }, finish);
    } else {
      const el = tl.content.querySelector(`.clip[data-id="${c.id}"]`);
      let moved = false;
      drag(e, (dx, ev) => {
        if (Math.abs(dx) > 4) moved = true;
        if (!moved) return;
        el.classList.add('dragging');
        el.style.transform = `translateX(${dx}px)`;
        showInsert(ev.clientX, c.id);
      }, (dx, ev) => {
        if (moved) {
          const to = insertIndex(ev.clientX, c.id);
          S.clips = S.clips.filter(x => x !== c);
          S.clips.splice(to, 0, c);
        }
        finish();
      });
    }
    return;
  }
  if (textEl) {
    const x = S.texts.find(t => t.id === textEl.dataset.id), start0 = x.start, dur0 = x.dur;
    select({ type: 'text', id: x.id });
    const resize = e.target.classList.contains('r');
    drag(e, dx => {
      if (resize) x.dur = Math.max(0.2, snapTime(start0 + dur0 + dx / S.pps, Infinity, x.id) - x.start);
      else {
        let s = snapTime(start0 + dx / S.pps, Infinity, x.id);
        const endSnap = snapTime(s + dur0, Infinity, x.id); // also let the end edge snap
        if (s === start0 + dx / S.pps && endSnap !== s + dur0) s = endSnap - dur0;
        x.start = Math.max(0, s);
      }
      renderTimeline();
    }, finish);
    return;
  }
  if (songBlock) {
    const off0 = S.song.offset;
    select({ type: 'song' });
    drag(e, dx => { S.song.offset = clamp(off0 + dx / S.pps, -S.song.duration + 1, 600); renderTimeline(); }, finish);
    return;
  }
  // empty space / ruler: scrub the playhead
  seek(xToTime(e.clientX));
  if (!e.target.closest('#ruler') && S.sel) select(null);
  drag(e, (dx, ev) => seek(xToTime(ev.clientX)));
});

$('#trackV').addEventListener('dragover', e => {
  if (!e.dataTransfer.types.includes('text/beatcut-media')) return;
  e.preventDefault();
  showInsert(e.clientX);
});
$('#trackV').addEventListener('dragleave', () => $('#insertLine')?.remove());
$('#trackV').addEventListener('drop', e => {
  const id = e.dataTransfer.getData('text/beatcut-media');
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  $('#insertLine')?.remove();
  addClip(mediaById(id), insertIndex(e.clientX));
});

$('#zoom').addEventListener('input', e => {
  const sc = tl.scroll, center = (sc.scrollLeft + sc.clientWidth / 2) / S.pps;
  S.pps = +e.target.value;
  renderTimeline();
  sc.scrollLeft = center * S.pps - sc.clientWidth / 2;
});
tl.scroll.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const z = $('#zoom');
  z.value = clamp(+z.value * (e.deltaY < 0 ? 1.15 : 0.87), +z.min, +z.max);
  z.dispatchEvent(new Event('input'));
}, { passive: false });

// ---------- edit actions ----------
function splitAtPlayhead() {
  const sel = selected();
  if (sel?.type === 'text') {
    const x = sel.obj;
    if (S.t <= x.start + 0.05 || S.t >= x.start + x.dur - 0.05) return toast('Move the playhead inside the text to split it');
    return commit(() => {
      S.texts.push({ ...x, id: uid(), start: S.t, dur: x.start + x.dur - S.t });
      x.dur = S.t - x.start;
    });
  }
  const hit = clipAt(S.clips, S.t);
  if (!hit) return toast('Move the playhead over a clip to split it');
  const c = hit.clip, cut = c.in + (S.t - hit.start) * c.speed;
  if (cut - c.in < 0.05 || c.out - cut < 0.05) return;
  commit(() => {
    const b = { ...c, id: uid(), in: cut, trans: 'none' };
    c.out = cut;
    S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
    S.sel = { type: 'clip', id: b.id };
  });
}
function deleteSelected() {
  const sel = selected();
  if (!sel) return toast('Select something on the timeline first');
  commit(() => {
    if (sel.type === 'clip') S.clips = S.clips.filter(c => c !== sel.obj);
    if (sel.type === 'text') S.texts = S.texts.filter(x => x !== sel.obj);
    if (sel.type === 'song') removeSong();
    S.sel = null;
  });
}
function duplicateSelected() {
  const sel = selected();
  if (!sel || sel.type === 'song') return toast('Select a clip or text to duplicate');
  commit(() => {
    const copy = { ...sel.obj, id: uid() };
    if (sel.type === 'clip') S.clips.splice(S.clips.indexOf(sel.obj) + 1, 0, copy);
    else { copy.start = sel.obj.start + sel.obj.dur; S.texts.push(copy); }
    S.sel = { type: sel.type, id: copy.id };
  });
}
function addText() {
  const beat = S.song?.bpm ? 60 / S.song.bpm : 0.75;
  commit(() => {
    const x = { id: uid(), text: 'your text', style: 'caption', color: '#ffffff', size: 4.5, y: 50, anim: 'type', start: S.t, dur: beat * 2 };
    S.texts.push(x);
    S.sel = { type: 'text', id: x.id };
  });
  goStep('edit');
  const ta = $('#inspector textarea');
  ta?.focus(); ta?.select();
}
function removeSong() {
  if (!S.song) return;
  URL.revokeObjectURL(S.song.url);
  stopSong();
  S.song = null;
}
// Retime the clips so every cut lands on a beat (every N beats). A clip whose source is too
// short ends early and the next cut moves on to the following beat.
function beatSync() {
  if (!S.song?.beats.length) return toast('Choose a song first — beat sync needs its beats');
  if (!S.clips.length) return toast('Add some clips first');
  const every = +$('#syncEvery').value;
  const beats = S.song.beats.map(b => b + S.song.offset).filter(b => b > 0.05);
  commit(() => {
    let t = 0;
    for (const c of S.clips) {
      const m = mediaById(c.mediaId);
      const j = beats.findIndex(b => b > t + 0.05);
      const end = j < 0 ? undefined : beats[j + every - 1] ?? beats.at(-1);
      if (end !== undefined && end > t) {
        const want = (end - t) * c.speed;
        if (c.in + want > m.duration) c.in = Math.max(0, m.duration - want);
        c.out = Math.min(m.duration, c.in + want);
      }
      t += clipDur(c);
    }
  });
  toast(`Cuts now land every ${every} beat${every > 1 ? 's' : ''}`);
}

// ---------- panels ----------
function goStep(step) {
  S.step = step;
  $$('#steps button').forEach(b => b.classList.toggle('on', b.dataset.step === step));
  $$('.step').forEach(p => { p.hidden = p.dataset.panel !== step; });
  if (step === 'export') renderExport();
  if (step === 'edit') renderInspector();
  if (step === 'clips' && clipSource === 'youtube') runYouTubeSearch();
}
function updateSteps() {
  const done = { song: !!S.song, clips: S.media.length > 0, edit: S.clips.length > 0 };
  $$('#steps button').forEach(b => b.classList.toggle('done', !!done[b.dataset.step]));
}

function renderSongCard() {
  const s = S.song;
  $('#songCard').innerHTML = s ? `<div class="song-card">
      <button class="icon-btn play-toggle" id="songPlay" title="Play / pause"><i data-lucide="play" class="i-play"></i><i data-lucide="pause" class="i-pause"></i></button>
      <div class="meta"><b>${esc(s.name)}</b><span>${fmt(s.duration)} · ${s.bpm ? `${s.bpm} BPM · ${s.beats.length} beats` : 'no clear beat'}</span></div>
      <button class="icon-btn" id="songRemove" title="Remove song"><i data-lucide="x"></i></button></div>` : '';
}
$('#songCard').addEventListener('click', e => {
  if (e.target.closest('#songPlay')) S.playing ? pause() : play();
  if (e.target.closest('#songRemove')) { pause(); removeSong(); if (S.sel?.type === 'song') S.sel = null; renderAll(); }
});

// songs: iTunes previews (search, Spotify links, popular edit songs)
const POPULAR = [
  ['Metamorphosis', 'Metamorphosis Interworld'], ['Murder In My Mind', 'Murder In My Mind Kordhell'],
  ['Memory Reboot', 'Memory Reboot VØJ Narvent'], ['After Dark', 'After Dark Mr.Kitty'],
  ['Sleepwalker', 'Sleepwalker akiaura'], ['Rapture', 'Rapture Interworld'], ['Close Eyes', 'Close Eyes DVRST'],
  ['Another Love', 'Another Love Tom Odell'], ['Little Dark Age', 'Little Dark Age MGMT'],
  ['Daylight', 'Daylight David Kushner'], ['Can You Feel My Heart', 'Can You Feel My Heart Bring Me The Horizon'],
  ['Sahara', 'Sahara Hensonn'], ['Snowfall', 'Snowfall Øneheart reidenshi'], ['Space Song', 'Space Song Beach House'],
];
$('#musicChips').innerHTML = POPULAR.map(([label, q]) => `<button data-q="${esc(q)}">${esc(label)}</button>`).join('');
let musicList = [];
const previewAudio = new Audio();
previewAudio.onended = previewAudio.onpause = () => $$('#musicResults .result').forEach(r => r.classList.remove('playing'));

async function runMusicSearch(q) {
  if (!q.trim()) return;
  $('#musicQuery').value = q;
  const box = $('#musicResults');
  box.innerHTML = '<p class="fine">Searching…</p>';
  let from;
  try { ({ list: musicList, from } = await searchSongs(q)); }
  catch (e) { box.innerHTML = `<p class="fine err">${esc(e.message)}</p>`; return; }
  box.innerHTML = (from ? `<p class="fine">Spotify link: “${esc(from)}”. Pick the matching version below.</p>` : '') +
    (musicList.map((r, i) => `<div class="result" data-i="${i}">
      <button class="cover play-toggle" data-prev="${i}" title="Listen" style="background-image:url(${esc(r.art)})"><i data-lucide="play" class="i-play"></i><i data-lucide="pause" class="i-pause"></i></button>
      <div class="meta"><b>${esc(r.title)}</b><span>${esc(r.artist)}</span></div>
      <button class="ghost small" data-use="${i}">Use</button></div>`).join('') || '<p class="fine">No songs found. Try the artist name too.</p>');
  refreshIcons();
}
$('#musicForm').addEventListener('submit', e => { e.preventDefault(); runMusicSearch($('#musicQuery').value); });
$('#musicChips').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) runMusicSearch(b.dataset.q); });
$('#musicResults').addEventListener('click', async e => {
  const prev = e.target.closest('[data-prev]'), use = e.target.closest('[data-use]');
  if (prev) {
    const r = musicList[prev.dataset.prev], row = prev.closest('.result');
    if (row.classList.contains('playing')) return previewAudio.pause();
    previewAudio.src = r.url;
    previewAudio.play().then(() => row.classList.add('playing')).catch(() => toast('Could not play that preview'));
  }
  if (use) {
    const r = musicList[use.dataset.use];
    previewAudio.pause();
    use.disabled = true;
    try {
      const blob = await download(r.url, p => { use.textContent = `${Math.round(p * 100)}%`; });
      await setSong(blob, { name: `${r.title} · ${r.artist}`, source: 'Apple Music preview', credit: `“${r.title}” by ${r.artist}`, page: r.page });
      goStep('clips');
    } catch (err) { toast(`Couldn't download that track (${err.message}). Try another one.`); }
    use.disabled = false; use.textContent = 'Use';
  }
});
$('#songFile').addEventListener('change', e => { if (e.target.files[0]) loadSongFile(e.target.files[0]); e.target.value = ''; });

// clips: local library + Wikimedia Commons
let clipSource = 'youtube', commonsList = [], ytList = [], ytQuery = '';
const mediaCard = m => `<div class="media" draggable="true" data-mid="${m.id}">
    <div class="thumb" style="background-image:url(${m.thumb})"><span class="dur">${fmt(m.duration)}</span>
    <button class="add" data-add="${m.id}" title="Add to the end of the timeline"><i data-lucide="plus"></i></button></div>
    <div class="mname">${esc(m.name)}</div><div class="msrc">${esc(m.tags || m.source)}</div></div>`;

function renderClipResults() {
  if (clipSource !== 'local') return;
  $('#clipResults').innerHTML = S.media.length ? `<div class="grid">${S.media.map(mediaCard).join('')}</div>`
    : '<p class="fine">No footage yet. That\'s fine: if you skip this, free clips of the character are searched online (mostly classic cartoons and films). For modern movies and anime, drop your own footage.</p>';
  refreshIcons();
}
async function runCommonsSearch() {
  const q = $('#clipQuery').value.trim();
  const box = $('#clipResults');
  if (!q) { box.innerHTML = '<p class="fine">Type a character or topic above and press Enter.</p>'; return; }
  box.innerHTML = '<p class="fine">Searching Wikimedia Commons…</p>';
  try { commonsList = await searchCommons(q); }
  catch (e) { box.innerHTML = `<p class="fine err">${esc(e.message)}</p>`; return; }
  box.innerHTML = commonsList.length ? `<div class="grid">${commonsList.map((r, i) => `<div class="media" data-ci="${i}">
      <div class="thumb"><img src="${esc(r.thumb)}" alt="" loading="lazy"><span class="dur">${fmt(r.duration)}</span></div>
      <div class="mname">${esc(r.title)}</div><div class="msrc">${esc(r.license)}</div></div>`).join('')}</div>
      <p class="fine">Free-licensed or public-domain videos from Wikimedia Commons. Commons mostly has older cartoons, films and real footage — modern movies and anime aren't there.</p>`
    : `<p class="fine">Nothing on Wikimedia Commons for “${esc(q)}”. For modern characters, add your own clips and tag them.</p>`;
}
// clip packs that editors upload for edits ("<name> scene pack", "raw clips")
async function runYouTubeSearch() {
  const q = $('#clipQuery').value.trim(), box = $('#clipResults');
  if (!(await hasClipServer())) {
    box.innerHTML = '<p class="fine err">Clip search needs Beatcut started with <b>Start Beatcut.vbs</b> (it runs the local helper that fetches clips).</p>';
    return;
  }
  if (!q) { box.innerHTML = '<p class="fine">Type the character above and press Enter. Clip packs of them are found for you.</p>'; return; }
  if (q === ytQuery && ytList.length) return renderYouTube();
  box.innerHTML = `<p class="fine">Finding clips of ${esc(q)}…</p>`;
  try { ytList = await searchYouTube(q); ytQuery = q; }
  catch (e) { box.innerHTML = `<p class="fine err">${esc(e.message)}</p>`; return; }
  renderYouTube();
}
function renderYouTube() {
  if (clipSource !== 'youtube') return;
  const added = new Set(S.media.map(m => m.ytId));
  $('#clipResults').innerHTML = ytList.length ? `
    <button class="ghost wide" data-yt-top><i data-lucide="download"></i> Add the top 3 for me</button>
    <div class="grid">${ytList.map((r, i) => `<div class="media" data-yi="${i}">
      <div class="thumb"><img src="${esc(r.thumb)}" alt="" loading="lazy"><span class="dur">${fmt(r.duration).slice(0, -2)}</span>
      ${added.has(r.id) ? '<span class="added"><i data-lucide="check"></i></span>' : `<button class="add" data-yadd="${i}" title="Add"><i data-lucide="plus"></i></button>`}</div>
      <div class="mname">${esc(r.title)}</div><div class="msrc">YouTube · ${esc(r.channel)}</div></div>`).join('')}</div>
    <p class="fine">Scene packs and raw clips that editors upload on YouTube. Downloaded at up to 720p.</p>`
    : `<p class="fine">No clip packs found for “${esc(ytQuery)}”. Try the full name or the show's name.</p>`;
  refreshIcons();
}
async function addYouTube(r, onProgress, extra = {}) {
  const existing = S.media.find(m => m.ytId === r.id);
  if (existing) return Object.assign(existing, extra);
  const blob = await fetchYouTube(r.id, onProgress);
  return addMedia(blob, r.title, { source: `YouTube · ${r.channel}`, page: r.page, ytId: r.id, thumbUrl: r.thumb, tags: ytQuery || $('#clipQuery').value.trim(), ...extra });
}
async function addYouTubeWithToast(list) {
  for (const [i, r] of list.entries()) {
    try { await addYouTube(r, p => toast(`Downloading ${i + 1} of ${list.length} · ${Math.round(p * 100)}%`)); }
    catch (e) { toast(`Couldn't get “${r.title}”: ${e.message}`); }
    renderYouTube();
  }
  toast(`Got ${S.media.length} video${S.media.length === 1 ? '' : 's'}. Go to Make it when you're ready.`);
}
function openYouTubeModal(r) {
  openModal(`<div class="modal-head"><b>${esc(r.title)}</b><button class="icon-btn" data-close><i data-lucide="x"></i></button></div>
    <iframe class="yt" src="https://www.youtube-nocookie.com/embed/${esc(r.id)}?autoplay=1&mute=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>
    <p class="fine"><b>Source:</b> YouTube · ${esc(r.channel)} · ${fmt(r.duration).slice(0, -2)} · <a href="${esc(r.page)}" target="_blank" rel="noopener">open on YouTube</a></p>
    <div class="row"><button class="primary" id="yAdd"><i data-lucide="download"></i> Add these clips</button></div>`);
  $('#yAdd').onclick = async () => {
    const btn = $('#yAdd');
    btn.disabled = true;
    try { await addYouTube(r, p => { btn.textContent = `Downloading ${Math.round(p * 100)}%`; }); closeModal(); renderYouTube(); toast('Added'); }
    catch (e) { btn.disabled = false; btn.textContent = 'Try again'; toast(`Download failed: ${e.message}`); }
  };
}

$('#clipForm').addEventListener('submit', e => {
  e.preventDefault();
  if (clipSource === 'local') $('#clipTabs [data-src="youtube"]').click();
  else clipSource === 'youtube' ? runYouTubeSearch() : runCommonsSearch();
});
$('#clipTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-src]');
  if (!b) return;
  clipSource = b.dataset.src;
  $$('#clipTabs button').forEach(x => x.classList.toggle('on', x === b));
  clipSource === 'local' ? renderClipResults() : clipSource === 'youtube' ? runYouTubeSearch() : runCommonsSearch();
});
$('#clipResults').addEventListener('click', e => {
  const yadd = e.target.closest('[data-yadd]');
  if (yadd) return addYouTubeWithToast([ytList[yadd.dataset.yadd]]);
  if (e.target.closest('[data-yt-top]')) {
    const fresh = ytList.filter(r => !S.media.some(m => m.ytId === r.id));
    return addYouTubeWithToast([...fresh.filter(r => !/manga/i.test(r.title)), ...fresh.filter(r => /manga/i.test(r.title))].slice(0, 3));
  }
  const ycard = e.target.closest('[data-yi]');
  if (ycard) return openYouTubeModal(ytList[ycard.dataset.yi]);
  const add = e.target.closest('[data-add]');
  if (add) { addClip(mediaById(add.dataset.add)); return toast('Added to the timeline'); }
  const card = e.target.closest('.media');
  if (card?.dataset.mid) openMediaModal(mediaById(card.dataset.mid));
  if (card?.dataset.ci) openCommonsModal(commonsList[card.dataset.ci]);
});
$('#clipResults').addEventListener('dragstart', e => {
  const card = e.target.closest('[data-mid]');
  if (card) e.dataTransfer.setData('text/beatcut-media', card.dataset.mid);
});

function openMediaModal(m) {
  openModal(`<div class="modal-head"><b>${esc(m.name)}</b><button class="icon-btn" data-close><i data-lucide="x"></i></button></div>
    <video src="${m.url}" controls autoplay muted playsinline></video>
    <div class="field"><label>Name</label><input data-m="name" value="${esc(m.name)}"></div>
    <div class="field"><label>Tags <span class="fine">— character names, so search finds this clip</span></label><input data-m="tags" value="${esc(m.tags)}" placeholder="e.g. anakin, obi-wan, mustafar"></div>
    ${m.credit ? `<p class="fine">${esc(m.credit)}</p>` : ''}
    <div class="row"><button class="primary" id="mAddHere"><i data-lucide="plus"></i> Add 3 s from here</button><button class="ghost" id="mAddAll">Add whole clip</button></div>`,
  () => { renderClipResults(); renderTimeline(); });
  const v = $('#modalCard video');
  $$('#modalCard [data-m]').forEach(inp => inp.addEventListener('input', () => { m[inp.dataset.m] = inp.value; }));
  $('#mAddHere').onclick = () => { addClip(m, S.clips.length, v.currentTime, 3); closeModal(); toast('Added to the timeline'); };
  $('#mAddAll').onclick = () => { addClip(m, S.clips.length, 0, m.duration); closeModal(); toast('Added to the timeline'); };
}
function openCommonsModal(r) {
  openModal(`<div class="modal-head"><b>${esc(r.title)}</b><button class="icon-btn" data-close><i data-lucide="x"></i></button></div>
    <video src="${esc(r.preview)}" controls autoplay muted playsinline crossorigin="anonymous"></video>
    <p class="fine"><b>Source:</b> Wikimedia Commons · <b>License:</b> ${esc(r.license)} · <b>By:</b> ${esc(r.artist)} · <a href="${esc(r.page)}" target="_blank" rel="noopener">file page</a></p>
    <div class="row"><button class="primary" id="cAdd"><i data-lucide="download"></i> Add to my clips</button></div>`);
  $('#cAdd').onclick = async () => {
    const btn = $('#cAdd');
    btn.disabled = true;
    try {
      const blob = await download(r.file, p => { btn.textContent = `Downloading ${Math.round(p * 100)}%`; });
      const m = await addMedia(blob, r.title, { source: 'Wikimedia Commons', credit: r.credit, page: r.page, tags: $('#clipQuery').value.trim() });
      closeModal();
      $('#clipTabs [data-src="local"]').click();
      toast(`“${m.name}” added — open it to pick the moment you want`);
    } catch (err) { btn.disabled = false; btn.textContent = 'Try again'; toast(`Download failed: ${err.message}`); }
  };
}

// inspector
const FMT = { panX: v => (Math.abs(v - 0.5) < 0.02 ? 'centre' : v < 0.5 ? 'left' : 'right'), speed: v => `${+v}×`, volume: v => `${Math.round(v * 100)}%`, zoom: v => `${Math.round(v * 100)}%`, size: v => (+v).toFixed(1), y: v => `${Math.round(v)}%` };
const range = (k, label, v, min, max, step) => `<div class="field"><label>${label} <output>${FMT[k](v)}</output></label>
  <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}"></div>`;
const chips = (k, label, opts, v) => `<div class="field"><label>${label}</label><div class="chips" data-k="${k}">${
  Object.entries(opts).map(([key, l]) => `<button data-v="${key}" class="${key === String(v) ? 'on' : ''}">${typeof l === 'string' ? l : l.label}</button>`).join('')}</div></div>`;
const num = (k, label, v, step = 0.05) => `<label class="num">${label}<input type="number" data-k="${k}" step="${step}" value="${(+v).toFixed(2)}"></label>`;

function renderInspector() {
  const box = $('#inspector'), sel = selected();
  if (!sel) {
    const name = $('#clipQuery').value.trim(), made = S.clips.length > 0;
    const check = (ok, label, step) => `<button class="check ${ok ? 'ok' : ''}" data-goto-step="${step}"><i data-lucide="${ok ? 'circle-check' : 'circle'}"></i>${label}</button>`;
    box.innerHTML = `<h2>Make the edit</h2>
      <div class="checks">
        ${check(S.song, S.song ? esc(S.song.name) : 'Pick a song', 'song')}
        ${check(name, name ? esc(name) : 'Type the character', 'clips')}
        ${check(S.media.length, S.media.length ? `${S.media.length} video${S.media.length > 1 ? 's' : ''} of footage` : 'No footage yet: clips of them will be found for you', 'clips')}
      </div>
      ${chips('style', 'Style', { auto: 'Surprise me', ...STYLES }, S.style)}

      ${S.song ? chips('length', 'Length', { 10: '10 s', 15: '15 s', 20: '20 s', 30: '30 s' }, S.length) : ''}
      <button class="primary wide make" data-act="make" ${S.making ? 'disabled' : ''}><i data-lucide="sparkles"></i> ${made ? 'Make it again (new version)' : 'Make my edit'}</button>
      <p class="fine" id="makeStatus">${S.making ? 'Starting…' : made ? 'Click anything on the timeline to change it, or go to Export.' : ''}</p>
      ${made ? `<div class="row wrap"><button class="ghost small" data-act="text"><i data-lucide="type"></i> Add text</button>
        <button class="ghost small" data-goto-step="export"><i data-lucide="download"></i> Export</button></div>` : ''}
      <details class="keys"><summary><b>Shortcuts</b></summary>
        <span><kbd>Space</kbd> play / pause</span><span><kbd>S</kbd> split at playhead</span><span><kbd>Del</kbd> delete</span>
        <span><kbd>T</kbd> add text</span><span><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</span>
        <span><kbd>←</kbd> <kbd>→</kbd> step a frame</span><span><kbd>Ctrl</kbd>+scroll zoom timeline</span></details>`;
  } else if (sel.type === 'clip') {
    const c = sel.obj, m = mediaById(c.mediaId);
    box.innerHTML = `<h2>Clip</h2><p class="hint">${esc(m.name)} · uses ${fmt(c.in)}–${fmt(c.out)} of ${fmt(m.duration)}</p>
      <div class="row">${num('in', 'Start in source', c.in)}${num('out', 'End in source', c.out)}</div>
      ${range('speed', 'Speed', c.speed, 0.25, 3, 0.05)}
      <div class="chips mini" data-k="speed">${[0.5, 1, 1.5, 2].map(v => `<button data-v="${v}" class="${c.speed === v ? 'on' : ''}">${v}×</button>`).join('')}</div>
      ${range('volume', 'Clip volume', c.volume, 0, 1, 0.01)}
      ${chips('look', 'Look', LOOKS, c.look)}
      <label class="toggle"><input type="checkbox" data-k="glow" ${c.glow ? 'checked' : ''}> Glow</label>
      ${chips('trans', 'Transition in', TRANSITIONS, c.trans)}
      ${chips('shake', 'Shake', { off: 'Off', soft: 'Soft', hard: 'Hard' }, c.shake)}
      ${range('zoom', 'Zoom / crop', c.zoom, 1, 2, 0.01)}
      ${range('panX', 'Framing (left ↔ right)', c.panX ?? 0.5, 0, 1, 0.01)}
      <label class="toggle"><input type="checkbox" data-k="pulse" ${c.pulse ? 'checked' : ''}> Punch in on every beat</label>
      <div class="row wrap">
        <button class="ghost small" data-act="lookall">Apply look to all clips</button>
        <button class="ghost small" data-act="split"><i data-lucide="scissors"></i> Split</button>
        <button class="ghost small danger" data-act="delete"><i data-lucide="trash-2"></i> Delete</button></div>`;
  } else if (sel.type === 'text') {
    const x = sel.obj;
    box.innerHTML = `<h2>Text</h2>
      <div class="field"><label>Words <span class="fine">— Enter for a new line</span></label><textarea data-k="text" rows="2">${esc(x.text)}</textarea></div>
      ${chips('style', 'Style', TEXT_STYLES, x.style)}
      ${chips('anim', 'Animation', TEXT_ANIMS, x.anim)}
      <div class="row"><div class="field"><label>Color</label><input type="color" data-k="color" value="${x.color}"></div>
        <div class="field grow">${range('size', 'Size', x.size, 2, 40, 0.5)}</div></div>
      ${range('y', 'Vertical position', x.y, 5, 95, 1)}
      <div class="row">${num('start', 'Starts at', x.start)}${num('dur', 'Length', x.dur)}</div>
      <div class="row wrap"><button class="ghost small" data-act="split"><i data-lucide="scissors"></i> Split</button>
        <button class="ghost small danger" data-act="delete"><i data-lucide="trash-2"></i> Delete</button></div>`;
  } else {
    const s = sel.obj;
    box.innerHTML = `<h2>Song</h2><p class="hint">${esc(s.name)} · ${fmt(s.duration)}${s.bpm ? ` · ${s.bpm} BPM` : ''}</p>
      ${range('volume', 'Song volume', s.volume, 0, 1, 0.01)}
      <div class="row">${num('offset', 'Song starts at (s)', s.offset)}</div>
      <p class="fine">Drag the song on the timeline to line a beat up with a cut. A negative start skips the song's intro.</p>
      ${s.credit ? `<p class="fine">${esc(s.credit)}</p>` : ''}
      <button class="ghost small danger" data-act="delete"><i data-lucide="trash-2"></i> Remove song</button>`;
  }
  if (sel) box.insertAdjacentHTML('afterbegin', '<button class="back" data-act="back"><i data-lucide="arrow-left"></i> Back to Make the edit</button>');
  refreshIcons();
}

async function makeEdit() {
  if (!S.song) { goStep('song'); return toast('Pick a song first'); }
  const name = $('#clipQuery').value.trim();
  const status = text => { const el = $('#makeStatus'); if (el) el.textContent = text; };
  pause();
  S.making = true;
  renderInspector();
  try {
    let pool = S.media.filter(m => !m.dialogue && name && `${m.name} ${m.tags}`.toLowerCase().includes(name.toLowerCase()));
    if (!pool.length) pool = S.media.filter(m => !m.dialogue);
    if (!pool.length) {
      if (!name) throw new Error('Type the character name, or drop some footage of them');
      status(`Finding clips of ${name}…`);
      if (await hasClipServer()) {
        if (ytQuery !== name || !ytList.length) { ytList = await searchYouTube(name); ytQuery = name; }
        // anime packs first: manga-panel packs don't match anime footage
        const picks = [...ytList.filter(r => !/manga/i.test(r.title)), ...ytList.filter(r => /manga/i.test(r.title))].slice(0, 3);
        if (!picks.length) throw new Error(`Couldn't find clips of “${name}”. Try the full name, or drop your own footage in step 2.`);
        for (const [i, r] of picks.entries()) {
          try { pool.push(await addYouTube(r, p => status(`Downloading clips ${i + 1} of ${picks.length} · ${Math.round(p * 100)}%`))); }
          catch (e) { console.warn(r.id, e); }
        }
        if (!pool.length) throw new Error('The clip downloads failed. Check your internet and try again.');
      } else {
        const found = (await searchCommons(name)).filter(r => r.duration >= 3 && r.duration <= 600).slice(0, 3);
        if (!found.length) throw new Error(`No clips of “${name}” found. Start Beatcut with Start Beatcut.vbs to search more widely, or drop your own footage.`);
        for (const [i, r] of found.entries()) {
          const blob = await download(r.file, p => status(`Downloading clip ${i + 1} of ${found.length} · ${Math.round(p * 100)}%`));
          pool.push(await addMedia(blob, r.title, { source: 'Wikimedia Commons', credit: r.credit, page: r.page, tags: name }));
        }
      }
    }
    for (const [i, m] of pool.entries()) {
      try { await findShots(m, p => status(`Finding the best moments · video ${i + 1} of ${pool.length} · ${Math.round(p * 100)}%`)); }
      catch (e) { console.warn(e); m.shots = []; }
    }
    // a line of the character's own dialogue for the intro (English dub scene, transcribed)
    let dialogue = null;
    if (name && (await hasClipServer())) {
      try {
        status(`Finding a line of ${name}'s dialogue…`);
        let dm = S.media.find(m => m.dialogue && m.tags === name);
        if (!dm) {
          const found = (await searchYouTube(name, 'dialogue')).filter(r => r.duration <= 400)[0];
          if (found) dm = await addYouTube(found, p => status(`Downloading a dialogue scene · ${Math.round(p * 100)}%`), { dialogue: true });
        }
        if (dm) {
          status('Listening to the dialogue…');
          dm.speech ??= await transcribe(dm.ytId);
          await findShots(dm).catch(() => { dm.shots = []; });
          dialogue = { id: dm.id, speech: dm.speech, shots: dm.shots, duration: dm.duration, w: dm.el.videoWidth, h: dm.el.videoHeight };
        }
      } catch (e) { console.warn('no dialogue', e); }
    }
    const picks = ['dark', 'noir', 'cold', 'warm'];
    const style = S.style === 'auto' ? picks[Math.floor(Math.random() * picks.length)] : S.style;
    const [aw, ah] = ASPECTS[S.aspect];
    const r = buildEdit({
      song: S.song, pool: pool.map(m => ({ id: m.id, shots: m.shots, w: m.el.videoWidth, h: m.el.videoHeight, manga: /manga/i.test(m.name) })),
      name, style, seed: Date.now() >>> 0, length: +S.length, aspect: aw / ah, dialogue,
    });
    commit(() => { S.clips = r.clips; S.texts = r.texts; S.voice = r.voice; S.song.offset = r.offset; S.song.duckUntil = r.duckUntil; S.sel = null; });
    seek(0);
    play();
    toast(`Here's your ${STYLES[style].label.toLowerCase()} edit. Press Make it again for a different version.`);
  } catch (e) {
    toast(e.message);
  } finally {
    S.making = false;
    renderInspector();
  }
}

let pendingEdit = null;
const inspector = $('#inspector');
inspector.addEventListener('focusin', () => { pendingEdit ??= snapshot(); });
inspector.addEventListener('pointerdown', () => { pendingEdit ??= snapshot(); });
inspector.addEventListener('input', e => {
  const k = e.target.dataset.k, sel = selected();
  if (!k || !sel) return;
  const o = sel.obj, el = e.target;
  let v = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number') ? +el.value : el.value;
  if (typeof v === 'number' && Number.isNaN(v)) return;
  if (sel.type === 'clip') {
    const m = mediaById(o.mediaId);
    if (k === 'in') v = clamp(v, 0, o.out - 0.1);
    if (k === 'out') v = clamp(v, o.in + 0.1, m.duration);
  }
  if (k === 'start') v = Math.max(0, v);
  if (k === 'dur') v = Math.max(0.2, v);
  o[k] = v;
  const out = el.closest('.field')?.querySelector('output');
  if (out && FMT[k]) out.textContent = FMT[k](v);
  if (k === 'speed') $$('.chips[data-k="speed"] button', inspector).forEach(b => b.classList.toggle('on', +b.dataset.v === v));
  renderTimeline();
});
inspector.addEventListener('change', () => {
  if (pendingEdit && pendingEdit !== snapshot()) pushUndo(pendingEdit);
  pendingEdit = null;
});
inspector.addEventListener('click', e => {
  const chip = e.target.closest('.chips button'), act = e.target.closest('[data-act]')?.dataset.act;
  const sel = selected();
  pendingEdit = null;
  const go = e.target.closest('[data-goto-step]');
  if (go) return goStep(go.dataset.gotoStep);
  if (act === 'make') return makeEdit();
  if (act === 'back') return select(null);
  if (chip && !sel) { S[chip.parentElement.dataset.k] = chip.dataset.v; return renderInspector(); }
  if (chip && sel) {
    const k = chip.parentElement.dataset.k, raw = chip.dataset.v;
    commit(() => {
      sel.obj[k] = k === 'speed' ? +raw : raw;
      if (k === 'style') sel.obj.size = TEXT_STYLES[raw].size;
    });
  }
  if (act === 'text') addText();
  if (act === 'sync') beatSync();
  if (act === 'split') splitAtPlayhead();
  if (act === 'delete') deleteSelected();
  if (act === 'lookall' && sel) commit(() => S.clips.forEach(c => { c.look = sel.obj.look; c.glow = sel.obj.glow; }));
});

// export
let exportAbort = null;
function exportSize() {
  const k = +$('#expRes .on').dataset.v, [w, h] = ASPECTS[S.aspect];
  const even = v => Math.round(v * k / 2) * 2;
  return [even(w), even(h)];
}
function renderExport() {
  const [w, h] = exportSize();
  $('#expSummary').innerHTML = canExportMp4()
    ? `${S.aspect} · ${w}×${h} · ${fmt(projectDuration())} long · ${S.clips.length} clip${S.clips.length === 1 ? '' : 's'}${S.texts.length ? ` · ${S.texts.length} text` : ''}`
    : '<span class="err">MP4 export needs Chrome or Edge (version 94 or newer). You can still edit and preview here.</span>';
  $('#exportBtn').disabled = !canExportMp4() || S.exporting;
  const credits = [];
  if (S.song?.credit) credits.push(`Music: ${S.song.credit}`);
  const used = new Set(S.clips.map(c => c.mediaId));
  for (const m of S.media) if (m.credit && used.has(m.id)) credits.push(`Clip: ${m.credit}`);
  $('#credits').innerHTML = credits.length
    ? `<pre>${esc(credits.join('\n'))}</pre><button class="ghost small" id="copyCredits"><i data-lucide="copy"></i> Copy credits</button>`
    : '<p class="fine">Nothing to credit — your own song and clips only.</p>';
  $('#copyCredits')?.addEventListener('click', () => navigator.clipboard.writeText(credits.join('\n')).then(() => toast('Credits copied — paste them into your post caption')));
  refreshIcons();
}
async function doExport() {
  if (!S.clips.length) return toast('Add clips to the timeline first');
  pause();
  const [width, height] = exportSize(), fps = +$('#expFps .on').dataset.v;
  S.exporting = true;
  exportAbort = new AbortController();
  $('#exportBtn').disabled = true;
  $('#expProgress').hidden = false;
  $('#expResult').innerHTML = '';
  try {
    const blob = await exportMp4({
      width, height, fps, bitrate: Math.round(width * height * fps * 0.14), signal: exportAbort.signal,
      onProgress: (p, text) => { $('#expBar').style.width = `${(p * 100).toFixed(1)}%`; $('#expText').textContent = `${Math.round(p * 100)}% · ${text}`; },
    });
    const url = URL.createObjectURL(blob);
    $('#expResult').innerHTML = `<video src="${url}" controls playsinline></video>
      <a class="primary wide" href="${url}" download="beatcut-edit.mp4"><i data-lucide="download"></i> Download MP4 (${(blob.size / 1048576).toFixed(1)} MB)</a>`;
    refreshIcons();
    toast('Export finished');
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Export cancelled' : `Export failed: ${e.message}`);
    if (e.name !== 'AbortError') console.error(e);
  } finally {
    S.exporting = false;
    $('#expProgress').hidden = true;
    renderExport();
  }
}
$('#exportBtn').addEventListener('click', doExport);
$('#expCancel').addEventListener('click', () => exportAbort?.abort());

// ---------- wiring ----------
function renderAll() {
  sizeCanvas();
  $$('#aspect button').forEach(b => b.classList.toggle('on', b.dataset.v === S.aspect));
  $('#emptyStage').hidden = !!(S.clips.length || S.texts.length);
  renderTimeline();
  renderSongCard();
  updateSteps();
  if (S.step === 'edit') renderInspector();
  if (S.step === 'export') renderExport();
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  refreshIcons();
}

$('#steps').addEventListener('click', e => { const b = e.target.closest('[data-step]'); if (b) goStep(b.dataset.step); });
$$('[data-goto]').forEach(b => b.addEventListener('click', () => goStep(b.dataset.goto)));
$('#aspect').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) commit(() => { S.aspect = b.dataset.v; }); });
$$('#expRes, #expFps, #expMusic').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
  S.musicOut = $('#expMusic .on').dataset.v === 'out';
  renderExport();
}));
$('#playBtn').addEventListener('click', () => (S.playing ? pause() : play()));
$('#toStart').addEventListener('click', () => seek(0));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#splitBtn').addEventListener('click', splitAtPlayhead);
$('#dupBtn').addEventListener('click', duplicateSelected);
$('#delBtn').addEventListener('click', deleteSelected);
$('#addTextBtn').addEventListener('click', addText);
$('#syncBtn').addEventListener('click', beatSync);
$('#videoFile').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });

// files dropped anywhere: videos -> clips, a lone audio file -> song
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', e => {
  document.body.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  if (e.target.closest('#songDrop')) { const f = e.dataTransfer.files[0]; return loadSongFile(f); }
  if (S.step !== 'clips' && [...e.dataTransfer.files].some(f => f.type.startsWith('video/'))) goStep('clips');
  importFiles(e.dataTransfer.files);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return closeModal();
  if (e.target.closest('input, textarea, select') || !$('#modal').hidden) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (mod) return;
  else if (k === 's') splitAtPlayhead();
  else if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 't') { e.preventDefault(); addText(); }
  else if (k === 'home') seek(0);
  else if (k === 'arrowleft') { e.preventDefault(); seek(S.t - (e.shiftKey ? 1 : 1 / 30)); }
  else if (k === 'arrowright') { e.preventDefault(); seek(S.t + (e.shiftKey ? 1 : 1 / 30)); }
});

// canvas text only uses web fonts that are already loaded
['300 20px Oswald', '500 20px "Cormorant Garamond"', '20px Anton', '600 20px Inter'].forEach(f => document.fonts.load(f));
goStep('song');
renderAll();
requestAnimationFrame(tick);
