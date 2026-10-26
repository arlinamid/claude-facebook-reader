#!/usr/bin/env python3
"""fb_tool.py — offline companion of fb-reader.js

Subcommands
  media      Download images + videos/reels (yt-dlp) listed in an fb-reader JSON dump
             or given as URLs. Writes a manifest.json next to the files.
  to-md      Convert fb-reader JSON (or facebook-private-group-scraper posts.json) to Markdown.
  parse-html Parse a saved Facebook page / copied outerHTML into fb-reader JSON (no CSS →
             timestamps that are obfuscated only in CSS stay unknown; aria-labelledby works).
  clean-url  Unwrap l.facebook.com shims and strip tracking params.
  urls       Print Facebook navigation / search URLs (same builders as __fbReader.nav).
  transcribe Text inside a video: Facebook's own captions, speech-to-text, on-screen text (OCR).

Examples
  python3 fb_tool.py media dump.json -o fb_media --cookies-from-browser chrome
  python3 fb_tool.py media --url https://www.facebook.com/reel/1234567890 -o fb_media
  python3 fb_tool.py to-md dump.json > posts.md
  python3 fb_tool.py parse-html saved_page.html --format md
  python3 fb_tool.py urls search "suno ai" --type groups
  python3 fb_tool.py transcribe --url https://www.facebook.com/reel/1234567890 -o out --subs --speech

Dependencies: Python 3.9+. media → `pip install yt-dlp` (videos) ; images use urllib only.
parse-html → `pip install beautifulsoup4`. transcribe --speech → `pip install faster-whisper`;
--ocr → ffmpeg + tesseract (eng+hun language data) on PATH, optionally Pillow for frame de-duplication.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
FB = "https://www.facebook.com"
TRACKING = {"fbclid", "__tn__", "__xts__", "eid", "mibextid", "rdid", "share_url", "ref", "refsrc",
            "comment_tracking", "paipv", "acontext", "notif_id", "notif_t", "h", "igshid", "s",
            "sfnsn", "extid", "app"}
INVISIBLE = re.compile("[͏­᠎​-‏‪-‮⁠-⁤﻿]")
SEARCH_TYPES = ["top", "posts", "people", "photos", "videos", "groups", "pages", "places", "events", "marketplace"]


# ── URL helpers ──────────────────────────────────────────────────────────────
def unwrap(url: str) -> str:
    try:
        u = urllib.parse.urlsplit(url)
        if u.hostname and u.hostname.endswith("facebook.com") and u.path == "/l.php":
            inner = urllib.parse.parse_qs(u.query).get("u", [""])[0]
            if inner.startswith("http"):
                return unwrap(inner)
    except ValueError:
        pass
    return url


def clean_url(url: str) -> str:
    url = unwrap(url)
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)
         if k not in TRACKING and not k.startswith("__cft__") and not k.startswith("utm_")]
    frag = "" if (u.hostname or "").endswith("facebook.com") else u.fragment
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), frag))


def kind_of(url: str) -> str:
    if re.search(r"/reel/", url):
        return "reel"
    if re.search(r"/videos/|/watch|fb\.watch", url):
        return "video"
    if re.search(r"fbcdn\.net|scontent|\.(jpe?g|png|webp|gif)(\?|$)", url, re.I):
        return "image"
    if re.search(r"/photo", url):
        return "photo-page"
    if re.search(r"/posts/|permalink|story_fbid", url):
        return "post"
    return "other"


# ── Loading dumps ────────────────────────────────────────────────────────────
def load_posts(path: str) -> tuple[dict, list[dict]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):  # facebook-private-group-scraper posts.json
        posts = [{
            "postId": p.get("postId"), "url": p.get("postUrl"), "author": p.get("author"),
            "date": p.get("postDate"), "dateRaw": p.get("postDate"), "text": p.get("text"),
            "links": p.get("links") or [], "cards": [],
            "images": [{"src": s, "alt": None} for s in (p.get("images") or [])],
            "videos": [l for l in (p.get("links") or []) if kind_of(l) in ("video", "reel")],
            "counts": {}, "comments": [],
        } for p in raw]
        return {"page": {"title": "posts.json", "url": None, "type": "scraper"}, "warnings": []}, posts
    if "posts" in raw:
        return raw, raw["posts"]
    if isinstance(raw, dict) and "rows" in raw:  # mediaList() wrapped
        return {"page": {}, "warnings": []}, []
    raise SystemExit("Ismeretlen JSON formátum (fb-reader dump vagy posts.json kell)")


def media_rows(posts: list[dict], include_comments: bool = True) -> list[dict]:
    rows = []
    for p in posts:
        pid = p.get("postId") or "post"
        for i, im in enumerate(p.get("images") or [], 1):
            rows.append({"type": "image", "url": im["src"], "postId": pid, "name": f"{pid}_{i}", "alt": im.get("alt")})
        vids = list(dict.fromkeys(p.get("videos") or []))
        for i, v in enumerate(vids, 1):
            rows.append({"type": kind_of(v), "url": v, "postId": pid, "name": f"{pid}_v{i}"})
        if p.get("hasVideo") and not vids and p.get("url"):
            rows.append({"type": "video", "url": p["url"], "postId": pid, "name": f"{pid}_v1"})
        if include_comments:
            for ci, c in enumerate(p.get("comments") or [], 1):
                for mi, m in enumerate(c.get("media") or [], 1):
                    url = m.get("link") if m.get("kind") == "video" else m.get("src")
                    if url:
                        rows.append({"type": "video" if m.get("kind") == "video" else "image", "url": url,
                                     "postId": pid, "name": f"{pid}_c{ci}_{mi}", "alt": m.get("alt")})
    return rows


# ── Downloading ──────────────────────────────────────────────────────────────
def fetch_image(url: str, dest_noext: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": FB + "/"})
    with urllib.request.urlopen(req, timeout=60) as r:
        ctype = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0]
        ext = mimetypes.guess_extension(ctype) or ".jpg"
        if ext == ".jpe":
            ext = ".jpg"
        out = dest_noext.with_suffix(ext)
        with open(out, "wb") as f:
            shutil.copyfileobj(r, f)
    return out


def ytdlp_cmd() -> list[str] | None:
    if shutil.which("yt-dlp"):
        return ["yt-dlp"]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return None


def fetch_video(url: str, dest_noext: Path, args) -> Path | None:
    base = ytdlp_cmd()
    if not base:
        raise RuntimeError("yt-dlp nincs telepítve: pip install -U yt-dlp")
    cmd = base + ["--no-progress", "--no-playlist", "-o", str(dest_noext) + ".%(ext)s",
                  "--print", "after_move:filepath", "--restrict-filenames"]
    if args.cookies:
        cmd += ["--cookies", args.cookies]
    if args.cookies_from_browser:
        cmd += ["--cookies-from-browser", args.cookies_from_browser]
    if args.format:
        cmd += ["-f", args.format]
    if args.audio_only:
        cmd += ["-x", "--audio-format", "mp3"]
    elif not args.any_codec:
        # Facebook often serves AV1 (or VP9) first; Windows' built-in player cannot play AV1 without the
        # Store "AV1 Video Extension". Prefer H.264 + AAC and an mp4 container.
        cmd += ["-S", "vcodec:h264,acodec:aac,res,fps", "--merge-output-format", "mp4"]
    cmd.append(url)
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout).strip().splitlines()[-1] if (res.stderr or res.stdout) else "yt-dlp hiba")
    lines = [l for l in res.stdout.strip().splitlines() if l.strip()]
    out = Path(lines[-1]) if lines else None
    if out and out.exists() and not args.audio_only and not args.any_codec:
        out = ensure_playable(out, args)
    return out


def probe_codecs(path: Path) -> dict:
    if not shutil.which("ffprobe"):
        return {}
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,profile",
                        "-of", "json", str(path)], capture_output=True, text=True)
    try:
        streams = json.loads(r.stdout).get("streams", [])
    except json.JSONDecodeError:
        return {}
    return {s.get("codec_type"): (s.get("codec_name"), s.get("profile")) for s in streams}


def ensure_playable(path: Path, args) -> Path:
    """If only AV1/VP9/HEVC was available, transcode to H.264 + AAC-LC (plays everywhere)."""
    codecs = probe_codecs(path)
    v = (codecs.get("video") or (None,))[0]
    a = codecs.get("audio") or (None, None)
    bad_audio = a[0] not in (None, "aac", "mp3") or (a[0] == "aac" and a[1] and "HE" in a[1])
    if v in (None, "h264") and not bad_audio:
        return path
    if not shutil.which("ffmpeg"):
        print(f"! {path.name}: {v}/{a[0]} — ffmpeg nélkül nem kódolható át; Windowson AV1-hez kell az 'AV1 Video Extension'", file=sys.stderr)
        return path
    out = path.with_name(path.stem + "_h264.mp4")
    vcodec = ["-c:v", "copy"] if v == "h264" else ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(args.crf),
                                                    "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0:v:0?", "-map", "0:a:0?", *vcodec,
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        print(f"! átkódolás sikertelen ({path.name}): {r.stderr.strip()[-200:]}", file=sys.stderr)
        return path
    if not args.keep_original:
        path.unlink()
        out = out.rename(path.with_suffix(".mp4"))
    print(f"  ↳ átkódolva {v}/{a[0]} → h264/aac", file=sys.stderr)
    return out


def cmd_media(args):
    rows = []
    if args.dump:
        raw = json.loads(Path(args.dump).read_text(encoding="utf-8"))
        if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "url" in raw[0] and "type" in raw[0]:
            # output of __fbReader.mediaList()
            for i, r in enumerate(raw, 1):
                name = f"{r.get('postId') or 'item'}" + (f"_c{r['comment']}" if r.get("comment") else "") + (f"_{r['n']}" if r.get("n") else f"_{i}")
                rows.append({"type": "video" if r["type"] in ("video", "reel") else ("image" if r["type"] in ("image", "gif", "sticker") else r["type"]),
                             "url": r["url"], "postId": r.get("postId"), "name": name, "alt": r.get("alt")})
        else:
            _, posts = load_posts(args.dump)
            rows = media_rows(posts, include_comments=not args.no_comments)
    for i, u in enumerate(args.url or [], 1):
        u = clean_url(u)
        rows.append({"type": kind_of(u), "url": u, "postId": "url", "name": f"url_{i}"})
    if args.only:
        want = set(args.only.split(","))
        rows = [r for r in rows if r["type"] in want or (r["type"] == "reel" and "video" in want)]
    if not rows:
        raise SystemExit("Nincs letölthető média.")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for r in rows:
        dest = out_dir / re.sub(r"[^\w.-]+", "_", r["name"])
        entry = dict(r)
        try:
            if r["type"] == "image":
                f = fetch_image(r["url"], dest)
            elif r["type"] in ("video", "reel", "post", "photo-page"):
                f = fetch_video(r["url"], dest, args)
            else:
                entry["status"] = "skipped"
                manifest.append(entry)
                continue
            entry.update(status="ok", file=str(f) if f else None)
            print(f"✓ {r['type']:6} {f}")
            if args.transcribe and f and r["type"] in ("video", "reel"):
                entry["transcribe"] = run_transcribe(f, r["url"], out_dir / re.sub(r"[^\w.-]+", "_", r["name"] + "_transcribe"), args)
        except Exception as e:  # noqa: BLE001
            entry.update(status="error", error=str(e)[:300])
            print(f"✗ {r['type']:6} {r['url'][:80]} — {e}", file=sys.stderr)
        manifest.append(entry)
        time.sleep(args.delay)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    ok = sum(1 for m in manifest if m.get("status") == "ok")
    print(f"\n{ok}/{len(manifest)} letöltve → {out_dir}/ (manifest.json)")


# ── Text inside the video: subs / speech / OCR ────────────────────────────────
def transcribe_subs(url, out_dir: Path, args) -> dict:
    if not re.match(r"^https?://", str(url) or ""):
        return {"status": "skipped", "error": "nincs URL (csak helyi fájl lett megadva) — a Facebook-feliratokhoz az eredeti URL kell"}
    base = ytdlp_cmd()
    if not base:
        return {"status": "error", "error": "yt-dlp nincs telepítve: pip install -U yt-dlp"}
    dest = out_dir / "subs"
    langs = args.lang if args.lang and args.lang != "auto" else "hu,en,hu.*,en.*"
    cmd = base + ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs,
                  "-o", str(dest) + ".%(ext)s", url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    files = sorted(str(p) for p in out_dir.glob("subs*.vtt")) + sorted(str(p) for p in out_dir.glob("subs*.srt"))
    if files:
        return {"status": "ok", "files": files}
    err = (res.stderr or res.stdout).strip().splitlines()
    return {"status": "none", "error": err[-1] if err else "nincs elérhető feliratfájl ehhez a videóhoz"}


def transcribe_speech(video: Path, out_dir: Path, args) -> dict:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"status": "error", "error": "faster-whisper nincs telepítve: pip install faster-whisper"}
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    lang = None if not args.lang or args.lang == "auto" else args.lang
    segments, info = model.transcribe(str(video), language=lang)

    def fmt(t: float) -> str:
        h, rem = divmod(t, 3600); mi, s = divmod(rem, 60)
        return f"{int(h):02}:{int(mi):02}:{int(s):02},{int((s - int(s)) * 1000):03}"
    srt_lines, txt_lines = [], []
    for i, seg in enumerate(segments, 1):
        text = seg.text.strip()
        srt_lines += [str(i), f"{fmt(seg.start)} --> {fmt(seg.end)}", text, ""]
        txt_lines.append(text)
    if not txt_lines:
        return {"status": "none", "error": "nincs felismert beszéd"}
    srt_path, txt_path = out_dir / "transcript.srt", out_dir / "transcript.txt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")
    txt_path.write_text(" ".join(txt_lines).strip() + "\n", encoding="utf-8")
    return {"status": "ok", "srt": str(srt_path), "txt": str(txt_path), "language": getattr(info, "language", lang)}


def _frame_hash(path: Path):
    try:
        from PIL import Image
    except ImportError:
        return None
    small = Image.open(path).convert("L").resize((8, 8))
    px = list(small.getdata())
    avg = sum(px) / len(px)
    return int("".join("1" if p > avg else "0" for p in px), 2)


def transcribe_ocr(video: Path, out_dir: Path, args) -> dict:
    if not shutil.which("ffmpeg"):
        return {"status": "error", "error": "ffmpeg nincs telepítve"}
    if not shutil.which("tesseract"):
        return {"status": "error", "error": "tesseract nincs telepítve (eng+hun nyelvi adatokkal) — https://github.com/tesseract-ocr/tesseract"}
    frame_dir = out_dir / "ocr_frames"
    frame_dir.mkdir(exist_ok=True)
    for old in frame_dir.glob("f_*.png"):
        old.unlink()
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", f"fps=1/{args.ocr}", str(frame_dir / "f_%05d.png")]
    res = subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(frame_dir.glob("f_*.png"))
    if res.returncode != 0 or not frames:
        return {"status": "error", "error": (res.stderr or "nincs kinyert képkocka").strip()[-300:]}
    rows, last_hash = [], None
    have_phash = _frame_hash(frames[0]) is not None
    for i, f in enumerate(frames):
        t = i * args.ocr
        if have_phash:
            h = _frame_hash(f)
            if last_hash is not None and bin(h ^ last_hash).count("1") <= 4:
                continue
            last_hash = h
        text = subprocess.run(["tesseract", str(f), "stdout", "-l", "eng+hun"], capture_output=True, text=True).stdout.strip()
        if text:
            rows.append((t, text))
    md = ["# Képernyőszöveg (OCR)", ""] + [f"**{int(t // 60):02}:{int(t % 60):02}** — {txt}" for t, txt in rows]
    ocr_path = out_dir / "ocr.md"
    ocr_path.write_text("\n\n".join(md) + "\n", encoding="utf-8")
    note = "" if have_phash else " (Pillow nélkül: minden képkocka, duplikátum-szűrés nélkül)"
    return {"status": "ok", "file": str(ocr_path), "frames": len(frames), "kept": len(rows), "note": note or None}


def run_transcribe(video: Path, url: str | None, out_dir: Path, args) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"video": str(video) if video else None, "url": url}
    if args.subs:
        manifest["subs"] = transcribe_subs(url, out_dir, args)
    if args.speech:
        manifest["transcript"] = transcribe_speech(video, out_dir, args) if video else {"status": "error", "error": "nincs letöltött videófájl"}
    if args.ocr:
        manifest["ocr"] = transcribe_ocr(video, out_dir, args) if video else {"status": "error", "error": "nincs letöltött videófájl"}
    return manifest


def cmd_transcribe(args):
    if not (args.subs or args.speech or args.ocr):
        args.subs = True  # "--subs (default first)" per references/media.md
    out_dir = Path(args.out)
    video = None
    if args.url:
        out_dir.mkdir(parents=True, exist_ok=True)
        video = fetch_video(args.url, out_dir / "video", args)
        if not video:
            raise SystemExit("A videó letöltése sikertelen, nincs mit átírni.")
    elif args.file:
        video = Path(args.file)
        if not video.exists():
            raise SystemExit(f"Nincs ilyen fájl: {video}")
    else:
        raise SystemExit("transcribe: adj meg egy fájlt vagy --url-t")
    manifest = run_transcribe(video, args.url, out_dir, args)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


# ── Markdown ─────────────────────────────────────────────────────────────────
def to_markdown(meta: dict, posts: list[dict]) -> str:
    pg = meta.get("page") or {}
    L = [f"# {pg.get('heading') or pg.get('title') or 'Facebook'}",
         f"Forrás: {pg.get('url') or '-'} · posztok: {len(posts)}"]
    for p in posts:
        flag = " · 📣 HIRDETÉS" if p.get("sponsored") else ""
        L += ["", f"## {p.get('author') or 'Ismeretlen szerző'} — {p.get('dateRaw') or p.get('date') or 'ismeretlen dátum'}{flag}"]
        if p.get("text"):
            L += ["", p["text"]]
        if p.get("sharedText"):
            L += ["", "> Megosztott tartalom:"] + ["> " + l for l in p["sharedText"].splitlines()]
        for c in p.get("cards") or []:
            L.append(f"- 🔗 **{c.get('title') or c.get('url')}** ({c.get('domain') or ''}) {c.get('url') or ''}")
        for u in p.get("links") or []:
            if not any(c.get("url") == u for c in p.get("cards") or []):
                L.append(f"- {u}")
        for i, im in enumerate(p.get("images") or [], 1):
            L.append(f"- 🖼 kép {i}" + (f": {im['alt']}" if im.get("alt") else ""))
        for v in p.get("videos") or []:
            L.append(f"- 🎬 {v}")
        c = p.get("counts") or {}
        cs = [f"{c[k]} {lbl}" for k, lbl in (("reactions", "reakció"), ("comments", "hozzászólás"), ("shares", "megosztás")) if c.get(k) is not None]
        if cs:
            L.append("_" + " · ".join(cs) + "_")
        if p.get("url"):
            L.append(f"Link: {p['url']}")
        if p.get("comments"):
            L += ["", "### Hozzászólások"]
            for k in p["comments"]:
                med = " ".join(f"[{m.get('kind')}{': ' + m['alt'] if m.get('alt') else ''}]" for m in k.get("media") or [])
                L.append(f"{'  ' * (k.get('depth') or 0)}- **{k.get('author') or '?'}**"
                         f"{' → ' + k['replyTo'] if k.get('replyTo') else ''}"
                         f"{' (' + k['dateRaw'] + ')' if k.get('dateRaw') else ''}: {(k.get('text') or '').replace(chr(10), ' ')} {med}".rstrip())
    return "\n".join(L) + "\n"


def cmd_to_md(args):
    meta, posts = load_posts(args.dump)
    sys.stdout.write(to_markdown(meta, posts))


# ── Offline HTML parsing ─────────────────────────────────────────────────────
def cmd_parse_html(args):
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        raise SystemExit("pip install beautifulsoup4")
    html = Path(args.file).read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.select('[aria-hidden="true"]'):
        # keep aria-hidden link-card images, drop decoy text
        if not el.find("img"):
            el.decompose()
    ids = {el.get("id"): el.get_text(" ", strip=True) for el in soup.select("[id]")}
    roots = soup.select('[role="main"] [aria-posinset], [role="feed"] [aria-posinset]') or \
        [a for a in soup.select('[role="article"]') if not a.find_parent(attrs={"role": "article"})] or \
        [soup]
    norm = lambda t: INVISIBLE.sub("", t or "").replace(" ", " ").strip()
    posts = []
    for r in roots:
        msg = r.select_one('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]')
        pn = r.select_one('[data-ad-rendering-role="profile_name"]')
        text = norm(msg.get_text("\n", strip=True)) if msg else ""
        if not text:
            parts = sorted({norm(e.get_text("\n", strip=True)) for e in r.select('[dir="auto"]')
                            if not e.find_parent("a") and len(norm(e.get_text())) > 20
                            and not e.find_parent(attrs={"data-ad-rendering-role": True})}, key=len, reverse=True)
            text = parts[0] if parts else ""
        date_raw = None
        for sp in r.select("[aria-labelledby]"):
            t = " ".join(ids.get(i, "") for i in sp["aria-labelledby"].split()).strip()
            if t and re.search(r"20\d\d|január|február|március|április|május|június|július|augusztus|szeptember|október|november|december|órája|napja|tegnap|\d+\s*(ó|n|p|hét)\b", t, re.I):
                date_raw = t
                break
        hrefs = [a.get("href", "") for a in r.select("a[href]")]
        url = next((h for h in hrefs if re.search(r"/posts/|permalink|story_fbid", h)), None)
        if not url:
            ins = next((h for h in hrefs if "post_insights/" in h), None)
            m = re.search(r"(/groups/[^/]+)/post_insights/(\d+)", ins or "")
            if m:
                url = f"{FB}{m.group(1)}/posts/{m.group(2)}/"
        if url and url.startswith("/"):
            url = FB + url
        cards = []
        for t in r.select('[data-ad-rendering-role="title"]'):
            card = t.find_parent(lambda tag: tag.select_one('[data-ad-rendering-role="meta"]') is not None) or t.parent
            dom = norm(card.select_one('[data-ad-rendering-role="meta"]').get_text()) if card.select_one('[data-ad-rendering-role="meta"]') else None
            desc = norm(card.select_one('[data-ad-rendering-role="description"]').get_text()) if card.select_one('[data-ad-rendering-role="description"]') else None
            if dom and re.fullmatch(r"(?=[^.]*[a-z])(?=[^.]*[A-Z])[A-Za-z0-9]{6,16}\.(com|net|org)", dom) and (not desc or re.fullmatch(r"[A-Za-z0-9_-]{25,}", desc)):
                continue  # decoy card
            a = card.select_one("a[href]")
            cards.append({"url": clean_url(a["href"]) if a else None, "title": norm(t.get_text()), "domain": dom, "description": desc})
        links = sorted({clean_url(h) for h in hrefs if h.startswith("http") and not re.search(r"facebook\.com|fbcdn", clean_url(h))})
        def _small(i):
            w, h = i.get("width"), i.get("height")
            if (w and w.isdigit() and int(w) < 80) or (h and h.isdigit() and int(h) < 80):
                return True
            m = re.search(r"[_-][sp](\d{2,4})x(\d{2,4})", i.get("src", ""))
            if m and max(int(m.group(1)), int(m.group(2))) <= 200:
                return True  # avatar / thumbnail
            return "/v/t1.30497-1/" in i.get("src", "")  # default avatar
        images = [{"src": i.get("src"), "alt": i.get("alt") or None} for i in r.select("img")
                  if re.search(r"fbcdn|scontent", i.get("src", "")) and not _small(i)
                  and not i.find_parent(attrs={"data-ad-rendering-role": "image"})]
        pid = None
        for h in hrefs:
            m = re.search(r"/posts/(pfbid\w+|\d+)|permalink/(\d+)|story_fbid=(pfbid\w+|\d+)|post_insights/(\d+)", h)
            if m:
                pid = next(g for g in m.groups() if g)
                break
        posts.append({"postId": pid, "url": clean_url(url) if url else None,
                      "author": norm(pn.get_text(" ", strip=True)) if pn else None,
                      "date": None, "dateRaw": date_raw, "text": text, "links": links, "cards": cards,
                      "images": images, "videos": [h for h in map(clean_url, hrefs) if kind_of(h) in ("video", "reel")],
                      "counts": {}, "comments": []})
    meta = {"tool": "fb_tool.py parse-html", "page": {"title": soup.title.get_text() if soup.title else args.file},
            "warnings": ["Offline HTML: a csak CSS-ben dekódolható dátumok/elrejtések nem állíthatók vissza — élő böngészőben pontosabb."]}
    if args.format == "md":
        sys.stdout.write(to_markdown(meta, posts))
    else:
        print(json.dumps({**meta, "posts": posts}, ensure_ascii=False, indent=2))


# ── URL builders ─────────────────────────────────────────────────────────────
def cmd_urls(args):
    q = urllib.parse.quote(args.query or "")
    g = re.sub(r"^https?://[^/]+/groups/|[/?#].*$", "", args.target or "")
    table = {
        "search": lambda: f"{FB}/search/{args.type}/?q={q}",
        "group": lambda: f"{FB}/groups/{g}/" + ("?sorting_setting=CHRONOLOGICAL" if args.chronological else ""),
        "group-search": lambda: f"{FB}/groups/{g}/search/?q={q}",
        "group-media": lambda: f"{FB}/groups/{g}/media/",
        "group-about": lambda: f"{FB}/groups/{g}/about/",
        "group-members": lambda: f"{FB}/groups/{g}/members/",
        "groups-joined": lambda: f"{FB}/groups/joins/",
        "hashtag": lambda: f"{FB}/hashtag/{urllib.parse.quote((args.query or '').lstrip('#'))}",
        "profile": lambda: f"{FB}/profile.php?id={args.target}" if (args.target or "").isdigit() else f"{FB}/{(args.target or '').lstrip('@')}",
    }
    print(table[args.kind]())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("media", help="képek + videók/reelek letöltése")
    m.add_argument("dump", nargs="?", help="fb-reader JSON dump (vagy scraper posts.json)")
    m.add_argument("--url", action="append", help="közvetlen URL (reel, videó, poszt, kép) — többször megadható")
    m.add_argument("-o", "--out", default="fb_media")
    m.add_argument("--only", help="image,video,reel szűrő (vesszővel)")
    m.add_argument("--no-comments", action="store_true", help="kommentek médiáját hagyja ki")
    m.add_argument("--cookies", help="Netscape cookies.txt (privát csoportok videóihoz)")
    m.add_argument("--cookies-from-browser", help="pl. chrome, edge, firefox — csak a SAJÁT gépeden!")
    m.add_argument("-f", "--format", help="yt-dlp formátum (pl. 'best[height<=720]')")
    m.add_argument("--audio-only", action="store_true", help="csak hang (mp3)")
    m.add_argument("--any-codec", action="store_true", help="ne kényszerítsen H.264-et (AV1/VP9 is maradhat)")
    m.add_argument("--crf", type=int, default=21, help="H.264 minőség átkódoláskor (alacsonyabb = jobb, alap 21)")
    m.add_argument("--keep-original", action="store_true", help="az eredeti (AV1/VP9) fájlt is megtartja")
    m.add_argument("--delay", type=float, default=1.5, help="szünet letöltések között (mp)")
    m.add_argument("--transcribe", action="store_true", help="minden letöltött videót átirat is készül (lásd: transcribe subcommand)")
    m.add_argument("--subs", action="store_true", help="--transcribe: Facebook saját feliratai (yt-dlp)")
    m.add_argument("--speech", action="store_true", help="--transcribe: beszéd felismerése (faster-whisper)")
    m.add_argument("--ocr", type=int, metavar="N", help="--transcribe: képkocka N másodpercenként + OCR (ffmpeg+tesseract)")
    m.add_argument("--lang", default="auto", help="--transcribe: hu|en|auto")
    m.add_argument("--model", default="small", help="--transcribe: faster-whisper modell")
    m.set_defaults(fn=cmd_media)

    t = sub.add_parser("to-md", help="JSON → Markdown")
    t.add_argument("dump")
    t.set_defaults(fn=cmd_to_md)

    h = sub.add_parser("parse-html", help="mentett HTML → JSON/Markdown")
    h.add_argument("file")
    h.add_argument("--format", choices=["json", "md"], default="json")
    h.set_defaults(fn=cmd_parse_html)

    c = sub.add_parser("clean-url", help="l.facebook.com kicsomagolás + tracking eltávolítás")
    c.add_argument("url", nargs="+")
    c.set_defaults(fn=lambda a: print("\n".join(clean_url(u) for u in a.url)))

    u = sub.add_parser("urls", help="navigációs/kereső URL-ek")
    u.add_argument("kind", choices=["search", "group", "group-search", "group-media", "group-about",
                                    "group-members", "groups-joined", "hashtag", "profile"])
    u.add_argument("query", nargs="?", help="keresőkifejezés / hashtag")
    u.add_argument("--target", help="csoport id/slug/URL vagy profil")
    u.add_argument("--type", choices=SEARCH_TYPES, default="top")
    u.add_argument("--chronological", action="store_true")
    u.set_defaults(fn=cmd_urls)

    tr = sub.add_parser("transcribe", help="felirat / beszéd-felismerés / OCR a videóból")
    tr.add_argument("file", nargs="?", help="letöltött videófájl")
    tr.add_argument("--url", help="reel/videó URL (letölti, majd átírja)")
    tr.add_argument("-o", "--out", default="fb_transcribe")
    tr.add_argument("--subs", action="store_true", help="Facebook saját feliratai, ha léteznek (yt-dlp) — alapértelmezett, ha semmi mást nem kérsz")
    tr.add_argument("--speech", action="store_true", help="beszéd felismerése .srt + .txt (faster-whisper)")
    tr.add_argument("--ocr", type=int, metavar="N", help="képkocka N másodpercenként + OCR, ocr.md (ffmpeg+tesseract)")
    tr.add_argument("--lang", default="auto", help="hu|en|auto")
    tr.add_argument("--model", default="small", help="faster-whisper modell (alap: small)")
    tr.add_argument("--summary", action="store_true", help="jelzi, hogy a hívó (az agent) a transcript.txt-ből fejezet-jegyzeteket ír — ez a parancs nem foglalkozik vele")
    tr.add_argument("--cookies", help="Netscape cookies.txt (--url esetén, privát videóhoz)")
    tr.add_argument("--cookies-from-browser", help="pl. chrome, edge, firefox — csak a SAJÁT gépeden!")
    tr.add_argument("-f", "--format", help="yt-dlp formátum --url letöltéshez")
    tr.add_argument("--audio-only", action="store_true", help="csak hang; a --speech ebből is tud átírni")
    tr.add_argument("--any-codec", action="store_true")
    tr.add_argument("--crf", type=int, default=21)
    tr.add_argument("--keep-original", action="store_true")
    tr.set_defaults(fn=cmd_transcribe)

    args = ap.parse_args()
    if args.cmd == "media" and not (args.dump or args.url):
        ap.error("media: adj meg dump JSON-t vagy --url-t")
    args.fn(args)


if __name__ == "__main__":
    main()
