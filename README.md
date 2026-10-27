# Beatcut

Pick a song, type a character, press **Make my edit**. Beatcut finds the best moments in the footage, cuts them on the beat (faster where the song is louder, a flash and a shake on the hardest hits), grades the colour, and drops the character's name on the drop. You can tweak anything afterwards and then export an MP4.

The page is plain HTML/CSS/JS. A small Python helper (`server.py`) serves it and finds clips with [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Run it

Double-click `Start Beatcut.vbs`. The first start sets up the Python packages (about a minute), and then http://localhost:8796 opens. You need Python 3.9 or newer installed. Use **Chrome or Edge**, because MP4 export needs WebCodecs.

Manual setup, from this folder:

```bash
py -3 -m venv .venv
.venv\Scripts\python -m pip install yt-dlp imageio-ffmpeg
.venv\Scripts\python server.py
```

Tests: `node tests/beats.test.js` and `node tests/autoedit.test.js`

## The three steps

1. **Song**: search any song or artist, tap a popular edit song (Metamorphosis, Murder In My Mind, After Dark…), or paste a Spotify link. You get Apple's 30-second preview of the track, which is usually the hook and is the right length for an edit. You can also upload a full song file, and the loudest 15/20/30 seconds are used.
2. **Character**: type who the edit is about (for example Thorfinn) and press Enter. **Find clips** shows scene packs and raw clips that editors upload to YouTube for that character. Press **Add the top 3 for me**, or open any of them to preview it first. You can skip this step, because **Make my edit** grabs the top 3 by itself. You can also drop your own footage, or use **Free archive** (Wikimedia Commons) for public-domain cartoons.
3. **Make it**: choose a style (Dark, Noir, Cold, Warm, Vivid, Clean, or Surprise me), optionally type a title (for example "a true warrior"), and press the button. **Make it again** gives a new version.

   Every edit follows the same structure as the reference edits. A calm intro holds one or two long shots of the character (the shots the clip packs' thumbnails came from) and blurs in. The title then appears one word per beat, right before the drop. On the drop there's a white flash, then fast cuts on the beat with motion-smear and zoom-blur transitions. The edit fades to black at the end.

Then **Export**: 9:16, 1:1 or 16:9, 720p or 1080p, 30 or 60 fps.

## About the music

- **Spotify** doesn't let any app get its audio: there's no API for it, and its 30-second previews were shut off for new apps in 2024. So a pasted Spotify link is read for the song name, and the same song is fetched from Apple's preview instead.
- **Song previews** come from the iTunes Search API (no key needed). They're copyrighted songs, so for TikTok, Reels or Shorts choose **Music → Leave it out** on Export and add the same sound inside the app. That way the platform's licence covers it and the video won't get muted.
- Apple's top-charts feed blocks browser apps, so "Popular for edits" is a built-in list of songs that are common in edits, looked up live on iTunes.

## About the footage

- **Find clips** searches YouTube for "<name> scene pack" and "<name> raw clips for edits". It skips anything over 15 minutes and downloads at up to 720p into `cache/`. Downloading from YouTube is against YouTube's terms, and the clips belong to the show's owners. That's normal for fan edits, but platforms can mute or claim them.
- If YouTube changes something and downloads stop working, restart with `Start Beatcut.vbs`: it updates yt-dlp in the background each time.
- Without the helper (for example a plain static server), only **Free archive** works. That's Wikimedia Commons: public-domain cartoons and old films.

## Limits
- Projects aren't saved. Export before you close the tab.
- One video track with one text track and one music track. No crossfades.
- Long footage is sampled at most 600 times, so on a full episode, very short shots can be missed.
