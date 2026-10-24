#!/usr/bin/env python3
"""Build the injectable fb-reader files.  Usage: python3 build.py   (needs node + npx terser)

Outputs (all next to this file):
  fb-reader.min.js          core, self-installing (localStorage + IndexedDB); paste once
  fb-reader-write.min.js    optional write-protocol module (composeCheck, commentBox, react…)
  install/fb-reader.part-N-of-M.js   the core split into ~12 KB tool calls (same result)
  fb-reader.loader.js       ~1.3 KB loader — run after every page load with `await`
"""
import hashlib
import json
import pathlib
import re
import subprocess

here = pathlib.Path(__file__).resolve().parent
TERSER = ['npx', '-y', 'terser@5.31.0', '-c', 'passes=2', '-m', '--comments', 'false']


def iife_body(src: str) -> str:
    start = src.index('(() => {')
    end = src.rindex('})();') + len('})()')
    return src[start:end]


def minify(code: str, name: str) -> str:
    tmp = here / f'.{name}.tmp.js'
    out = here / f'.{name}.out.js'
    tmp.write_text(code, encoding='utf-8')
    subprocess.run(TERSER + [str(tmp), '-o', str(out)], check=True)
    res = out.read_text(encoding='utf-8')
    tmp.unlink(); out.unlink()
    return res


def installer(core: str, key: str, verkey: str, ver_expr: str) -> str:
    """Wrap an IIFE so that it runs AND stores its own source in localStorage + IndexedDB."""
    return (
        "(() => {\n  const boot = () => " + core + ";\n  boot();\n"
        "  const src = '(' + boot.toString() + ')()', ver = " + ver_expr + ";\n"
        f"  try {{ localStorage.setItem('fb-reader:{key}', src); localStorage.setItem('fb-reader:{verkey}', ver); }} catch (e) {{}}\n"
        "  try { const q = indexedDB.open('fb-reader', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv');\n"
        f"    q.onsuccess = () => {{ const tx = q.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(src, '{key}'); tx.objectStore('kv').put(ver, '{verkey}'); }}; }} catch (e) {{}}\n"
        "  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}\n"
        "})();\nwindow.__fbReader.status();\n"
    )


core_src = (here / 'fb-reader.js').read_text(encoding='utf-8')
write_src = (here / 'fb-reader-write.js').read_text(encoding='utf-8')
version = re.search(r"const VERSION = '([^']+)'", core_src).group(1)
build = hashlib.sha1(core_src.encode()).hexdigest()[:8]
wbuild = hashlib.sha1(write_src.encode()).hexdigest()[:8]

core_iife = iife_body(core_src).replace("'__BUILD__'", repr(build))
write_iife = iife_body(write_src).replace('const WRITE_VERSION = R.version;', f"const WRITE_VERSION = R.version + '+w{wbuild}';")

core_min = minify(installer(core_iife, 'src', 'ver', "window.__fbReader.version + '+' + window.__fbReader.build"), 'core')
write_min = minify(installer(write_iife, 'wsrc', 'wver', "window.__fbReader.writeModule"), 'write')
(here / 'fb-reader.min.js').write_text(core_min, encoding='utf-8')
(here / 'fb-reader-write.min.js').write_text(write_min, encoding='utf-8')

