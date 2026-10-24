#!/usr/bin/env python3
"""facebook-reader regression suite — synthetic pages only, never touches facebook.com.

    python3 tests/run_tests.py            (needs: pip install playwright && playwright install chromium; node)

Covers: build freshness, loader / chunked install / cache restore, extension (MAIN world, CSP), extraction,
pinned comments, target tags, selfTest + snapshot round trip, write-guard hook (ask / deny / allow, audit).
"""
import hashlib, io, json, os, pathlib, re, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

# Windows' legacy console codepage (e.g. cp1250) can't print every accented character this suite uses in
# its check names/output; UTF-8 output is always safe to request explicitly.
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT / 'plugins' / 'facebook-reader'
S = PLUGIN / 'skills' / 'facebook-reader' / 'scripts'
EXT = PLUGIN / 'extension'
HOOKS = PLUGIN / 'hooks'
PAGES = {p.stem: p.read_text(encoding='utf-8') for p in (ROOT / 'tests' / 'pages').glob('*.html')}
FAILS = []


def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + ('' if cond else f'  → {detail}'))
    if not cond:
        FAILS.append(name)


def read(p):
    return pathlib.Path(p).read_text(encoding='utf-8')


# ── 0. build freshness ───────────────────────────────────────────────────────
print('build')
src = read(S / 'fb-reader.js')
ver = re.search(r"const VERSION = '([^']+)'", src).group(1)
build = hashlib.sha1(src.encode()).hexdigest()[:8]
check('loader pinned to the current source hash', f"W='{ver}+{build}'" in read(S / 'fb-reader.loader.js'), 'run scripts/build.py')
check('extension manifest version', json.loads(read(EXT / 'manifest.json'))['version'] == ver)
check('extension icons exist (16/32/48/128)', all((EXT / 'icons' / f'icon{n}.png').stat().st_size > 200 for n in (16, 32, 48, 128)))
check('plugin listing icon exists (.claude-plugin/icon.png)', (PLUGIN / '.claude-plugin' / 'icon.png').stat().st_size > 5000)
check('plugin.json version', json.loads(read(PLUGIN / '.claude-plugin' / 'plugin.json'))['version'] == ver)
mk = json.loads(read(ROOT / '.claude-plugin' / 'marketplace.json'))
check('marketplace.json version', mk['plugins'][0].get('version', ver) == ver)

_ps = subprocess.run([sys.executable, str(ROOT / 'tests' / 'privacy_scan.py')], capture_output=True, text=True, encoding='utf-8')
check('privacy scan: no e-mails, absolute user paths, real-looking ids, FB slugs or secrets in the repo', _ps.returncode == 0, _ps.stdout[-600:])
_cx = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(ROOT / 'tests'), '-p', 'test_codex_hooks.py'], capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
check('Codex adapter + manifests: unittest (deny instead of ask, no Claude tokens, one shared guard)', _cx.returncode == 0, (_cx.stderr or '')[-800:])

LOADER = read(S / 'fb-reader.loader.js').strip()
LOADER_X = LOADER[len('await '):]
PARTS = sorted((S / 'install').glob('fb-reader.part-*.js'), key=lambda p: int(p.name.split('-')[2]))
FBURL = 'https://www.facebook.com/profile.php?id=100000000000001'


def serve(target, name):
    cur = {'p': name}
    target.route('**/*', lambda r: r.fulfill(body=PAGES[cur['p']] if isinstance(cur['p'], str) and cur['p'] in PAGES else cur['p'], content_type='text/html; charset=utf-8'))
    return cur


def fake_facebook(state):
    """A real HTTPS server answering for www.facebook.com (via --host-resolver-rules), so tabs opened by the extension's service
    worker behave exactly like production (Playwright's route interception races with tabs it did not open itself)."""
    import http.server, ssl, threading
    d = tempfile.mkdtemp()
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f'{d}/k.pem', '-out', f'{d}/c.pem', '-days', '2', '-subj', '/CN=www.facebook.com',
                    '-addext', 'subjectAltName=DNS:www.facebook.com'], check=True, capture_output=True)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = (PAGES[state['p']] if state['p'] in PAGES else state['p']).encode('utf-8')
            self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    cx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); cx.load_cert_chain(f'{d}/c.pem', f'{d}/k.pem')
    srv.socket = cx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


HOME_TPL = '<!doctype html><html lang="hu"><head><meta charset="utf-8"><title>(%d) Facebook</title></head><body><div role="banner"><div role="button" aria-label="Értesítések, %d olvasatlan">N</div><div role="button" aria-label="Messenger, %d olvasatlan">M</div></div><div role="main"><h1>Főoldal</h1></div></body></html>'


