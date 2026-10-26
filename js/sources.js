// Online sources. Both need no API key and allow browser downloads (CORS):
//  - Openverse audio (api.openverse.org): CC-licensed music from Freesound + Wikimedia Commons.
//    Jamendo is excluded because its file host blocks in-browser downloads.
//  - Wikimedia Commons video: public-domain / freely licensed clips (old cartoons, films, footage).

const stripHtml = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();

async function searchMusic(q) {
  const url = 'https://api.openverse.org/v1/audio/?' + new URLSearchParams({
    q, page_size: '20', license_type: 'modification', length: 'medium,long', excluded_source: 'jamendo',
  });
  const res = await fetch(url);
  if (res.status === 429) throw new Error('Openverse rate limit reached — wait a minute and try again.');
  if (!res.ok) throw new Error(`Openverse error ${res.status}`);
  const data = await res.json();
  return data.results.filter(r => r.url).map(r => ({
    title: r.title || 'Untitled',
    creator: r.creator || 'Unknown',
    license: `CC ${r.license.toUpperCase()} ${r.license_version || ''}`.replace('CC CC0', 'CC0').trim(),
    duration: (r.duration || 0) / 1000,
    url: r.url,
    page: r.foreign_landing_url,
    source: r.source === 'wikimedia_audio' ? 'Wikimedia Commons' : 'Freesound',
    credit: r.attribution || `"${r.title}" by ${r.creator}`,
  }));
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
