// Online sources. Neither needs an API key and both allow browser downloads (CORS):
//  - iTunes Search: any popular song, as Apple's 30-second preview (usually the hook).
//    Spotify has no audio API, so a pasted Spotify link is looked up by name (oEmbed) on iTunes.
//  - Wikimedia Commons video: public-domain / freely licensed clips (old cartoons, films, footage).

const stripHtml = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();

async function searchSongs(q) {
  let from = null;
  const sp = q.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?track\/([A-Za-z0-9]+)/);
  if (sp) {
    const res = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(`https://open.spotify.com/track/${sp[1]}`));
    if (!res.ok) throw new Error("Couldn't read that Spotify link");
    q = from = (await res.json()).title;
  }
  const res = await fetch('https://itunes.apple.com/search?' + new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: '20' }));
  if (!res.ok) throw new Error(`Song search failed (${res.status}) — wait a moment and try again`);
  const list = (await res.json()).results.filter(r => r.previewUrl).map(r => ({
    title: r.trackName, artist: r.artistName, art: r.artworkUrl100, url: r.previewUrl, page: r.trackViewUrl,
  }));
  return { list, from };
}

async function searchCommons(q) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search',
    gsrsearch: `${q} filetype:video`, gsrnamespace: '6', gsrlimit: '24',
    prop: 'videoinfo', viprop: 'url|derivatives|size|extmetadata', viurlwidth: '320',
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikimedia Commons error ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => a.index - b.index);
  return pages.map(p => {
    const v = p.videoinfo?.[0];
    if (!v) return null;
    const webm = (v.derivatives || []).filter(d => d.type.startsWith('video/webm')).sort((a, b) => a.height - b.height);
    const file = [...webm].reverse().find(d => d.height <= 480) || webm[0];
    const preview = webm.find(d => d.height >= 240) || file;
    if (!file) return null;
    const meta = v.extmetadata || {};
    const title = p.title.replace(/^File:/, '').replace(/\.[^.]+$/, '');
    const artist = stripHtml(meta.Artist?.value) || 'Unknown';
    const license = stripHtml(meta.LicenseShortName?.value) || 'See file page';
    return {
      title, artist, license, thumb: v.thumburl, page: v.descriptionurl,
      duration: +v.duration || 0,
      file: file.src, preview: preview.src,
      credit: `"${title}" — ${artist} — ${license} — via Wikimedia Commons`,
    };
  }).filter(Boolean);
}

// fetch with a progress callback (0..1); resolves to a Blob
async function download(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.(got / total);
  }
  return new Blob(parts, { type: res.headers.get('content-type') || '' });
}
