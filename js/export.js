// MP4 export: frames are rendered one by one (exact, not real-time) and encoded with WebCodecs
// (H.264 + AAC, Opus if AAC is unavailable), then muxed with mp4-muxer. Chrome / Edge 94+.

const canExportMp4 = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && !!window.Mp4Muxer;

function seekVideo(el, time) {
  if (Math.abs(el.currentTime - time) < 0.001 && !el.seeking) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); el.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 4000); // never hang the export on a stuck seek
    el.addEventListener('seeked', done);
    el.currentTime = time;
  });
}

const audioCache = new Map(); // mediaId -> AudioBuffer | null
async function mediaAudio(ctx, media) {
  if (!audioCache.has(media.id)) {
    let buf = null;
    try { buf = await ctx.decodeAudioData(await media.blob.arrayBuffer()); } catch { /* no audio track */ }
    audioCache.set(media.id, buf);
  }
  return audioCache.get(media.id);
}

async function mixAudio(duration, sampleRate) {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const play = (buffer, when, offset, length, rate, volume) => {
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer; src.playbackRate.value = rate; gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.start(when, offset, length);
  };
  const song = S.song;
  if (song && song.volume > 0 && !S.musicOut) {
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = song.buffer;
    gain.gain.setValueAtTime(song.volume * (song.duckUntil ? DUCK : 1), 0);
    if (song.duckUntil) { // back up to full volume as the dialogue ends
      gain.gain.setValueAtTime(song.volume * DUCK, Math.max(0, song.duckUntil - 0.15));
      gain.gain.linearRampToValueAtTime(song.volume, song.duckUntil);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(Math.max(0, song.offset), Math.max(0, -song.offset));
  }
  for (const r of layoutClips(S.clips)) {
    if (r.clip.volume <= 0) continue;
    const buf = await mediaAudio(ctx, mediaById(r.clip.mediaId));
    if (buf) play(buf, r.start, r.clip.in, r.clip.out - r.clip.in, r.clip.speed, r.clip.volume);
  }
  return ctx.startRendering();
}

async function pickConfig(list) {
  for (const cfg of list) {
    try { if ((await cfg.check(cfg.config)).supported) return cfg; } catch { /* try next */ }
  }
  return null;
}

async function exportMp4({ width, height, fps, bitrate, onProgress, signal }) {
  const duration = projectDuration();
  if (duration <= 0) throw new Error('Nothing to export yet — add clips to the timeline.');
  await document.fonts.ready;

  const sampleRate = 48000;
  onProgress(0, 'Mixing audio…');
  const audio = await mixAudio(duration, sampleRate);

  const v = await pickConfig(['avc1.640033', 'avc1.4d0033', 'avc1.420033'].map(codec => ({
    check: c => VideoEncoder.isConfigSupported(c),
    config: { codec, width, height, bitrate, framerate: fps },
  })));
  if (!v) throw new Error('This browser cannot encode H.264 video at this size.');
  const a = await pickConfig([['mp4a.40.2', 'aac'], ['opus', 'opus']].map(([codec, mux]) => ({
    mux, check: c => AudioEncoder.isConfigSupported(c),
    config: { codec, sampleRate, numberOfChannels: 2, bitrate: 192000 },
  })));

  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: a ? { codec: a.mux, numberOfChannels: 2, sampleRate } : undefined,
    fastStart: 'in-memory',
  });
  let failure = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  venc.configure(v.config);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const total = Math.ceil(duration * fps), started = performance.now();
  for (let i = 0; i < total; i++) {
    if (signal.aborted) { venc.close(); throw new DOMException('Export cancelled', 'AbortError'); }
    if (failure) throw failure;
    const t = i / fps;
    const hit = clipAt(S.clips, t);
    if (hit) {
      const el = getSource(hit.clip);
      await seekVideo(el, Math.min(hit.clip.in + (t - hit.start) * hit.clip.speed, el.duration - 0.001));
    }
    drawFrame(ctx, width, height, t, S, getSource);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
    if (i % 3 === 0) {
      const left = (performance.now() - started) / (i + 1) * (total - i - 1) / 1000;
      onProgress((i + 1) / total * 0.95, `Rendering frame ${i + 1} of ${total} · about ${Math.ceil(left)} s left`);
    }
  }
  await venc.flush();
  venc.close();

  if (a) {
    onProgress(0.97, 'Encoding audio…');
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { failure = e; } });
    aenc.configure(a.config);
    const L = audio.getChannelData(0), R = audio.getChannelData(1), step = 4800;
    for (let s = 0; s < audio.length; s += step) {
      const n = Math.min(step, audio.length - s), planes = new Float32Array(n * 2);
      planes.set(L.subarray(s, s + n), 0);
      planes.set(R.subarray(s, s + n), n);
      const data = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(s / sampleRate * 1e6), data: planes });
      aenc.encode(data);
      data.close();
    }
    await aenc.flush();
    aenc.close();
    if (failure) throw failure;
  }
  muxer.finalize();
  onProgress(1, 'Done');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
