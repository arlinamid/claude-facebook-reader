#!/usr/bin/env node
// fb-write-guard.mjs — facebook-reader safety hook (Claude Code PreToolUse / PostToolUse)
//
// Any browser action that could WRITE to Facebook (publish, comment, reply, message, react, join,
// approve, delete, type text, press Enter, upload / attach a file or media, run state-changing JS)
// is stopped with permissionDecision "ask": the user sees exactly where and what, and must approve.
// Read-only actions (navigation, screenshots, scrolling, fb-reader read calls) pass silently.
//
//   PreToolUse : node fb-write-guard.mjs            (decides: ask / deny / allow)
//   PreToolUse : node fb-write-guard.mjs --bash     (gates fb-approve.mjs and tampering with approval/audit files)
//   PostToolUse: node fb-write-guard.mjs --track    (remembers which tab shows which URL)
//   PostToolUse: node fb-write-guard.mjs --post     (audit "executed" + advances the typed-text counter)
//
// Approval token (fb-approve.mjs): once the user approved an exact text + target, `computer type` is let through
// only for that text (in order, chunks allowed) and DENIED for anything else. Without a token it still asks.
// Every decision and every executed write lands in ~/.fb-reader/audit.log (JSON lines).
// Never blocks non-Facebook tabs except media/file uploads with unknown destination.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { audit, loadApproval, saveApproval, loadSelf, norm, sha, TEXT_KINDS, sameTarget, firstDiff, APPROVAL_FILE, AUDIT_FILE, photoKey, listingField, listingTyped, listingPhotosDone, listingProgress, uploadPaths, listingChoiceIn } from './fb-guard-lib.mjs';

const STATE = path.join(process.env.FB_READER_GUARD_STATE_DIR || os.tmpdir(), 'fb-reader-guard-state.json');
const TRACK = process.argv.includes('--track');
const POST = process.argv.includes('--post');
const BASH = process.argv.includes('--bash');

const readStdin = () => new Promise(res => {
  let d = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (d += c));
  process.stdin.on('end', () => res(d));
  setTimeout(() => res(d), 3000);
});
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { tabs: {}, last: null }; } };
const saveState = s => { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch { /* ignore */ } };

const FB_RE = /(^|\/\/|\.)(facebook\.com|fb\.com|messenger\.com|fb\.watch)(\/|$|:)/i;

// Verbs that change something on Facebook (HU + EN), matched against the click's action_summary.
const WRITE_RE = /publish|közzé|posztol|\bsends?\b|\bküld|elküld|submit|\bposts? (it|the|a|this|to|as)\b|reply to|válaszol|válasz küld|\bcomments? (on|with|as)\b|hozzászólás küld|attach|csatol|upload|feltölt|\bshares?\b|megoszt|\blikes?\b|tetszik|\breacts?\b|reag[áa]l|\bjoins?\b|csatlakoz|\bleaves?\b|kilép|\bfollows?\b|követ|friend|ismerős|invite|meghív|approve|jóváhagy|decline|elutasít|reject|delete|töröl|\bremoves?\b|eltávolít|\bedits?\b|szerkeszt|\bsaves?\b|mentés|report|jelent|\bblocks?\b|letilt|\bpins?\b|kitűz|\bwrites?\b|\btypes?\b|beír|paste|beilleszt|\bmessages?\b|üzen|confirm|megerősít|accept|elfogad|\bbuy|vásárl|pay|fizet/i;
// Clearly read-only intents; anything neither read nor write is treated as ambiguous → ask.
const READ_RE = /^(opens?|expands?|shows?|reveals?|loads?|scrolls?|views?|closes?|dismiss(es)?|navigates?|hovers?|focuses on|switches to|goes back|megnyit|kibont|mutat|betölt|görget|bezár|visszalép)\b/i;

