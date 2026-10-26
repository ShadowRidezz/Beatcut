# Beatcut

A browser video editor for character edits synced to music. Plain HTML/CSS/JS, so there's no build step and nothing to install except Python (for a tiny local web server).

## Run it

**Easiest:** double-click `Start Beatcut.vbs`. It starts a local server and opens http://localhost:8796.

**Or from a terminal** in this folder:

```bash
python -m http.server 8796 --bind 127.0.0.1
```

then open http://localhost:8796 in **Chrome or Edge**. MP4 export uses WebCodecs, which needs Chrome or Edge 94 or newer. Other browsers can edit and preview but can't export.

The page needs internet for its fonts, icons, the MP4 library (loaded from CDNs) and the online search. Your own videos never leave your PC.

Tests for the beat detector: `node tests/beats.test.js`

## How it works

1. **Song**: upload audio, or search the royalty-free library and press play to listen first. Beats are detected automatically and shown as red ticks on the timeline.
2. **Clips**: drop videos in, or search for a character:
   - **My clips** searches your imported clips by name and tags. Click a clip to tag it (e.g. "anakin, obi-wan").
   - **Wikimedia Commons** searches free-licensed and public-domain video. Every result shows its source, license and author, and you can preview it before adding.
3. **Edit** on the timeline: drag clips to reorder, drag the edges to trim, `S` splits, `Del` deletes. **Beat sync** retimes every clip so each cut lands on a beat. Each clip has speed, volume, a look (B&W, Noir, Warm, Cool, Vivid, Faded, Glow), shake, zoom, and a transition in (Flash, Fade, Zoom punch, Blur, Whip). Text comes in Caption, Big word, Serif and Comic styles, with Typewriter, Pop, Fade and Shake animations.
4. **Export** a 720p or 1080p MP4 (30 or 60 fps) in 9:16, 1:1 or 16:9, with a progress bar. The Credits box has the attribution text to paste into your post.

## Sources and keys

| Source | Used for | Key needed? | Notes |
|---|---|---|---|
| [Openverse](https://openverse.org) API | Music library | No | Creative Commons tracks from Freesound + Wikimedia Commons, filtered to licenses that allow remixing. Anonymous use has a rate limit (wait a minute if you hit it). Jamendo is left out because its file server blocks in-browser downloads. Credit the artist (CC BY needs it, and the box gives you the text). Some tracks are NC (non-commercial), so don't use those in monetized videos. |
| [Wikimedia Commons](https://commons.wikimedia.org) API | Character / clip search | No | Public-domain and free-licensed video: old cartoons (Popeye, Superman 1940s, Betty Boop, Felix…), classic films and real footage. |

**Modern movie, TV and anime characters are not available from any source that licenses clips for this kind of use.** No API offers them legally. For those, add clips you already have and tag them; the My clips search then finds them by character name.

## Limits (kept simple on purpose)
- One video track (clips play back to back) with one text track and one music track. No picture-in-picture and no crossfades between two clips.
- Projects aren't saved. Reloading the page starts fresh, so export before you close.
- Tempo detection can land on a related tempo (e.g. 112 instead of 84) on syncopated tracks. The beat ticks still sit on real drum hits.