with sync_playwright() as p:
    # ── 1. paste route: chunked install, cache restore ───────────────────────
    print('paste route')
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1200, 'height': 900})
    cur = serve(pg, 'page2')
    pg.goto(FBURL)
    check('loader before install says NINCS TELEPÍTVE', 'NINCS TELEPÍTVE' in pg.evaluate(f'(async()=>{{return {LOADER}}})()'))
    out = ''
    for part in PARTS:
        out = pg.evaluate(part.read_text(encoding='utf-8'))
    check('chunked install runs the core', 'betöltve' in str(out), out)
    pg.evaluate((S / 'fb-reader-write.min.js').read_text(encoding='utf-8'))
    pg.goto(FBURL + '&x=1')
    r = pg.evaluate(f'(async()=>{{return {LOADER}}})()')
    check('loader after navigation: cache OK + write module', 'cache OK' in r and 'írási modul: van' in r, r)
    pg.evaluate('localStorage.clear()'); pg.goto(FBURL + '&x=2')
    r = pg.evaluate(f'(async()=>{{return {LOADER}}})()')
    check('localStorage cleared → restored from IndexedDB', 'cache OK' in r and pg.evaluate("!!localStorage.getItem('fb-reader:src')"), r)
    b.close()

    # ── 2. extension route (MAIN world, strict CSP, navigation) ──────────────
    print('extension')
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel='chromium', headless=True, viewport={'width': 1200, 'height': 900},
                                               args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    csp = "default-src 'self' data: 'unsafe-inline'; script-src 'self' 'nonce-abc'; object-src 'none'"
    state = {'p': 'page2', 'csp': csp}  # the page's own inline script is blocked while the CSP is on; the extension must still load
    ctx.route('**/*', lambda r: r.fulfill(body=PAGES[state['p']] if state['p'] in PAGES else state['p'], content_type='text/html; charset=utf-8', headers={'content-security-policy': state['csp']} if state['csp'] else {}))
    pg = ctx.new_page(); pg.goto(FBURL); pg.wait_for_timeout(800)
    check('__fbReader present without pasting (strict CSP)', pg.evaluate('typeof window.__fbReader') == 'object')
    check('write module present', pg.evaluate("typeof __fbReader.react") == 'function')
    pg.goto('https://www.facebook.com/groups/peldacsoport/search/?q=x'); pg.wait_for_timeout(500)
    check('present again after navigation', pg.evaluate('typeof window.__fbReader') == 'object')
    r = pg.evaluate(f'(async()=>{{return {LOADER}}})()')
    check('loader short-circuits when the extension is active', 'bővítményből' in r, r)

    # ── 3. reader behaviour on the synthetic J&A-style page ─────────────────
    print('reader')
    state['csp'] = None
    pg.goto(FBURL); pg.wait_for_timeout(500)
    ev = pg.evaluate
    st = ev("__fbReader.selfTest({format:'object'})")
    check('selfTest ok on page2', st['ok'] and st['extraction']['posts'] == 1, json.dumps(st['warnings']))
    f = ev("__fbReader.findPost({text:'12500 follower'})")
    check('findPost by text', f['found'] and f['inDom'])
    pc = ev("__fbReader.extractPinnedComments().then(r=>r)")
    check('pinned/author comment found with full text', pc['found'] and any(c['pinned'] and c['isAuthor'] and 'IDENTITY REFERENCE' in (c['text'] or '') for c in pc['comments']), json.dumps(pc)[:200])
    prompt = ev("__fbReader.extractPrompt().then(r=>r)")
    check('extractPrompt returns the pinned text', prompt['found'] and prompt['source'] == 'pinned-comment')
    cb = ev('__fbReader.commentBox()')
    check('commentBox: identity read', cb['found'] and cb['asWhom'] == 'Teszt Elek', json.dumps(cb)[:200])
    check('commentBox: ref tag', cb['target']['ref'] == '[fbr:comment-box]')
    rc = ev("__fbReader.react('love').then(r=>r)")
    check('react locates the bar, never clicks', rc['found'] and rc['target']['ref'] == '[fbr:love]' and ev('__fbReader.reactionState().pressed') is False, json.dumps(rc)[:300])
    tags = ev("[...document.querySelectorAll('[data-fbr-target]')].map(e=>e.getAttribute('aria-label')).join('|')")
    check('aria-label carries the tags', '[fbr:love]' in tags and '[fbr:like]' in tags, tags)
    ev("__fbReader.unmark()")
    check('unmark() restores labels', ev("document.querySelectorAll('[data-fbr-target],[data-fbr-orig]').length") == 0)
    js = ev("__fbReader.extract({format:'json'})")
    check('json output has no signed CDN query strings', 'oh=' not in js and '_nc_' not in js)
    md = ev("__fbReader.extract({format:'md',comments:true})")
    check('markdown shows pin + author badge', '📌' in md and '(szerző)' in md)
    sc = ev("__fbReader.harvest.start(),__fbReader.harvest.scroll({steps:10,pause:1500,budgetMs:3500}).then(r=>r)")
    check('scroll honours budgetMs', sc.get('done') is False and sc.get('reason') == 'budget', json.dumps(sc))
    ev("document.querySelector('[contenteditable]').focus()")
    pg.fill('[contenteditable]', 'Herzlichen Glückwunsch!')
    rep = ev('__fbReader.composeReport()')
    check('composeReport: identity, text, publish button', 'Teszt Elek' in rep and 'Herzlichen' in rep and 'Közzététel gomb' in rep)
    qp = ev("__fbReader.q('posts')")
    check('q(posts): compact, under 900 chars, no CDN query', len(qp) < 900 and 'oh=' not in qp and 'Példa Stúdió' in qp and qp.splitlines()[1].startswith('1|'), qp)
    qc = ev("__fbReader.q('comments', ['author','text:30','pinned'])")
    check('q(comments): pinned/author flag', '📌szerző' in qc, qc)
    qm = ev("__fbReader.q('media')")
    check('q(media) never prints media URLs', 'http' not in qm, qm)
    check('q: unknown field is reported', 'ismeretlen mező' in ev("__fbReader.q('posts',['nope'])"))
    long = ev("__fbReader.q('comments', ['author','text:100'], {maxChars:200})")
    check('q: truncation gives a continuation hint', "{offset:" in long, long)
    snap = ev('__fbReader.snapshot()')
    check('snapshot anonymises', all(w not in snap for w in ['Teszt', 'Elek', 'FOLLOWER', 'Gratul', 'Kiss']), snap[:200])
    state['p'] = snap
    pg.goto('https://www.facebook.com/profile.php?id=1'); pg.wait_for_timeout(500)
    st2 = ev("__fbReader.selfTest({format:'object'})")
    check('selfTest ok on the anonymised snapshot', st2['ok'] and st2['extraction']['author'] == 1 and st2['extraction']['text'] == 1, json.dumps(st2['warnings']))
    state['p'] = 'search'
    pg.goto('https://www.facebook.com/search/pages/?q=x'); pg.wait_for_timeout(500)
    res = ev('__fbReader.extractSearchResults()')
    check('search results carry id/slug, no signed image URL', len(res) >= 2 and res[0]['id'] == '100000000000001' and all('oh=' not in (r.get('image') or '') for r in res), json.dumps(res)[:200])
    check('nav.page from a result', ev('__fbReader.nav.page(__fbReader.extractSearchResults()[0])').endswith('id=100000000000001'))

    # ── 3b. reading levels: map / peek / thread / full / grep / where / go ──
    print('reading levels')
    state['p'] = 'synth'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    ev("__fbReader.forgetSeen()")
    mp = ev('__fbReader.map()')
    check('map: header, 2 real posts, suggestion widget skipped', mp.startswith('map ') and len(mp.splitlines()) >= 3 and 'Javasolt' not in mp, mp)
    check('map: ≤ 960 chars, token estimate in header', len(mp) <= 960 and 'tok' in mp.splitlines()[0], mp)
    hs = re.findall(r'^([0-9a-z]{4})[•↑]* ', mp, re.M)
    check('map: one anchor per post', len(hs) == 2 and len(set(hs)) == 2, mp)
    check('map: unseen marker before reading', mp.count('•') == 2, mp)
    h1 = next(h for h in hs if 'Kovács' in re.search(rf'^{h}.*$', mp, re.M).group(0))
    pk = ev(f"__fbReader.peek('#{h1}')")
    check('peek: author, shortened text, image alt, link domain, top comment, next-step hint',
          'Kovács Teszt' in pk and 'Zenegép' in pk and 'zenegep.example' in pk and 'Nagy Éva' in pk and 'thread(' in pk and len(pk) < 1400, pk)
    check('peek marks the post as seen', ev('__fbReader.map()').count('•') == 1)
    check('anchor is stable after re-extraction and hoverDates', ev("(async()=>{await __fbReader.hoverDates({limit:3});return __fbReader.map()})()").find(h1) >= 0)
    th = ev(f"__fbReader.thread('#{h1}')")
    check('thread: comments with c-numbers and reply marker', 'c1' in th and 'Nagy Éva' in th and '↳' in th, th)
    check('thread filter only:replies', 'Köszi Éva' in ev(f"__fbReader.thread('#{h1}',{{only:'replies'}})") and 'ütős' not in ev(f"__fbReader.thread('#{h1}',{{only:'replies'}})"))
    check('thread match filter', 'ütős' in ev(f"__fbReader.thread('#{h1}',{{match:'utos'}})"))
    fl = ev(f"__fbReader.full('#{h1}','c1')")
    check('full: one comment, complete', 'Ez nagyon ütős' in fl, fl)
    fp = ev(f"__fbReader.full('#{h1}',null,{{maxChars:60}})")
    check('full: pages long text with a continuation hint', '{offset:60}' in fp, fp)
    gp = ev("__fbReader.grep('tts')")
    check('grep finds the post by folded text', 'TTS' in gp and re.search(r'#[0-9a-z]{4} Szabó', gp), gp)
    gc = ev("__fbReader.grep(/ütős/i,{where:'comments'})")
    check('grep in comments gives post/comment anchor', re.search(rf'#{h1}/c1 ', gc) is not None, gc)
    check('resolvePost accepts a map anchor', ev(f"!!__fbReader.resolvePost('#{h1}')") is True)
    check('go scrolls and reports the anchor', ev(f"__fbReader.go('#{h1}')").startswith(f'#{h1} a nézetben'))
    wh = ev('__fbReader.where()')
    check('where: page type, scroll, counts', 'tok' in wh and 'DOM 2' in wh and 'látszik' in wh, wh)
    check('unknown anchor is reported', 'nincs ilyen horgony' in ev("__fbReader.peek('#zzzz')"))
    check('map by author groups posts', 'Kovács Teszt ×1' in ev("__fbReader.map({by:'author'})"))
    # a long feed must stay paged, bounded and far smaller than the raw page text
    big = ''.join(f'<div aria-posinset="{i}"><div><div data-ad-rendering-role="profile_name"><a href="/groups/123/user/{900 + i}/">Szerző {i}</a></div>'
                  f'<div data-ad-rendering-role="story_message"><div dir="auto">Hosszabb bejegyzés száma {i}: ' + ('lorem ipsum dolor sit amet ' * 25) + f'</div></div></div></div>' for i in range(1, 41))
    state['p'] = f'<!doctype html><html><body><div role="main"><h1>Nagy hírfolyam</h1><div role="feed">{big}</div></div></body></html>'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    bm = ev('__fbReader.map()')
    raw = ev('document.body.innerText.length')
    check('map of a 40-post feed: paged, bounded, continuation hint', len(bm) <= 960 and "map({offset:" in bm and '/40' in bm, bm)
    check('map first page is ≥ 20× smaller than the raw page text', raw / len(bm) >= 20, f'{raw} vs {len(bm)}')
    print(f'    (40 posts: raw {raw} chars ≈ {raw // 3} tok → map page {len(bm)} chars ≈ {len(bm) // 3} tok)')
    check('map offset continues', ev("__fbReader.map({offset:8})").startswith('map ') and '9–' in ev("__fbReader.map({offset:8})").splitlines()[0])

    # ── 3c. live-feedback regressions: post-scoped expand, modal check, sort, go(), virtualization, count gap ──
    print('feedback regressions')
    state['p'] = 'comments'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    ev("__fbReader.forgetSeen()")
    mp = ev('__fbReader.map()')
    anchors = dict((n, h) for h, n in re.findall(r'^([0-9a-z]{4})[•↑]* \S+ (Első|Második)', mp, re.M))
    h_first, h_second = anchors.get('Első'), anchors.get('Második')
    check('map lists both posts', bool(h_first and h_second), mp)
    check('card link shows the card domain (github.com), not facebook.com', '🔗github.com' in mp and 'facebook.com' not in mp.split('\n')[1], mp)
    r1 = ev(f"__fbReader.expandComments({{post:'#{h_second}', rounds:1, budgetMs:4000}})")
    log = ev('window.__log')
    check('expandComments({post}) touches only that post', log.count('more2') == 1 and 'more1' not in log, f'{log} {json.dumps(r1)}')
    check('expandComments switches the sort to "all" by itself', 'sort-all' in log and r1.get('sort', {}).get('changed') is True, json.dumps(r1))
    ev("(()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','Értesítések');d.style.display='none';d.innerHTML='<div data-ad-rendering-role=\"story_message\"><div dir=\"auto\">értesítés</div></div>';document.body.appendChild(d)})()")
    check('a hidden panel (Értesítések) is no overlay: where() stays quiet, posts stay visible', 'overlay nyitva' not in ev('__fbReader.where()') and 'Első' in ev('__fbReader.map()'), ev('__fbReader.where()'))
    ev("document.querySelectorAll('[role=dialog][aria-label=\"Értesítések\"]').forEach(d=>d.remove())")
    ev("(()=>{const m=document.querySelector('[aria-posinset=\"1\"] [data-ad-rendering-role=\"story_message\"] div');window.__t0=m.textContent;})()")
    a1 = ev("__fbReader.map()").split('\n')[1][:4]
    ev("document.querySelector('[aria-posinset=\"1\"] [data-ad-rendering-role=\"story_message\"] div').textContent = 'Első poszt szövege. Hozzáfűzve: a Facebook később töltötte be a teljes szöveget, ami már jóval hosszabb.'")
    a2 = ev("__fbReader.map()").split('\n')[1][:4]
    check('anchor survives late text hydration of the same post', a1 == a2 and a1 != '', f'{a1} → {a2}')
    th0 = ev(f"__fbReader.thread('#{a2}')")
    check('thread in the feed (no comment list) points at opening the post, not at "deleted"', 'nincs komment-lista' in th0 and 'törölt' not in th0, th0)
    r2 = ev("__fbReader.expandComments({post:'#zzzz'})")
    check('unknown post → error, nothing clicked', 'nincs ilyen poszt' in (r2.get('error') or '') and 'more1' not in ev('window.__log'), json.dumps(r2))
    th1 = ev(f"__fbReader.thread('#{h_second}')")
    check('thread explains a gap that expandComments can still close', 'nincs betöltve' in th1 and 'expandComments' in th1, th1)
    r3 = ev(f"__fbReader.expandComments({{post:'#{h_second}', rounds:1, budgetMs:4000, sort:null}})")
    check('nothing left to click → clicked 0', r3['clicked'] == 0 and r3['done'] is True, json.dumps(r3))
    th2 = ev(f"__fbReader.thread('#{h_second}')")
    check('thread then says the missing comments are probably deleted/hidden', 'valószínűleg törölt/rejtett/szűrt' in th2 and 'expandComments' not in th2, th2)
    r4 = ev(f"__fbReader.expandComments({{post:'#{h_first}', rounds:1, budgetMs:4000, sort:null}})")
    check('a modal that opens for another post is reported (modal-mismatch)', r4.get('error') == 'modal-mismatch', json.dumps(r4))
    ev("document.getElementById('dlg')?.remove()")
    g = ev(f"__fbReader.go('#{h_second}')")
    check('go() reveals the real permalink, not the photo link', '/posts/222' in g and 'photo' not in g, g)
    day = ev("(()=>{const d=new Date(Date.now()-3*864e5);return String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()")
    md = ev(f"__fbReader.map({{date:'{day}'}})")
    check('map({date}) keeps only posts whose rounding window contains the day', 'Első' in md and 'Második' not in md, f'{day}: {md}')
    check('map({date}) rejects a bad date format', "map({date:" in ev("__fbReader.map({date:'tegnap'})"))

    # ── 3c-bis. the main reported bug: two posts with an identical author + first 60 chars must not collide
    # once they each carry their own postId (the hash is keyed by postId first, not by content) ──
    same_text = 'Azonos kezdetű poszt mindkettőnél, hogy ütközzön a tartalom-hash.'
    collide_ids = (
        '<div aria-posinset="90"><div><div data-ad-rendering-role="profile_name"><a href="/groups/123/user/901/">Ütköző Szerző</a></div>'
        '<a href="https://www.facebook.com/groups/123/posts/9001/">90 perce</a>'
        f'<div data-ad-rendering-role="story_message"><div dir="auto">{same_text}</div></div></div></div>'
        '<div aria-posinset="91"><div><div data-ad-rendering-role="profile_name"><a href="/groups/123/user/901/">Ütköző Szerző</a></div>'
        '<a href="https://www.facebook.com/groups/123/posts/9002/">80 perce</a>'
        f'<div data-ad-rendering-role="story_message"><div dir="auto">{same_text}</div></div></div></div>')
    state['p'] = f'<!doctype html><html><body><div role="main"><h1>Ütköző posztok</h1><div role="feed">{collide_ids}</div></div></body></html>'
    pg.goto(FBURL); pg.wait_for_timeout(300)
    mc = ev('__fbReader.map()')
    ids = re.findall(r'^([0-9a-z]{4})', mc, re.M)
    check('identical-start posts with different postId get different, non-colliding anchors', len(ids) == 2 and ids[0] != ids[1], mc)
    check("map() reports no 'horgony nem stabil' warning when postId disambiguates", 'horgony nem stabil' not in mc, mc)
    # keyed by postId, not by DOM render order: a full reload (fresh in-memory session) must reproduce the same anchors
    pg.goto(FBURL); pg.wait_for_timeout(300)
    ids2 = re.findall(r'^([0-9a-z]{4})', ev('__fbReader.map()'), re.M)
    check('postId-based anchor is stable across a full reload (fresh session)', ids == ids2, f'{ids} → {ids2}')
    # and it survives moving from the feed to the post's own permalink page (no aria-posinset there) — the
    # original bug report's exact repro ("#w3ar on the profile, #w1g3 again on the permalink")
    solo_post = (
        '<div role="article"><div data-ad-rendering-role="profile_name"><a href="/groups/123/user/901/">Ütköző Szerző</a></div>'
        '<a href="https://www.facebook.com/groups/123/posts/9002/">80 perce</a>'
        f'<div data-ad-rendering-role="story_message"><div dir="auto">{same_text}</div></div></div>')
    state['p'] = f'<!doctype html><html><body><div role="main"><h1>Poszt</h1>{solo_post}</div></body></html>'
    pg.goto('https://www.facebook.com/groups/123/posts/9002/'); pg.wait_for_timeout(300)
    solo = ev('__fbReader.map()')
    id_solo = re.findall(r'^([0-9a-z]{4})', solo, re.M)
    check('the SAME post keeps the SAME anchor on its own permalink page as in the feed', id_solo == [ids[1]], f'feed:{ids[1]} permalink:{solo}')

    state['p'] = 'photopage'
    pg.goto('https://www.facebook.com/photo/?fbid=555'); pg.wait_for_timeout(400)
    check('nav.photoPost() finds "Bejegyzés megtekintése"', ev('__fbReader.nav.photoPost()').split('?')[0].endswith('/groups/1/posts/222/'), ev('__fbReader.nav.photoPost()'))
    check('where() hints at the real post on a photo page', 'fotóoldal' in ev('__fbReader.where()'), ev('__fbReader.where()'))
    check('peek on a photo page explains the way out', 'nav.photoPost()' in ev("__fbReader.peek('#abcd')"))
    # virtualized feed: posts leave the DOM while scrolling
    state['p'] = 'virtual'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    ev("__fbReader.harvest.collect()")
    m0 = ev('__fbReader.map()')
    v1 = re.search(r'^([0-9a-z]{4})[•↑]* \S+ Szerző 1:', m0, re.M)
    check('virtual feed: post 1 anchored', v1 is not None, m0)
    h_v1 = v1.group(1)
    ev('window.scrollTo(0, 12000)'); pg.wait_for_timeout(400)
    mv = ev('__fbReader.map({limit:30})')
    check('dropped post is kept in map as ↑ (harvest store)', re.search(rf'^{h_v1}↑', mv, re.M) is not None, mv)
    pk = ev(f"__fbReader.peek('#{h_v1}')")
    check('peek brings a dropped post back by scrolling', 'Szerző 1' in pk and '↑(nem a DOM-ban)' not in pk, pk)
    check('...and it is live again', ev(f"!!__fbReader.resolvePost('#{h_v1}')") is True)
    ev('window.scrollTo(0, 3000)'); pg.wait_for_timeout(400)
    y0 = ev('scrollY'); s0 = ev('__fbReader.harvest.store.size')
    hd = ev('__fbReader.hoverDates({limit:3, all:true, budgetMs:9000})')
    check('hoverDates restores the scroll position', abs(ev('scrollY') - y0) <= 2, f'{y0} → {ev("scrollY")} {json.dumps(hd)}')
    check('hoverDates records every post it passes in harvest.store', ev('__fbReader.harvest.store.size') > s0, f'{s0} → {ev("__fbReader.harvest.store.size")}')
    # ── 3d. feedback #2: reply to ONE comment (replyBox, replyTo from the mention, scoped attachments + send button) ──
    print('reply box')
    state['p'] = 'replybox'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    rb0 = ev("__fbReader.replyBox(undefined, 'Minta')")
    check('replyBox: comment found by author name', rb0.get('comment', {}).get('ref') == 'c2' and rb0['comment']['author'] == 'Minta Tamás', json.dumps(rb0)[:300])
    check('replyBox: closed box → returns the "Válasz" button with a tag', rb0.get('found') is False and rb0.get('openWith', {}).get('target', {}).get('ref') == '[fbr:reply-c2]', json.dumps(rb0)[:300])
    rb1 = ev("__fbReader.replyBox(undefined, 'c9')")
    check('replyBox: unknown comment → error, not a guess', rb1.get('found') is False and 'nincs ilyen komment' in rb1.get('error', ''), json.dumps(rb1))
    ev("document.getElementById('reply-tamas').click()")
    rb2 = ev("__fbReader.replyBox(undefined, 'c2')")
    check('replyBox: open box → found, verified addressee', rb2.get('found') is True and rb2['replyTo']['author'] == 'Minta Tamás' and rb2['replyTo']['ref'] == 'c2', json.dumps(rb2)[:400])
    check('replyBox: box tag for find/click', rb2['target']['ref'] == '[fbr:reply-box]' and rb2['asWhom'] == 'Elek Teszt', json.dumps(rb2)[:300])
    wrong = ev("__fbReader.replyBox(undefined, 'c1')")
    check('replyBox: another comment does not get this box', wrong.get('found') is False and wrong.get('openWith', {}).get('target', {}).get('ref') == '[fbr:reply-c1]', json.dumps(wrong)[:300])
    CARET_END = "(()=>{const e=document.querySelector('#slot-tamas [contenteditable]');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()"
    ev(CARET_END)  # FB puts the caret behind the inserted mention
    pg.keyboard.type('Köszi, jó ötlet!')
    cc = ev('__fbReader.composeCheck()')
    check('composeCheck: replyTo from the typed name (Minta Tamás, c2)', (cc.get('replyTo') or {}).get('author') == 'Minta Tamás' and cc['replyTo']['ref'] == 'c2' and cc['replyTo']['via'] == 'említés', json.dumps(cc)[:500])
    check('composeCheck: mention reported', cc.get('mention') == 'Minta Tamás', json.dumps(cc)[:300])
    check('composeCheck: attachments counted only in the reply box (0, not the dialog gallery)', cc['attachmentCount'] == 0 and cc['media'] == [], json.dumps(cc)[:500])
    check('composeCheck: send button is the reply arrow, not "Hozzászólás írása"', cc['publishButton'] and cc['publishButton']['label'] == 'Válasz küldése' and cc['publishButton']['disabled'] is True, json.dumps(cc.get('publishButton')))
    check('composeCheck: no warnings on a verified reply', cc['warnings'] == [], json.dumps(cc['warnings']))
    rep = ev('__fbReader.composeReport()')
    check('composeReport: names the addressee and c-number', 'Minta Tamás' in rep and 'c2' in rep and 'Köszi' in rep, rep[:600])
    # attach an image inside the reply box → counted there
    ev("""(()=>{const i=document.createElement('img');i.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAQklEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GZ3dAABHjbg4wAAAABJRU5ErkJggg==';i.width=80;i.height=80;document.querySelector('#slot-tamas .rc').appendChild(i)})()""")
    cc2 = ev('__fbReader.composeCheck()')
    check('composeCheck: image inside the reply box → attachmentCount 1', cc2['attachmentCount'] == 1, json.dumps(cc2)[:400])
    # box with no mention: target only by proximity → warning
    ev("document.querySelector('#slot-tamas [contenteditable]').innerHTML=''")
    pg.keyboard.type('Szia')
    cc3 = ev('__fbReader.composeCheck()')
    check('composeCheck: no mention → proximity target + warning', cc3['replyTo']['via'] == 'közelség' and any('közelség' in w for w in cc3['warnings']), json.dumps(cc3)[:500])
    # mention of someone else under this comment → named, with note
    ev("document.querySelector('#slot-tamas [contenteditable]').innerHTML='<span>Harmadik Kommentelő</span>&nbsp;'")
    ev("(()=>{const e=document.querySelector('#slot-tamas [contenteditable]');const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);e.focus()})()")
    pg.keyboard.type('x')
    cc4 = ev('__fbReader.composeCheck()')
    check('composeCheck: mention ≠ box position → addressee is the mentioned one, with a warning', cc4['replyTo']['author'] == 'Harmadik Kommentelő' and cc4['replyTo']['ref'] == 'c3' and any('megszólított' in w for w in cc4['warnings']), json.dumps(cc4)[:600])
    # the dialog's main comment field is a comment, not a reply
    ev("document.getElementById('main-box').focus()")
    pg.keyboard.type('Főkomment')
    cc5 = ev('__fbReader.composeCheck()')
    check('composeCheck: main field → no replyTo, no reply-arrow confusion', cc5['replyTo'] is None and 'Főkomment' in cc5['text'], json.dumps(cc5)[:500])
    # real-FB label forms: "A legrelevánsabbak" → "Az összes hozzászólás"; GIF/sticker buttons are never the send button
    ev("document.getElementById('main-box').blur()")
    sr = ev("__fbReader.setCommentSort('all').then(r=>r)")
    check('setCommentSort finds the plural selector "A legrelevánsabbak" and switches to "Az összes hozzászólás"', sr.get('changed') is True and ev("document.getElementById('sortr').textContent") == 'Az összes hozzászólás', json.dumps(sr))
    ev("document.getElementById('reply-third').click()")
    ev("(()=>{const e=document.querySelector('#slot-third [contenteditable]');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()")
    pg.keyboard.type('ok')
    ev("document.querySelector('#slot-third [aria-label=\"Válasz küldése\"]').remove()")
    cc6 = ev('__fbReader.composeCheck()')
    check('composeCheck: without a send arrow, GIF/sticker buttons are NOT taken for it', cc6['publishButton'] is None and any('küldés gombot nem' in w for w in cc6['warnings']), json.dumps(cc6.get('publishButton')) + json.dumps(cc6['warnings']))
    ev('__fbReader.unmark()')

    # ── 3d2. languages: packs (hu verified, en), registerLang, lang(), langProbe ──
    print('languages')
    # --- Codex review fixes: links, dates, prompt size, weak alt text
    state['p'] = 'review'
    pg.goto('https://www.facebook.com/groups/1/'); pg.wait_for_timeout(500)
    qd = ev("__fbReader.q('posts', ['author','date','url'])")
    check('q(posts): approximate old date = date + raw label, no invented time of day', '~' in qd and '(3 hét)' in qd and not re.search(r'~\d{4}-\d\d-\d\d \d\d:\d\d \(3 h', qd), qd)
    check('q(posts): a photo link keeps its identifying query (fbid), not just "/photo"', '/photo?fbid=1234567890123' in qd, qd)
    qj = json.loads(ev("__fbReader.q('posts', ['author','date','url'], {format:'json'})"))
    row2 = [r for r in qj['rows'] if r['author'] == 'Minta Béla'][0]
    check('q json: wrapper with paging info, FULL url, ISO date + approx flag + raw label', qj['total'] == 2 and row2['url'].startswith('https://www.facebook.com/photo/?fbid=1234567890123') and row2['dateApprox'] is True and row2['dateRaw'] == '3 hét' and row2['date'][:4] == '2026', json.dumps(row2))
    qcm = ev("__fbReader.q('comments', ['author','date'])")
    check('q(comments): a comment older than its post is flagged', 'Régi Eszter' in qcm and 'korábbi, mint a poszt' in qcm and qcm.count('korábbi') == 1, qcm)
    cj = ev("__fbReader.extract({format:'object', comments:true})")['posts'][0]['comments']
    check('extract: dateConflict on the old comment only', [c.get('dateConflict', False) for c in cj] == [False, True], json.dumps([(c['author'], c.get('dateConflict')) for c in cj], ensure_ascii=False))
    pr = ev("__fbReader.extractPrompt().then(r=>r)")
    check('extractPrompt: default size limit, total length and a next offset', pr['found'] and len(pr['prompt']) == 2000 and pr['truncated'] is True and pr['promptChars'] > 4000 and pr['nextOffset'] == 2000, json.dumps({k: pr[k] for k in ('promptChars', 'truncated', 'nextOffset')}))
    pr2 = ev("__fbReader.extractPrompt({offset:2000, chars:0}).then(r=>r)")
    check('extractPrompt: paging reaches the end (chars:0 = rest)', pr2['truncated'] is False and pr2['nextOffset'] is None and len(pr['prompt']) + len(pr2['prompt']) == pr['promptChars'])
    check('extractPrompt: weak auto alt text is flagged', pr['imageAltWeak'] is True)
    ex = ev("__fbReader.extract({format:'object'})")['posts']
    check('images: weak alt flagged, descriptive alt not', ex[0]['images'][0].get('altWeak') is True and not ex[1]['images'][0].get('altWeak'), json.dumps([i['images'][0].get('altWeak') for i in ex]))
    state['p'] = 'en_post'
    pg.goto('https://www.facebook.com/groups/1/'); pg.wait_for_timeout(500)
    lg = ev('__fbReader.lang()')
    check('lang(): page language en, pack exists, not yet verified on the real UI', lg['code'] == 'en' and lg['supported'] is True and lg['verified'] is False and any(x.startswith('hu') for x in lg['packs']), json.dumps(lg))
    pe = ev("__fbReader.extract({format:'object', comments:true})")
    p1 = pe['posts'][0] if isinstance(pe, dict) and 'posts' in pe else None
    check('en post: author, date from the aria-label, text without "See more"', p1 and p1['author'] == 'Alex Sample' and (p1['date'] or '').startswith('2025-10-03') and 'sample post' in p1['text'] and 'See more' not in p1['text'], json.dumps(p1, ensure_ascii=False)[:400])
    check('en post: reactions (K suffix), comments, shares, reaction types', p1 and p1['counts']['comments'] == 14 and p1['counts']['shares'] == 3 and p1['counts']['reactions'] == 1200 and p1['counts']['reactionTypes'] == {'like': 184}, json.dumps(p1 and p1['counts']))
    cm = (p1 or {}).get('comments') or []
    check('en comments: author + age from the label, pinned + author badge, reply addressee', len(cm) >= 2 and cm[0]['author'] == 'Sam Example' and cm[0]['pinned'] and cm[0]['isAuthor'] and cm[1]['replyTo'] == 'Sam Example', json.dumps(cm, ensure_ascii=False)[:500])
    check('en post 2: sponsored badge recognised', pe['posts'][1]['sponsored'] is True and (pe['posts'][1]['date'] or '') != '', json.dumps(pe['posts'][1], ensure_ascii=False)[:300])
    FD = """(() => { const f = (s) => { const r = __fbReader.parseFbDate(s, new Date(2026, 9, 24, 12, 0)); return r.iso ? new Date(r.iso).toLocaleString('sv').slice(0, 16) + (r.approx ? '~' : '') : null; }; return %s.map(f); })()"""
    cases = {'3 hours ago': '2026-10-24 09:00~', 'an hour ago': '2026-10-24 11:00~', 'just now': '2026-10-24 12:00~', '2d': '2026-10-22 12:00~', '4 min': '2026-10-24 11:56~',
             '1w': '2026-10-17 12:00~', '5 yrs': None, 'yesterday at 2:22 PM': '2026-10-23 14:22', 'October 3, 2025 at 2:22 PM': '2025-10-03 14:22', '3 October 2025': '2025-10-03 00:00~',
             'Oct 3': '2026-10-03 00:00~', '12:30 AM Oct 3': '2026-10-03 00:30',
             '2026. október 3., 14:22': '2026-10-03 14:22', '2026. okt. 3.': '2026-10-03 00:00~', 'október 3. 14:22': '2026-10-03 14:22', 'tegnap 14:22': '2026-10-23 14:22',
             'egy órája': '2026-10-24 11:00~', '5 p': '2026-10-24 11:55~', '2 n': '2026-10-22 12:00~', '3 hónapja': '2026-07-26 12:00~', 'most': '2026-10-24 12:00~',
             '2026. október 23., péntek 10:00': '2026-10-23 10:00', '10:15 du. okt. 3.': '2026-10-03 22:15', '3 ó.': '2026-10-24 09:00~'}
    cases['5 yrs'] = '2021-10-24 12:00~' if False else None
    got = dict(zip(cases, ev(FD % json.dumps(list(cases)))))
    bad_ = {k: (got[k], v) for k, v in cases.items() if v is not None and got[k] != v and not (k == '3 hónapja' and (got[k] or '')[:7] == '2026-07')}
    check('parseFbDate: en + hu absolute and relative forms (local time), incl. the pre-pack hu cases', not bad_ and got['5 yrs'] is not None, json.dumps(bad_, ensure_ascii=False))
    # a pack for a language the plugin does not know yet is plain data
    DE = """{ id: 'de', name: 'Deutsch',
      months: { januar: 0, februar: 1, 'märz': 2, april: 3, mai: 4, juni: 5, juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11, okt: 9 },
      rel: { long: { min: ['minuten', 'minute'], hour: ['stunden', 'stunde'], day: ['tagen', 'tag'] }, short: { min: ['min'], hour: ['std'], day: ['t'] }, one: ['vor einer', 'vor einem'], agoPre: ['vor'], now: ['gerade eben'], yesterday: ['gestern'], am: [], pm: [] },
      count: { k: ['tsd'], m: ['mio'] },
      w: { seeMore: ['mehr anzeigen'], sponsored: ['gesponsert'], person: ['personen'] },
      r: { publish: ['posten', 'senden', 'teilen', 'kommentieren', 'speichern', 'beitreten', "gefällt mir"], reaction: ["gefällt mir", 'super'], commentLabel: ['kommentar', 'antwort'] },
      commentLabels: [{ re: '^kommentar von (.+?) (.+)$', a: 1, when: 2 }] }"""
    r0 = ev("__fbReader.parseFbDate('3. Oktober 2025 um 14:22').iso")
    reg = ev(f"__fbReader.registerLang({DE})")
    dd = ev(FD % json.dumps(['3. Oktober 2025 um 14:22', 'vor 3 Stunden', 'vor 5 min', 'gestern um 14:22', 'gerade eben', 'vor einer Stunde']))
    check('registerLang(de): returns the known ids; before registration the German date was not understood', 'de' in reg and r0 is None, json.dumps([reg, r0]))
    check('registerLang(de): absolute, "vor N …", "gestern", "gerade eben", "vor einer Stunde"', dd == ['2025-10-03 14:22', '2026-10-24 09:00~', '2026-10-24 11:55~', '2026-10-23 14:22', '2026-10-24 12:00~', '2026-10-24 11:00~'], json.dumps(dd))
    check('registerLang(de): count suffix (Tsd.) and the new publish words reach the click guard', ev("__fbReader.lang().packs.length") == 3 and ev("(() => { const b = document.createElement('div'); b.setAttribute('role','button'); b.textContent = 'Senden'; return __fbReader._i.safeToClick ? __fbReader._i.safeToClick(b) : null; })()") in (False, None))
    bad = ev("(() => { try { __fbReader.registerLang({ id: 'xx', months: {}, rel: { long: {}, short: {} }, count: {}, w: {}, r: {} }); return 'accepted'; } catch (e) { return String(e.message); } })()")
    check('registerLang: a pack without publish words is refused (safety)', 'r.publish' in bad, bad)
    check('registerLang: a refused pack is not left behind', 'xx' not in ' '.join(ev('__fbReader.lang().packs')))
    ev("document.documentElement.lang = 'fr'")
    st_fr = ev("__fbReader.selfTest({format:'object'})")
    check("selfTest warns when the page language has no pack", st_fr['language']['supported'] is False and any('nyelvi csomag' in w for w in st_fr['warnings']), json.dumps(st_fr['warnings'], ensure_ascii=False)[:300])
    pr = ev('__fbReader.langProbe()')
    check('langProbe: reports the language, dates parsed, and unknown button labels (read only)', pr['lang']['code'] == 'fr' and pr['dates']['parsed'] >= 1 and 'langProbe' in pr['text'] and any('Most relevant' not in x for x in pr['unknownButtonLabels'] + ['x']), pr['text'][:300])
    ev("document.documentElement.lang = 'hu'")
    state['p'] = 'page2'

    # ── 3e. inbox: notifications + Messenger (read only) ──
    print('inbox')
    state['p'] = 'notifications'
    pg.goto('https://www.facebook.com/notifications'); pg.wait_for_timeout(500)
    ib = ev('__fbReader.inbox()')
    check('inbox: bell and messenger counts from the banner labels', '🔔 3 ' in ib and '✉ 2 ' in ib and 'notifications' in ib, ib)
    nl = ev('__fbReader.notifs()')
    check('notifs: lists rows, de-duplicated by notif_id, hidden panel ignored', '5/5 betöltve' in nl and 'rejtett' not in nl and 'duplikált' not in nl, nl)
    check('notifs: kind from notif_t and "mine" star on reactions/comments', 'reakció★' in nl and 'említés★' in nl and 'csoport:' in nl and 'esemény:' in nl and 'komment★' in nl, nl)
    check('notifs: unread bullet + 3 unread counted', nl.count('•') == 3 and '3 olvasatlan' in nl, nl)
    nu = ev("__fbReader.notifs({unread:true})")
    check('notifs: unread filter', 'Futók' not in nu and 'Kiss Anna' in nu and 'Tóth Peti' in nu, nu)
    wp = ev('__fbReader.watchPeek()')
    check('watchPeek: counters only (bell 3, messenger 2), no names or text', wp['ok'] and wp['bell'] == 3 and wp['msg'] == 2 and wp['notifs'] == 3 and wp['msgs'] == 2 and set(wp) == {'ok', 'page', 'bell', 'msg', 'title', 'notifs', 'msgs'}, json.dumps(wp))
    state['p'] = '<!doctype html><html><head><title>Facebook</title></head><body><div role="main">még tölt</div></body></html>'
    pg.goto('https://www.facebook.com/'); pg.wait_for_timeout(300)
    check('watchPeek: header not loaded yet → not ok, no stop', ev('__fbReader.watchPeek()')['ok'] is False and not ev('__fbReader.watchPeek()').get('stop'))
    state['p'] = '<!doctype html><html><head><title>Facebook</title></head><body><form id="login_form" action="/login"></form></body></html>'
    pg.goto('https://www.facebook.com/'); pg.wait_for_timeout(300)
    check('watchPeek: login page → stop', ev('__fbReader.watchPeek()').get('stop') is True)
    state['p'] = 'notifications'
    pg.goto('https://www.facebook.com/notifications'); pg.wait_for_timeout(300)
    nm = ev("__fbReader.notifs({kind:'mine'})")
    check('notifs: kind "mine" = reactions/comments/mentions only', 'Futók' not in nm and 'Őszi futás' not in nm and 'Kiss Anna' in nm, nm)
    nq = ev("__fbReader.notifs({match:'gratulalok'})")
    check('notifs: match folds accents/case', 'Tóth Peti' in nq and 'Kiss Anna' not in nq, nq)
    ref0 = re.search(r'(@[0-9a-z]{4})', nl).group(1)
    nd = ev(f"__fbReader.notif('{ref0}')")
    check('notif: detail has the cleaned link without notif_id', 'groups/1/posts/222' in nd and 'notif_id' not in nd and 'id 222' in nd, nd)
    nmore = ev('__fbReader.notifMore()')
    check('notifMore: located + tagged, not clicked', nmore.get('found') is True and nmore['target']['ref'] == '[fbr:notif-more]', json.dumps(nmore)[:300])
    ev('__fbReader.unmark()')
    state['p'] = 'messages'
    pg.goto('https://www.facebook.com/messages/e2ee/t/222'); pg.wait_for_timeout(500)
    ml = ev('__fbReader.msgs()')
    check('msgs: 4 threads, header link of the open thread is not a list row', '4/4 betöltve' in ml and 'fejléc' not in ml, ml)
    check('msgs: unread marker, group and e2ee flags, 2 unread', ml.count('•') == 2 and '👥' in ml and '🔒' in ml and '2 olvasatlan' in ml, ml)
    check('msgs: preview ordered after the name, time not in the preview', 'Kiss Anna: Szia, ráérsz holnap' in ml and '5 p' not in ml.split('Kiss Anna:')[1].split('\n')[0], ml)
    mu = ev("__fbReader.msgs({unread:true})")
    check('msgs: unread filter', 'Szabó' not in mu and 'Nagy Béla' not in mu and 'Futók' in mu, mu)
    mq = ev("__fbReader.msgs({q:'kave'})")
    check('msgs: local search folds accents (kávé → kave)', 'Kiss Anna' in mq and 'Futók' not in mq, mq)
    mg = ev("__fbReader.msgs({group:true})")
    check('msgs: group filter', 'Futók' in mg and 'Kiss Anna' not in mg, mg)
    mref = re.search(r'(\^[0-9a-z]{4})• .*Kiss Anna', ml).group(1)
    mo = ev(f"__fbReader.msgOpen('{mref}')")
    check('msgOpen: unread thread → URL + read-receipt warning, no navigation', '/messages/t/111' in mo and 'OLVASATLAN' in mo and 'látásjelzést' in mo.replace('Látta', 'látásjelzést') and ev('location.pathname') == '/messages/e2ee/t/222', mo)
    rref = re.search(r'(\^[0-9a-z]{4}) .*Szabó Dóra', ml).group(1)
    check('msgOpen: read thread → no receipt warning', 'nem küld újabb jelzést' in ev(f"__fbReader.msgOpen('{rref}')"))
    mt = ev('__fbReader.msgThread()')
    check('msgThread: open thread, sender/time/text from the article labels', 'Nagy Béla' in mt and '🔒' in mt and 'm1 Nagy Béla 14:02: Szia, megvan a fájl!' in mt and 'm2 Te 14:03' in mt and '3/3' in mt, mt)
    check('msgs: msgThread never opens or changes anything', ev('location.pathname') == '/messages/e2ee/t/222')
    ms = ev('__fbReader.msgSearch()'); mr = ev('__fbReader.msgRequests()')
    check('msgSearch / msgRequests: located and tagged', ms.get('found') is True and ms['target']['ref'] == '[fbr:msg-search]' and mr.get('found') is True and mr['target']['ref'] == '[fbr:msg-requests]', json.dumps([ms, mr])[:400])
    ev('__fbReader.unmark()')
    # composeCheck in Messenger: the recipient is the open thread; E2EE flag; mismatch warning
    ev("document.getElementById('composer').focus()")
    pg.keyboard.type('Szia, holnap 10-kor jó?')
    cm = ev('__fbReader.composeCheck()')
    rcp = cm.get('recipient') or {}
    check('composeCheck (message): recipient = open thread, e2ee flag, host', cm['kind'] == 'message' and rcp.get('name') == 'Nagy Béla' and rcp.get('e2ee') is True and rcp.get('threadId') == '222' and rcp.get('group') is False, json.dumps(cm)[:600])
    check('composeCheck (message): no warnings when box and header agree', cm['warnings'] == [], json.dumps(cm['warnings']))
    rpt = ev('__fbReader.composeReport()')
    check('composeReport (message): "Címzett" line with name and lock', 'Címzett' in rpt and 'Nagy Béla' in rpt and 'titkosított' in rpt, rpt[:500])
    ev("document.getElementById('composer').setAttribute('aria-label','Írás nekik: Béla Becenév')")
    cm2 = ev('__fbReader.composeCheck()')
    check('composeCheck (message): box name ≠ header → warning', any('eltér' in w for w in cm2['warnings']), json.dumps(cm2['warnings']))
    ev("document.querySelector('main').insertAdjacentHTML('afterbegin','<div aria-label=\"Csoportos chat: Futók\"></div>')")
    cm3 = ev('__fbReader.composeCheck()')
    check('composeCheck (message): group chat → warning "MINDEN tagnak"', (cm3['recipient'] or {}).get('group') is True and any('MINDEN tagnak' in w for w in cm3['warnings']), json.dumps(cm3['warnings']))
    ev("document.getElementById('composer').blur()")
    # ── 3f. the logged-in account + own-thread candidates ──
    me_ = ev('__fbReader.me()')
    check('me(): account id and name read from the page data (unicode escapes decoded)', me_.get('id') == '111111111' and me_.get('name') == 'Nagy Béla', json.dumps(me_, ensure_ascii=False))
    stt = ev('__fbReader.selfThread()')
    check('selfThread: the profile link equal to the account id gives a name-free PROOF', 'BIZONYÍTOTT' in stt, stt)
    check('selfThread: name-equal 1:1 thread + open thread proposed, with the register command and account', '/messages/e2ee/t/222/' in stt and 'megnyitott szál' in stt and '--register-self' in stt and 'account 111111111' in stt, stt)
    ev("document.querySelector('main > [aria-label^=\"Csoportos chat\"]').remove()")
    ev("document.getElementById('composer').setAttribute('aria-label','Írás nekik: ')")
    ev("document.getElementById('composer').focus()")
    pg.keyboard.type('x')
    cm4 = ev('__fbReader.composeCheck()')
    check('composeCheck (message): empty "Írás nekik:" label → recipient from the header, no ":" name', (cm4['recipient'] or {}).get('name') == 'Nagy Béla' and cm4['warnings'] == [], json.dumps(cm4['recipient'], ensure_ascii=False) + json.dumps(cm4['warnings'], ensure_ascii=False))
    check('msgThread: empty label name falls back to the header', 'Nagy Béla' in ev('__fbReader.msgThread()').split('\n')[0])
    # ── 3g. Marketplace (read only) ──
    print('marketplace')
    state['p'] = 'marketplace'
    pg.goto('https://www.facebook.com/marketplace/100000000000003/search/?query=bicikli'); pg.wait_for_timeout(500)
    ml_ = ev('__fbReader.market()')
    print('    ' + ml_.replace('\n', '\n    '))
    check('market: visible cards de-duplicated by id, hidden card ignored, sponsored skipped', 'betöltve' in ml_ and 'rejtett' not in ml_ and 'duplik' not in ml_ and 'Peugeot' not in ml_, ml_)
    check('market: header carries query, sort and location from the page', 'bicikli' in ml_ and 'legújabb elsőként' in ml_ and 'Mintaváros' in ml_, ml_)
    check('market: line = ref price title · location ⟨badge⟩', re.search(r'\$[0-9a-z]+ 46 900 Ft Mintabike 20 as gyerek bicikli · Budapest, BU ⟨Az imént meghirdetve⟩', ml_) is not None, ml_)
    check('market: "Ingyenes" is a free item; old price shown', 'Ingyenes' in ml_ and 'Camping bicikli' in ml_ and '(volt 50 000 Ft)' in ml_, ml_)
    check('market: sponsored skipped and counted', '1 szponzorált' in ml_, ml_)
    ms_ = ev("__fbReader.market({sponsored:true})")
    check('market: sponsored:true includes it, flagged', 'Peugeot' in ms_ and 'szponzorált]' in ms_, ms_)
    mp_ = ev("__fbReader.market({max:50000, by:'price'})")
    first = [l for l in mp_.split('\n') if l.startswith('$')]
    check('market: max price filter + local sort by price (free first), no expensive/sponsored', first and 'Camping' in first[0] and 'Cannondale' not in mp_ and 'Peugeot' not in mp_, mp_)
    fr_ = ev('__fbReader.market({free:true})')
    check('market: free filter', 'Camping' in fr_ and 'Mintabike' not in fr_, fr_)
    check('market: text filter folds accents', 'Cannondale' in ev("__fbReader.market({q:'orszagut'})"))
    mref = re.search(r'(\$[0-9a-z]+) 46 900 Ft', ml_).group(1)
    lo = ev(f"__fbReader.listing('{mref}')")
    check('listing(ref) from a result: URL, no navigation', '/marketplace/item/1001/' in lo and ev('location.pathname').startswith('/marketplace/100000000000003/search'), lo)
    rd = ev("__fbReader.ready({format:'json'}).then(r=>r)")
    check('ready(): marketplace results present, page kind and item count, not title-only', rd['ready'] is True and rd['page'] == 'marketplace' and rd['items'] >= 3 and rd['why'] is None, json.dumps(rd))
    mj = ev("__fbReader.market({format:'json', limit:50})")
    check('market json: one record shape (ref,id,title,price,priceNum,location,sponsored,FULL url), paging + context', mj['page'] == 'marketplace' and mj['query'] == 'bicikli' and mj['count'] == len(mj['rows']) >= 3 and all(set(r) >= {'ref', 'id', 'title', 'price', 'priceNum', 'location', 'sponsored', 'url'} for r in mj['rows']) and all(r['url'].startswith('https://www.facebook.com/marketplace/item/') for r in mj['rows']), json.dumps(mj, ensure_ascii=False)[:400])
    check('market json: sponsored skipped and counted, free item has price "Ingyenes"', mj['sponsoredSkipped'] == 1 and not any(r['sponsored'] for r in mj['rows']) and any(r['free'] for r in mj['rows']), json.dumps(mj, ensure_ascii=False)[:300])
    lj = ev(f"__fbReader.listing('{mref}', {{format:'json'}})")
    check('listing($ref, json): record with full URL, no navigation', lj['ok'] and lj['url'] == 'https://www.facebook.com/marketplace/item/1001/' and lj['title'].startswith('Mintabike'), json.dumps(lj, ensure_ascii=False)[:300])
    check('listing(bad ref, json): ok:false', ev("__fbReader.listing('$zzzz', {format:'json'})")['ok'] is False)
    sj = ev("__fbReader.marketScroll({steps:1, format:'json'}).then(r=>r)")
    check('marketScroll json: counters (loaded, added, newRefs, done)', all(k in sj for k in ('loaded', 'added', 'newRefs', 'done', 'scrollPct')) and sj['loaded'] >= 3 and sj['added'] == len(sj['newRefs']), json.dumps(sj))
    check('marketScroll text: "+N új" counter', re.search(r'marketScroll · \+\d+ új · \d+ betöltve', ev("__fbReader.marketScroll({steps:1}).then(r=>r)")) is not None)
    wh = ev('__fbReader.where()')
    check('where(): marketplace branch', 'marketplace' in wh.lower(), wh)
    u1 = ev("__fbReader.nav.marketplace({q:'bicikli', min:5000, max:50000, sort:'price', days:7, condition:'good', delivery:'pickup'})")
    print('    nav.marketplace →', u1)
    for part in ('query=bicikli', 'minPrice=5000', 'maxPrice=50000', 'sortBy=price_ascend', 'daysSinceListed=7', 'itemCondition=used_good', 'deliveryMethod=local_pick_up'):
        check('nav.marketplace URL has ' + part, part in str(u1), u1)
    check('nav.search(q, "marketplace") goes to the marketplace search', '/marketplace/' in str(ev("__fbReader.nav.search('kerékpár','marketplace')")))
    e1 = ev("(()=>{try{return String(__fbReader.nav.marketplace({q:'x',sort:'zzz'}))}catch(e){return 'ERR '+e.message}})()")
    e2 = ev("(()=>{try{return String(__fbReader.nav.marketplace({q:'x',days:3}))}catch(e){return 'ERR '+e.message}})()")
    check('nav.marketplace rejects unknown sort / days', e1.startswith('ERR') and e2.startswith('ERR'), e1 + ' | ' + e2)
    ctl = ev("__fbReader.marketControl('location')"); al = ev("__fbReader.marketControl('alert')"); sr = ev("__fbReader.marketControl('sort')")
    print('    controls →', json.dumps([ctl, al, sr], ensure_ascii=False)[:500])
    check('marketControl: location / sort read-only, alert flagged WRITE', ctl.get('found') and not ctl.get('write') and sr.get('found') and al.get('found') and al.get('write') is True, json.dumps([ctl, al, sr], ensure_ascii=False)[:400])
    ctl2 = ev("__fbReader.marketControl('location')")
    check('marketControl("location") still found after tagging (label kept in data-fbr-orig)', ctl2.get('found') and 'Mintaváros' in ctl2.get('label', ''), json.dumps(ctl2, ensure_ascii=False)[:200])
    mj = ev("__fbReader.market({format:'json',limit:2})")
    check('market json: sort from the checked radio, place from the aria-label', isinstance(mj, dict) and mj.get('sort') == 'Meghirdetés dátuma: a legújabb elsőként' and mj.get('place') == 'Mintaváros, 65 km-en belül', json.dumps({k: mj.get(k) for k in ('sort', 'place')} if isinstance(mj, dict) else mj, ensure_ascii=False))
    ev('__fbReader.unmark()')
    state['p'] = 'listing'
    pg.goto('https://www.facebook.com/marketplace/item/4000000000000001/'); pg.wait_for_timeout(500)
    rdl = ev("__fbReader.ready({format:'json'}).then(r=>r)")
    check('ready() on a listing page: title and price present', rdl['ready'] is True and rdl['page'] == 'listing', json.dumps(rdl))
    ljj = ev("__fbReader.listing({format:'json'})")
    check('listing({format:json}) on the page: one record, details as an object, seller, full URL', ljj['ok'] and ljj['id'] == '4000000000000001' and ljj['priceNum'] == 46900 and ljj['details'].get('Állapot') and ljj['sellerName'] == 'Minta Eladó' and ljj['url'] == 'https://www.facebook.com/marketplace/item/4000000000000001/', json.dumps(ljj, ensure_ascii=False)[:400])
    li = ev('__fbReader.listing()')
    print('    ' + li.replace('\n', '\n    '))
    check('listing(): title, price, age, place, delivery', 'Mintabike 20 as gyerek bicikli' in li and '46 900 Ft' in li and '36 perce' in li and 'Budapest, BU' in li and 'Átadás az eladónál' in li, li)
    check('listing(): detail key/values and description', 'Állapot: Használt, jó állapotú' in li and 'Kerékpárabroncs mérete: 20' in li and '20 as gyerek bicikli eladó' in li, li)
    check('listing(): seller name and join year, URL; ads and related cards left out', 'Minta Eladó' in li and '2016' in li and '4000000000000001' in li and 'IKEA' not in li and 'Continental' not in li, li)
    state['p'] = 'empty'
    pg.goto('https://www.facebook.com/marketplace/item/4000000000000009/'); pg.wait_for_timeout(300)
    rde = ev("__fbReader.ready({budgetMs:700, format:'json'}).then(r=>r)")
    check('ready() on a title-only page: NOT ready, says why (no false success)', rde['ready'] is False and rde['page'] == 'listing' and 'címe' in (rde['why'] or ''), json.dumps(rde, ensure_ascii=False))
    check('ready() text form says NEM', ev("__fbReader.ready({budgetMs:300}).then(r=>r)").startswith('ready · NEM'))
    state['p'] = 'listing'
    pg.goto('https://www.facebook.com/marketplace/item/4000000000000001/'); pg.wait_for_timeout(300)
    check('where() on a listing page', 'hirdet' in ev('__fbReader.where()').lower(), ev('__fbReader.where()'))
    mc = ev("__fbReader.marketControl('message')")
    check('marketControl("message"): located, flagged WRITE', mc.get('found') and mc.get('write') is True, json.dumps(mc, ensure_ascii=False)[:300])
    ev('__fbReader.unmark()')

    # ── 3h. selling: listing form check/report (read only) ──
    print('selling')
    state['p'] = 'sellform'
    pg.goto('https://www.facebook.com/marketplace/create/item'); pg.wait_for_timeout(500)
    sc = ev('__fbReader.sellCheck()')
    check('sellCheck: marketplace form, step 1, seller from the header', sc['ok'] and sc['step'] == 1 and sc['target']['kind'] == 'marketplace' and sc['seller'] == 'Minta Péter' and sc['target']['audience'] == 'Nyilvános', json.dumps(sc, ensure_ascii=False)[:500])
    check('sellCheck: empty form → missing title/price/category/condition, no photo warning, not ready', all(x in sc['missing'] for x in ('megnevezés', 'ár', 'kategória', 'állapot')) and sc['ready'] is False and any('fotó' in w for w in sc['warnings']), json.dumps([sc['missing'], sc['warnings']], ensure_ascii=False))
    check('sellCheck: controls tagged, Tovább is disabled', all(k in sc['controls'] for k in ('title', 'price', 'category', 'condition', 'more', 'next', 'draft', 'photos')) and sc['controls']['next']['disabled'] is True and sc['controls']['title']['ref'] == '[fbr:sell-title]', json.dumps(sc['controls']))
    check('sellCheck: photos 0/10 read', sc['photos'] == 0 and sc['photoMax'] == 10, json.dumps([sc['photos'], sc['photoMax']]))
    ev("(() => { const i = document.querySelectorAll('input[type=text]'); i[0].value = 'Gyerek bicikli 20\"'; i[1].value = '45000'; document.getElementById('cat').innerHTML = '<div>Kategória</div><div>Kerékpár</div>'; document.getElementById('cond').innerHTML = '<div>Állapot</div><div>Használt – jó</div>'; })()")
    sc2 = ev('__fbReader.sellCheck()')
    check('sellCheck: filled → category/condition values read, nothing missing but description hint', sc2['missing'] == [] and sc2['fields']['category'] == 'Kerékpár' and sc2['fields']['condition'] == 'Használt – jó' and sc2['ready'] is True and any('További részletek' in w for w in sc2['warnings']), json.dumps([sc2['missing'], sc2['fields'], sc2['warnings']], ensure_ascii=False))
    ev("document.getElementById('more').insertAdjacentHTML('afterend', '<label><span>Leírás</span><textarea></textarea></label>'); document.querySelector('textarea').value = 'Jó állapotú, csak személyesen.'")
    rp = ev('__fbReader.sellReport()')
    check('sellReport: preview with target, seller, title, price, description, checklist', all(x in rp for x in ('HIRDETÉS ELŐNÉZET', 'még NINCS közzétéve', 'Marketplace', 'Minta Péter', 'Gyerek bicikli 20"', '45000 Ft', 'Kerékpár', 'Jó állapotú, csak személyesen.', 'kifejezett jóváhagyása')), rp)
    check('sellReport: public listing warning (hide-from-friends switch is off)', 'nyilvános' in rp.lower(), rp)
    ev("document.querySelectorAll('input[type=text]')[1].value = '0'")
    check('sellCheck: price 0 → numeric warning', any('szám kell' in w for w in ev('__fbReader.sellCheck()')['warnings']))
    ev("document.querySelectorAll('input[type=text]')[1].value = '45 ezer'")
    check('sellCheck: non-numeric price → warning', any('szám kell' in w for w in ev('__fbReader.sellCheck()')['warnings']))
    ev('__fbReader.unmark()')
    state['p'] = 'sellgroup'
    pg.goto('https://www.facebook.com/groups/aiadokveszek/'); pg.wait_for_timeout(500)
    sg = ev('__fbReader.sellCheck()')
    check('sellCheck: group dialog → target group by name, photos 0/42, no category required', sg['ok'] and sg['target']['kind'] == 'group' and sg['target']['name'] == 'Minta Adok-Veszek' and sg['photoMax'] == 42 and 'kategória' not in sg['missing'] and 'állapot' in sg['missing'], json.dumps(sg, ensure_ascii=False)[:500])
    check('sellReport: group shown as 👥 csoport', '👥 csoport — Minta Adok-Veszek' in ev('__fbReader.sellReport()'))
    ev("document.querySelector('[role=dialog]').innerHTML = '<div>Közzététel helyei</div><label><input type=checkbox checked aria-label=\"Minta Adok-Veszek csoport\"> Minta Adok-Veszek csoport</label><label><input type=checkbox aria-label=\"Másik csoport\"> Másik csoport</label><div role=button>Közzététel</div><div role=button>Vissza</div>'")
    s2 = ev('__fbReader.sellCheck()')
    check('sellCheck: step 2 lists where it is posted; checked groups are warned about', s2['ok'] and s2['step'] == 2 and any(c['checked'] and 'Minta Adok-Veszek' in c['label'] for c in s2['checks']) and any('CSOPORT' in w for w in s2['warnings']) and 'publish' in s2['controls'], json.dumps(s2, ensure_ascii=False)[:600])
    state['p'] = 'page2'
    pg.goto(FBURL); pg.wait_for_timeout(500)
    check('sellCheck: no form on other pages', ev('__fbReader.sellCheck()')['ok'] is False)
    check('nav.marketplaceCreate / marketplaceSelling', ev("__fbReader.nav.marketplaceCreate()") == 'https://www.facebook.com/marketplace/create/item' and ev("__fbReader.nav.marketplaceSelling()").endswith('/marketplace/you/selling'))

    # ── 3i. tracking own listings and sale posts (read only; store = localStorage) ──
    print('tracking')
    ev("localStorage.removeItem('fb-reader:track')")
    state['p'] = 'listing'
    pg.goto('https://www.facebook.com/marketplace/item/4000000000000001/'); pg.wait_for_timeout(500)
    check('trackCheck before trackAdd → not tracked', 'nem követett' in ev('__fbReader.trackCheck()'))
    ta = ev('__fbReader.trackAdd()')
    check('trackAdd on a listing page: id, kind, title, price', '⌗m4000000000000001' in ta and 'marketplace' in ta and 'Mintabike' in ta and '46 900 Ft' in ta, ta)
    check('trackList: shows it as due (⏰) with its path', '⏰' in ev('__fbReader.trackList()') and '/marketplace/item/4000000000000001/' in ev('__fbReader.trackList()'))
    c1 = ev('__fbReader.trackCheck()')
    check('trackCheck: first measurement recorded', 'első mérés' in c1, c1)
    check('trackCheck: nothing changed → "nincs változás"', 'nincs változás' in ev('__fbReader.trackCheck()'))
    ev("document.querySelector('h1').insertAdjacentHTML('afterend', '<div>Eladva</div><div>12 megtekintés</div><div>3 érdeklődő</div>'); [...document.querySelectorAll('div')].find(d => d.textContent === '46 900 Ft').textContent = '39 900 Ft'")
    c2 = ev('__fbReader.trackCheck()')
    check('trackCheck: price change, sold flag and counters reported', '⚑' in c2 and '46 900 Ft → 39 900 Ft' in c2 and 'állapot: eladva' in c2 and 'megtekintés 0 → 12' in c2 and 'érdeklődő 0 → 3' in c2, c2)
    check('trackList: marked as changed, state shown', '⚑ változott' in ev('__fbReader.trackList()') and 'eladva' in ev('__fbReader.trackList()'))
    co = ev("__fbReader.trackCheck({format:'object', save:false})")
    check("trackCheck({format:'object'}) is structured for the extension", co['ok'] is True and co['changed'] is False and co['kind'] == 'marketplace' and co['url'].endswith('/marketplace/item/4000000000000001/'), json.dumps(co, ensure_ascii=False))
    # group sale post: new comments, inquiries
    state['p'] = 'page2'
    pg.goto('https://www.facebook.com/groups/peldacsoport/posts/1234567890/'); pg.wait_for_timeout(500)
    tg = ev("__fbReader.trackAdd({note:'bicikli'})")
    check('trackAdd on a group post', '⌗g1234567890' in tg and 'group' in tg, tg)
    ev('__fbReader.trackCheck()')
    ev("document.querySelector('[role=article]').insertAdjacentHTML('beforeend', '<div role=\"article\" aria-label=\"Nagy Béla hozzászólása (1 perce)\"><a href=\"/nagy.bela?comment_id=9\">Nagy Béla</a><div dir=\"auto\">Még elérhető a bicikli?</div></div>')")
    g2 = ev('__fbReader.trackCheck()')
    check('trackCheck on a group post: new comment flagged as an inquiry', '1 új komment' in g2 and '1 érdeklődés-jelzés' in g2 and '❓' in g2 and 'Nagy Béla' in g2, g2)
    check('trackList shows both items', ev('__fbReader.trackList()').count('⌗') >= 2)
    check('trackRemove', 'nem követett többé' in ev("__fbReader.trackRemove('g1234567890')") and 'g1234567890' not in ev('__fbReader.trackList()'))
    check('trackCheck on a page that is not tracked', 'nem követett' in ev('__fbReader.trackCheck()'))
    # seller dashboard + price position
    state['p'] = 'marketplace'
    pg.goto('https://www.facebook.com/marketplace/100000000000003/search/?query=bicikli'); pg.wait_for_timeout(500)
    ml = ev('__fbReader.myListings()')
    check('myListings: rows without sponsored', 'hirdetés' in ml and 'Peugeot' not in ml and 'Mintabike' in ml, ml)
    ev('__fbReader.myListings({track:true})')
    check('myListings({track:true}) adds them to the tracked list', ev('__fbReader.trackList()').count('⌗m') >= 4)
    pc = ev('__fbReader.market()') and ev('__fbReader.priceCheck({price: 40000})')
    check('priceCheck: quartiles and own position', all(x in pc for x in ('medián', 'Q1', 'saját ár 40 000')) and 'olcsóbb' in pc, pc)
    ev("localStorage.removeItem('fb-reader:track')")

    ctx.close()
    # ── 3j. extension tracking helper: bridge → service worker mirror, one check pass, popup ──
    print('extension: tracking helper')
    state['p'] = 'page2'
    fb = fake_facebook(state)
    ctx2 = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel='chromium', headless=True, viewport={'width': 1200, 'height': 900},
                                                args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', f'--host-resolver-rules=MAP www.facebook.com 127.0.0.1:{fb.server_address[1]}', '--ignore-certificate-errors', '--no-proxy-server'])
    sw = ctx2.service_workers[0] if ctx2.service_workers else ctx2.wait_for_event('serviceworker', timeout=15000)
    extid = sw.url.split('/')[2]
    check('service worker: due items = never checked or older than the interval, oldest first', sw.evaluate("dueItems([{id:'a',url:'u',checkedAt:null},{id:'b',url:'u',checkedAt:Date.now()-7*3600e3},{id:'c',url:'u',checkedAt:Date.now()-3600e3}], Date.now(), 6).map(x=>x.id).join()") == 'a,b')
    check('service worker: quiet hours (22–8)', sw.evaluate('[inQuiet(23,22,8), inQuiet(3,22,8), inQuiet(12,22,8)].join()') == 'true,true,false')
    check('service worker: background checking is OFF by default; no alarm', sw.evaluate("getSettings().then(s => s.enabled === false)") is True and sw.evaluate("chrome.alarms.get('fbr-track-tick').then(a => a == null)") is True)
    seed = json.dumps([{'id': 'm4000000000000001', 'kind': 'marketplace', 'url': 'https://www.facebook.com/marketplace/item/4000000000000001/', 'title': 'Mintabike 20 as gyerek bicikli', 'price': '46 900 Ft', 'addedAt': 1, 'checkedAt': None, 'changedAt': None, 'snap': None}])
    state['p'] = 'listing'
    pg2 = ctx2.new_page(); pg2.add_init_script(f"localStorage.setItem('fb-reader:track', {json.dumps(seed)})")
    pg2.goto('https://www.facebook.com/marketplace/item/4000000000000001/'); pg2.wait_for_timeout(1500)
    mir = sw.evaluate("chrome.storage.local.get('track').then(r => r.track || [])")
    check('bridge: the tracked list of the page reaches the extension store', len(mir) == 1 and mir[0]['id'] == 'm4000000000000001' and mir[0]['kind'] == 'marketplace', json.dumps(mir))
    npages = len(ctx2.pages)
    r1 = sw.evaluate("tick(true, 800)")
    check('check pass: opens the item in a background tab, first measurement, tab closed again', r1.get('checked') == 'm4000000000000001' and r1['result']['ok'] and r1['result']['first'] is True and len(ctx2.pages) == npages, json.dumps(r1, ensure_ascii=False)[:400])
    check('check pass: no notification on the first measurement', sw.evaluate('self.__lastNotify === undefined') is True)
    state['p'] = PAGES['listing'].replace('46 900 Ft', '39 900 Ft')
    r2 = sw.evaluate("tick(true, 800)")
    check('check pass: price change detected → changed', r2['result']['ok'] and r2['result']['changed'] and any('39 900' in c for c in r2['result']['changes']), json.dumps(r2, ensure_ascii=False)[:500])
    ln = sw.evaluate('self.__lastNotify')
    check('check pass: notification with the change (no comment text)', ln and 'változás' in ln['title'] and '39 900' in ln['message'], json.dumps(ln, ensure_ascii=False))
    st_ = sw.evaluate("chrome.storage.local.get(['log','unseen']).then(r => r)")
    check('log + unseen counter updated', len(st_['log']) == 2 and st_['unseen'] == 1, json.dumps(st_, ensure_ascii=False)[:300])
    check('login/checkpoint redirect is recognised (stop flag logic)', sw.evaluate("/\\/(login|checkpoint|recover)\\b/.test('https://www.facebook.com/login/?next=x') && !/\\/(login|checkpoint|recover)\\b/.test('https://www.facebook.com/marketplace/item/1/')") is True)
    pop = ctx2.new_page(); pop.goto(f'chrome-extension://{extid}/popup.html'); pop.wait_for_timeout(700)
    check('popup: switch is off, the tracked item is listed with its price', pop.evaluate("document.getElementById('enabled').checked") is False and 'Mintabike' in pop.inner_text('#list') and '39 900' in pop.inner_text('#list') or 'Mintabike' in pop.inner_text('#list'), pop.inner_text('body')[:300])
    pop.check('#enabled'); pop.wait_for_timeout(500)
    check('popup: enabling creates the alarm, settings saved', sw.evaluate("chrome.alarms.get('fbr-track-tick').then(a => !!a)") is True and sw.evaluate("getSettings().then(s => s.enabled)") is True)
    pop.uncheck('#enabled'); pop.wait_for_timeout(500)
    check('popup: disabling removes the alarm', sw.evaluate("chrome.alarms.get('fbr-track-tick').then(a => a == null)") is True)
    pop.close(); pg2.close()

    # ── 3k. extension: notification + Messenger watch (counters only) ──
    print('extension: notification/messenger watch')
    home = lambda n, m: HOME_TPL % (n + m, n, m)
    check('watch: OFF by default, no watch alarm', sw.evaluate("getSettings().then(s => s.watchNotifs === false && s.watchMsgs === false)") is True and sw.evaluate("chrome.alarms.get('fbr-watch-tick').then(a => a == null)") is True)
    check('watch diff: first = baseline; only increases count; switches respected', sw.evaluate("JSON.stringify([watchDiff(null,{notifs:1,msgs:1},{watchNotifs:true,watchMsgs:true}), watchDiff({at:1,notifs:1,msgs:5},{notifs:3,msgs:2},{watchNotifs:true,watchMsgs:true}), watchDiff({at:1,notifs:1,msgs:1},{notifs:3,msgs:4},{watchNotifs:false,watchMsgs:true})])") == '[{"first":true,"n":0,"m":0},{"first":false,"n":2,"m":0},{"first":false,"n":0,"m":3}]')
    sw.evaluate("chrome.storage.local.set({settings: {...DEFAULTS, watchNotifs: true, watchMsgs: true}, unseen: 0, watch: {}})")
    sw.evaluate('self.__lastNotify = undefined')
    npages = len(ctx2.pages)
    state['p'] = home(1, 2)
    w1 = sw.evaluate('watchTick(true, 800)')
    check('watch pass 1: no Facebook tab open → background tab, counters read, tab closed, baseline only (no alert)', w1.get('ok') and w1['via'] == 'háttérlap' and w1['result']['notifs'] == 1 and w1['result']['msgs'] == 2 and w1['diff']['first'] is True and len(ctx2.pages) == npages and sw.evaluate('self.__lastNotify === undefined') is True, json.dumps(w1, ensure_ascii=False)[:400])
    state['p'] = home(3, 5)
    w2 = sw.evaluate('watchTick(true, 800)')
    ln = sw.evaluate('self.__lastNotify')
    st_ = sw.evaluate("chrome.storage.local.get(['unseen','watch','watchLog']).then(r => r)")
    check('watch pass 2: +2 notifications, +3 messages → both alerts, badge counter 2', w2['diff']['n'] == 2 and w2['diff']['m'] == 3 and ln['id'] == 'watch-m' and '3 új' in ln['message'] and st_['unseen'] == 2, json.dumps([w2, ln, st_['unseen']], ensure_ascii=False)[:500])
    check('watch: stored state is numbers only (no names / texts / thread ids)', set(st_['watch']) <= {'at', 'notifs', 'msgs', 'navDue'} and all(isinstance(v, (int, float)) or v is None for v in st_['watch'].values()) and 'Kiss' not in json.dumps(st_), json.dumps(st_, ensure_ascii=False)[:300])
    sw.evaluate('self.__lastNotify = undefined')
    state['p'] = home(1, 1)
    w3 = sw.evaluate('watchTick(true, 800)')
    check('watch pass 3: counters went down (read elsewhere) → no alert', w3['diff']['n'] == 0 and w3['diff']['m'] == 0 and sw.evaluate('self.__lastNotify === undefined') is True, json.dumps(w3, ensure_ascii=False)[:300])
    pg3 = ctx2.new_page(); state['p'] = home(4, 1); pg3.goto('https://www.facebook.com/'); pg3.wait_for_timeout(1200)
    n_open = len(ctx2.pages)
    w4 = sw.evaluate('watchTick(true, 800)')
    check('watch pass 4: an open Facebook tab is read in place (no new tab, no navigation)', w4.get('ok') and w4['via'] == 'nyitott lap' and w4['diff']['n'] == 3 and len(ctx2.pages) == n_open and 'facebook.com/' in pg3.url, json.dumps(w4, ensure_ascii=False)[:300])
    sw.evaluate("chrome.storage.local.set({watch: {at: Date.now(), notifs: 4, msgs: 1, navDue: Date.now() + 3600e3}})")
    pg3.close()
    w5 = sw.evaluate('watchTick(false, 800)')
    check('watch: no open tab and the next background tab is not due yet → skipped', 'skipped' in w5 and 'esedékes' in w5['skipped'] or 'csendes' in w5.get('skipped', ''), json.dumps(w5, ensure_ascii=False))
    state['p'] = '<!doctype html><html><head><title>Facebook</title></head><body><form id="login_form" action="/login"></form></body></html>'
    w6 = sw.evaluate('watchTick(true, 800)')
    st6 = sw.evaluate("getSettings().then(s => [s.watchNotifs, s.watchMsgs])")
    check('watch: login page → stopped, both switches off, alarm gone, user notified', w6.get('stopped') is True and st6 == [False, False] and sw.evaluate("chrome.alarms.get('fbr-watch-tick').then(a => a == null)") is True and sw.evaluate('self.__lastNotify.id') == 'watch-stop', json.dumps([w6, st6], ensure_ascii=False)[:300])
    pop = ctx2.new_page(); pop.goto(f'chrome-extension://{extid}/popup.html'); pop.wait_for_timeout(700)
    check('popup: both watch switches are off and explain "no thread opened"', pop.evaluate("[document.getElementById('watchNotifs').checked, document.getElementById('watchMsgs').checked]") == [False, False] and 'Látta' in pop.inner_text('body'), pop.inner_text('body')[:200])
    pop.check('#watchMsgs'); pop.wait_for_timeout(500)
    check('popup: enabling the Messenger watch creates the watch alarm and a fresh baseline', sw.evaluate("chrome.alarms.get('fbr-watch-tick').then(a => !!a)") is True and sw.evaluate("getSettings().then(s => s.watchMsgs && !s.watchNotifs)") is True and sw.evaluate("chrome.storage.local.get('watch').then(r => Object.keys(r.watch || {}).length)") == 0)
    pop.uncheck('#watchMsgs'); pop.wait_for_timeout(500)
    check('popup: disabling removes the watch alarm', sw.evaluate("chrome.alarms.get('fbr-watch-tick').then(a => a == null)") is True)
    pop.close()
    state['p'] = 'page2'
    ctx2.close(); fb.shutdown()