// fb-reader read-only API — calls to these never write
const SAFE_API = /__fbReader\.(extract|extractPost|extractSearchResults|extractMediaGrid|extractPinnedComments|extractPrompt|promptsToMarkdown|listGroups|groupInfo|mediaList|findPostRoots|findPost|resolvePost|pageInfo|parseFbDate|cleanUrl|unwrapUrl|kindOfUrl|fbIdOf|cdnSafe|toMarkdown|render|hide|chunk|status|mark|unmark|expandSeeMore|expandComments|hoverDates|hoverReveal|composeCheck|composeReport|commentBox|replyBox|react|reactionState|setCommentSort|where|map|peek|thread|full|grep|go|inbox|notifs|notif|msgs|msgOpen|msgThread|me|selfThread|market|marketScroll|ready|listing|marketControl|trackAdd|trackList|trackRemove|trackCheck|myListings|priceCheck|sellCheck|sellForm|sellReport|notifMore|msgSearch|msgRequests|threadActions|untag|selfTest|snapshot|q|visibleText|decodeScrambled|nav\.[a-zA-Z]+|harvest\.(start|scroll|collect|dump|stop))\s*\(/g;
const JS_WRITE_RE = /\.click\s*\(|dispatchEvent|execCommand|insertText|insertHTML|contenteditable|\.value\s*=|textContent\s*=|innerText\s*=|innerHTML\s*=|\.submit\s*\(|requestSubmit|method\s*:\s*['"`](POST|PUT|DELETE)|\/api\/graphql|DataTransfer|ClipboardEvent|InputEvent|KeyboardEvent|\.files\s*=|__fbReader\.download\s*\(|navigator\.clipboard|sendBeacon/i;
// Only the plugin's own, reviewed bundle and loader are exempt — compared byte-for-byte.
const HERE = path.dirname(fileURLToPath(import.meta.url));   // percent-decoded, Windows drive letters and spaces in the path
const SCRIPTS = path.join(HERE, '..', 'skills', 'facebook-reader', 'scripts');
const OWN = [];
for (const dir of [SCRIPTS, path.join(SCRIPTS, 'install')]) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^fb-reader.*\.js$/.test(f) && !/^fb-reader(-write)?\.js$/.test(f)) OWN.push(fs.readFileSync(path.join(dir, f), 'utf8').trim());
    }
  } catch { /* ignore */ }
}
const isFbReaderBundle = code => OWN.includes(String(code).trim());

function urlFor(state, input) {
  const tab = input?.tabId ?? input?.tab_id;
  if (tab != null && state.tabs[String(tab)]) return state.tabs[String(tab)];
  return state.last;
}

let CTX = { tool: '', input: {}, url: null, state: null };
function decide(decision, reason) {
  const i = CTX.input || {};
  const typed = i.action === 'type' || /type$/.test(CTX.tool) ? norm(i.text || '') : null;
  audit({ event: 'decision', decision, tool: CTX.tool, action: i.action || null, summary: i.action_summary || null, url: CTX.url || null,
    ...(typed != null ? { textLength: typed.length, textHash: sha(typed), text: typed.slice(0, 600) } : {}), reason: reason.split('\n')[0].slice(0, 160) });
  if (decision !== 'deny' && CTX.state) { CTX.state.pending = { tool: CTX.tool, action: i.action || null, summary: i.action_summary || null, url: CTX.url || null, text: typed, at: Date.now() }; saveState(CTX.state); }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}
const ask = reason => decide('ask', reason);
const deny = reason => decide('deny', reason);
const allow = reason => decide('allow', reason);

function approvalNote() {
  const ap = loadApproval();
  if (!ap) return '\nNincs rögzített jóváhagyás (fb-approve.mjs) — a szöveg/cél egyezése nem ellenőrizhető.';
  if (ap.kind === 'listing') return `\nRögzített jóváhagyás: HIRDETÉS → ${ap.urls[0]}${ap.as ? ' · mint ' + ap.as : ''} · beírva: ${listingProgress(ap)}${listingTyped(ap) && listingPhotosDone(ap) ? '' : ' ⚠ a jóváhagyott tartalom még NINCS teljesen beírva/feltöltve'}`;
  return `\nRögzített jóváhagyás: ${ap.kind} → ${ap.urls[0]}${ap.as ? ' · mint ' + ap.as : ''}${ap.react ? ' · reakció: ' + ap.react : ''}` +
    (TEXT_KINDS.has(ap.kind) ? ` · beírva ${ap.typed.length}/${ap.text.length} karakter${ap.typed !== ap.text ? ' ⚠ NEM a teljes jóváhagyott szöveg' : ''}` : '');
}

const short = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const HEADER = '🛡️ facebook-reader írásvédelem —';