# ── browser extension (MV3, MAIN world): same code, no installer, no cache ──
ext = here.parent.parent.parent / 'extension'
ext.mkdir(exist_ok=True)
ext_core = minify(core_iife, 'extcore')
ext_write = minify(write_iife, 'extwrite')
marker = f"window.__fbReaderExt={{version:'{version}',build:'{build}',write:'{wbuild}'}};"
(ext / 'fb-reader.core.js').write_text(ext_core + ';\n' + marker + '\n', encoding='utf-8')
(ext / 'fb-reader.write.js').write_text(ext_write + ';\n', encoding='utf-8')
manifest = {
    "manifest_version": 3,
    "name": "facebook-reader (Claude)",
    "version": version,
    "description": "Betölti a facebook-reader szkriptet (window.__fbReader) a facebook.com és messenger.com oldalakra, hogy ne kelljen kézzel beilleszteni. Csak olvas; írási műveletet nem végez.",
    "content_scripts": [{
        "matches": ["https://www.facebook.com/*", "https://web.facebook.com/*", "https://m.facebook.com/*", "https://www.messenger.com/*"],
        "js": ["fb-reader.core.js", "fb-reader.write.js"],
        "run_at": "document_idle",
        "world": "MAIN",
        "all_frames": False,
    }],
    "minimum_chrome_version": "111",
    "icons": {n: f"icons/icon{n}.png" for n in ("16", "32", "48", "128")},
}
# tracking helper: bridge (ISOLATED) mirrors the tracked-listing list, the service worker may re-check them (OFF by default, see background.js)
manifest["content_scripts"].append({
    "matches": ["https://www.facebook.com/*", "https://web.facebook.com/*"],
    "js": ["bridge.js"], "run_at": "document_idle", "all_frames": False,
})
manifest["permissions"] = ["storage", "alarms", "notifications", "scripting", "tabs"]
manifest["host_permissions"] = ["https://www.facebook.com/*"]
manifest["background"] = {"service_worker": "background.js"}
manifest["action"] = {"default_title": "facebook-reader: követett hirdetések", "default_popup": "popup.html", "default_icon": {n: f"icons/icon{n}.png" for n in ("16", "32", "48", "128")}}
manifest["description"] = "Betölti a facebook-reader szkriptet (window.__fbReader) a facebook.com és messenger.com oldalakra, és segíti a hirdetések követését, valamint az értesítések és Messenger-üzenetek jelzését (opcionális, alapból kikapcsolt háttérfigyelés, csak olvasás, csak számlálók). Írási műveletet nem végez."
(ext / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

# ── chunked install of the core (same effect as pasting fb-reader.min.js) ──
inst = here / 'install'
inst.mkdir(exist_ok=True)
for old in inst.glob('fb-reader.part-*.js'):
    old.unlink()
CHUNK = 12000
chunks = [core_min[i:i + CHUNK] for i in range(0, len(core_min), CHUNK)]
n = len(chunks)
for i, ch in enumerate(chunks):
    body = f"(window.__fbI=window.__fbI||[])[{i}]={json.dumps(ch, ensure_ascii=False)};"
    if i < n - 1:
        body += f"'fb-reader telepítés: {i + 1}/{n} rész kész'"
    else:
        body += ("(()=>{const p=window.__fbI;for(let k=0;k<" + str(n) + ";k++)if(typeof p[k]!=='string')return'HIÁNYZÓ RÉSZ: '+(k+1)+'/" + str(n) + "';"
                 "const c=p.join('');delete window.__fbI;return(0,eval)(c)})()")
    (inst / f'fb-reader.part-{i + 1}-of-{n}.js').write_text(body + '\n', encoding='utf-8')

# ── loader: run as `await <loader>` — syncs localStorage <-> IndexedDB both ways ──
want = f"{version}+{build}"
wwant = f"{version}+w{wbuild}"
loader = (
    "await (async()=>{const W='" + want + "',WW='" + wwant + "';"
    "const X=window.__fbReaderExt;if(X&&window.__fbReader&&X.version+'+'+X.build===W&&window.__fbReader.writeModule===WW)return window.__fbReader.status()+' · bővítményből betöltve '+W;"
    "const db=await new Promise(r=>{try{const q=indexedDB.open('fb-reader',1);q.onupgradeneeded=()=>q.result.createObjectStore('kv');q.onsuccess=()=>r(q.result);q.onerror=()=>r(null)}catch(e){r(null)}});"
    "const g=k=>new Promise(r=>{try{const t=db.transaction('kv').objectStore('kv').get(k);t.onsuccess=()=>r(t.result??null);t.onerror=()=>r(null)}catch(e){r(null)}});"
    "const p=(k,v)=>{try{db.transaction('kv','readwrite').objectStore('kv').put(v,k)}catch(e){}};"
    "const L=k=>{try{return localStorage.getItem('fb-reader:'+k)}catch(e){return null}},S=(k,v)=>{try{localStorage.setItem('fb-reader:'+k,v)}catch(e){}};"
    "const pair=async(sk,vk,want)=>{const a=[L(sk),L(vk)],b=[await g(sk),await g(vk)];"
    "const c=(b[0]&&b[1]===want&&a[1]!==want)?b:(a[0]?a:b);if(c[0]){if(a[0]!==c[0]||a[1]!==c[1]){S(sk,c[0]);S(vk,c[1])}if(b[0]!==c[0]||b[1]!==c[1]){p(sk,c[0]);p(vk,c[1])}}return c};"
    "const[s,v]=await pair('src','ver',W),[ws,wv]=await pair('wsrc','wver',WW);"
    "try{navigator.storage?.persist?.()}catch(e){}"
    "if(!s)return'FB-READER NINCS TELEPÍTVE → injektáld a scripts/fb-reader.min.js-t (vagy az install/ részeket sorban)';"
    "(0,eval)(s);let w='';if(ws){try{(0,eval)(ws);w=wv===WW?'':' · ÍRÁSI MODUL ELAVULT → fb-reader-write.min.js'}catch(e){w=' · írási modul hiba: '+e.message}}"
    "return window.__fbReader.status()+(v===W?' · cache OK '+v:' · ELAVULT CACHE ('+v+' ≠ '+W+') → injektáld újra a fb-reader.min.js-t')+w})()\n"
)
(here / 'fb-reader.loader.js').write_text(loader, encoding='utf-8')

print(f'version {version} core {build} write {wbuild}')
print(f'extension/ {len(ext_core.encode())+len(ext_write.encode())} B · fb-reader.min.js {len(core_min.encode())} B · fb-reader-write.min.js {len(write_min.encode())} B · '
      f'install/ {n} részben (≤{CHUNK} kar.) · loader {len(loader.encode())} B')