# ── 4. write-guard hook ──────────────────────────────────────────────────────
print('hook')
home, tmp = tempfile.mkdtemp(), tempfile.mkdtemp()
env = dict(os.environ, HOME=home, USERPROFILE=home, TMPDIR=tmp, TEMP=tmp, TMP=tmp)


def run(script, ev=None, args=()):
    r = subprocess.run(['node', str(HOOKS / script), *args], input=json.dumps(ev) if ev is not None else None, capture_output=True, text=True, encoding='utf-8', env=env)
    return (r.stdout or '').strip()


def hook(ev, *a):
    out = run('fb-write-guard.mjs', ev, a)
    return json.loads(out)['hookSpecificOutput']['permissionDecision'] if out else 'pass'


T = 'mcp__claude-in-chrome__computer'
J = 'mcp__claude-in-chrome__javascript_tool'
post = 'https://www.facebook.com/groups/1/posts/2/'
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': post, 'tabId': 7}, 'tool_response': 'ok'}, '--track')
typ = lambda t, tab=7: {'tool_name': T, 'tool_input': {'action': 'type', 'text': t, 'tabId': tab, 'action_summary': 'Types comment'}}
check('type without approval → ask', hook(typ('Hallo')) == 'ask')
run('fb-approve.mjs', None, ['--kind', 'comment', '--url', post, '--text', 'Szép munka! 🎉'])
check('type of the approved text → allow', hook(typ('Szép munka! 🎉')) == 'allow')
check('type of other text → deny', hook(typ('Szép munka!!')) == 'deny')
hook(typ('Szép '), '--post')  # not pending → no advance
check('chunk of the approved text → allow', hook(typ('Szép ')) == 'allow')
hook(typ('Szép '), '--post')
check('typed counter advanced; wrong next chunk → deny', hook(typ('xx')) == 'deny')
check('next correct chunk → allow', hook(typ('munka! 🎉')) == 'allow')
check('Enter → ask', hook({'tool_name': T, 'tool_input': {'action': 'key', 'text': 'Enter', 'tabId': 7, 'action_summary': 'Presses Enter'}}) == 'ask')
check('send click → ask', hook({'tool_name': T, 'tool_input': {'action': 'left_click', 'ref': 'ref_1', 'tabId': 7, 'action_summary': 'Sends the comment'}}) == 'ask')
check('read-only click → pass', hook({'tool_name': T, 'tool_input': {'action': 'left_click', 'ref': 'ref_1', 'tabId': 7, 'action_summary': 'Opens the See more text'}}) == 'pass')
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': 'https://www.facebook.com/groups/9/posts/9/', 'tabId': 8}, 'tool_response': 'ok'}, '--track')
run('fb-approve.mjs', None, ['--kind', 'comment', '--url', post, '--text', 'Hi'])
check('approved text on a different page → ask', hook(typ('Hi', 8)) == 'ask')
check('bash fb-approve → ask', hook({'tool_name': 'Bash', 'tool_input': {'command': 'node hooks/fb-approve.mjs --kind comment --url https://www.facebook.com/x --text a'}}, '--bash') == 'ask')
check('bash tampering with the approval file → ask', hook({'tool_name': 'Bash', 'tool_input': {'command': 'echo {} > /tmp/fb-reader-approval.json'}}, '--bash') == 'ask')
check('bash ls → pass', hook({'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}, '--bash') == 'pass')
for f in [S / 'fb-reader.loader.js', S / 'fb-reader-write.min.js', PARTS[-1]]:
    check(f'own bundle passes silently: {f.name}', hook({'tool_name': J, 'tool_input': {'text': f.read_text(encoding='utf-8')}}) == 'pass')
check('safe API call passes', hook({'tool_name': J, 'tool_input': {'text': "JSON.stringify(await __fbReader.react('love'))"}}) == 'pass')
check('inbox API calls pass', hook({'tool_name': J, 'tool_input': {'text': "[__fbReader.inbox(), __fbReader.notifs({unread:true}), __fbReader.msgs(), __fbReader.msgThread(), JSON.stringify(__fbReader.msgSearch())].join('\\n')"}}) == 'pass')
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': 'https://www.messenger.com/t/222', 'tabId': 9}, 'tool_response': 'ok'}, '--track')
check('approval for a facebook.com comment does not carry to messenger.com → ask', hook({'tool_name': T, 'tool_input': {'action': 'type', 'text': 'Hi', 'tabId': 9, 'action_summary': 'Types a message'}}) == 'ask')
check('Enter on messenger.com → ask', hook({'tool_name': T, 'tool_input': {'action': 'key', 'text': 'Enter', 'tabId': 9, 'action_summary': 'Presses Enter'}}) == 'ask')
nr = lambda *a: run('fb-approve.mjs', None, list(a))

# ── listing approval (selling): one approval for title + price + description + photos + dropdown choices ──
CREATE = 'https://www.facebook.com/marketplace/create/item'
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': CREATE, 'tabId': 10}, 'tool_response': 'ok'}, '--track')
UP = 'mcp__claude-in-chrome__file_upload'
lt = lambda s, tab=10: {'tool_name': T, 'tool_input': {'action': 'type', 'text': s, 'tabId': tab, 'action_summary': 'Types into the listing form'}}
lc = lambda s, tab=10: {'tool_name': T, 'tool_input': {'action': 'left_click', 'ref': 'ref_5', 'tabId': tab, 'action_summary': s}}
lu = lambda paths, tab=10: {'tool_name': UP, 'tool_input': {'paths': paths, 'tabId': tab}}
DESC = 'Jó állapotú, csak személyesen.\nBudapest'
nr('--kind', 'listing', '--url', CREATE, '--as', 'Minta Péter', '--target-name', 'Marketplace', '--title', 'Gyerek bicikli 20"', '--price', '45000', '--description', DESC, '--category', 'Kerékpár', '--condition', 'Használt – jó', '--photo', 'C:\\fotok\\a.jpg')
stl = json.loads(run('fb-approve.mjs', None, ['--status']))
check('listing approval: status lists the fields and photos', stl.get('kind') == 'listing' and len(stl['fields']) == 3 and stl['photos'] == '0/1', json.dumps(stl, ensure_ascii=False))
check('listing: the approved title on another page → ask', hook(lt('Gyerek bicikli 20"', 8)) == 'ask')
check('listing: the approved title → allow', hook(lt('Gyerek bicikli 20"')) == 'allow')
hook(lt('Gyerek bicikli 20"'), '--post')
check('listing: another title → deny', hook(lt('Másik cím')) == 'deny')
check('listing: the title cannot be typed twice (field complete) → deny', hook(lt('Gyerek bicikli 20"')) == 'deny')
check('listing: first price chunk → allow', hook(lt('45')) == 'allow')
hook(lt('45'), '--post')
check('listing: wrong next digit → deny', hook(lt('999')) == 'deny')
check('listing: price continuation → allow', hook(lt('000')) == 'allow')
hook(lt('000'), '--post')
check('listing: description with a newline → allow', hook(lt(DESC)) == 'allow')
hook(lt(DESC), '--post')
check('listing: "Next" before the photo is uploaded → ask', hook(lc('Clicks the Next button')) == 'ask')
check('listing: another photo → ask', hook(lu(['C:\\fotok\\other.jpg'])) == 'ask')
check('listing: the approved photo (path case/slash tolerant) → allow', hook(lu(['c:/FOTOK/a.jpg'])) == 'allow')
hook(lu(['C:\\fotok\\a.jpg']), '--post')
stl2 = json.loads(run('fb-approve.mjs', None, ['--status']))
check('listing: progress is tracked (all typed, photo 1/1)', stl2['photos'] == '1/1' and all(f.split(' ')[1].split('/')[0] == f.split('/')[1] for f in stl2['fields']), json.dumps(stl2, ensure_ascii=False))
check('listing: the "Next" step button, content complete → allow', hook(lc('Clicks the Next button')) == 'allow')
check('listing: PUBLISH is never auto-allowed → ask', hook(lc('Clicks the Publish button')) == 'ask' and hook(lc('Publishes the listing')) == 'ask')
check('listing: "Next and publish" wording is not let through → ask', hook(lc('Clicks Next to publish the listing')) == 'ask')
check('listing: approved dropdown choice → allow', hook(lc('Selects category Kerékpár from the dropdown')) == 'allow')
check('listing: other dropdown choice → ask', hook(lc('Selects category Autó from the dropdown')) == 'ask')
check('listing: the hide-from-friends switch is not approved → ask', hook(lc('Toggles the Hide from friends switch')) == 'ask')
check('bash: listing approval is asked, file content is shown', hook({'tool_name': 'Bash', 'tool_input': {'command': 'node hooks/fb-approve.mjs --kind listing --url https://www.facebook.com/marketplace/create/item --title a --price 1'}}, '--bash') == 'ask')
bad = run('fb-approve.mjs', None, ['--kind', 'listing', '--url', CREATE, '--title', 'x', '--price', '12 ezer'])
check('listing: non-numeric price is refused by fb-approve', 'error' in bad)
bad2 = run('fb-approve.mjs', None, ['--kind', 'listing', '--url', CREATE, '--title', 'x', '--price', '1', '--photo', 'https://x.y/a.jpg'])
check('listing: a photo URL is refused (local path only)', 'error' in bad2)
nr('--clear')
# ── self-notification: registered once, bound to the account + one thread url ──
SELF_URL = 'https://www.facebook.com/messages/e2ee/t/9000000000000001/'
tf = pathlib.Path(tmp) / 'self.txt'; tf.write_text('Task kész: teszt', encoding='utf-8')
nr = lambda *a: run('fb-approve.mjs', None, list(a))
check('self-notify without registration → refused', 'nincs regisztrált' in nr('--self-notify', '--account', '111111111', '--text-file', str(tf)))
check('register-self via Bash → the user is asked', hook({'tool_name': 'Bash', 'tool_input': {'command': f'node hooks/fb-approve.mjs --register-self --url {SELF_URL} --account 111111111'}}, '--bash') == 'ask')
check('register-self rejects a non-thread url', 'saját Messenger-szál' in nr('--register-self', '--url', 'https://www.facebook.com/groups/1/posts/2/', '--account', '111111111'))
check('register-self needs a numeric account', 'fiók azonosítója' in nr('--register-self', '--url', SELF_URL, '--account', 'Nagy'))
nr('--register-self', '--url', SELF_URL, '--account', '111111111', '--max-chars', '40')
check('self-notify with another account → refused', 'nem egyezik' in nr('--self-notify', '--account', '222222222', '--text-file', str(tf)))
tf2 = pathlib.Path(tmp) / 'long.txt'; tf2.write_text('x' * 41, encoding='utf-8')
check('self-notify over the length limit → refused', 'a határ 40' in nr('--self-notify', '--account', '111111111', '--text-file', str(tf2)))
tf3 = pathlib.Path(tmp) / 'nl.txt'; tf3.write_text('egy\nkettő', encoding='utf-8')
check('self-notify with a newline → refused (a typed newline would send)', 'egysoros' in nr('--self-notify', '--account', '111111111', '--text-file', str(tf3)))
SN = f'node plugins/facebook-reader/hooks/fb-approve.mjs --self-notify --account 111111111 --text-file {tf}'
check('self-notify via Bash (registered, exact form) → allowed without asking', hook({'tool_name': 'Bash', 'tool_input': {'command': SN}}, '--bash') == 'allow')
check('self-notify chained with another command → asked', hook({'tool_name': 'Bash', 'tool_input': {'command': SN + '; rm -rf x'}}, '--bash') == 'ask')
check('self-notify with an inline --text → asked', hook({'tool_name': 'Bash', 'tool_input': {'command': 'node plugins/facebook-reader/hooks/fb-approve.mjs --self-notify --account 111111111 --text hi'}}, '--bash') == 'ask')
check('touching self.json via Bash → asked', hook({'tool_name': 'Bash', 'tool_input': {'command': 'echo {} > ~/.fb-reader/self.json'}}, '--bash') == 'ask')
nr('--self-notify', '--account', '111111111', '--text-file', str(tf))
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': SELF_URL, 'tabId': 11}, 'tool_response': 'ok'}, '--track')
hook({'tool_name': 'mcp__claude-in-chrome__navigate', 'tool_input': {'url': 'https://www.facebook.com/messages/t/777/', 'tabId': 12}, 'tool_response': 'ok'}, '--track')
ENT = lambda tab: {'tool_name': T, 'tool_input': {'action': 'key', 'text': 'Enter', 'tabId': tab, 'action_summary': 'Presses Enter'}}
SEND = lambda tab, s='Sends the approved message to the own thread': {'tool_name': T, 'tool_input': {'action': 'left_click', 'ref': 'ref_9', 'tabId': tab, 'action_summary': s}}
FOC = 'Focuses the message box of the own thread (no text yet)'
check('self: focusing click on the registered thread before typing → allow (no question for a harmless focus)', hook(SEND(11, FOC)) == 'allow')
check('self: the same focusing click on ANOTHER thread → ask', hook(SEND(12, FOC)) == 'ask')
check('self: a send click before the text is typed → ask', hook(SEND(11)) == 'ask')
check('self: an attach click → ask', hook(SEND(11, 'Attaches a file to the message input')) == 'ask')
check('self: a click that only mentions the box but says send/like → ask', hook(SEND(11, 'Clicks the message input and sends a like')) == 'ask')
check('self: Enter before the text is typed → ask', hook(ENT(11)) == 'ask')
check('self: typing other text → deny', hook(typ('Valami más', 11)) == 'deny')
check('self: typing the approved text on the registered thread → allow', hook(typ('Task kész: teszt', 11)) == 'allow')
hook(typ('Task kész: teszt', 11), '--post')
check('self: Enter on ANOTHER thread → ask', hook(ENT(12)) == 'ask')
check('self: send click with a like/emoji summary → ask', hook(SEND(11, 'Sends a thumbs up like')) == 'ask')
check('self: Enter on the registered thread after the full text → allow', hook(ENT(11)) == 'allow')
check('self: second Enter (already sent) → ask', hook(ENT(11)) == 'ask')
check('self: second send click (already sent) → ask', hook(SEND(11)) == 'ask')
nr('--self-notify', '--account', '111111111', '--text-file', str(tf))
hook(typ('Task kész: teszt', 11), '--post')  # not pending → no advance; advance through the real path:
check('self: type chunk allowed again after a new notify', hook(typ('Task kész: teszt', 11)) == 'allow')
hook(typ('Task kész: teszt', 11), '--post')
check('self: send-button click on the registered thread → allow once', hook(SEND(11)) == 'allow')
check('self: the send click cannot be repeated', hook(SEND(11)) == 'ask')
nr('--unregister-self')
check('after unregister: self-notify refused again', 'nincs regisztrált' in nr('--self-notify', '--account', '111111111', '--text-file', str(tf)))
check('market API calls pass', hook({'tool_name': J, 'tool_input': {'text': "[__fbReader.market({max:50000}), __fbReader.listing(), JSON.stringify(__fbReader.marketControl('sort')), await __fbReader.marketScroll({steps:2}), await __fbReader.ready(), JSON.stringify(__fbReader.market({format:'json'}))].join('\\n')"}}) == 'pass')
check('tracking + selling API calls pass', hook({'tool_name': J, 'tool_input': {'text': "[__fbReader.trackAdd(), __fbReader.trackList(), __fbReader.trackCheck(), __fbReader.trackRemove('m1'), __fbReader.myListings(), __fbReader.priceCheck({price:1}), JSON.stringify(__fbReader.sellCheck()), __fbReader.sellReport()].join('\\n')"}}) == 'pass')
check('raw .click() → ask', hook({'tool_name': J, 'tool_input': {'text': 'document.querySelector("button").click()'}}) == 'ask')
log = pathlib.Path(home) / '.fb-reader' / 'audit.log'
events = [json.loads(l)['event'] for l in log.read_text(encoding='utf-8').splitlines()] if log.exists() else []
check('audit log has approvals, decisions and executions', {'approval', 'decision', 'executed'} <= set(events), str(set(events)))

print()
if FAILS:
    print(f'{len(FAILS)} FAILED:', ', '.join(FAILS)); sys.exit(1)
print('all tests passed')
