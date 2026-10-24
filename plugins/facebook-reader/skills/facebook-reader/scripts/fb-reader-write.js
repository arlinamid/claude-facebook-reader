/*
 * fb-reader-write.js — OPTIONAL write-protocol module for fb-reader (needs the core loaded first).
 * Nothing here clicks, types or publishes. It only LOCATES things and REPORTS them, so the
 * model can show the user a preview and, after explicit approval, act with normal browser
 * clicks (which the plugin's write-guard hook will prompt for again).
 *
 *   __fbReader.composeCheck() / composeReport()   preview of the open composer / reply box
 *   __fbReader.commentBox(post, {mark})           the comment box of a post + "Hozzászólás mint …" identity
 *   __fbReader.replyBox(post, 'c3', {mark})       the reply box of ONE comment (c-number from thread()), or its "Válasz" button
 *   await __fbReader.react('love', {post, mark})  hover → reaction bar → coordinates of the wanted reaction
 *   __fbReader.reactionState(post)                own reaction + counts (verification after the click)
 */
(() => {
  'use strict';
  const R = window.__fbReader;
  if (!R || !R._i) throw new Error('fb-reader core nincs betöltve — előbb a loader / fb-reader.min.js');
  const { SEL, unsalt, norm, isShown, extractPost, extractCounts, pageInfo, resolvePost, mark, sleep, PUBLISH_RE, commentArticles, commentInfo } = R._i;
  const WRITE_VERSION = R.version;

  const VIEWPORT_NOTE = 'x,y = CSS viewport pixel. A computer eszköz a képernyőkép koordinátáit várja: szorozd meg (képernyőkép szélessége / vw) aránnyal, vagy kattints a képernyőképen látható jelölő (keret) közepére.';
  const center = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
  const FBR_RE = /\s*\[fbr:[^\]]*\]/g;
  const U = s => unsalt(s).replace(FBR_RE, '');
  const labelOf = el => unsalt(el?.getAttribute?.('aria-label') || el?.getAttribute?.('aria-placeholder') || el?.getAttribute?.('placeholder') || el?.innerText || '').replace(FBR_RE, '').trim();

  // ── Target tags: the only thing Claude in Chrome's find/read_page can see is the accessible name,
  // so the tag is appended to aria-label ("Imádom [fbr:love]"). find("[fbr:love]") → ref → click(ref).
  // untag() restores the original labels (also called by unmark()).
  const untag = () => {
    let n = 0;
    for (const el of document.querySelectorAll('[data-fbr-orig]')) {
      const o = el.getAttribute('data-fbr-orig');
      if (o === '\u0000') el.removeAttribute('aria-label'); else el.setAttribute('aria-label', o);
      el.removeAttribute('data-fbr-orig'); el.removeAttribute('data-fbr-target'); n++;
    }
    return n ? `${n} jelölés eltávolítva` : 'nincs jelölés';
  };
  const tag = (el, id, keep = false) => {
    if (!el) return null;
    if (!keep) for (const o of document.querySelectorAll('[data-fbr-target="' + id + '"]')) if (o !== el) { const ol = o.getAttribute('data-fbr-orig'); ol === '\u0000' ? o.removeAttribute('aria-label') : o.setAttribute('aria-label', ol); o.removeAttribute('data-fbr-orig'); o.removeAttribute('data-fbr-target'); }
    if (!el.hasAttribute('data-fbr-orig')) el.setAttribute('data-fbr-orig', el.hasAttribute('aria-label') ? el.getAttribute('aria-label') : '\u0000');
    const base = (el.getAttribute('data-fbr-orig') === '\u0000' ? (el.innerText || '').trim().slice(0, 40) : el.getAttribute('data-fbr-orig')).replace(FBR_RE, '');
    el.setAttribute('aria-label', `${base} [fbr:${id}]`.trim());
    el.setAttribute('data-fbr-target', id);
    return { ref: `[fbr:${id}]`, find: `${base} [fbr:${id}]`.trim() };
  };
  const hover = el => {
    const { x, y } = center(el);
    const ev = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, ev) : new MouseEvent(t, ev));
  };
  const ownLikeButton = root => {
    const inOwnScope = b => { const a = b.closest(SEL.article); return !a || a === root || !root.contains(a); };
    // the data-ad-rendering-role marker is often an empty 0-height div inside the real button
    const marker = [...root.querySelectorAll('[data-ad-rendering-role="like_button"]')].find(inOwnScope);
    return (marker && (marker.closest('[role="button"]') || marker))
      || [...root.querySelectorAll('[role="button"][aria-label]')].find(b => inOwnScope(b) && /^(tetszik|like|reagálás|react|eltávolítás: tetszik|remove like)/i.test(labelOf(b)))
      || null;
  };

  // ── Composer scope: the box plus its own toolbar, nothing else ─────────────
  // Climbs from the box while the ancestor holds no other textbox, no comment article and no post text;
  // attachments, audience and the send button are searched ONLY in here, never in the whole dialog.
  const composerRoot = box => {
    let best = box.parentElement || box;
    for (let a = box.parentElement, i = 0; a && i < 10; a = a.parentElement, i++) {
      if (a === document.body || a.matches?.('[role="main"], ' + SEL.dialog + ', [aria-posinset]')) break;
      if (a.querySelector(SEL.article) || a.querySelector(SEL.message) || [...a.querySelectorAll('[contenteditable="true"]')].some(e => e !== box)) break;
      best = a;
    }
    return best;
  };
  const foldS = x => unsalt(String(x || '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

  // Whom does this box answer? FB writes the addressee's name at the start of a reply box, so the mention is the
  // primary evidence (longest known comment author that prefixes the text); the comment right above the box is the
  // second. Both are reported, with c-number, so the user can check them.
  function replyTarget(box, scope) {
    const arts = commentArticles(scope).map((a, i) => ({ a, n: i + 1, ...commentInfo(a) }));
    if (!arts.length) return null;
    const typed = U(box.innerText || '').replace(/ /g, ' ').trim();
    const names = [...new Set(arts.map(x => x.author).filter(Boolean))].sort((x, y) => y.length - x.length);
    const mention = names.find(n => typed.startsWith(n)) || null;
    const inside = box.closest(SEL.article);
    const preceding = arts.filter(x => !x.a.contains(box) && (x.a.compareDocumentPosition(box) & 4));
    const nearest = (inside && arts.find(x => x.a === inside)) || preceding[preceding.length - 1] || null;
    let target = null, via = null;
    if (mention) {
      const same = preceding.filter(x => x.author === mention);
      target = same[same.length - 1] || arts.find(x => x.author === mention) || null;
      via = 'említés';
    }
    if (!target && nearest) { target = nearest; via = 'közelség'; }
    if (!target) return null;
    return { author: target.author, n: target.n, ref: 'c' + target.n, snippet: target.text, via, mention,
      nearest: nearest ? { author: nearest.author, n: nearest.n } : null,
      note: mention && nearest && nearest.author !== mention ? `a doboz ${nearest.author} kommentje (c${nearest.n}) alatt áll, de ${mention} nevét tartalmazza: a megszólított ${mention}` : null };
  }

  // ── Write protocol: inspect an open composer WITHOUT touching it ─────────
  // Returns where the text would go, as whom, to which audience, the exact text and
  // every attachment, so the user can approve before anything is published.
  function composeCheck() {
    const boxes = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')]
      .filter(b => isShown(b, document.body) && b.getBoundingClientRect().height > 0);
    const active = document.activeElement?.closest?.('[contenteditable="true"]');
    const nonEmpty = boxes.filter(b => U(b.innerText || '').trim());
    const box = (active && boxes.includes(active) ? active : null) || nonEmpty[nonEmpty.length - 1] || boxes[boxes.length - 1] || null;
    if (!box) return { ok: false, problem: 'Nincs nyitott szerkesztő (composer) az oldalon.' };
    const dialog = box.closest(SEL.dialog);
    const scope = dialog || box.closest(SEL.article) || box.closest('[aria-posinset]') || document.querySelector('[role="main"]') || document.body;
    const label = U(box.getAttribute('aria-label') || box.getAttribute('aria-placeholder') || box.getAttribute('placeholder') || '').trim();
    let kind = 'post';
    if (/hozzászól|comment|írj nyilvános hozzászólást|write a (public )?comment/i.test(label)) kind = 'comment';
    if (/válasz|reply/i.test(label)) kind = 'reply';
    if (/üzenet|message|messenger|írás nekik|írj neki|írj nekik|write to /i.test(label)) kind = 'message';
    // reply target: the mentioned comment author + the comment above the box
    const postRoot0 = box.closest('[aria-posinset]') || dialog || scope;
    let replyTo = replyTarget(box, postRoot0);
    // the dialog's main comment field is no reply: without an explicit mention of a commenter it has no addressee
    if (replyTo && kind !== 'reply' && replyTo.via !== 'említés') replyTo = null;
    // post the comment belongs to (feed item or overlay)
    const postRoot = box.closest('[aria-posinset]') || dialog;
    const post = postRoot ? (() => { try { const p = extractPost(postRoot); return { author: p.author, url: p.url, text: (p.text || '').slice(0, 160) }; } catch { return null; } })() : null;
    // where / as whom / audience
    const dlgTitle = U(dialog?.querySelector('h2, [role="heading"]')?.innerText || '').trim();
    const pageTitle = U(document.querySelector('[role="main"] h1')?.innerText || '').trim();
    const heading = [dlgTitle, pageTitle && `oldal: ${pageTitle}`].filter(Boolean).join(' · ') || null;
    const idm = /(?:hozzászólás|válasz|bejegyzés|comment|reply|post(?:ing)?)\s+(?:mint|as)\s+(.+?)\s*$/i.exec(label);
    const asWhom = (idm && idm[1]) || [...scope.querySelectorAll('[aria-label]')].map(e => U(e.getAttribute('aria-label')).trim())
      .find(t => /^(hozzászólás|bejegyzés|közzététel|posting|commenting|comment) (mint|as) /i.test(t) || / profilképe$|'s profile picture$/i.test(t)) || null;
    // attachments / link preview / send button: ONLY inside the composer's own wrapper
    const area = composerRoot(box);
    const media = [];
    for (const img of area.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!/^blob:|^data:image|fbcdn|scontent/.test(src) || img.closest('a, [role="link"]')) continue; // avatars sit in links
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w && h && (w < 48 || h < 48)) continue;
      media.push({ kind: /^blob:|^data:/.test(src) ? 'image (feltöltés)' : 'image', alt: U(img.alt || '').trim() || null, src: src.slice(0, 80) });
    }
    for (const v of area.querySelectorAll('video')) media.push({ kind: 'video', alt: null, src: (v.currentSrc || v.src || '').slice(0, 80) });
    for (const inp of area.querySelectorAll('input[type="file"]')) for (const f of inp.files || []) media.push({ kind: 'file', alt: f.name, src: `${f.type || '?'} · ${Math.round(f.size / 1024)} KB` });
    const removeChips = [...area.querySelectorAll('[aria-label]')].map(e => U(e.getAttribute('aria-label')))
      .filter(t => /(eltávolítás|remove|törlés)/i.test(t) && /(fotó|photo|videó|video|fájl|file|gif|matrica|sticker|melléklet|attachment)/i.test(t));
    const linkPreview = area.querySelector(SEL.cardTitle) ? { title: norm(area.querySelector(SEL.cardTitle).innerText), domain: norm(area.querySelector(SEL.cardMeta)?.innerText) || null } : null;
    // the button that WOULD publish (reported, never clicked): inside the composer wrapper only, never a textbox
    // (e.g. the dialog's main "Hozzászólás írása" field), never the post's Like/Comment action bar
    const SEND_EXACT = /^(közzététel|post|küldés|elküldés|send|hozzászólás|comment|válasz|reply|share now|megosztás most)$/i;
    const SEND_LIKE = /(küld|send|közzétét|publish)/i, NOT_SEND = /(írása|write|emoji|hangulat|fotó|fénykép|photo|videó|video|gif|matric|sticker|avatar|csatol|attach|feeling|helyszín|check in)/i; // stems: FB inflects ("matricával", "GIF-fel")
    const cands = [...area.querySelectorAll('[role="button"], button, [aria-label]')]
      .filter(b => b !== box && !b.contains(box) && !b.matches('[contenteditable], [role="textbox"], input, textarea') && !b.querySelector('[contenteditable]')
        && !b.closest('[data-ad-rendering-role$="_button"]') && !b.matches('[data-ad-rendering-role$="_button"]'))
      .map(b => ({ label: labelOf(b), disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true, el: b }))
      .filter(b => b.label && !NOT_SEND.test(b.label) && !/^(tetszik|like)/i.test(b.label) && (SEND_EXACT.test(b.label) || SEND_LIKE.test(b.label)));
    let publish = null, guessed = false;
    if (cands.length) { const c0 = cands[0]; publish = { label: c0.label, disabled: c0.disabled, target: tag(c0.el, 'send') }; }
    else {
      // icon-only send arrow without a label: the last button after the box that carries an svg
      const icon = [...area.querySelectorAll('[role="button"], button')].filter(b => b !== box && !b.contains(box) && (box.compareDocumentPosition(b) & 4) && b.querySelector('svg, i') && !labelOf(b)).pop(); // only a label-less icon is a guess; every labelled non-send button (sticker, GIF …) is not
      if (icon) { publish = { label: labelOf(icon) || '(ikon, felirat nélkül)', disabled: icon.getAttribute('aria-disabled') === 'true', guessed: true, target: tag(icon, 'send') }; guessed = true; }
    }
    const audienceBtn = kind !== 'post' ? null : ([...(dialog || scope).querySelectorAll('[role="button"], [role="combobox"]')]
      .map(b => U(b.getAttribute('aria-label') || b.innerText || '').trim())
      .find(t => /közönség|audience|nyilvános|public|ismerős|friends|csak én|only me|privát|private|csoport|group|megosztás itt|share to/i.test(t) && t.length < 80) || null);
    const text = U(box.innerText || '').replace(/ /g, ' ').trim();
    const warnings = [];
    if (kind === 'reply' && !replyTo) warnings.push('Nem azonosítható, melyik kommentre válaszol a doboz: ellenőrizd képernyőképen (replyBox(post, "c3")).');
    else if (replyTo && replyTo.via === 'közelség') warnings.push(`Nincs megszólítás a dobozban, a célt (${replyTo.author}, ${replyTo.ref}) csak a közelség alapján találtam: ellenőrizd képernyőképen.`);
    if (replyTo?.note) warnings.push(replyTo.note);
    if (!publish && kind !== 'message') warnings.push('A küldés gombot nem találtam a szerkesztő saját keretében: képernyőképen keresd meg, ne találgass.');
    else if (guessed) warnings.push('A küldés gombot felirat híján ikon alapján jelöltem: képernyőképen ellenőrizd.');
    // Messenger: the recipient is the open thread (name from the box label "Írás nekik: X", else the thread header)
    let recipient = null;
    if (kind === 'message') {
      const tm = /\/(?:messages\/)?(e2ee\/)?t\/(\d+)/.exec(location.pathname);
      const nm = /^(?:írás nekik|írj neki|írj nekik|write to|message)\s*:?\s*([^:\s].*)$/i.exec(label);
      const mainEl = document.querySelector('[role="main"]') || document;
      const h3 = [...mainEl.querySelectorAll('h3')].map(h => U(h.innerText || '').split('\n')[0].trim()).find(x => x && x.length < 60 && !/információ|information|details|beszélgetés|chat/i.test(x));
      const groupChat = !!mainEl.querySelector('[aria-label^="Csoportos chat"], [aria-label^="Group chat"]');
      recipient = { name: (nm && nm[1]) || h3 || null, threadHeading: h3 || null, group: groupChat, e2ee: !!(tm && tm[1]), threadId: tm ? tm[2] : null, host: location.hostname };
      if (!recipient.name) warnings.push('A címzett (a megnyitott beszélgetés) neve nem azonosítható: ellenőrizd képernyőképen.');
      else if (recipient.threadHeading && nm && foldS(nm[1]) !== foldS(recipient.threadHeading)) warnings.push(`A doboz címzettje („${nm[1]}”) és a szál fejléce („${recipient.threadHeading}”) eltér: gyakran becenév vs. valódi név, ellenőrizd képernyőképen.`);
      if (recipient.group) warnings.push('Csoportos beszélgetés: a küldés MINDEN tagnak megy.');
    } else if (!asWhom) warnings.push('A „kinek a nevében” nem azonosítható.');
    const attachCount = Math.max(media.length, removeChips.length) + (linkPreview ? 1 : 0);
    return {
      ok: true, warnings, attachmentCount: attachCount,
      kind, page: pageInfo().url, where: heading, composerLabel: label || null, audience: audienceBtn, asWhom, recipient, sendHint: kind === 'message' && !publish ? 'Messengerben az Enter küld, a küldő gomb csak megjelenhet: a küldés előtt (Enter vagy gomb) a hook mindig kérdez' : undefined,
      replyTo, mention: replyTo?.mention || null, post, text, textLength: text.length,
      media, attachmentChips: removeChips, linkPreview,
      publishButton: publish,
      checklist: [
        'Cél (oldal/csoport/profil/komment) egyezik a kéréssel?',
        'Kinek a nevében (saját profil vs. kezelt oldal)?',
        'Közönség / láthatóság rendben?',
        'Szöveg betűre egyezik a jóváhagyott piszkozattal?',
        `Csatolmányok (${attachCount}): pontosan a jóváhagyott fájlok?`,
      ],
    };
  }

  function composeReport(c = composeCheck()) {
    if (!c.ok) return `⚠ ${c.problem}`;
    const L = ['# ÍRÁSI ELŐNÉZET — még NINCS közzétéve', '',
      `- **Művelet:** ${c.kind}`, `- **Oldal:** ${c.page}`, `- **Hely:** ${c.where || '?'}`,
      `- **Közönség:** ${c.audience || 'nem látható'}`, `- **Kinek a nevében:** ${c.asWhom || 'nem azonosítható — ellenőrizd a képernyőképen'}`];
    if (c.recipient) L.push(`- **Címzett (beszélgetés):** ${c.recipient.name || '⚠ NEM AZONOSÍTHATÓ'}${c.recipient.group ? ' · 👥 CSOPORT' : ''}${c.recipient.e2ee ? ' · 🔒 végpontig titkosított' : ''} · ${c.recipient.host}`);
    if (c.replyTo) L.push(`- **Válasz erre:** ${c.replyTo.author || '?'} (${c.replyTo.ref}, ${c.replyTo.via}) — „${c.replyTo.snippet || ''}”`);
    else if (c.kind === 'reply') L.push('- **Válasz erre:** ⚠ NEM AZONOSÍTHATÓ');
    if (c.post && (c.post.author || c.post.text) && c.kind !== 'post') L.push(`- **Poszt:** ${c.post.author || '?'} — „${c.post.text}” ${c.post.url || ''}`);
    if (c.warnings?.length) L.push('', '## ⚠ Figyelmeztetések (közzététel előtt tisztázandó)', ...c.warnings.map(w => `- ${w}`));
    L.push('', '## Szöveg', '```', c.text || '(üres)', '```', '', `## Csatolmányok (${c.attachmentCount ?? c.media.length})`);
    c.media.forEach((m, i) => L.push(`${i + 1}. ${m.kind}${m.alt ? ' — ' + m.alt : ''} (${m.src})`));
    c.attachmentChips.forEach(t => L.push(`- jelölő: ${t}`));
    if (c.linkPreview) L.push(`- link-előnézet: ${c.linkPreview.title} (${c.linkPreview.domain || ''})`);
    L.push('', `**Közzététel gomb:** ${c.publishButton ? `„${c.publishButton.label}”${c.publishButton.guessed ? ' (találgatott ikon)' : ''}${c.publishButton.disabled ? ' (inaktív)' : ''}` : 'nem található'} — csak a felhasználó kifejezett jóváhagyása után!`, '', ...c.checklist.map(x => `- [ ] ${x}`));
    return L.join('\n');
  }


  // ── Comment box of a post ────────────────────────────────────────────────
  function commentBox(post, { mark: doMark = false } = {}) {
    const root = resolvePost(post);
    const scope = root ? (root.closest?.(SEL.dialog) || root) : document;
    const isCommentBox = b => /hozzászól|comment|válasz|reply/i.test(labelOf(b));
    const boxes = [...scope.querySelectorAll('[contenteditable="true"]')].filter(b => isShown(b, document.body) && b.getBoundingClientRect().height > 0);
    const box = boxes.find(b => isCommentBox(b) && !b.closest(SEL.article + ':not(' + SEL.dialog + ')')) || boxes.find(isCommentBox) || null;
    let p = null; try { if (root) { const x = extractPost(root); p = { author: x.author, url: x.url, text: (x.text || '').slice(0, 120) }; } } catch { /* ignore */ }
    if (!box) {
      const btn = root && [...root.querySelectorAll('[data-ad-rendering-role="comment_button"], [role="button"]')]
        .find(b => b.matches('[data-ad-rendering-role="comment_button"]') || /^(hozzászólás|comment|hozzászólás írása|write a comment)$/i.test(labelOf(b)));
      return { found: false, post: p, openWith: btn ? { label: labelOf(btn), ...center(btn), target: tag(btn, 'open-comment') } : null,
        hint: 'A kommentmező még nincs nyitva: kattints a „Hozzászólás” gombra (action_summary: "Opens the comment box"), majd hívd újra.' };
    }
    const lab = labelOf(box);
    const m = /(?:hozzászólás|válasz|comment|reply)\s+(?:mint|as)\s+(.+?)\s*$/i.exec(lab);
    const rt = /válasz|reply/i.test(lab) ? replyTarget(box, root || document) : null;
    const replyTo = rt ? rt.author : null;
    const pos = doMark ? mark(box, '#2563eb') : center(box);
    const target = tag(box, 'comment-box');
    return { found: true, label: lab, asWhom: m ? m[1] : null, replyTo, text: U(box.innerText || '').trim(), x: pos.x, y: pos.y, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, post: p,
      target,
      note: 'Kattintás: find "' + target.ref + '" → computer left_click ref. ' + VIEWPORT_NOTE + ' Gépelés előtt a piszkozatnak jóváhagyottnak kell lennie; Entert soha ne nyomj.' };
  }

  // ── Reply box of ONE comment ────────────────────────────────────────────────
  // replyBox(post, 'c3' | 3 | {author, text} | 'szövegrészlet', {mark}) — c-number from thread()/extractComments.
  // Returns the open reply box of that comment (tag [fbr:reply-box]) or, when it is not open yet, its "Válasz" button
  // (tag [fbr:reply-c3]) → find → click(ref), then call again. The box's own addressee is verified, never assumed.
  function replyBox(post, ref, { mark: doMark = false } = {}) {
    const root = resolvePost(post);
    if (!root) return { found: false, error: 'nem található a poszt (post: "#horgony" / index / selector)' };
    const arts = commentArticles(root);
    let n = null;
    if (typeof ref === 'number') n = ref;
    else if (/^c?\d+$/i.test(String(ref ?? ''))) n = +String(ref).replace(/^c/i, '');
    else if (ref != null) {
      const infos = arts.map((a, i) => ({ i, ...commentInfo(a) }));
      const hit = typeof ref === 'object'
        ? infos.find(x => (!ref.author || foldS(x.author).includes(foldS(ref.author))) && (!ref.text || foldS(x.text).includes(foldS(ref.text))))
        : infos.find(x => foldS(x.author).includes(foldS(ref))) || infos.find(x => foldS(x.text).includes(foldS(ref)));
      n = hit ? hit.i + 1 : null;
    }
    const art = n ? arts[n - 1] : null;
    if (!art) return { found: false, error: `nincs ilyen komment (${ref}); ${arts.length} komment van betöltve: thread() listázza, expandComments({post}) tölt még` };
    const info = commentInfo(art);
    const comment = { n, ref: 'c' + n, author: info.author, snippet: info.text };
    const boxes = [...root.querySelectorAll('[contenteditable="true"]')].filter(b => isShown(b, document.body) && b.getBoundingClientRect().height > 0 && /válasz|reply/i.test(labelOf(b)));
    const mine = boxes.find(b => { const rt = replyTarget(b, root); return rt && rt.n === n; });
    if (mine) {
      const lab = labelOf(mine), m = /(?:hozzászólás|válasz|comment|reply)\s+(?:mint|as)\s+(.+?)\s*$/i.exec(lab);
      const rt = replyTarget(mine, root);
      const pos = doMark ? mark(mine, '#2563eb') : center(mine);
      const target = tag(mine, 'reply-box');
      return { found: true, comment, label: lab, asWhom: m ? m[1] : null, replyTo: rt, text: U(mine.innerText || '').trim(), x: pos.x, y: pos.y, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, target,
        note: 'Kattintás: find "' + target.ref + '" → computer left_click ref → computer type a jóváhagyott szöveg (a FB maga beírja a címzett nevét az elejére; azt ne gépeld újra). Entert soha ne nyomj. Küldés előtt composeReport().' };
    }
    const own = el => el.closest(SEL.article) === art;
    const btn = [...art.querySelectorAll('[role="button"], a[role="link"], [aria-label]')].find(b => own(b) && /^(válasz|reply)(?!\s*(küld|send))/i.test(labelOf(b)) && !b.matches('[contenteditable]'));
    if (!btn) return { found: false, comment, error: 'nincs „Válasz” gomb ennél a kommentnél (zárolt / törölt / nem látható)' };
    btn.scrollIntoView({ block: 'center' });
    if (doMark) mark(btn, '#2563eb');
    return { found: false, comment, openWith: { label: labelOf(btn), ...center(btn), target: tag(btn, 'reply-c' + n) },
      hint: 'A válaszdoboz még nincs nyitva: find "[fbr:reply-c' + n + ']" → computer left_click ref (action_summary: "Opens the reply box of ' + (info.author || 'the comment') + '"), majd hívd újra a replyBox-ot.' };
  }

  // ── Inbox locators (locate & report, never click) ───────────────────────────────────────────────
  const first = (sel, re, root = document) => [...root.querySelectorAll(sel)].find(e => isShown(e, document.body) && e.getBoundingClientRect().height > 0 && re.test(labelOf(e)));
  const located = (el, id, miss) => {
    if (!el) return { found: false, ...miss };
    el.scrollIntoView({ block: 'center' });
    const c = center(el);
    return { found: true, label: labelOf(el), x: c.x, y: c.y, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, target: tag(el, id) };
  };
  // "Korábbi értesítések megjelenítése" (loads older notifications: a read action)
  const notifMore = () => located(first('[role="button"], a', /^(korábbi értesítések megjelenítése|see (previous|earlier|more) notifications|előző értesítések)/i), 'notif-more',
    { hint: 'nincs „Korábbi értesítések megjelenítése” gomb: nincs több betöltendő, vagy nem az értesítés-oldalon vagy.' });
  // the Messenger search field (typing into it is a computer `type` action; the hook asks first)
  const msgSearch = () => located(first('input, [role="searchbox"], [role="combobox"]', /^(keresés a messengeren|search messenger|keresés a chatekben|search chats)/i), 'msg-search',
    { hint: 'nincs Messenger-kereső mező: nyisd meg a Messenger oldalt (nav.messages() / nav.messenger()).' });
  // the "Message requests" entry (usually inside the ⚙ / "…" menu of the chat list)
  const msgRequests = () => located(first('[role="menuitem"], [role="button"], [role="tab"], a', /(üzenetkérés|message requests|kéretlen|spam)/i), 'msg-requests',
    { hint: 'nem látszik az „Üzenetkérések” pont: nyisd meg a chatlista ⚙/… menüjét (find „Beállítások” → kattintás), majd hívd újra.' });
  // accept / decline style buttons in an opened message request (GUESSED by label; confirm by screenshot, both are writes)
  function threadActions() {
    const ACC = /^(elfogadás|accept)$/i, DEC = /^(elutasítás|decline|törlés|delete|blokkolás|block|jelentés|report|spam)/i;
    const main = document.querySelector('[role="main"]') || document;
    const out = {};
    const a = first('[role="button"]', ACC, main), d = first('[role="button"]', DEC, main);
    if (a) out.accept = { label: labelOf(a), ...center(a), target: tag(a, 'req-accept') };
    if (d) out.decline = { label: labelOf(d), ...center(d), target: tag(d, 'req-decline') };
    return Object.keys(out).length ? { found: true, ...out, note: 'Mindkettő ÍRÁS: a felhasználó kifejezett jóváhagyása nélkül nem kattints. Az elfogadás látásjelzést is küldhet.' } : { found: false, hint: 'nincs elfogadás/elutasítás gomb a megnyitott szálban (ez nem üzenetkérés?)' };
  }

  // ── Marketplace controls (locate & report, never click) ────────────────────────────────────────────────
  // Filters are best set through URL parameters (nav.marketplace). These locate the buttons that URLs cannot reach:
  // the location/radius picker, and the two WRITES: messaging the seller and saving a search alert.
  const MK_CONTROLS = {
    location: [/^(helyszín|location)\b/i, false], sort: [/^(rendezés|sort)\b/i, false], delivery: [/^(szállítási mód|delivery method)/i, false],
    condition: [/^(állapot|condition)\b/i, false], date: [/^(hirdetés kezdetének dátuma|date listed)/i, false], availability: [/^(elérhetőség|availability)/i, false],
    sellerType: [/^(eladó típusa|seller type)/i, false],
    alert: [/^(értesítést kérek|get notifications|save search|keresés mentése)/i, true],
    message: [/^(üzenet|message|send message|üzenet küldése)$/i, true],
  };
  function marketControl(name) {
    const c = MK_CONTROLS[name];
    if (!c) return { found: false, error: 'marketControl: ' + Object.keys(MK_CONTROLS).join('|') };
    const txt = e => U(e.innerText || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    // Some controls carry their name only in aria-label (the location button shows "Dunaújváros · 65 km-en belül" but is labelled "Helyszín: …").
    // A control we tagged earlier keeps its real label in data-fbr-orig, so a second call still finds it.
    const aria = e => { const o = e.getAttribute('data-fbr-orig'); return U(o !== null ? (o === '\u0000' ? '' : o) : (e.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim(); };
    const el = [...document.querySelectorAll('[role="button"], [role="combobox"], a[role="link"], button')].find(e => isShown(e, document.body) && e.getBoundingClientRect().height > 0 && (c[0].test(txt(e)) || c[0].test(aria(e))));
    if (!el) return { found: false, hint: `nincs „${name}” vezérlő: nem a Marketplace találati vagy hirdetés-oldalon vagy (a szűrők az URL-ből: nav.marketplace)` };
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { found: true, name, label: txt(el).slice(0, 80), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, target: tag(el, 'mk-' + name),
      write: c[1], note: c[1] ? (name === 'message' ? 'ÍRÁS: a megnyitás még nem küld, de az üzenet a védelmi protokollal megy (címzett = az eladó, a hirdetés linkjével).' : 'ÍRÁS: értesítést állít be a fiókodban; a felhasználó kifejezett jóváhagyása nélkül nem kattints.') : 'olvasás: a menü megnyitása nem módosít semmit; a szűrő a menüben kiválasztva megváltoztatja a keresést (URL-ből egyszerűbb).' };
  }

  // ── Selling: the listing form (Marketplace /marketplace/create/item or the group's "Eladó tárgy" dialog) ──────────
  // sellCheck() reads what is filled in, tags the controls ([fbr:sell-<name>] → find → click/type) and warns about gaps;
  // sellReport() is the preview the user approves BEFORE anything is typed or published. Nothing here clicks, types or publishes.
  const SELL_BTN = { photos: /^(fényképek hozzáadása|add photos)/i, more: /^(további részletek|more details)/i, next: /^(tovább|next)$/i, publish: /^(közzététel|publish|post)$/i, draft: /^(piszkozat mentése|save draft)/i, back: /^(vissza|back)$/i };
  const SELL_COMBO = { category: /^(kategória|category)\b/i, condition: /^(állapot|condition)\b/i };
  const SELL_SWITCH = { hideFromFriends: /elrejtés az ismerősök elől|hide from friends/i, boost: /kiemelése a közzététel után|boost listing/i };
  function sellCheck() {
    const vis = e => isShown(e, document.body) && e.getBoundingClientRect().width > 0;
    const lab = e => U((e.closest('label')?.innerText) || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    const tl = e => U(e.innerText || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const dlgs = [...document.querySelectorAll('[role="dialog"]')].filter(vis);
    const btnIn = (r, rx) => [...r.querySelectorAll('[role="button"], button')].find(e => vis(e) && rx.test(tl(e)));
    const field = (r, rx) => [...r.querySelectorAll('input:not([type="checkbox"]):not([type="file"]), textarea')].find(e => vis(e) && rx.test(lab(e)));
    const hasTitle = r => !!field(r, /^(megnevezés|cím|title)\b/i);
    const main = document.querySelector('[role="main"]');
    const root = dlgs.find(hasTitle) || dlgs.find(d => btnIn(d, SELL_BTN.publish) && btnIn(d, SELL_BTN.back)) || (/\/marketplace\/create\//.test(location.pathname) && main ? main : null);
    if (!root) return { ok: false, problem: 'nincs megnyitott hirdetésfeladó űrlap: Marketplace → nav.marketplaceCreate() (…/marketplace/create/item), vagy csoportban az „Eladó tárgy” gomb (action_summary: "Opens the sell-item dialog")' };
    const controls = {}, put = (n, el) => { if (el) { el.scrollIntoView?.({ block: 'center' }); controls[n] = { ref: tag(el, 'sell-' + n).ref, disabled: el.getAttribute('aria-disabled') === 'true' || el.disabled === true }; } return el; };
    const titleEl = put('title', field(root, /^(megnevezés|cím|title)\b/i)), priceEl = put('price', field(root, /^(ár|price)\b/i));
    const descEl = put('description', field(root, /^(leírás|description)\b/i) || [...root.querySelectorAll('[contenteditable="true"], [role="textbox"]')].find(e => vis(e) && /leírás|description/i.test(lab(e) || tl(e))));
    const combos = {}; for (const [n, rx] of Object.entries(SELL_COMBO)) { const el = put(n, [...root.querySelectorAll('[role="combobox"]')].find(e => vis(e) && rx.test(tl(e)))); if (el) combos[n] = tl(el).split('\n')[0] && tl(el).replace(rx, '').trim(); }
    for (const n of Object.keys(SELL_BTN)) put(n, btnIn(root, SELL_BTN[n]));
    const sw = {}; for (const [n, rx] of Object.entries(SELL_SWITCH)) { const el = [...root.querySelectorAll('input[role="switch"], input[type="checkbox"]')].find(e => rx.test(lab(e))); if (el) sw[n] = !!el.checked; }
    const checks = [...root.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(e => !Object.values(SELL_SWITCH).some(rx => rx.test(lab(e) || tl(e)))).map(e => ({ label: (lab(e) || tl(e)).slice(0, 60), checked: e.checked ?? e.getAttribute('aria-checked') === 'true' })).filter(c => c.label);
    const txt = U(root.innerText || ''), lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
    const pm = /(\d+)\s*\/\s*(\d+)/.exec(lines.find(l => /^(fényképek|photos)\b.*\d+\s*\/\s*\d+/i.test(l)) || ''), pc = /(\d+)\s*(csatolt fénykép|photos? attached)/i.exec(txt);
    const photos = pc ? +pc[1] : pm ? +pm[1] : null;
    const ai = lines.findIndex(l => /közzététele|publish(ing)? (on|in|to)/i.test(l)), am = ai >= 0 ? /^(.*?)\s*·\s*(.+)$/.exec(lines[ai]) : null;
    const grp = /^\/groups\//.test(location.pathname), gname = grp ? document.title.replace(/\s*\|\s*Facebook\s*$/, '').trim() : null;
    let seller = ai > 0 ? lines[ai - 1] : null; if (!seller) { try { seller = R.me?.().name || null; } catch (e) { /* ignore */ } }
    const f = { title: titleEl ? titleEl.value || '' : null, price: priceEl ? priceEl.value || '' : null, category: combos.category ?? null, condition: combos.condition ?? null,
      description: descEl ? (descEl.value ?? descEl.innerText ?? '').trim() : null };
    const step = titleEl ? 1 : 2, warnings = [], missing = [];
    if (step === 1) {
      if (!f.title) missing.push('megnevezés'); else if (f.title.length > 100) warnings.push(`a megnevezés ${f.title.length} karakter (a Facebook 100-nál vág)`);
      if (!f.price) missing.push('ár'); else if (!/^\d[\d\s.,]*$/.test(f.price) || +f.price.replace(/\D/g, '') === 0) warnings.push(`az ár „${f.price}” – szám kell (0 = ingyen/ajándék)`);
      if (!grp && f.category !== null && !f.category) missing.push('kategória');
      if (f.condition !== null && !f.condition) missing.push('állapot');
      if (photos === 0) warnings.push('nincs fotó: fotó nélkül a hirdetés alig kap érdeklődőt');
      if (descEl == null) warnings.push('a leírás mezőt a „További részletek” alatt találod (more → kattintás), üresen is közzétehető, de gyengébb');
      else if (!f.description) warnings.push('a leírás üres');
    } else {
      const on = checks.filter(c => c.checked && /csoport|group/i.test(c.label)); if (on.length) warnings.push(`CSOPORTBA(OK)BA is kerül: ${on.map(c => c.label).join(', ')}`);
    }
    if (sw.hideFromFriends === false && !grp) warnings.push('a hirdetés nyilvános; az ismerősök is látják (az „Elrejtés az ismerősök elől” kapcsoló ki)');
    return { ok: true, kind: 'listing', step, target: { kind: grp ? 'group' : 'marketplace', name: gname || 'Marketplace', audience: am ? am[2] : null, page: location.pathname }, seller, fields: f, photos, photoMax: pm ? +pm[2] : null, options: sw, checks, controls, missing, warnings, ready: !missing.length,
      note: 'Csak olvasás/jelölés. Kitöltés: find "[fbr:sell-title]" → kattintás → type (a hook a jóváhagyott szöveggel veti össze), közzététel csak jóváhagyás után.' };
  }
  const sellForm = sellCheck;
  function sellReport(c = sellCheck()) {
    if (!c.ok) return `⚠ ${c.problem}`;
    const f = c.fields, t = c.target;
    const L = ['# HIRDETÉS ELŐNÉZET — még NINCS közzétéve', '', `- **Hova:** ${t.kind === 'group' ? '👥 csoport — ' + t.name : '🛒 ' + t.name}${t.audience ? ' · ' + t.audience : ''}`, `- **Kinek a nevében:** ${c.seller || 'nem azonosítható — ellenőrizd a képernyőképen'}`, `- **Lépés:** ${c.step}/2`];
    if (c.step === 1) L.push(`- **Megnevezés:** ${f.title || '⚠ üres'}`, `- **Ár:** ${f.price ? f.price + ' Ft' : '⚠ üres'}`, ...(f.category !== null ? [`- **Kategória:** ${f.category || '⚠ nincs kiválasztva'}`] : []), ...(f.condition !== null ? [`- **Állapot:** ${f.condition || '⚠ nincs kiválasztva'}`] : []), `- **Fotók:** ${c.photos ?? '?'}${c.photoMax ? '/' + c.photoMax : ''}`);
    if (c.options && Object.keys(c.options).length) L.push(`- **Beállítások:** ${Object.entries(c.options).map(([k, v]) => `${k}: ${v ? 'be' : 'ki'}`).join(', ')}`);
    if (c.checks.length) L.push(`- **Közzététel helyei / opciók:** ${c.checks.map(x => (x.checked ? '☑ ' : '☐ ') + x.label).join(' · ')}`);
    if (c.missing.length) L.push('', `## ⚠ Hiányzik: ${c.missing.join(', ')}`);
    if (c.warnings.length) L.push('', '## ⚠ Figyelmeztetések', ...c.warnings.map(w => `- ${w}`));
    if (c.step === 1) L.push('', '## Leírás', '```', f.description || '(üres)', '```');
    const pub = c.controls.publish, nx = c.controls.next;
    L.push('', `**Gombok:** ${nx ? 'Tovább' + (nx.disabled ? ' (inaktív)' : '') : '–'} · ${pub ? 'Közzététel' + (pub.disabled ? ' (inaktív)' : '') : '–'} — közzététel csak a felhasználó kifejezett jóváhagyása után!`, '',
      '- [ ] a cél (Marketplace vagy a csoport neve) pontosan az, ami kell', '- [ ] megnevezés, ár, leírás betűre az, amit jóváhagytál', '- [ ] a fotók a jóváhagyott fájlok', '- [ ] a hirdetés nyilvános: nincs benne telefonszám, cím, személyes adat, ha nem akarod');
    return L.join('\n');
  }

  // ── Reactions: locate, never click ───────────────────────────────────────
  const REACTIONS = { like: ['tetszik', 'like'], love: ['imádom', 'love'], care: ['törődöm', 'care'], haha: ['haha'], wow: ['hűha', 'wow'], sad: ['szomorú', 'sad'], angry: ['dühös', 'angry'] };
  async function react(type = 'like', { post, mark: doMark = true, budgetMs = 4000 } = {}) {
    const key = Object.keys(REACTIONS).find(k => k === String(type).toLowerCase() || REACTIONS[k].includes(String(type).toLowerCase()));
    if (!key) return { found: false, error: `ismeretlen reakció: ${type} (${Object.keys(REACTIONS).join('|')})` };
    const root = resolvePost(post);
    if (!root) return { found: false, error: 'nem található a poszt (findPost / post index / url)' };
    const likeBtn = ownLikeButton(root);
    if (!likeBtn) return { found: false, error: 'nincs „Tetszik” gomb ennél a posztnál' };
    likeBtn.scrollIntoView({ block: 'center' });
    await sleep(350);
    const before = new Set(document.querySelectorAll('[aria-label]'));
    hover(likeBtn);
    const t0 = Date.now();
    let target = null;
    while (!target && Date.now() - t0 < budgetMs) {
      await sleep(200);
      target = [...document.querySelectorAll('[aria-label]')].find(e => e !== likeBtn && !likeBtn.contains(e)
        && REACTIONS[key].includes(labelOf(e).toLowerCase()) && isShown(e, document.body)
        && e.getBoundingClientRect().width > 0 && (!before.has(e) || e.closest('[role="toolbar"], [role="dialog"], [role="menu"]')));
    }
    const lb = { label: labelOf(likeBtn), pressed: likeBtn.getAttribute('aria-pressed') === 'true', ...center(likeBtn) };
    lb.target = tag(likeBtn, 'like');
    if (!target) return { found: false, type: key, likeButton: lb, error: 'a reakciósáv nem jelent meg — hover a likeButton-ra (find ' + lb.target.ref + ' → computer hover ref), majd hívd újra' };
    const pos = doMark ? mark(target) : center(target);
    const tg = tag(target, key);
    return { found: true, type: key, label: labelOf(target), target: tg, x: pos.x, y: pos.y, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, likeButton: lb,
      note: 'NEM kattintottam. Jóváhagyás után: find "' + tg.ref + '" → computer left_click ref (nincs koordináta-átszámolás). Ha a sáv bezárult: hover ' + lb.target.ref + ', majd találd meg újra. Utána: reactionState(), végül unmark().' };
  }

  function reactionState(post) {
    const root = resolvePost(post);
    if (!root) return { found: false };
    const b = ownLikeButton(root);
    const lab = b ? labelOf(b) : null;
    const txt = b ? U(b.innerText || '').trim().split('\n')[0] : null;
    const word = t => Object.keys(REACTIONS).find(k => REACTIONS[k].some(n => new RegExp('(^|[\\s:])' + n + '($|\\b)', 'i').test(t || '')));
    const neutral = t => /^(tetszik|like|reagálás|react)$/i.test(t || '');
    const textual = txt && !/^[\d\s.,]+(e|k|m|ezer)?$/i.test(txt) ? txt : null;
    const pressed = b ? (b.getAttribute('aria-pressed') === 'true' || /^(eltávolítás|remove|change|módosítás)/i.test(lab || '')
      || (!!lab && !neutral(lab) && !!word(lab)) || (!!textual && !neutral(textual) && !!word(textual))) : null;
    return { found: true, myReaction: pressed ? (word(lab) || word(textual) || lab) : null, pressed, buttonLabel: lab, counts: extractCounts(root) };
  }

  Object.assign(window.__fbReader, { composeCheck, composeReport, commentBox, replyBox, notifMore, msgSearch, msgRequests, threadActions, marketControl, sellCheck, sellForm, sellReport, react, reactionState, untag, writeModule: WRITE_VERSION });
  if (!R.unmark.__w) { const um = R.unmark; R.unmark = () => um() + ' · ' + untag(); R.unmark.__w = true; }
})();
window.__fbReader.status();
