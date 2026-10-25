# Downloading Facebook media

## What can be downloaded how

| Media | Source field | Tool | Cookies needed? |
|---|---|---|---|
| post photos, comment images, GIFs, stickers | `images[].src`, `comments[].media[].src` (fbcdn URLs) | `fb_tool.py media` (urllib) | no — but the signed URLs **expire within hours**, so download right after extraction |
| public reels / videos / watch | `videos[]`, `/reel/<id>`, `/videos/<id>`, `/watch/?v=` | yt-dlp | no |
| videos in private groups, friends-only posts | post URL / video URL | yt-dlp `--cookies-from-browser chrome` | yes, **only on the user's own machine** |
| full-size photo(s) behind `/photo/?fbid=` (incl. a >4-photo set, mixed with video/reel) | `photoSet()` + `downloadImages()` | real files straight from the browser, or `fb_tool.py media` on the JSON | session |

## Flow from the browser route — images: let the browser save the files itself (new, preferred)

No Python round trip needed for plain images: `downloadImages()` fetches each one's bytes **inside the
page**, so the signed URL never has to appear as text in the chat/tool output (the `[BLOCKED: Cookie/query
string data]` output filter only ever sees a filename and a byte count, never the URL).

1. Extract or harvest the posts (`comments:true` if comment images are wanted).
2. Ask the user (it is a file download), then `await __fbReader.downloadImages({post:'#a3f9'})` for one
   post, or `await __fbReader.downloadImages()` for everything currently extracted/harvested. `dest:'view'`
   instead shows the image(s) in the `__fbReader` overlay for `screenshot`/`zoom` — no file saved — when the
   goal is to *look at* the photo (read text in it, judge quality, etc.), not keep a copy.
3. **Photo-viewer sets (`/photo/?fbid=…&set=pcb.…`)**, including the ones a grid undercounts behind a "+N"
   overlay tile: open the viewer, `await __fbReader.photoSet({limit:10, download:true})`. It steps the
   "Next photo" control, collects the set, flags any video/reel inside it separately (own page link only —
   hand that to step 4 below, not to `downloadImages()`), and — with `download:true` — saves the images the
   same way as step 2. Without `download:true`, the images are left on `__fbReader.lastSet` for a later
   `downloadImages({rows:__fbReader.lastSet})`.
4. Videos / reels (standalone, or found by `photoSet()`/`mediaList()` inside a set): their page URLs
   (`/reel/<id>`, `/videos/<id>`) are safe in the chat and go straight to step "Flow from the browser
   route — videos" below (`fb_tool.py media --url …`).
5. `downloadImages()`'s fetch needs the CDN host to allow a cross-origin read (plain `<img>` loading never
   needs this, so it is not yet confirmed for every fbcdn host): a failed image is reported by name, never
   silently dropped — fall back to the JSON route below for exactly those.

## Flow from the browser route — JSON export (fallback, also the only route for videos)

1. Signed image URLs (`…fbcdn.net/…?_nc_cat=…&oh=…&oe=…`) are blocked by the browser extension's
   output filter (`[BLOCKED: Cookie/query string data]`) and must not be pasted into the chat anyway.
   Ask the user, then run `__fbReader.download(__fbReader.mediaList(), 'fb-media.json')`. That is a file
   download into their Downloads folder, and the write-guard hook asks too. `fb_tool.py media` accepts
   this list, a full fb-reader dump, or a scraper `posts.json`.
   Videos / reels only: their page URLs (`/reel/<id>`, `/videos/<id>`) are safe in the chat and go
   straight to `fb_tool.py media --url …`.
2. Run the download where Facebook may be contacted from:
   - **Claude Code CLI / linked computer shell (preferred):**
     `python3 scripts/fb_tool.py media dump.json -o fb_media --cookies-from-browser chrome`
   - **Cloud workspace:** only public items and fbcdn images, **no cookies**:
     `python3 scripts/fb_tool.py media --url https://www.facebook.com/reel/<id> -o fb_media`
3. Deliver the files (or say where they are) and summarise `fb_media/manifest.json`
   (`status: ok | error | skipped` per item).

## Photo → post (already built in, easy to miss)

The photo-viewer page's own comments are empty; the real post is behind "Bejegyzés megtekintése" / "View
post". Do not read that link's raw `href` (the unprocessed query string trips the output filter) — call
`nav.photoPost()` (or just `where()` on the photo page, which already prints it) instead; it returns the
query-cleaned URL and is safe in the chat.

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
