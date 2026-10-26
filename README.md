# Beatcut

Pick a song, type a character, press **Make my edit**. Beatcut finds the best moments in the footage, cuts them on the beat (faster where the song is louder, a flash and a shake on the hardest hits), grades the colour, and drops the character's name on the drop. You can tweak anything afterwards and then export an MP4.

Plain HTML/CSS/JS with no build step. You only need Python, for a tiny local web server.

## Run it

**Easiest:** double-click `Start Beatcut.vbs`. It starts a local server and opens http://localhost:8796.

**Or from a terminal** in this folder:

```bash
python -m http.server 8796 --bind 127.0.0.1
```

Then open http://localhost:8796 in **Chrome or Edge**. MP4 export uses WebCodecs, which needs Chrome or Edge 94 or newer.

Tests: `node tests/beats.test.js` and `node tests/autoedit.test.js`

## The three steps

1. **Song**: search any song or artist, tap a popular edit song (Metamorphosis, Murder In My Mind, After Dark…), or paste a Spotify link. You get Apple's 30-second preview of the track, which is usually the hook and is the right length for an edit. You can also upload a full song file, and the loudest 15/20/30 seconds are used.
2. **Character**: type who the edit is about and drop footage of them: clips, scenes or a whole episode. With no footage, free clips of the character are searched and downloaded from Wikimedia Commons automatically.
3. **Make it**: choose a style (Dark, Noir, Cold, Warm, Vivid, Clean, or Surprise me) and press the button. **Make it again** gives a new version.

Then **Export**: 9:16, 1:1 or 16:9, 720p or 1080p, 30 or 60 fps.

## About the music

- **Spotify** doesn't let any app get its audio: there's no API for it, and its 30-second previews were shut off for new apps in 2024. So a pasted Spotify link is read for the song name, and the same song is fetched from Apple's preview instead.
- **Song previews** come from the iTunes Search API (no key needed). They're copyrighted songs, so for TikTok, Reels or Shorts choose **Music → Leave it out** on Export and add the same sound inside the app. That way the platform's licence covers it and the video won't get muted.
- Apple's top-charts feed blocks browser apps, so "Popular for edits" is a built-in list of songs that are common in edits, looked up live on iTunes.

## About the footage

Wikimedia Commons only has free footage, which means mostly classic cartoons (Popeye, 1940s Superman, Betty Boop…), old films and real footage. Modern movie, TV and anime characters aren't available from any source that permits this, so for those, drop footage you already have.

## Limits
- Projects aren't saved. Export before you close the tab.
- One video track with one text track and one music track. No crossfades.
- Long footage is sampled at most 600 times, so on a full episode, very short shots can be missed.
