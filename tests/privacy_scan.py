#!/usr/bin/env python3
"""Privacy scan: fails when the repository contains things that look personal.

Generic rules (run in CI and by release.py):
  * e-mail addresses (except example.*, noreply)
  * absolute home / user paths (/home/<u>, /Users/<u>, C:\\Users\\<u>, D:\\...)
  * long digit runs (Facebook ids, phone numbers) unless obviously synthetic (many zeros, 1234567890…, repeated digit)
  * facebook.com profile / group slugs and ids that are not on the synthetic allowlist
  * tokens, cookies, signed CDN query strings (oh=, _nc_sid=, c_user, xs=)

Optional local deny list (never committed): --deny FILE (one case-insensitive token per line), or the env var
FB_READER_PRIVACY_DENY pointing at such a file. Put real names, group names, ids of the maintainer there.

Usage: python3 tests/privacy_scan.py [--deny FILE]      exit code 1 on findings
"""
import os, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', 'dist', 'node_modules', '__pycache__'}
SKIP_FILES = {'privacy_scan.py'}
TEXT_SUFFIX = {'.js', '.mjs', '.py', '.md', '.json', '.html', '.yml', '.yaml', '.txt', '.svg', '.css', ''}
SKIP_SUFFIX_NAMES = ('.min.js',)  # generated copies are scanned through their sources

SYNTH_SLUGS = {'mintamarta', 'peldacsoport', 'kiss.peter', 'gergo.minta', 'user', 'username', 'profile.php', 'groups', 'marketplace', 'events',
               'photo', 'photo.php', 'permalink.php', 'watch', 'reel', 'share', 'login', 'notifications', 'messages', 'help', 'x', 'search',
               'stories', 'hashtag', 'pages', 'people', 'story.php', 'l.php', 'bookmarks', 'friends', 'me', 'plugins', 'dialog', 'sharer'}

RULES = [
    ('email', re.compile(r'[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply)[A-Za-z0-9-]+\.[A-Za-z]{2,}'), lambda m: 'noreply' in m.group(0) or m.group(0).startswith('@')),
    ('abs-path', re.compile(r'(?:/home/(?!user\b|runner\b|<)[a-z][\w.-]*/|/Users/(?!user\b|<)[A-Za-z][\w.-]*/|[A-Za-z]:\\Users\\[^\\\s]+|\b[D-Z]:[\\/](?:tool|projects?|work|dev)[\\/])'), None),
    ('secret', re.compile(r'(?:c_user|\bxs=|datr=|fr=\w{10,}|_nc_sid=|[?&]oh=[0-9a-f]{8,}|access_token=|EAA[A-Za-z0-9]{20,})'), None),
]
DIGITS = re.compile(r'(?<![\w.#-])\d{10,}(?![\w])')
FBSLUG = re.compile(r'facebook\.com/(?!l\.php)([A-Za-z0-9.]{3,})(?=[/?"\'\s)<>`\\]|$)')


def synthetic_number(s: str) -> bool:
    return bool(re.search(r'0{5,}', s) or s.startswith('1234567890') or re.fullmatch(r'(\d)\1+', s) or re.fullmatch(r'(\d)\1{3,}\d*', s)
                or s in {'2166136261', '2147483647', '2147483646', '1112223334', '5551234567890', '9876543210', '987654321'})


def files():
    for p in sorted(ROOT.rglob('*')):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.parts) or p.name in SKIP_FILES or p.name.endswith(SKIP_SUFFIX_NAMES):
            continue
        if p.suffix.lower() in TEXT_SUFFIX and 'fb-reader.core.js' not in p.name and 'fb-reader.write.js' not in p.name and '.part-' not in p.name:
            yield p


def scan(deny):
    out = []
    for p in files():
        try:
            txt = p.read_text(encoding='utf-8')
        except Exception:
            continue
        rel = p.relative_to(ROOT).as_posix()
        for i, line in enumerate(txt.split('\n'), 1):
            for name, rx, skip in RULES:
                for m in rx.finditer(line):
                    if skip and skip(m):
                        continue
                    out.append((rel, i, name, m.group(0)[:60]))
            for m in DIGITS.finditer(line):
                if not synthetic_number(m.group(0)):
                    out.append((rel, i, 'digits', m.group(0)))
            for m in FBSLUG.finditer(line):
                slug = m.group(1).rstrip('.')
                if slug.lower() in SYNTH_SLUGS or slug.isdigit() and synthetic_number(slug) or re.fullmatch(r'\d{1,9}', slug):
                    continue
                if slug.isdigit():
                    out.append((rel, i, 'fb-id', slug)); continue
                out.append((rel, i, 'fb-slug', slug))
            low = line.lower()
            for tok in deny:
                if tok in low:
                    out.append((rel, i, 'deny-list', tok))
    return out


def main(argv):
    deny_file = None
    if '--deny' in argv:
        deny_file = argv[argv.index('--deny') + 1]
    deny_file = deny_file or os.environ.get('FB_READER_PRIVACY_DENY')
    deny = []
    if deny_file and os.path.exists(deny_file):
        deny = [l.strip().lower() for l in open(deny_file, encoding='utf-8') if l.strip() and not l.startswith('#')]
    res = scan(deny)
    for r in res:
        print('%s:%d  [%s] %s' % r)
    print('privacy scan: %d finding(s)%s' % (len(res), ' (+ local deny list: %d tokens)' % len(deny) if deny else ''))
    return 1 if res else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