// Self-notification exception: the approval was created by `fb-approve.mjs --self-notify` for the REGISTERED own thread,
// the full text is typed, nothing was sent yet and the tab shows exactly that thread → Enter / the send button once is allowed.
const NOT_SEND_RE = /like|kedvel|thumb|emoji|sticker|matric|gif|attach|csatol|voice|hang|file|fájl|photo|fotó|video|videó/i;
function selfSendOk(url) {
  const ap = loadApproval(), self = loadSelf();
  if (!ap || !self || !ap.self || ap.sent || ap.kind !== 'message') return null;
  if (ap.typed !== ap.text || ap.urls[0] !== self.threadUrl || sameTarget(ap.urls, url) !== true) return null;
  return ap;
}
function consumeSelf(ap) { ap.sent = true; saveApproval(ap); }
// Focusing the box of the registered own thread before typing: the click's summary often contains "message" (a write word),
// so without this the user would be asked for a harmless focus click. Only while a self approval is fresh and nothing was typed yet.
function selfFocusOk(url, summary) {
  const ap = loadApproval(), self = loadSelf();
  if (!ap || !self || !ap.self || ap.sent || ap.kind !== 'message' || ap.typed !== '') return null;
  if (ap.urls[0] !== self.threadUrl || sameTarget(ap.urls, url) !== true) return null;
  const s = String(summary || '');
  if (!/^(focus|click(s)? (in|into|on) the|put(s)? the cursor)|\b(text ?box|input|compose)\b/i.test(s)) return null;
  if (/\bsend|\bküld|\bdelete|\btöröl|\bshare|\breact|\bjoin|\bblock|\bpost\b/i.test(s) || NOT_SEND_RE.test(s)) return null;
  return ap;
}

