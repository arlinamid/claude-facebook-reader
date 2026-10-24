# Downloading Facebook media

## What can be downloaded how

| Media | Source field | Tool | Cookies needed? |
|---|---|---|---|
| post photos, comment images, GIFs, stickers | `images[].src`, `comments[].media[].src` (fbcdn URLs) | `fb_tool.py media` (urllib) | no — but the signed URLs **expire within hours**, so download right after extraction |
| public reels / videos / watch | `videos[]`, `/reel/<id>`, `/videos/<id>`, `/watch/?v=` | yt-dlp | no |
| videos in private groups, friends-only posts | post URL / video URL | yt-dlp `--cookies-from-browser chrome` | yes, **only on the user's own machine** |
| full-size photo behind `/photo/?fbid=` page | `extractMediaGrid()` url | open the photo page in the browser, extract `img` src, then download | session |

## Flow from the browser route

1. Extract or harvest the posts (with `comments:true` if comment media is wanted).
2. Signed image URLs (`…fbcdn.net/…?_nc_cat=…&oh=…&oe=…`) are blocked by the browser extension's
   output filter (`[BLOCKED: Cookie/query string data]`) and must not be pasted into the chat anyway.
   Ask the user, then run `__fbReader.download(__fbReader.mediaList(), 'fb-media.json')`. That is a file
   download into their Downloads folder, and the write-guard hook asks too. `fb_tool.py media` accepts
   this list, a full fb-reader dump, or a scraper `posts.json`.
   Videos / reels only: their page URLs (`/reel/<id>`, `/videos/<id>`) are safe in the chat and go
   straight to `fb_tool.py media --url …`.
3. Run the download where Facebook may be contacted from:
   - **Claude Code CLI / linked computer shell (preferred):**
     `python3 scripts/fb_tool.py media dump.json -o fb_media --cookies-from-browser chrome`
   - **Cloud workspace:** only public items and fbcdn images, **no cookies**:
     `python3 scripts/fb_tool.py media --url https://www.facebook.com/reel/<id> -o fb_media`
4. Deliver the files (or say where they are) and summarise `fb_media/manifest.json`
   (`status: ok | error | skipped` per item).

## Playable output (AV1 problem)

Facebook increasingly serves **AV1** video (sometimes VP9) with HE-AAC audio. The file is valid,
but Windows' built-in players (Fényképek, Filmek és TV, Médialejátszó) cannot play AV1 without the
Microsoft Store "AV1 Video Extension", so the download looks broken.
`fb_tool.py media` therefore:
- asks yt-dlp for H.264 + AAC first (`-S vcodec:h264,acodec:aac` + `--merge-output-format mp4`);
- if only AV1/VP9/HEVC exists, transcodes with ffmpeg to H.264 (`-preset veryfast -crf 21`) + AAC-LC
  and replaces the file (`--keep-original` keeps the AV1 copy, `--any-codec` turns all of this off).
Without ffmpeg it prints a warning. Fixing an existing file by hand:
`ffmpeg -i in.mp4 -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart out.mp4`

## yt-dlp tips

- Install: `pip install -U yt-dlp` (keep it current; FB extractor breaks often).
- `-f "best[height<=720]"` → passed through `fb_tool.py media -f`.
- `--audio-only` → mp3 (needs ffmpeg).
- Reel short links (`fb.watch/…`, `share/r/…`) work; pass them as-is.
- Error `Cannot parse data` / `login required` → the video is private: use cookies on the user's
  machine, or tell the user.
- Never copy the user's cookies to the cloud. If the user offers a cookies.txt, use it only with
  tools running on their own computer (`--cookies path` locally), and do not echo cookie values.

## Naming

`<postId>_<n>.jpg` for post images, `<postId>_v<n>.mp4` for videos, `<postId>_c<comment>_<n>.*`
for comment media, `url_<n>.*` for `--url` items. `manifest.json` keeps url, alt text and status.

## Respect

Download what the user is entitled to see, for their own use (archiving their group, research,
quoting). Mention copyright when the user wants to republish someone else's video.