function checkComputerAction(a, url, onFb) {
  const action = a.action;
  const summary = a.action_summary || '';
  if (action === 'type') {
    if (onFb) {
      const ap = loadApproval();
      if (ap && ap.kind === 'listing') {
        const chunk = norm(a.text || ''), fld = listingField(ap, chunk);
        if (!fld) deny(`${HEADER} TILTVA: a beírandó szöveg NEM a jóváhagyott hirdetés valamelyik mezőjének folytatása.\nJóváhagyott mezők: ${ap.fields.map(x => `${x.name} (${x.text.length} kar.): „${short(x.text, 120)}”`).join(' | ')}\nBeírni próbált: „${short(chunk, 300)}”\nJavítsd, vagy kérj új jóváhagyást (fb-approve.mjs --kind listing).`);
        const same = sameTarget(ap.urls, url);
        if (same === true) allow(`${HEADER} HIRDETÉS: a beírandó szöveg a jóváhagyott „${fld.name}” mező folytatása (${fld.typed.length + chunk.length}/${fld.text.length}), a cél oldal egyezik.`);
        return `${HEADER} a szöveg a jóváhagyott „${fld.name}” mezőé, DE a cél oldal ${same === false ? 'ELTÉR' : 'ismeretlen'}.\nJelenlegi oldal: ${url || 'ismeretlen'}\nJóváhagyott cél: ${ap.urls.join(' | ')}\nEllenőrizd, hogy a megfelelő hirdetés-űrlapba (Marketplace / jó csoport) írsz-e.`;
      }
      if (ap && TEXT_KINDS.has(ap.kind)) {
        const chunk = norm(a.text || '');
        const cand = ap.typed + chunk;
        if (!ap.text.startsWith(cand)) {
          const d = firstDiff(ap.text, cand);
          deny(`${HEADER} TILTVA: a beírandó szöveg NEM egyezik a jóváhagyottal.\nEltérés a(z) ${d.at}. karakternél: várt „${d.expectedNext}”, kapott „${d.gotNext}”.\nJóváhagyott (${ap.text.length} kar.): „${short(ap.text, 300)}”\nBeírni próbált: „${short(chunk, 300)}”\nJavítsd a szöveget, vagy kérj új jóváhagyást (fb-approve.mjs).`);
        }
        const same = sameTarget(ap.urls, url);
        if (same === true) allow(`${HEADER} a beírandó szöveg megegyezik a jóváhagyott piszkozattal (${cand.length}/${ap.text.length} karakter), a cél oldal is egyezik.`);
        return `${HEADER} a szöveg egyezik a jóváhagyottal, DE a cél oldal ${same === false ? 'ELTÉR' : 'ismeretlen'}.\nJelenlegi oldal: ${url || 'ismeretlen'}\nJóváhagyott cél: ${ap.urls.join(' | ')}\nEllenőrizd a képernyőképen, hogy a megfelelő komment/poszt mezőbe fogsz-e írni.`;
      }
      return `${HEADER} SZÖVEG BEÍRÁSA a Facebookon — nincs rögzített jóváhagyás.\nCél oldal: ${url || 'ismeretlen'}\nMűvelet: ${summary || '(nincs leírás)'}\nBeírandó szöveg: „${short(a.text, 600)}”\nCsak akkor engedélyezd, ha ez a jóváhagyott piszkozat és jó helyre kerül.`;
    }
    return null;
  }
  if (action === 'key') {
    const k = String(a.text || '');
    if (onFb && /^(enter|return)$/i.test(k.trim())) { const sp = selfSendOk(url); if (sp) { consumeSelf(sp); allow(`${HEADER} ÖNÉRTESÍTÉS: a regisztrált saját szálra küldés (${sp.text.length} karakter), egyszeri Enter engedélyezve.`); } }
    if (onFb && /(^|\s|\+)(enter|return|kp_enter)(\s|$)/i.test(k)) return `${HEADER} ENTER a Facebookon — egy komment/üzenet mezőben ez azonnal ELKÜLD.\nCél oldal: ${url || 'ismeretlen'}\nMűvelet: ${summary || '(nincs leírás)'}\nBillentyű: ${k}${approvalNote()}`;
    if (onFb && /ctrl\+v|cmd\+v|meta\+v/i.test(k)) return `${HEADER} BEILLESZTÉS a Facebookon (szöveg vagy kép/média kerülhet a szerkesztőbe).\nCél oldal: ${url || 'ismeretlen'}\nMűvelet: ${summary || '(nincs leírás)'}`;
    return null;
  }
  if (/click|left_click_drag/.test(action || '')) {
    if (!onFb) return null;
    if (summary && selfFocusOk(url, summary)) allow(`${HEADER} ÖNÉRTESÍTÉS: a regisztrált saját szál üzenetmezőjére kattintás (még nincs beírt szöveg), engedélyezve.`);
    if (summary && /\bsend|\bküld/i.test(summary) && !NOT_SEND_RE.test(summary)) { const sp = selfSendOk(url); if (sp) { consumeSelf(sp); allow(`${HEADER} ÖNÉRTESÍTÉS: a regisztrált saját szálra küldés (${sp.text.length} karakter), egyszeri küldés-kattintás engedélyezve.`); } }
    { const ap = loadApproval();
      if (ap && ap.kind === 'listing' && summary && sameTarget(ap.urls, url) === true) {
        if (/\b(next|continue)\b|tovább|következő/i.test(summary) && !/publish|\bpost\b|közzé|\bsend|\bküld|submit/i.test(summary) && listingTyped(ap) && listingPhotosDone(ap)) allow(`${HEADER} HIRDETÉS: a jóváhagyott tartalom be van írva, a következő lépés gombja (nem közzététel), engedélyezve.`);
        if (/\b(select|choose|pick)(s|es|ed)?\b|kiválaszt|választ/i.test(summary) && !/publish|\bpost\b|közzé|\bsend|\bküld|submit/i.test(summary) && listingChoiceIn(ap, summary)) allow(`${HEADER} HIRDETÉS: a jóváhagyott legördülő-érték kiválasztása.`);
      } }
    if (!summary) return `${HEADER} kattintás a Facebookon leírás (action_summary) nélkül — nem ellenőrizhető, hogy olvasás vagy írás.\nCél oldal: ${url || 'ismeretlen'} · koordináta: ${JSON.stringify(a.coordinate || a.ref || '')}`;
    if (WRITE_RE.test(summary) || !READ_RE.test(summary.trim())) return `${HEADER} MÓDOSÍTÓ KATTINTÁS a Facebookon.\nCél oldal: ${url || 'ismeretlen'}\nMűvelet: „${short(summary)}”\nKözzététel/küldés/csatolás előtt a felhasználónak látnia kell a composeReport() előnézetet (hely, kinek a nevében, közönség, pontos szöveg, csatolmányok).${approvalNote()}`;
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const tool = ev.tool_name || '';
  const input = ev.tool_input || {};
  const state = loadState();
  CTX = { tool, input, url: null, state };

  if (BASH) {
    // The approval is the user's confirmation of the exact text: running fb-approve.mjs is gated, and so is
    // anything that touches the approval / state / audit files directly (best effort).
    const cmd = String(input.command || '');
    const SELF_CMD = /^\s*node\s+(?:"[^"]*fb-approve\.mjs"|'[^']*fb-approve\.mjs'|[\w./\\:~-]*fb-approve\.mjs)\s+--self-notify\s+--account\s+\d+\s+--text-file\s+[\w./\\:~-]+\s*$/;
    if (SELF_CMD.test(cmd) && loadSelf()) {
      let tx = ''; try { tx = fs.readFileSync(/--text-file\s+(\S+)/.exec(cmd)[1], 'utf8'); } catch { /* the script reports it */ }
      CTX.url = null; allow(`${HEADER} ÖNÉRTESÍTÉS a regisztrált saját szálra (kérdés nélkül): „${short(tx, 200)}”`);
    }
    if (/fb-approve\.mjs/.test(cmd) && /--(register|unregister)-self/.test(cmd)) ask(`🔔 ÖNÉRTESÍTÉS REGISZTRÁLÁSA — ha engedélyezed, a plugin a megadott Messenger-szálra (a SAJÁT szálad) ezentúl kérdés nélkül küldhet rövid, egysoros értesítést (pl. „a feladat kész”), a regisztrált fiókhoz kötve. Más szálra, csoportba vagy névre nem. Visszavonás: fb-approve.mjs --unregister-self.\nParancs: ${short(cmd, 800)}\nCsak akkor engedélyezd, ha az URL valóban a SAJÁT beszélgetésed (te vagy az egyetlen résztvevő).`);
    if (/fb-approve\.mjs/.test(cmd) && !/--(status|clear)\b/.test(cmd)) {
      let extra = '';
      const tf = /--(?:text|description)-file\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
      if (tf) { try { extra = `\nA fájl tartalma (${tf[1] || tf[2] || tf[3]}):\n„${short(fs.readFileSync(tf[1] || tf[2] || tf[3], 'utf8'), 1500)}”`; } catch { extra = '\n(a --text-file nem olvasható)'; } }
      CTX.url = null;
      ask(`✅ ÍRÁSI JÓVÁHAGYÁS RÖGZÍTÉSE — ha engedélyezed, a plugin kizárólag az alábbi szöveget és célt fogja beírni/végrehajtani, bármi más TILTVA lesz.\nParancs: ${short(cmd, 1500)}${extra}\nCsak akkor engedélyezd, ha a szöveg betűre az, amit jóváhagytál, és a cél (oldal/poszt, név) is stimmel.`);
    }
    if (/fb-reader-approval|fb-reader-guard-state|fb-reader[\/\\]audit|\.fb-reader[\/\\]audit|\.fb-reader[\/\\]self|fb-guard-lib/.test(cmd) && !/^\s*(cat|tail|head|less|type|Get-Content|wc|grep)\b/.test(cmd)) {
      ask(`${HEADER} a parancs a jóváhagyási/audit fájlokhoz nyúl (${short(cmd, 300)}). Ezeket csak a fb-approve.mjs módosíthatja; engedélyezd, ha te kérted.`);
    }
    process.exit(0);
  }

  if (POST) {
    // PostToolUse: the tool ran → whatever was asked/allowed was approved; log it and advance the typed counter
    const pend = state.pending;
    const i = input || {};
    if (pend && pend.tool === tool && (pend.action || null) === (i.action || null) && Date.now() - pend.at < 10 * 60000) {
      audit({ event: 'executed', tool, action: pend.action, summary: pend.summary, url: pend.url, ...(pend.text != null ? { textLength: pend.text.length, textHash: sha(pend.text), text: pend.text.slice(0, 600) } : {}) });
      if (/file_upload|upload_image|upload_file|set_input_files/i.test(tool)) {
        const ap = loadApproval();
        if (ap && ap.kind === 'listing') { ap.uploaded = [...new Set([...(ap.uploaded || []), ...uploadPaths(i).map(photoKey).filter(k => (ap.photos || []).map(photoKey).includes(k))])]; saveApproval(ap); }
      }
      if (i.action === 'type' && pend.text) {
        const ap = loadApproval();
        if (ap && ap.kind === 'listing') { const f = listingField(ap, pend.text); if (f) { f.typed += pend.text; saveApproval(ap); } }
        else if (ap && TEXT_KINDS.has(ap.kind) && ap.text.startsWith(ap.typed + pend.text)) { ap.typed += pend.text; saveApproval(ap); }
      }
      delete state.pending; saveState(state);
    }
    process.exit(0);
  }

  if (TRACK) {
    // PostToolUse: remember URLs per tab from navigate / tabs_context / tabs_create results
    const resp = typeof ev.tool_response === 'string' ? ev.tool_response : JSON.stringify(ev.tool_response || '');
    if (/navigate/i.test(tool) && input.url && !/^(back|forward)$/.test(input.url)) {
      const u = /^https?:/i.test(input.url) ? input.url : `https://${input.url}`;
      if (input.tabId != null) state.tabs[String(input.tabId)] = u;
      state.last = u;
    }
    for (const m of resp.matchAll(/tabId[\\"':\s]+(\d+)[^\n]*?\((?:\\")?["']?(https?:\/\/[^"'\s)\\]+)/g)) state.tabs[m[1]] = m[2];
    const exec = /Executed on tabId:\s*(\d+)/.exec(resp);
    if (exec && state.tabs[exec[1]]) state.last = state.tabs[exec[1]];
    saveState(state);
    process.exit(0);
  }

  if (state.pending) { delete state.pending; saveState(state); } // stale: that action was refused or never ran
  const url = urlFor(state, input);
  CTX.url = url;
  const onFb = url ? FB_RE.test(url) : false;
  const unknown = !url;

  // 1. file / media uploads — always ask when target is Facebook or unknown
  if (/file_upload|upload_image|upload_file|set_input_files/i.test(tool)) {
    { const ap = loadApproval(), ps = uploadPaths(input);
      if ((onFb || unknown) && ap && ap.kind === 'listing' && ps.length && ps.every(p => (ap.photos || []).map(photoKey).includes(photoKey(p))) && sameTarget(ap.urls, url) === true) allow(`${HEADER} HIRDETÉS: a jóváhagyott fotó(k) feltöltése (${ps.length} fájl), a cél oldal egyezik.`); }
    if (onFb || unknown) ask(`${HEADER} FÁJL/MÉDIA CSATOLÁS.\nCél oldal: ${url || 'ismeretlen'}\nFájl(ok): ${short(JSON.stringify(input.paths || input.path || input.files || input.imageId || input.filePath || input), 500)}\nEllenőrizd: ezt a fájlt hagytad jóvá, és ehhez a poszthoz/kommenthez kerül?`);
    process.exit(0);
  }

  // 2. form filling
  if (/form_input/i.test(tool) && (onFb || unknown)) {
    ask(`${HEADER} ŰRLAPMEZŐ KITÖLTÉSE a Facebookon.\nCél oldal: ${url || 'ismeretlen'}\nÉrték: „${short(input.value ?? JSON.stringify(input), 500)}”`);
  }

  // 3. mouse / keyboard
  if (/__computer$|_computer$|computer_(type|key|left_click|double_click|triple_click|right_click|left_click_drag)/i.test(tool)) {
    const act = input.action ? input : { ...input, action: tool.replace(/^.*computer_/, '') };
    const r = checkComputerAction(act, url, onFb || (unknown && /facebook|poszt|komment|hozzászól|post|comment/i.test(act.action_summary || '')));
    if (r) ask(r);
    process.exit(0);
  }

  // 4. batched browser actions
  if (/browser_batch|computer_batch/i.test(tool)) {
    const actions = input.actions || input.steps || input.batch || [];
    for (const a of Array.isArray(actions) ? actions : []) {
      const a2 = a.input || a.params || a;
      const name = a.tool || a.name || '';
      if (/navigate/i.test(name) && a2.url) { state.last = a2.url; continue; }
      if (/javascript/i.test(name) && a2.text && JS_WRITE_RE.test(String(a2.text).replace(SAFE_API, '')) && !isFbReaderBundle(a2.text) && (onFb || unknown)) ask(`${HEADER} csomagolt (batch) JS a Facebookon, ami írhat:\n${short(a2.text, 500)}`);
      if (/file_upload|upload/i.test(name) && (onFb || unknown)) ask(`${HEADER} FÁJL/MÉDIA CSATOLÁS egy batch-ben: ${short(JSON.stringify(a2), 400)}`);
      const r = checkComputerAction(a2, state.last || url, state.last ? FB_RE.test(state.last) : onFb);
      if (r) ask(r);
    }
    process.exit(0);
  }

  // 5. page JavaScript
  if (/javascript/i.test(tool)) {
    const code = String(input.text || input.code || input.script || '');
    if (isFbReaderBundle(code)) process.exit(0); // the reviewed fb-reader bundle / loader
    const residue = code.replace(SAFE_API, '');
    if ((onFb || unknown) && JS_WRITE_RE.test(residue)) {
      ask(`${HEADER} JAVASCRIPT a Facebookon, ami az oldalt módosíthatja (kattintás, szövegbeírás, küldés, fájl).\nCél oldal: ${url || 'ismeretlen'}\nKód: ${short(code, 700)}`);
    }
    process.exit(0);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
