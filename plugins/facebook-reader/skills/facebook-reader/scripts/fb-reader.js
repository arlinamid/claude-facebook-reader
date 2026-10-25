/*
 * fb-reader.js — de-obfuscating Facebook content extractor (browser side)
 *
 * Paste the whole file into a page-context JS evaluator (Claude in Chrome
 * `javascript_tool`, built-in browser, Playwright `page.evaluate`, DevTools).
 * Idempotent: re-injecting only replaces window.__fbReader.
 *
 * Quick use (each line is a separate evaluate call after injection):
 *   __fbReader.extract({ format: 'md' })            // visible posts → Markdown
 *   __fbReader.extract({ format: 'json', comments: true })
 *   await __fbReader.expandSeeMore()                // click "Továbbiak"/"See more"
 *   await __fbReader.expandComments({ rounds: 3 })  // "Több hozzászólás"/"View more comments"
 *   __fbReader.harvest.start()                      // collect while FB virtualizes the feed
 *   await __fbReader.harvest.scroll({ steps: 15 })
 *   __fbReader.harvest.dump({ format: 'md', limit: 50 })
 *   await __fbReader.hoverDates()                   // last-resort tooltip date decode
 *
 * Built on the DOM knowledge of facebook-private-group-scraper and Shadowcast
 * (fb-ytembed-plugin). Never relies on generated class names (x1i10hfl …).
 */
(() => {
  'use strict';

  const VERSION = '0.13.3';
  const BUILD = '__BUILD__'; // replaced by build.py with a content hash

  // ── Selectors (semantic anchors only) ────────────────────────────────────
  const SEL = {
    feedPost: '[role="main"] [aria-posinset], [role="feed"] [aria-posinset]',
    dialog: '[role="dialog"]',
    article: '[role="article"]',
    message:
      '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]',
    profileName: '[data-ad-rendering-role="profile_name"]',
    cardTitle: '[data-ad-rendering-role="title"]',
    cardMeta: '[data-ad-rendering-role="meta"]',
    cardDesc: '[data-ad-rendering-role="description"]',
    cardImage: '[data-ad-rendering-role="image"]',
  };

  // ── Language packs ────────────────────────────────────────────────────────
  // Everything that depends on the Facebook UI LANGUAGE lives in these tables: month names, relative-time units,
  // UI words, badge / label patterns. A pack is plain data (see references/i18n.md): add a language with
  // __fbReader.registerLang({…}) or by appending an entry here. The reader works with the UNION of all packs, so
  // no detection is needed to read a page; the page language (<html lang>) is only reported (lang(), selfTest()).
  //   r: regex SOURCE fragments (matched case-insensitively, no anchors)     w: literal lowercase phrases
  //   rel.long: "ago" forms ("perce", "hours") — also valid after "one" words    rel.short: "3h", "5 p", "2d"
  const PACKS = {
    hu: {
      id: 'hu', name: 'magyar', verified: true, // verified = tested against the real Facebook UI
      months: { 'január': 0, 'jan': 0, 'február': 1, 'febr': 1, 'feb': 1, 'március': 2, 'márc': 2, 'április': 3, 'ápr': 3, 'május': 4, 'máj': 4,
        'június': 5, 'jún': 5, 'július': 6, 'júl': 6, 'augusztus': 7, 'aug': 7, 'szeptember': 8, 'szept': 8, 'szep': 8, 'október': 9, 'okt': 9,
        'november': 10, 'nov': 10, 'december': 11, 'dec': 11 },
      rel: {
        long: { sec: ['másodperce'], min: ['perce'], hour: ['órája'], day: ['napja'], week: ['hete'], month: ['hónapja'], year: ['éve'] },
        short: { sec: ['mp'], min: ['perc', 'p'], hour: ['óra', 'ó'], day: ['nap', 'n'], week: ['hét'], month: ['hónap', 'hó'], year: ['év'] },
        one: ['egy'], ago: [], agoPre: [], now: ['most', 'épp most', 'néhány másodperce'], yesterday: ['tegnap'], am: ['de'], pm: ['du'],
      },
      count: { k: ['e', 'ezer'], m: ['millió'] },
      w: {
        seeMore: ['továbbiak', 'tovább', 'több megjelenítése'],
        noise: ['továbbiak', 'kevesebb megjelenítése', 'tetszik', 'hozzászólás', 'megosztás', 'válasz', 'követés', 'csatlakozás', 'fordítás megtekintése'],
        seeLess: ['kevesebb megjelenítése'], translate: ['fordítás megtekintése'], viewPost: ['bejegyzés megtekintése'],
        nextPhoto: ['következő fénykép', 'következő videó', 'következő'], prevPhoto: ['előző fénykép', 'előző videó', 'előző'],
        sponsored: ['hirdetés', 'szponzorált', 'támogatott', 'fizetett partnerség'], verified: ['ellenőrzött fiók', 'hitelesített'],
        person: ['ember'],
        keep: ('tetszik szuper imádom törődöm haha vicces hűha szomorú dühös reagálás reakció reakciók hozzászólás hozzászólása hozzászólására válasz válasza ' +
          'válaszára megosztás megosztva továbbiak kevesebb megjelenítése mint bejegyzése bejegyzés szerző felül rögzített rögzítve hirdetés szponzorált ' +
          'követés csatolt fotó videó kép jelenleg ember embertől egy ma hétfő kedd szerda csütörtök péntek szombat vasárnap legrelevánsabb legfrissebb ' +
          'összes további megtekintése megtekintés mutat írj hozzászólást nyilvános privát csoport').split(' '),
      },
      r: {
        commentLabel: ['hozzászól', 'válasz', 'komment'],
        moreComments: ['több hozzászólás', 'további hozzászólások', 'összes hozzászólás', '\\d+ válasz', 'összes válasz'],
        uiLine: ['elemzési adatok megtekintése', '\\d[\\d\\s.,]*\\s*bejegyzéselérés', 'hozzászólás mint .*', 'írj hozzászólást.*', 'láthatóság:.*', 'szerkesztve',
          'további hozzászólások', '\\d+ válasz megtekintése', 'összes válasz megtekintése', '(a |az )?(legrelevánsabb(ak)?|legújabbak|legfrissebb(ek)?|összes hozzászólás)'],
        publish: ['közzététel', 'közzétesz', 'posztolás', 'bejegyzés', 'küldés', 'elküld', 'megosztás most', 'megosztás', 'hozzászólás küldése', 'válasz küldése', 'mentés',
          'frissítés', 'csatlakozás', 'tetszik', 'kérés', 'jóváhagyás', 'elutasítás', 'törlés'],
        reaction: ['tetszik', 'szuper', 'imádom', 'törődöm', 'haha', 'vicces', 'hűha', 'szomorú', 'dühös'],
        reactionsWord: ['összes reakció', 'reakció'], reactionAttr: ['reakci'], verifiedAttr: ['llenőrzött'],
        commentsWord: ['hozzászólás'], sharesWord: ['megosztás'], skipDateLabel: ['reakci', 'hozzászól'],
        pinned: ['felül rögzített( hozzászólás)?', 'rögzített hozzászólás', 'kitűzött( hozzászólás)?', 'kitűzve'],
        authorBadge: ['szerző', 'a szerző', 'alkotó'], badgeLine: ['legjobb hozzászóló', 'felül rögzített( hozzászólás)?'],
        sortAll: ['(az )?összes hozzászólás'], sortNewest: ['(a )?(legújabbak|legfrissebb(ek)?)'], sortRelevant: ['(a )?legrelevánsabb(ak)?'], sortOther: ['(a )?legrégebbi(ek)?'],
        postBy: ['^(.+?)\\s+bejegyzése$'], replyTo: ['^válasz\\b.*?\\bneki:?\\s+(.+?)$'],
      },
      // aria-label of a comment: groups a = author, to = addressee (replies), when = age
      commentLabels: [
        { re: '^(.+?)\\s+(?:hozzászólása|válasza|megjegyzése)(?:\\s+(.+?)\\s+(?:hozzászólására|válaszára))?\\s*\\((.+)\\)\\s*$', a: 1, to: 2, when: 3 },
        { re: '^(?:hozzászólás|válasz)\\s+tőle:\\s*([^,]+?)(?:,\\s*(.+))?$', a: 1, when: 2 },
      ],
    },
    en: {
      id: 'en', name: 'English', verified: false,
      months: { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
        september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 },
      rel: {
        long: { sec: ['seconds', 'second'], min: ['minutes', 'minute'], hour: ['hours', 'hour'], day: ['days', 'day'], week: ['weeks', 'week'], month: ['months', 'month'], year: ['years', 'year'] },
        short: { sec: ['sec', 's'], min: ['mins', 'min', 'm'], hour: ['hrs', 'hr', 'h'], day: ['d'], week: ['wks', 'wk', 'w'], month: ['mo'], year: ['yrs', 'yr', 'y'] },
        one: ['an', 'a', 'one'], ago: ['ago'], agoPre: [], now: ['just now', 'now'], yesterday: ['yesterday'], am: ['am'], pm: ['pm'],
      },
      count: { k: ['k'], m: ['m'] },
      w: {
        seeMore: ['see more', 'see more…'],
        noise: ['see more', 'see less', 'like', 'comment', 'share', 'reply', 'follow', 'join', 'see translation'],
        seeLess: ['see less'], translate: ['see translation'], viewPost: ['view post'],
        nextPhoto: ['next photo', 'next video', 'next'], prevPhoto: ['previous photo', 'previous video', 'previous'],
        sponsored: ['sponsored', 'promoted', 'paid partnership'], verified: ['verified account'],
        person: ['people', 'person'],
        keep: ('like love care sad angry wow comment reply share see more view all posts photo video by as author pinned ago just now yesterday ' +
          'monday tuesday wednesday thursday friday saturday sunday').split(' '),
      },
      r: {
        commentLabel: ['comment', 'reply'],
        moreComments: ['view more comments', 'view all \\d+ comments', 'more comments', '\\d+ (reply|replies)', 'view \\d+ more repl', 'view all \\d+ repl'],
        uiLine: ['view insights', '\\d[\\d\\s.,]*\\s*(post )?reach', 'comment as .*', 'write a comment.*', 'edited', 'view \\d+ (more )?repl(y|ies)', 'view more comments',
          'more comments', 'most relevant', 'all comments', 'newest'],
        publish: ['post', 'publish', 'send', 'share( now)?', 'comment', 'reply', 'save', 'update', 'join', 'like', 'request', 'approve', 'decline', 'delete'],
        reaction: ['like', 'love', 'care', 'wow', 'sad', 'angry'],
        reactionsWord: ['all reactions', 'reactions?'], reactionAttr: ['eaction'], verifiedAttr: ['erified'],
        commentsWord: ['comments?'], sharesWord: ['shares?'], skipDateLabel: ['reaction', 'comment'],
        pinned: ['pinned( comment)?', 'pinned by .*'],
        authorBadge: ['author', 'creator'], badgeLine: ['top fan', 'top contributor', 'pinned( comment)?'],
        sortAll: ['all comments'], sortNewest: ['newest', 'most recent'], sortRelevant: ['most relevant'], sortOther: ['oldest'],
        postBy: ['^(.+?)[\'’]s post$'], replyTo: ['^reply\\b.*?\\bto\\s+(.+?)(?:[\'’]s comment)?$'],
      },
      commentLabels: [
        { re: '^(?:comment|reply)\\s+by\\s+(.+?)\\s+((?:\\d+|an?|one)\\s+\\w+\\s+ago|yesterday|just now)$', a: 1, when: 2 },
        { re: '^(?:comment|reply)\\s+by\\s+(.+)$', a: 1 },
      ],
    },
  };

  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byLen = (a, b) => b.length - a.length;
  const pk = () => Object.values(PACKS);
  const rAll = key => pk().flatMap(p => (p.r && p.r[key]) || []);
  const wAll = key => pk().flatMap(p => (p.w && p.w[key]) || []);
  const RX = (key, pre = '', post = '', flags = 'i') => new RegExp(pre + '(?:' + (rAll(key).join('|') || '(?!)') + ')' + post, flags);
  const UNIT_BASE = { sec: 1e3, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
  // derived vocabulary (rebuilt by buildVocab() whenever a pack is registered); the names below are used all over the reader
  let COMMENT_LABEL_RE, SEE_MORE, MORE_COMMENTS_RE, UI_NOISE, PUBLISH_RE, MONTHS, MONTH_HINT_RE, UI_LINE_RE, CNT, UNIT, REL_RE, YESTERDAY_RE, NOW_RE, AMPM_RE,
    REACTION_RE, BARE_NUM_RE, PINNED_RE, AUTHOR_BADGE_RE, BADGE_LINE_RE, SPONSORED_RE, SORT_RE, SORT_ANY, VERIFIED_RE, VERIFIED_SEL, REACTION_ATTR_SEL, SKIP_DATE_RE,
    COMMENT_LABEL_PARSE, REPLY_TO_RES, POST_BY_RES, VIEW_POST_RE, NEXT_PHOTO_RE, PREV_PHOTO_RE, KEEP_WORDS, NOTIF_TIME_RE, COMMENTS_COUNT_RE, SHARES_COUNT_RE, REACTIONS_WORD_RE, AM, PM;
  function buildVocab() {
    COMMENT_LABEL_RE = RX('commentLabel');
    SEE_MORE = wAll('seeMore');
    MORE_COMMENTS_RE = RX('moreComments', '^');
    UI_NOISE = new Set([...wAll('noise'), 'facebook']);
    PUBLISH_RE = RX('publish', '^', '$');
    MONTHS = Object.assign(Object.create(null), ...pk().map(p => p.months));
    const long = [], all = [];
    UNIT = Object.create(null);
    for (const p of pk()) for (const k of Object.keys(UNIT_BASE)) {
      for (const t of (p.rel.long[k] || [])) { UNIT[t] = UNIT_BASE[k]; long.push(t); all.push(t); }
      for (const t of (p.rel.short[k] || [])) { UNIT[t] = UNIT_BASE[k]; all.push(t); }
    }
    const alt = a => [...new Set(a)].sort(byLen).map(esc).join('|') || '(?!)';
    const one = alt(pk().flatMap(p => p.rel.one)), agoPre = pk().flatMap(p => p.rel.agoPre || []);
    REL_RE = new RegExp('^' + (agoPre.length ? '(?:(?:' + alt(agoPre) + ')\\s+)?' : '') + '(?:(\\d+)\\s*(' + alt(all) + ')|(' + one + ')\\s+(' + alt(long) + '))(?![\\p{L}])', 'iu');
    YESTERDAY_RE = new RegExp(alt(pk().flatMap(p => p.rel.yesterday)), 'u');
    NOW_RE = new RegExp('^(?:' + alt(pk().flatMap(p => p.rel.now)) + ')$');
    AM = pk().flatMap(p => p.rel.am); PM = pk().flatMap(p => p.rel.pm);
    AMPM_RE = new RegExp('(\\d{1,2})[:.](\\d{2})\\s*(' + alt([...AM, ...PM]) + ')?\\.?', 'i');
    MONTH_HINT_RE = new RegExp('20\\d\\d|' + alt(Object.keys(MONTHS)) + '|' + alt(pk().flatMap(p => p.rel.yesterday)) + '|' + alt(pk().flatMap(p => p.rel.ago || [])) + '|' +
      alt(long) + '|^\\s*\\d+\\s*(?:' + alt(all) + ')(?![\\p{L}])', 'iu');
    NOTIF_TIME_RE = new RegExp('^(\\d+\\s*(?:' + alt(all) + ')(?![\\p{L}\\d])\\.?|' + alt(pk().flatMap(p => p.rel.yesterday)) + '|' + alt(pk().flatMap(p => p.rel.now)) + '|(?:' + one + ')\\s+(?:' + alt(long) + '))', 'iu');
    const cntSuf = alt([...pk().flatMap(p => p.count.k), ...pk().flatMap(p => p.count.m)]), kSuf = alt(pk().flatMap(p => p.count.k));
    CNT = cntSuf;
    const kSet = new Set(pk().flatMap(p => p.count.k)), mSet = new Set(pk().flatMap(p => p.count.m));
    UI_LINE_RE = new RegExp('^(?:' + [...rAll('uiLine'), '·', '\\d[\\d\\s.,]*\\s*(?:' + kSuf + ')?'].join('|') + ')$', 'i');
    REACTION_RE = new RegExp('^(' + rAll('reaction').join('|') + ')\\s*:\\s*([\\d][\\d\\s.,]*\\s*(?:' + cntSuf + ')?)\\s*(?:' + alt(wAll('person')) + ')?$', 'i');
    BARE_NUM_RE = new RegExp('^[\\d][\\d\\s.,]*\\s*(?:' + cntSuf + ')?$', 'i');
    COMMENTS_COUNT_RE = new RegExp('^[\\d][\\d\\s.,]*\\s*(?:' + kSuf + ')?\\s*(?:' + rAll('commentsWord').join('|') + ')$');
    SHARES_COUNT_RE = new RegExp('^[\\d][\\d\\s.,]*\\s*(?:' + kSuf + ')?\\s*(?:' + rAll('sharesWord').join('|') + ')$');
    REACTIONS_WORD_RE = new RegExp('(?:' + rAll('reactionsWord').join('|') + ')\\s*:?\\s*[\\d]', 'i');
    PINNED_RE = RX('pinned', '^', '$');
    AUTHOR_BADGE_RE = RX('authorBadge', '^[–—·•-]?\\s*', '$');
    BADGE_LINE_RE = new RegExp('^[–—·•-]?\\s*(?:' + [...rAll('authorBadge'), ...rAll('badgeLine')].join('|') + ')$', 'i');
    SPONSORED_RE = new RegExp('^(?:' + alt(wAll('sponsored')) + ')$', 'i');
    SORT_RE = { all: RX('sortAll', '^', '$'), newest: RX('sortNewest', '^', '$'), relevant: RX('sortRelevant', '^', '$') };
    SORT_ANY = new RegExp('^(?:' + [...rAll('sortAll'), ...rAll('sortNewest'), ...rAll('sortRelevant'), ...rAll('sortOther')].join('|') + ')$', 'i');
    VERIFIED_RE = new RegExp('\\s*(?:' + alt(wAll('verified')) + ')\\s*$', 'i');
    VERIFIED_SEL = [...rAll('verifiedAttr').map(x => `[aria-label*="${x}"]`), ...rAll('verifiedAttr').map(x => `[title*="${x}"]`)].join(', ');
    REACTION_ATTR_SEL = rAll('reactionAttr').map(x => `[aria-label*="${x}"]`).join(', ');
    SKIP_DATE_RE = RX('skipDateLabel');
    COMMENT_LABEL_PARSE = pk().flatMap(p => (p.commentLabels || []).map(c => ({ ...c, re: new RegExp(c.re, 'i') })));
    REPLY_TO_RES = rAll('replyTo').map(x => new RegExp(x, 'i'));
    POST_BY_RES = rAll('postBy').map(x => new RegExp(x, 'i'));
    VIEW_POST_RE = new RegExp('^(?:' + alt(wAll('viewPost')) + ')$', 'i');
    NEXT_PHOTO_RE = new RegExp('^(?:' + alt(wAll('nextPhoto')) + ')$', 'i');
    PREV_PHOTO_RE = new RegExp('^(?:' + alt(wAll('prevPhoto')) + ')$', 'i');
    KEEP_WORDS = new Set([...wAll('keep'), ...Object.keys(MONTHS), ...all, ...pk().flatMap(p => [...p.rel.yesterday, ...p.rel.now, ...AM, ...PM, ...(p.rel.ago || [])]).flatMap(x => x.split(' ')),
      ...[...kSet, ...mSet], 'e', 'k', 'm']);
    return { kSet, mSet };
  }
  let COUNT_SETS = buildVocab();
  // register another language (plain data, see references/i18n.md); returns the ids of all known packs
  function registerLang(pack) {
    if (!pack || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(pack.id || '')) throw new Error('registerLang: id (e.g. "de") is required');
    for (const k of ['months', 'rel', 'count', 'w', 'r']) if (!pack[k]) throw new Error('registerLang: missing "' + k + '"');
    for (const k of ['long', 'short']) if (!pack.rel[k]) throw new Error('registerLang: rel.' + k + ' is required');
    if (!(pack.r.publish || []).length) throw new Error('registerLang: r.publish is required (the click guard must know the publish / send / like words of the language)');
    const saved = PACKS[pack.id];
    PACKS[pack.id] = { verified: false, ...pack, rel: { one: [], ago: [], agoPre: [], now: [], yesterday: [], am: [], pm: [], ...pack.rel }, count: { k: [], m: [], ...pack.count },
      w: { ...pack.w }, r: { ...pack.r } };
    try { COUNT_SETS = buildVocab(); } catch (e) { if (saved) PACKS[pack.id] = saved; else delete PACKS[pack.id]; COUNT_SETS = buildVocab(); throw e; }
    return Object.keys(PACKS);
  }
  // which language does the page speak, and is there a pack for it?
  function lang() {
    const raw = (document.documentElement.lang || '').toLowerCase(), code = raw.split(/[-_]/)[0] || null;
    const known = Object.keys(PACKS);
    return { page: raw || null, code, supported: code ? known.includes(code) : null, verified: code && PACKS[code] ? !!PACKS[code].verified : false, packs: known.map(id => id + (PACKS[id].verified ? '✓' : '')) };
  }
  const COMPOSER_SEL = '[contenteditable="true"], [role="textbox"], form, [role="combobox"]';

  // Write guard: fb-reader itself must never press these (PUBLISH_RE = union of every pack's publish / send / like words), and never click inside a composer.
  const safeToClick = b => !PUBLISH_RE.test((b.innerText || b.getAttribute('aria-label') || '').trim()) && !b.closest(COMPOSER_SEL) && !b.querySelector(COMPOSER_SEL) && !b.closest('a[href]');
  const isScrambledRun = el => {
    const leafs = [...el.querySelectorAll('span')].filter(e => !e.children.length && (e.textContent || '').trim().length && (e.textContent || '').length <= 2);
    return leafs.length >= 6 && leafs.length * 3 >= (el.textContent || '').length;
  };
  // FB salts visible strings with invisible code points (U+034F combining grapheme
  // joiner between every glyph of timestamps, ZWSP, soft hyphen, bidi marks…)
  const INVISIBLE_RE = /[\u034F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  const unsalt = s => String(s || '').replace(INVISIBLE_RE, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (base, range = 400) => base + Math.floor(Math.random() * range) - range / 2;
  const norm = s => unsalt(s).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── Visibility / decoy handling ───────────────────────────────────────────
  // FB injects aria-hidden decoys ("Facebook" blockquotes with data-0…data-19)
  // and scrambles timestamps/"Sponsored" into single-char spans whose real
  // order and visibility only exist in CSS. Everything below reads what a
  // human SEES, not what the DOM text says.
  function isDecoy(el) {
    return !!el.closest?.('[aria-hidden="true"]');
  }

  // Is the element actually displayed? Decoy cards sit under a display:none ancestor.
  // Checked only up to the post root: FB also sets display:none on whole feed items
  // that scrolled away, and those must still be readable.
  function isShown(el, stop = null) {
    if (!(el instanceof Element)) return true;
    const limit = stop || el.closest('[aria-posinset]') || el.closest(SEL.dialog) || null;
    for (let p = el; p && p !== limit; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  }

  function isRendered(el) {
    if (!(el instanceof Element)) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0 || parseFloat(cs.fontSize) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Reconstruct scrambled single-character runs in visual order.
  function decodeScrambled(container) {
    const box = container.getBoundingClientRect();
    const leafs = [...container.querySelectorAll('span, b, i, s, em')].filter(
      e => e.children.length === 0 && (e.textContent || '').length > 0 && (e.textContent || '').length <= 3
    );
    if (leafs.length < 4) return null;
    const vis = leafs.filter(e => {
      if (!isRendered(e)) return false;
      let p = e;
      while (p && p !== container) {
        if (!isRendered(p)) return false;
        const cs = getComputedStyle(p);
        if ((cs.position === 'absolute' || cs.position === 'fixed') && p !== container) {
          const r = p.getBoundingClientRect();
          if (r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right) return false;
        }
        p = p.parentElement;
      }
      const r = e.getBoundingClientRect();
      // outside the line box (pushed up/down by top:/transform) → decoy
      if (r.bottom <= box.top + 1 || r.top >= box.bottom - 1) return false;
      if (r.right <= box.left || r.left >= box.right) return false;
      return true;
    });
    vis.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return Math.abs(ra.top - rb.top) > ra.height / 2 ? ra.top - rb.top : ra.left - rb.left;
    });
    let out = '', prevRight = null;
    for (const e of vis) {
      const r = e.getBoundingClientRect();
      // a visual gap between glyph boxes = a collapsed space
      if (prevRight != null && r.left - prevRight > Math.max(2, r.height * 0.18)) out += ' ';
      out += e.textContent;
      prevRight = r.right;
    }
    out = unsalt(out).replace(/\s+/g, ' ').trim();
    return out || null;
  }

  // Visible text of an element: honours aria-labelledby, skips aria-hidden decoys,
  // decodes scrambled char runs.
  function visibleText(el) {
    if (!el) return '';
    const lby = el.getAttribute?.('aria-labelledby');
    if (lby) {
      const t = lby.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const scrambled = decodeScrambled(el);
    if (scrambled) return scrambled;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], style, script').forEach(n => n.remove());
    // innerText of a detached clone ignores CSS; fall back to live innerText when possible
    const live = (el.innerText || '').trim();
    const cleaned = (clone.textContent || '').trim();
    return live && !el.querySelector('[aria-hidden="true"]') ? live : cleaned;
  }

  // ── URL helpers ───────────────────────────────────────────────────────────
  const TRACKING_PARAMS = [
    'fbclid', '__cft__', '__tn__', '__xts__', 'eid', 'mibextid', 'rdid', 'share_url', 'ref', 'refsrc',
    'comment_tracking', 'paipv', 'acontext', 'notif_id', 'notif_t', 'h', 'utm_source', 'utm_medium',
    'utm_campaign', 'utm_term', 'utm_content', 'igshid', 's', 'sfnsn', 'extid', 'app',
  ];

  function unwrapUrl(href) {
    if (!href) return '';
    try {
      const u = new URL(href, location.href);
      if (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname === '/l.php' && u.searchParams.get('u')) {
        const inner = u.searchParams.get('u');
        // newer shims carry an opaque token instead of the URL — keep the shim then
        if (/^https?:\/\//i.test(inner)) return unwrapUrl(inner);
      }
      return u.toString();
    } catch {
      return href;
    }
  }

  function cleanUrl(href) {
    const raw = unwrapUrl(href);
    try {
      const u = new URL(raw, location.href);
      for (const k of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.includes(k) || k.startsWith('__cft__') || k.startsWith('utm_')) u.searchParams.delete(k);
      }
      if (/facebook\.com$/i.test(u.hostname)) u.hash = '';
      return u.toString().replace(/\?$/, '');
    } catch {
      return raw;
    }
  }

  // Signed CDN URLs (…fbcdn.net/…?_nc_cat=…&oh=…&oe=…) trip the browser extension's
  // "cookie/query string" output filter → strip their query string in chat-bound output.
  const cdnSafe = u => (typeof u === 'string' && /(fbcdn\.net|scontent|fbsbx\.com)/i.test(u)) ? u.split('?')[0] : u;
  const cdnSafeJson = obj => JSON.stringify(obj, (k, v) => cdnSafe(v));
  const isFbUrl = h => /^https?:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.watch|fb\.com|messenger\.com)\//i.test(h);
  const isFbCdn = h => /(fbcdn\.net|scontent|fbsbx\.com)/i.test(h);

  function postIdFromUrl(href) {
    if (!href) return null;
    const m =
      /\/posts\/(pfbid\w+|\d+)/.exec(href) ||
      /\/permalink\/(\d+)/.exec(href) ||
      /[?&]story_fbid=(pfbid\w+|\d+)/.exec(href) ||
      /post_insights\/(\d+)/.exec(href) ||
      /multi_permalinks=(\d+)/.exec(href) ||
      /\/(?:videos|reel)\/(\d+)/.exec(href) ||
      /[?&]v=(\d+)/.exec(href) ||
      /[?&]fbid=(\d+)/.exec(href);
    return m ? m[1] : null;
  }

  // ── Date parsing (HU + EN, absolute + relative) ──────────────────────────
  function parseFbDate(str, now = new Date()) {
    if (!str) return { iso: null, approx: false };
    const s = unsalt(str).toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const mk = (y, mo, d, h = 0, mi = 0, approx = false) => {
      const dt = new Date(y, mo, d, h, mi);
      return isNaN(dt) ? { iso: null, approx } : { iso: dt.toISOString(), approx };
    };
    const hm = x => {
      const m = AMPM_RE.exec(x);
      if (!m) return [0, 0, false];
      let h = +m[1];
      const ap = (m[3] || '').toLowerCase();
      if (PM.includes(ap) && h < 12) h += 12;
      if (AM.includes(ap) && h === 12) h = 0;
      return [h, +m[2], true];
    };
    let m;
    // unix seconds
    if (/^\d{10}$/.test(s)) return { iso: new Date(+s * 1000).toISOString(), approx: false };
    // ISO
    if (/^\d{4}-\d{2}-\d{2}t/.test(s)) return { iso: new Date(str).toISOString(), approx: false };
    // absolute dates with a month NAME of any registered language, in the three orders Facebook uses:
    //   year first  "2026. október 3., 14:22" / "2026. okt. 3."      month first  "október 3. 14:22" / "October 3, 2025 at 2:22 PM"
    //   day first   "3 October 2025" / "3. Oktober 2025"
    const byName = (re, mi, di, yi) => {
      for (const x of s.matchAll(re)) {
        const mo = MONTHS[x[mi]];
        if (mo === undefined) continue;
        let [h, mi2, hasT] = hm(s.slice(x.index + x[0].length));
        if (!hasT) [h, mi2, hasT] = hm(s.slice(0, x.index)); // "10:15 pm Oct 3"
        return mk(x[yi] ? +x[yi] : now.getFullYear(), mo, +x[di], h, mi2, !hasT);
      }
      return null;
    };
    const ab = byName(/(\d{4})\.?\s*(\p{L}+)\.?\s*(\d{1,2})(?!\d)\.?,?/gu, 2, 3, 1)
      || byName(/(\p{L}+)\.?\s*(\d{1,2})(?!\d)(?:,?\s+(\d{4}))?\.?,?/gu, 1, 2, 3)
      || byName(/(\d{1,2})\.?\s+(?:de\s+)?(\p{L}+)\.?(?:\s+(?:de\s+)?(\d{4}))?/gu, 2, 1, 3);
    if (ab) return ab;
    // yesterday
    if (YESTERDAY_RE.test(s)) {
      const [h, mi, hasT] = hm(s);
      const d = new Date(now); d.setDate(d.getDate() - 1);
      return mk(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, !hasT);
    }
    // relative: "3 ó", "15 p", "2 n", "1 hét", "5 év", "3h", "2d", "1w", "4 min", "egy órája", "an hour ago", "just now / most"
    if (NOW_RE.test(s)) return { iso: now.toISOString(), approx: true };
    m = REL_RE.exec(s);
    if (m) {
      const n = m[1] != null ? +m[1] : 1, ms = UNIT[(m[2] || m[4]).toLowerCase()];
      if (ms) return { iso: new Date(now - n * ms).toISOString(), approx: true };
    }
    // last resort only for machine-ish strings ("Fri, 03 Oct 2025 14:22:00 GMT")
    if (/\b(19|20)\d\d\b/.test(s) && /[a-z]{3}/.test(s)) {
      const d = new Date(str);
      if (!isNaN(d) && d.getFullYear() >= 2004 && d <= new Date(now.getTime() + 864e5)) return { iso: d.toISOString(), approx: false };
    }
    return { iso: null, approx: false };
  }

  // ── Post root discovery ───────────────────────────────────────────────────
  function isCommentArticle(art) {
    if (!art || !art.matches?.(SEL.article)) return false;
    if (COMMENT_LABEL_RE.test(art.getAttribute('aria-label') || '')) return true;
    const outer = art.parentElement?.closest(SEL.article);
    return !!(outer && !art.querySelector(SEL.message));
  }

  function findPostRoots(scope = document) {
    const roots = new Set();
    // 1. Feed items (groups, pages, profiles, home)
    scope.querySelectorAll(SEL.feedPost).forEach(el => roots.add(el));
    // 2. Open post dialog (photo/permalink overlay)
    const dialogs = [...scope.querySelectorAll(SEL.dialog)].filter(d => (d.querySelector(SEL.message) || d.querySelector(SEL.profileName)) && d.getBoundingClientRect().height > 0); // hidden panels (e.g. Értesítések) are no overlay
    if (dialogs.length) roots.clear(); // an open post overlay is what the user is looking at
    for (const d of dialogs) {
      const top = [...d.querySelectorAll(SEL.article)].find(a => !isCommentArticle(a) && !a.parentElement?.closest(SEL.article));
      roots.add(top || d);
    }
    // 3. Permalink page without aria-posinset
    if (!roots.size) {
      const main = scope.querySelector('[role="main"]') || scope;
      main.querySelectorAll(SEL.article).forEach(a => {
        if (!isCommentArticle(a) && !a.parentElement?.closest(SEL.article)) roots.add(a);
      });
      if (!roots.size) {
        main.querySelectorAll(SEL.message).forEach(m => {
          roots.add(m.closest('[data-pagelet]') || m.closest(SEL.article) || m.parentElement?.parentElement || m);
        });
      }
    }
    // drop roots nested inside other roots
    const arr = [...roots];
    return arr.filter(r => !arr.some(o => o !== r && o.contains(r)));
  }

  // Elements that belong to the post itself, not to its comments
  function ownAll(root, selector) {
    return [...root.querySelectorAll(selector)].filter(el => {
      const art = el.closest(SEL.article);
      return !art || art === root || !root.contains(art) || !isCommentArticle(art);
    });
  }

  // ── Field extractors ──────────────────────────────────────────────────────
  function extractAuthor(root) {
    const pn = ownAll(root, SEL.profileName)[0];
    let a = pn?.querySelector('a');
    let name = (a?.innerText || pn?.innerText || '').trim().split('\n')[0];
    if (!name) {
      a = ownAll(root, 'h2 a, h3 a, h4 a, strong a').find(x => !isDecoy(x) && (x.innerText || '').trim());
      name = (a?.innerText || '').trim().split('\n')[0];
    }
    if (!name) {
      a = ownAll(root, 'a[href*="/user/"][aria-label]:not([aria-hidden]), a[href*="/user/"][tabindex="0"]')[0];
      name = (a?.getAttribute('aria-label') || a?.innerText || '').trim().split('\n')[0];
    }
    // header badges ("A csoport szakértője", "Admin"…): short labels before the message
    const firstMsg = ownAll(root, SEL.message)[0] || ownAll(root, SEL.cardTitle)[0];
    const badges = pn
      ? ownAll(root, '[dir="auto"]')
          .filter(e => !isDecoy(e) && !pn.contains(e) && !e.closest(SEL.message + ',' + SEL.cardTitle + ',' + SEL.cardMeta + ',' + SEL.cardDesc + ',a'))
          .filter(e => !firstMsg || (e.compareDocumentPosition(firstMsg) & Node.DOCUMENT_POSITION_FOLLOWING))
          .filter(e => pn.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)
          .map(e => (e.innerText || '').trim())
          .filter(t => t && t !== name && t.length < 40 && !/^[·•\s]+$/.test(t) && !UI_NOISE.has(t.toLowerCase()))
          .filter((t, i, a) => a.indexOf(t) === i)
          .slice(0, 3)
      : [];
    name = unsalt(name).trim();
    const verified = VERIFIED_RE.test(name) || !!(pn && VERIFIED_SEL && pn.querySelector(VERIFIED_SEL));
    name = name.replace(VERIFIED_RE, '').trim();
    return { name: name || null, url: a?.href ? cleanUrl(a.href) : null, badges, verified };
  }

  const stripUi = t => norm(String(t || '').replace(new RegExp('(\\n|\\s|…)*(?:' + [...wAll('seeMore'), ...wAll('seeLess'), ...wAll('translate')].map(esc).join('|') + ')\\s*$', 'i'), ''));

  function extractText(root) {
    const msgs = ownAll(root, SEL.message).filter(m => !isDecoy(m) && isShown(m, root));
    const texts = msgs.map(m => stripUi(m.innerText)).filter(Boolean);
    const uniq = texts.filter((t, i) => texts.indexOf(t) === i && !texts.some((o, j) => j < i && o.includes(t)));
    if (uniq.length) return { text: uniq[0], sharedText: uniq.slice(1).join('\n\n') || null };
    // fallback: longest dir=auto block outside comments, cards and decoys
    const cardSel = [SEL.cardTitle, SEL.cardDesc, SEL.cardMeta, SEL.cardImage, SEL.profileName].join(',');
    const actionBar = ownAll(root, '[data-ad-rendering-role="like_button"], [data-ad-rendering-role="comment_button"]')[0];
    const beforeFooter = el => !actionBar || !!(el.compareDocumentPosition(actionBar) & Node.DOCUMENT_POSITION_FOLLOWING);
    const parts = ownAll(root, '[dir="auto"]')
      .filter(el => !isDecoy(el) && isShown(el, root) && !el.closest(cardSel) && !el.querySelector(cardSel) && !el.closest('a[href]') && !el.closest('h1, h2, h3, [role="heading"]'))
      .filter(el => !isScrambledRun(el) && beforeFooter(el))
      .map(el => stripUi(el.innerText))
      .filter(t => t.length > 1 && !UI_NOISE.has(t.toLowerCase()) && !UI_LINE_RE.test(t))
      .filter(t => t.split('\n').filter(l => l.trim().length <= 2).length < 5); // char-per-line junk
    if (!parts.length) return { text: '', sharedText: null };
    parts.sort((a, b) => b.length - a.length);
    const primary = parts[0];
    const extras = parts.slice(1).filter(p => !primary.includes(p) && p.length > 20).slice(0, 2);
    return { text: [primary, ...extras].join('\n'), sharedText: null };
  }

  function findTimestampLink(root) {
    const cands = ownAll(root, 'a[href]').filter(a => {
      const h = a.getAttribute('href') || '';
      if (isDecoy(a)) return false;
      if (/\/user\/|\/groups\/[^/]+\/?$|\/hashtag\/|\/profile\.php|photo|l\.php/.test(h)) return false;
      return /\/posts\/|permalink|story_fbid|\/videos\/|\/reel\/|\?__cft__|^#|multi_permalinks/.test(h) || a.querySelector('[aria-labelledby]');
    });
    // Prefer links that sit right below the profile name
    return cands.find(a => a.querySelector('[aria-labelledby]')) || cands.find(a => /\/posts\/|permalink|story_fbid/.test(a.getAttribute('href') || '')) || cands[0] || null;
  }

  const plausibleDate = t => { t = unsalt(t).trim(); return !!t && t.length <= 60 && MONTH_HINT_RE.test(t) && !!parseFbDate(t).iso; };

  function extractDate(root) {
    // 1. classic abbr
    const abbr = root.querySelector('abbr[data-utime]');
    if (abbr) return { raw: abbr.getAttribute('data-utime'), method: 'abbr-utime' };
    // 2. aria-labelledby → referenced node holds the real, unscrambled date
    for (const span of ownAll(root, '[aria-labelledby]')) {
      const ids = (span.getAttribute('aria-labelledby') || '').split(/\s+/);
      const t = ids.map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (plausibleDate(t)) return { raw: t, method: 'aria-labelledby' };
    }
    const tl = findTimestampLink(root);
    if (tl) {
      // 3. aria-label on the link itself
      const al = tl.getAttribute('aria-label');
      if (plausibleDate(al)) return { raw: al, method: 'aria-label' };
      // 4. visual decode of the scrambled run
      const dec = decodeScrambled(tl);
      if (plausibleDate(dec)) return { raw: dec, method: 'visual-decode' };
      const vt = (tl.innerText || '').trim();
      if (plausibleDate(vt)) return { raw: vt, method: 'innerText' };
    }
    // 5. any aria-label with a month/relative marker
    for (const el of ownAll(root, 'a[aria-label], span[aria-label]')) {
      const l = el.getAttribute('aria-label') || '';
      if (plausibleDate(l) && !SKIP_DATE_RE.test(l)) return { raw: l, method: 'aria-label-any' };
    }
    return { raw: null, method: null };
  }
  const extractDateClean = root => { const d = extractDate(root); return { raw: d.raw ? unsalt(d.raw).trim() : null, method: d.method }; };

  function extractPostUrl(root) {
    const links = ownAll(root, 'a[href]').map(a => a.href);
    const pick =
      links.find(h => /\/groups\/[^/]+\/posts\/(pfbid\w+|\d+)/.test(h)) ||
      links.find(h => /\/posts\/(pfbid\w+|\d+)|\/permalink\/\d+|story_fbid=/.test(h)) ||
      links.find(h => /\/(videos|reel)\/\d+/.test(h));
    if (pick) {
      const u = cleanUrl(pick);
      return u.replace(/[?&]comment_id=\d+.*/, '');
    }
    const ins = links.find(h => /post_insights\/(\d+)/.test(h));
    const grp = /\/groups\/[^/?#]+/.exec(location.pathname);
    if (ins && grp) return `https://www.facebook.com${grp[0]}/posts/${/post_insights\/(\d+)/.exec(ins)[1]}/`;
    if (/\/(posts|permalink|videos|reel)\//.test(location.pathname)) return cleanUrl(location.href);
    // profile/page feeds hide the permalink until hover/focus; the photo link still opens the post
    const ph = links.map(h => /\/photo\/?\?(?:.*&)?fbid=(\d+)/.exec(h)).find(Boolean);
    if (ph) return `https://www.facebook.com/photo/?fbid=${ph[1]}`;
    return null;
  }

  // Fallback when CSS is unavailable (saved HTML): decoy cards carry a random
  // mixed-case domain and a long space-less random description.
  const looksLikeDecoyCard = c =>
    /^(?=[^.]*[a-z])(?=[^.]*[A-Z])[A-Za-z0-9]{6,16}\.(com|net|org)$/.test(c.domain || '') &&
    (!c.description || /^[A-Za-z0-9_-]{25,}$/.test(c.description));

  function extractLinksAndCards(root) {
    const links = new Set();
    const cards = [];
    for (const a of ownAll(root, 'a[href]')) {
      if (isDecoy(a) && !a.closest(SEL.cardImage)) continue;
      if (!isShown(a, root)) continue;
      const u = cleanUrl(a.href);
      if (!/^https?:/.test(u)) continue;
      if (/\/hashtag\//.test(u)) continue;
      if (isFbUrl(u) && !/\/(watch|reel|videos|events)\b/.test(u)) continue;
      if (isFbCdn(u)) continue;
      links.add(u);
    }
    for (const t of ownAll(root, SEL.cardTitle)) {
      if (!isShown(t, root) || isDecoy(t)) continue; // decoy cards: random domain + viewer's name, display:none ancestor
      let card = t.parentElement;
      for (let i = 0; i < 12 && card && card !== root; i++, card = card.parentElement) {
        if (card.querySelector(SEL.cardImage) || card.querySelector(SEL.cardMeta)) break;
      }
      if (!card || card === root) card = t.parentElement;
      const anchors = [card.querySelector(`${SEL.cardImage} a[href]`), t.closest('a[href]'), ...card.querySelectorAll('a[href]')].filter(Boolean);
      const urls = anchors.map(x => cleanUrl(x.href)).filter(u => /^https?:/.test(u));
      const url = urls.find(u => !isFbUrl(u)) || urls.find(u => /\/(posts|permalink|videos|reel|watch|events)\b|story_fbid/.test(u)) || null;
      if (url) links.add(url);
      const card_ = { title: norm(t.innerText), domain: norm(card.querySelector(SEL.cardMeta)?.innerText), description: norm(card.querySelector(SEL.cardDesc)?.innerText) };
      if (looksLikeDecoyCard(card_)) continue;
      cards.push({
        url,
        title: norm(t.innerText) || null,
        domain: norm(card.querySelector(SEL.cardMeta)?.innerText) || null,
        description: norm(card.querySelector(SEL.cardDesc)?.innerText) || null,
      });
    }
    return { links: [...links], cards };
  }

  // Facebook's auto alt text is often just "szöveg" / "Text" / "Lehet, hogy ez egy szöveg képe": it says nothing about the picture.
  const WEAK_ALT_RE = /^(?:lehet,? hogy( ez)?|may be|maybe)?\s*(?:egy |an? )?(?:szöveg|text|kép|image|photo|fotó|screenshot|képernyőkép|screen ?shot)\b.{0,14}$/i;
  const isWeakAlt = a => !a || a.length < 10 || WEAK_ALT_RE.test(a.trim());
  // A >4-photo grid shows a handful of thumbnails plus one "+N" overlay tile for the rest; the N hidden
  // photos behind it have no <img> at all, so a plain img-count undercounts the post (live-review finding,
  // not yet confirmed against the real DOM: only trust this when it is near a thumbnail, never a bare "+N").
  function hiddenGridCount(root, imgs) {
    if (!imgs.length) return 0;
    let n = 0;
    for (const el of ownAll(root, 'span, div')) {
      if (!isShown(el, root)) continue;
      const t = (el.textContent || '').trim();
      if (!/^\+\s*\d{1,3}$/.test(t)) continue;
      if (!el.closest('a,div')?.querySelector('img')) continue; // must sit on top of a thumbnail, not an unrelated badge
      n = Math.max(n, parseInt(t.replace(/\D/g, ''), 10));
    }
    return n;
  }
  function extractMedia(root) {
    const images = [];
    const seen = new Set();
    for (const img of ownAll(root, 'img')) {
      if (img.closest(SEL.cardImage)) continue; // link-preview thumbnail, already in cards
      if (!isShown(img, root)) continue;
      const src = img.currentSrc || img.src || '';
      if (!isFbCdn(src) || seen.has(src)) continue;
      const w = img.naturalWidth || +img.getAttribute('width') || img.width || 0;
      const h = img.naturalHeight || +img.getAttribute('height') || img.height || 0;
      if (w && h && (w < 80 || h < 80)) continue; // avatars / emoji
      seen.add(src);
      const alt = (img.getAttribute('alt') || '').trim();
      images.push({ src, alt: alt || null, altWeak: alt ? isWeakAlt(alt) : undefined });
    }
    const hiddenMore = hiddenGridCount(root, images);
    const videos = [...new Set(
      ownAll(root, 'a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch"], a[href*="fb.watch"]').map(a => cleanUrl(a.href)).filter(u => !/\/hashtag\//.test(u))
    )];
    const hasVideoTag = !!root.querySelector('video');
    return { images, videos, hasVideo: hasVideoTag || videos.length > 0, hiddenMore };
  }

  function parseCount(s) {
    if (!s) return null;
    const m = new RegExp('([\\d][\\d\\s.,]*)\\s*(' + CNT + ')?(?![\\p{L}\\d])', 'iu').exec(s.replace(/\u00a0/g, ' '));
    if (!m) return null;
    let n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    const suf = (m[2] || '').toLowerCase();
    if (COUNT_SETS.kSet.has(suf)) n *= 1e3;
    else if (COUNT_SETS.mSet.has(suf)) n *= 1e6;
    return Math.round(n);
  }

  function extractCounts(root) {
    const out = { reactions: null, comments: null, shares: null, reactionTypes: null };
    // "Vicces: 1,9 E ember", "Tetszik: 184 ember"
    for (const el of ownAll(root, '[aria-label]')) {
      const m = REACTION_RE.exec(unsalt(el.getAttribute('aria-label') || '').trim());
      if (m) (out.reactionTypes ||= {})[m[1].toLowerCase()] = parseCount(m[2]);
    }
    // footer buttons with bare numbers, in order: reactions · comments · shares
    const nums = ownAll(root, '[role="button"]')
      .filter(b => isShown(b, root) && !b.querySelector('[role="button"]'))
      .map(b => unsalt(b.innerText || '').trim())
      .filter(t => t && BARE_NUM_RE.test(t));
    if (nums.length >= 3) [out.reactions, out.comments, out.shares] = nums.slice(0, 3).map(parseCount);
    else if (nums.length === 2) [out.reactions, out.comments] = nums.map(parseCount);
    else if (nums.length === 1) out.reactions = parseCount(nums[0]);
    for (const el of ownAll(root, '[aria-label]')) {
      const l = el.getAttribute('aria-label') || '';
      if (out.reactions == null && REACTIONS_WORD_RE.test(l)) out.reactions = parseCount(l.split(':').pop());
    }
    for (const el of ownAll(root, 'span, div[role="button"]')) {
      if (el.children.length > 2) continue;
      const t = (el.innerText || '').trim().toLowerCase();
      if (!t || t.length > 30) continue;
      if (COMMENTS_COUNT_RE.test(t)) out.comments = parseCount(t);
      if (SHARES_COUNT_RE.test(t)) out.shares = parseCount(t);
      if (out.reactions == null && BARE_NUM_RE.test(t) && REACTION_ATTR_SEL && el.closest(REACTION_ATTR_SEL)) out.reactions = parseCount(t);
    }
    if (out.reactions == null && out.reactionTypes) out.reactions = Object.values(out.reactionTypes).reduce((a, b) => a + b, 0);
    return out;
  }

  // aria-label of a comment ("Minta Anna hozzászólása (5 órája)", "Comment by X 5 hours ago"): patterns come from the language packs (commentLabels)
  const EMOJI_SRC_RE = /\/emoji\.php|static\.xx\.fbcdn\.net\/images\/emoji|\/rsrc\.php/;


  function extractComments(root, max = 50, postAuthor = null) {
    const arts = [...root.querySelectorAll(SEL.article)].filter(a => a !== root && isCommentArticle(a));
    const out = [];
    for (const art of arts.slice(0, max)) {
      let depth = 0;
      for (let p = art.parentElement?.closest(SEL.article); p && p !== root && root.contains(p); p = p.parentElement?.closest(SEL.article)) depth++;
      const label = unsalt(art.getAttribute('aria-label') || '').trim();
      let lAuthor = null, lWhen = null, replyTo = null;
      for (const c of COMMENT_LABEL_PARSE) { const m = c.re.exec(label); if (m) { lAuthor = m[c.a]; replyTo = (c.to && m[c.to]) || null; lWhen = (c.when && m[c.when]) || null; break; } }
      if (!replyTo) for (const re of REPLY_TO_RES) { const rm = re.exec(label); if (rm) { replyTo = rm[1]; break; } }
      if (replyTo && depth === 0) depth = 1; // FB no longer always nests reply articles
      const own = el => el.closest(SEL.article) === art;
      const links = [...art.querySelectorAll('a[href]')].filter(a => own(a) && !isDecoy(a));
      const tsA = links.find(a => plausibleDate(a.getAttribute('aria-label') || a.innerText || ''));
      const authorA = links.find(a => a !== tsA && unsalt(a.innerText || '').trim() && !/\/photo|\/videos\/|\/reel\//.test(a.href));
      const author = unsalt(authorA?.innerText || '').trim().split('\n')[0] || lAuthor;
      const textEls = [...art.querySelectorAll('div[dir="auto"], span[dir="auto"]')].filter(e => own(e) && !isDecoy(e) && !e.closest('a') && !e.parentElement?.closest('[dir="auto"]'));
      const text = norm(textEls.map(e => e.innerText).filter(t => t && unsalt(t).trim() !== author && !UI_NOISE.has(unsalt(t).trim().toLowerCase()) && !plausibleDate(t)).join('\n'))
        .split('\n').filter((l, i) => !(i < 2 && BADGE_LINE_RE.test(l.trim()))).join('\n').trim();
      const when = (tsA ? unsalt(tsA.getAttribute('aria-label') || tsA.innerText).trim() : null) || lWhen;
      // media: photos, GIFs, stickers, videos, attached links
      const media = [];
      for (const img of art.querySelectorAll('img')) {
        if (!own(img) || /^data:/.test(img.src) || EMOJI_SRC_RE.test(img.src)) continue;
        const w = img.naturalWidth || +img.getAttribute('width') || img.width, h = img.naturalHeight || +img.getAttribute('height') || img.height;
        if (w && h && (w < 60 || h < 60)) continue; // avatars, reaction icons
        const a = img.closest('a[href]');
        const alt = unsalt(img.alt || '').trim() || null;
        const kind = /giphy|tenor|\.gif/i.test(img.src) ? 'gif' : /matrica|sticker/i.test(alt || '') ? 'sticker' : 'image';
        media.push({ kind, src: img.currentSrc || img.src, alt, link: a ? cleanUrl(a.href) : null });
      }
      if (art.querySelector('video')) media.push({ kind: 'video', src: null, alt: null, link: links.map(a => a.href).find(h => /\/videos\/|\/reel\//.test(h)) || null });
      const extLinks = [...new Set(links.map(a => cleanUrl(a.href)).filter(u => /^https?:/.test(u) && !isFbUrl(u) && !isFbCdn(u)))];
      const lines = [...art.querySelectorAll('span, div')].filter(e => own(e) && e.children.length === 0).map(e => unsalt(e.textContent || '').trim()).filter(t => t && t.length < 40);
      const pinned = lines.some(t => PINNED_RE.test(t)) || PINNED_RE.test(label);
      const isAuthor = lines.some(t => AUTHOR_BADGE_RE.test(t)) || (!!postAuthor && !!author && author === postAuthor);
      out.push({
        author: author || null,
        authorUrl: authorA ? cleanUrl(authorA.href).replace(/[?&]comment_id=.*/, '') : null,
        depth,
        replyTo,
        pinned,
        isAuthor,
        text: text || null,
        date: when ? parseFbDate(when).iso : null,
        dateRaw: when || null,
        media,
        links: extLinks,
        url: tsA ? cleanUrl(tsA.href) : null,
      });
    }
    return out;
  }

  // The comment articles of a post in DOM order: c1, c2, … (same numbering as thread()/extractComments)
  const commentArticles = root => [...root.querySelectorAll(SEL.article)].filter(a => a !== root && isCommentArticle(a));
  // Author / addressee / snippet of one comment article (aria-label first, author link as extractComments does)
  function commentInfo(art) {
    const label = unsalt(art.getAttribute('aria-label') || '').trim();
    let author = null, replyTo = null;
    for (const c of COMMENT_LABEL_PARSE) { const m = c.re.exec(label); if (m) { author = m[c.a]; replyTo = (c.to && m[c.to]) || null; break; } }
    const own = el => el.closest(SEL.article) === art;
    const a = [...art.querySelectorAll('a[href]')].find(x => own(x) && !isDecoy(x) && unsalt(x.innerText || '').trim()
      && !/\/photo|\/videos\/|\/reel\//.test(x.href) && !plausibleDate(x.getAttribute('aria-label') || x.innerText || ''));
    if (a) author = unsalt(a.innerText).trim().split('\n')[0] || author;
    const text = norm([...art.querySelectorAll('div[dir="auto"], span[dir="auto"]')]
      .filter(e => own(e) && !isDecoy(e) && !e.closest('a') && !e.parentElement?.closest('[dir="auto"]'))
      .map(e => e.innerText).filter(t => t && unsalt(t).trim() !== author && !plausibleDate(t)).join(' ')).slice(0, 160);
    return { author: author ? author.trim() : null, replyTo, text: text || null };
  }

  function isSponsored(root) {
    if (root.querySelector('a[href*="/ads/about"], a[href*="ad_preferences"]')) return true;
    for (const sp of ownAll(root, '[aria-labelledby]')) {
      const t = (sp.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      if (SPONSORED_RE.test(unsalt(t).trim())) return true;
    }
    for (const a of ownAll(root, 'a[href], span[aria-labelledby]')) {
      const dec = decodeScrambled(a);
      if (dec && SPONSORED_RE.test(dec.replace(/[^\p{L} ]/gu, '').trim())) return true;
    }
    return ownAll(root, 'span, a').some(e => e.children.length === 0 && SPONSORED_RE.test(unsalt(e.textContent).trim()) && isShown(e, root));
  }

  function extractPost(root, opts = {}) {
    const url = extractPostUrl(root);
    const author = extractAuthor(root);
    const { text, sharedText } = extractText(root);
    const d = extractDateClean(root);
    const parsed = parseFbDate(d.raw);
    const { links, cards } = extractLinksAndCards(root);
    const media = extractMedia(root);
    const truncated = ownAll(root, '[role="button"], div[tabindex="0"]').some(b => SEE_MORE.includes((b.innerText || '').trim().toLowerCase()));
    const post = {
      postId: postIdFromUrl(url) || ownAll(root, 'a[href]').map(a => postIdFromUrl(a.href)).find(Boolean) || null,
      url,
      author: author.name,
      authorUrl: author.url,
      authorBadges: author.badges,
      authorVerified: author.verified,
      sponsored: isSponsored(root),
      date: parsed.iso,
      dateApprox: parsed.approx,
      dateRaw: d.raw,
      dateMethod: d.method,
      text,
      textTruncated: truncated,
      hashtags: [...new Set(ownAll(root, 'a[href*="/hashtag/"]').map(a => unsalt(a.innerText || '').trim()).filter(t => t.startsWith('#')))],
      sharedText,
      links,
      cards,
      images: media.images,
      hiddenImages: media.hiddenMore || 0,
      videos: media.videos,
      hasVideo: media.hasVideo,
      counts: extractCounts(root),
      position: root.getAttribute('aria-posinset') ? +root.getAttribute('aria-posinset') : null,
    };
    // Post overlay title "X bejegyzése" / "X's post" names the real author (anonymous posts, page-as-group)
    if (root.matches?.(SEL.dialog) || root.closest?.(SEL.dialog)) {
      const dlg = root.matches(SEL.dialog) ? root : root.closest(SEL.dialog);
      const h = unsalt(dlg.querySelector('h2, [role="heading"]')?.innerText || '').trim();
      const m = POST_BY_RES.map(re => re.exec(h)).find(Boolean);
      if (m && m[1] !== post.author) { if (post.author) post.authorBadges.unshift('megosztva itt: ' + post.author); post.author = m[1]; }
    }
    post.authorBadges = post.authorBadges.filter(b => !(post.text || '').includes(b) && !(post.sharedText || '').includes(b));
    if (opts.comments) post.comments = flagDateConflicts(post, extractComments(root, opts.maxComments || 50, post.author));
    return post;
  }

  // suggestion widgets, "Javasolt csoportok", stories etc. have neither id nor author
  const isRealPost = p => (p.position != null ? !!p.author : !!(p.postId || p.author)) && !!(p.text || p.cards.length || p.images.length || p.hasVideo || p.sharedText);

  // ── Page context ──────────────────────────────────────────────────────────
  function pageInfo() {
    const p = location.pathname;
    let type = 'unknown';
    if (/^\/notifications\b/.test(p)) type = 'notifications';
    else if (/^\/messages\b/.test(p) || /(^|\.)messenger\.com$/.test(location.hostname)) type = 'messages';
    else if (/\/groups\/[^/]+\/(posts|permalink)\//.test(p) || /\/posts\/|\/permalink\.php|story\.php/.test(p)) type = 'post';
    else if (/^\/groups\/(joins|feed|discover|notifications)\b/.test(p)) type = 'groups-index';
    else if (/\/groups\/[^/]+\/search\b/.test(p)) type = 'group-search';
    else if (/\/groups\/[^/]+\/?$/.test(p) || /\/groups\/[^/]+\/(?!posts)/.test(p)) type = 'group';
    else if (/\/(videos|watch|reel)\b/.test(p)) type = 'video';
    else if (/\/photo/.test(p)) type = 'photo';
    else if (/\/events\//.test(p)) type = 'event';
    else if (/\/marketplace\//.test(p)) type = 'marketplace';
    else if (/\/search\//.test(p)) type = 'search';
    else if (p === '/' || p === '') type = 'home';
    else type = 'profile-or-page';
    // only a VISIBLE h1 counts: FB litters the page with screen-reader-only landmark headings (e.g. "Értesítések"
    // for the notification bell region, usually clipped to ~1px) that would otherwise win just by DOM order
    const h1 = [...document.querySelectorAll('[role="main"] h1, h1')]
      .filter(h => { const r = h.getBoundingClientRect(); return r.width > 10 && r.height > 10 && isShown(h); })
      .map(h => (h.innerText || '').trim()).find(t => t && t.length < 120);
    const loggedOut = !!document.querySelector('#login_form, [data-testid="royal_login_button"], form[action*="login"]');
    let warning = null;
    if (/\/checkpoint\//.test(p)) warning = 'Facebook biztonsági ellenőrzés (checkpoint) — a felhasználónak kell feloldania a saját böngészőjében';
    else if (loggedOut) warning = 'Nincs bejelentkezve — privát/csoport tartalom nem látszik';
    else if (type === 'group' && !document.querySelector(SEL.feedPost) && [...document.querySelectorAll('[role="main"] [role="button"]')].some(b => /^(csatlakozás|join group|join)$/i.test((b.innerText || '').trim())))
      warning = 'Nem vagy tagja a csoportnak — csak a névjegy látszik';
    return {
      url: cleanUrl(location.href),
      title: document.title.replace(/^\(\d+\)\s*/, ''),
      heading: h1 || null,
      type,
      loggedOut,
      dialogOpen: [...document.querySelectorAll(SEL.dialog)].some(d => d.getBoundingClientRect().height > 0 && d.querySelector(SEL.message)),
      warning,
    };
  }

  // ── Output formatting ─────────────────────────────────────────────────────
  // Approximate dates ("3 hét", "okt. 3.") carry no time of day. Show the DATE and the raw label ("~2026-10-03 (3 hét)"),
  // never an invented HH:MM; only a date less than a day old keeps the (approximate) time. Local time, not UTC.
  const localYmd = d => d.toLocaleDateString('sv');
  const localHm = d => d.toLocaleTimeString('sv').slice(0, 5);
  const CONFLICT = ' ⚠korábbi, mint a poszt';
  function dateLabel(p) {
    if (!p.date) return p.dateRaw || '';
    const d = new Date(p.date), warn = p.dateConflict ? CONFLICT : '';
    if (!p.dateApprox) return `${localYmd(d)} ${localHm(d)}${warn}`;
    const fresh = Math.abs(Date.now() - d.getTime()) < 864e5;
    const raw = p.dateRaw && String(p.dateRaw).length <= 24 ? ` (${p.dateRaw})` : '';
    return `~${localYmd(d)}${fresh ? ' ' + localHm(d) : ''}${raw}${warn}`;
  }
  // A comment cannot be older than its post. Flags comments that are (beyond the precision of the dates involved).
  function flagDateConflicts(post, comments) {
    if (!post?.date || !comments?.length) return comments;
    const pd = new Date(post.date).getTime();
    for (const c of comments) {
      if (!c.date) continue;
      const tol = post.dateApprox || c.dateApprox ? 36 * 36e5 : 5 * 6e4;
      if (new Date(c.date).getTime() < pd - tol) c.dateConflict = true;
    }
    return comments;
  }
  function fmtDate(p) {
    if (!p.date) return p.dateRaw ? `${p.dateRaw} (nem értelmezett)` : 'ismeretlen dátum';
    if (p.dateApprox) return dateLabel(p);
    const s = new Date(p.date).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return s + (p.dateConflict ? CONFLICT : '');
  }

  function toMarkdown(result, { maxChars = 60000 } = {}) {
    const L = [];
    const pg = result.page;
    L.push(`# ${pg.heading || pg.title || 'Facebook'}`);
    L.push(`Forrás: ${pg.url} · típus: ${pg.type} · posztok: ${result.posts.length}${result.warnings.length ? ' · ⚠ ' + result.warnings.join('; ') : ''}`);
    for (const p of result.posts) {
      L.push('', `## ${p.author || 'Ismeretlen szerző'}${p.authorVerified ? ' ✔' : ''} — ${fmtDate(p)}${p.sponsored ? ' · 📣 HIRDETÉS' : ''}`);
      if (p.authorBadges?.length) L.push(`_${p.authorBadges.join(' · ')}_`);
      if (p.text) L.push('', p.text + (p.textTruncated ? ' […csonkolt — futtasd: expandSeeMore()]' : ''));
      if (p.sharedText) L.push('', '> Megosztott tartalom:', ...p.sharedText.split('\n').map(l => '> ' + l));
      for (const c of p.cards || []) L.push(`- 🔗 **${c.title || c.url}**${c.domain ? ` (${c.domain})` : ''}${c.description ? ` — ${c.description}` : ''}${c.url ? `\n  ${c.url}` : ''}`);
      const loose = (p.links || []).filter(u => !(p.cards || []).some(c => c.url === u));
      for (const u of loose) L.push(`- ${u}`);
      p.images.forEach((im, i) => L.push(`- 🖼 kép ${i + 1}${im.alt ? `: ${im.alt}` : ''}`));
      if (p.hashtags?.length) L.push(`- # ${p.hashtags.join(' ')}`);
      if (p.hasVideo) L.push(`- 🎬 videó${p.videos.length ? ': ' + p.videos.join(', ') : ''}`);
      const c = p.counts || {};
      const rt = c.reactionTypes ? ' (' + Object.entries(c.reactionTypes).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : '';
      const cs = [c.reactions != null && `${c.reactions} reakció${rt}`, c.comments != null && `${c.comments} hozzászólás`, c.shares != null && `${c.shares} megosztás`].filter(Boolean);
      if (cs.length) L.push(`_${cs.join(' · ')}_`);
      if (p.url) L.push(`Link: ${p.url}`);
      if (p.comments?.length) {
        L.push('', '### Hozzászólások');
        for (const k of p.comments) {
          const med = (k.media || []).map(x => `[${x.kind}${x.alt ? ': ' + x.alt : ''}]`).join(' ');
          L.push(`${'  '.repeat(k.depth)}- ${k.pinned ? '📌 ' : ''}**${k.author || '?'}**${k.isAuthor ? ' (szerző)' : ''}${k.replyTo ? ` → ${k.replyTo}` : ''}${k.dateRaw ? ` (${k.dateRaw})` : ''}: ${(k.text || '').replace(/\n/g, ' ')}${med ? ' ' + med : ''}${k.links?.length ? ' ' + k.links.join(' ') : ''}`);
        }
      }
    }
    let md = L.join('\n');
    if (md.length > maxChars) md = md.slice(0, maxChars) + `\n\n[…levágva ${md.length - maxChars} karakter — kérj kevesebb posztot (limit) vagy JSON-t]`;
    return md;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function extract(opts = {}) {
    const { format = 'json', limit = 100, comments = false, maxChars = 60000 } = opts;
    const page = pageInfo();
    const warnings = [];
    if (page.warning) warnings.push(page.warning);
    const roots = findPostRoots().slice(0, limit);
    const posts = roots.map(r => extractPost(r, { comments, maxComments: opts.maxComments })).filter(isRealPost);
    if (!posts.length) warnings.push('Nem található poszt a DOM-ban (görgess, vagy várj a betöltésre)');
    if (posts.some(p => !p.date && p.dateRaw == null && !p.sponsored)) warnings.push('Egyes dátumok nem dekódolhatók — próbáld: await __fbReader.hoverDates()');
    if (posts.some(p => p.textTruncated)) warnings.push('Csonkolt szövegek — futtasd: await __fbReader.expandSeeMore()');
    const result = { tool: 'fb-reader', version: VERSION, extractedAt: new Date().toISOString(), page, posts, warnings };
    if (format === 'md') return toMarkdown(result, { maxChars });
    if (format === 'object') return result; // full CDN URLs (for mediaList / download)
    const json = cdnSafeJson(result);
    return json.length > maxChars * 2 ? cdnSafeJson({ ...result, posts: posts.map(p => ({ ...p, images: p.images.slice(0, 3) })), warnings: [...warnings, 'JSON rövidítve'] }) : json;
  }

  async function expandSeeMore({ rounds = 3, scope = document, budgetMs = 6000, roots = null } = {}) {
    let total = 0;
    const t0 = Date.now();
    for (let r = 0; r < rounds && Date.now() - t0 < budgetMs; r++) {
      let n = 0;
      for (const root of roots || findPostRoots(scope)) {
        for (const b of root.querySelectorAll('[role="button"], div[tabindex="0"], span[tabindex="0"]')) {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (!SEE_MORE.includes(t)) continue;
          if (!safeToClick(b)) continue; // never navigate, never touch composers / publish buttons
          b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          n++;
        }
      }
      total += n;
      if (!n) break;
      await sleep(jitter(900, 300));
    }
    return { expanded: total };
  }

  // Which comment-sort the post shows ("Legrelevánsabb" / "Összes hozzászólás" …); the default "relevant" hides
  // spam-filtered and low-signal comments, so the loaded count is lower than the counter.
  const lastExpand = new Map(); // contentKey → {clicked, done, sort, at}: lets thread() explain a count gap honestly

  // setCommentSort('all'|'newest'|'relevant', {post}) — switches the sort menu of ONE post (default: open overlay / post in view)
  async function setCommentSort(mode = 'all', { post } = {}) {
    const want = SORT_RE[mode];
    if (!want) return { error: "mode: 'all' | 'newest' | 'relevant'" };
    const root = await resolveLive(post);
    if (!root) return { error: post === undefined ? 'nincs poszt a nézetben' : `nincs ilyen poszt: ${post}` };
    const trig = [...root.querySelectorAll('[role="button"], div[tabindex="0"]')]
      .filter(b => SORT_ANY.test(unsalt(b.innerText || '').trim()) && (!b.closest(SEL.article) || b.closest(SEL.article) === root))
      .sort((a, b) => (b.hasAttribute('aria-haspopup') ? 1 : 0) - (a.hasAttribute('aria-haspopup') ? 1 : 0))[0];
    if (!trig) return { changed: false, note: 'nincs rendezés-választó ezen a poszton (előbb nyisd meg a posztot / az overlayt)' };
    const label = unsalt(trig.innerText || '').trim();
    if (want.test(label)) return { changed: false, now: label };
    trig.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    let item = null;
    for (let i = 0; i < 10 && !item; i++) {
      await sleep(150);
      item = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].find(m => want.test(unsalt((m.innerText || '').split('\n')[0]).trim()));
    }
    if (!item) return { changed: false, error: 'a menüben nincs ilyen pont', now: label };
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(jitter(900, 200));
    return { changed: true, from: label, now: unsalt(trig.innerText || '').trim() };
  }

  // Same post? (overlay author can differ from the feed card's author, so postId / text prefix decide)
  const samePost = (a, b) => (a.postId && b.postId ? a.postId === b.postId
    : !!a.text && !!b.text && fold(a.text).slice(0, 40) === fold(b.text).slice(0, 40));

  // expandComments({post, rounds, budgetMs, sort}) — opens "more comments / replies" of ONE post.
  // post: undefined → open overlay or the post nearest the screen centre · '#a3f9' / selector as in resolvePost · 'all' → every post in scope.
  // Never guesses: an unknown post is an error, and a modal that opens for a different post is reported, not used.
  async function expandComments({ rounds = 3, scope = document, budgetMs = 7000, post, sort = 'all' } = {}) {
    let roots;
    if (post === 'all') roots = findPostRoots(scope);
    else {
      const r = await resolveLive(post);
      if (!r) return { clicked: 0, done: true, error: post === undefined ? 'nincs poszt a nézetben' : `nincs ilyen poszt: ${post} — map() listázza az elérhetőket` };
      roots = [r];
    }
    const t0 = Date.now();
    let want = null, dlgBefore = null;
    if (post !== 'all') {
      try { want = extractPost(roots[0]); } catch (e) { want = null; }
      dlgBefore = new Set(findPostRoots().filter(r => r.matches?.(SEL.dialog) || r.closest?.(SEL.dialog)));
    }
    let sortRes = null;
    if (sort && post !== 'all') { try { sortRes = await setCommentSort(sort, { post: roots[0] }); } catch (e) { sortRes = { error: String(e.message || e) }; } }
    let total = 0;
    for (let r = 0; r < rounds && Date.now() - t0 < budgetMs - 2000; r++) {
      let n = 0;
      for (const root of roots) {
        for (const b of root.querySelectorAll('[role="button"], span[role="button"], div[tabindex="0"]')) {
          const t = (b.innerText || '').trim();
          if (!t || t.length > 60 || !MORE_COMMENTS_RE.test(t)) continue;
          if (b.hasAttribute('aria-haspopup') || b.hasAttribute('aria-expanded')) continue; // sort menu trigger, not an expander
          if (!safeToClick(b)) continue;
          b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          n++;
        }
      }
      total += n;
      if (dlgBefore && want) {
        await sleep(300);
        const fresh = findPostRoots().filter(r => (r.matches?.(SEL.dialog) || r.closest?.(SEL.dialog)) && !dlgBefore.has(r));
        for (const d of fresh) {
          let got = null;
          // the overlay's own content (text, postId) can still be loading right after it opens — wait rather
          // than report a false mismatch from comparing against an empty snippet
          for (let tries = 0; tries < 4; tries++) {
            try { got = extractPost(d); } catch (e) { got = null; }
            if (got && (got.postId || got.text)) break;
            await sleep(300);
          }
          if (got && !samePost(want, got)) return { clicked: total, done: true, error: 'modal-mismatch', opened: `${got.author || '?'}: ${(got.text || '').slice(0, 40)}`, hint: 'más poszt overlay-e nyílt meg: zárd be (Escape), majd go(\'#horgony\') és újra' };
        }
      }
      if (!n) break;
      await sleep(jitter(1500, 400));
    }
    await expandSeeMore({ scope, roots, rounds: 1, budgetMs: Math.max(500, budgetMs - (Date.now() - t0)) });
    const res = { clicked: total, done: Date.now() - t0 < budgetMs };
    if (sortRes && (sortRes.changed || sortRes.error)) res.sort = sortRes;
    if (want) lastExpand.set(contentKey(want), { clicked: total, done: res.done, at: Date.now() });
    return res;
  }

  // Synthesize hover on the timestamp link: FB then (a) shows the exact date in a
  // [role=tooltip] and (b) swaps the "?__cft__…" placeholder href for the real permalink.
  // One timestamp hover/focus on a single post → {tip, permalink}
  async function hoverOne(root, { needDate = true, needUrl = true } = {}) {
    const tl = findTimestampLink(root);
    if (!tl) return { tip: null };
    tl.scrollIntoView({ block: 'center' });
    await sleep(250);
    const r = tl.getBoundingClientRect();
    const ev = { bubbles: true, cancelable: true, clientX: r.left + 3, clientY: r.top + 3, view: window };
    // FB swaps the real permalink into href on focus (synthetic hover alone is not enough)
    try { tl.focus({ preventScroll: true }); tl.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (e) {}
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      tl.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, ev) : new MouseEvent(type, ev));
    }
    let tip = null;
    for (let i = 0; i < 10 && !tip; i++) {
      await sleep(150);
      tip = [...document.querySelectorAll('[role="tooltip"]')].map(t => (t.textContent || '').trim()).find(t => t.length > 4);
    }
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      tl.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, ev) : new MouseEvent(type, ev));
    }
    try { tl.blur(); } catch (e) {}
    if (tip && needDate && plausibleDate(tip)) tl.setAttribute('aria-label', unsalt(tip)); // cache so extract() picks it up
    return { tip: tip && plausibleDate(tip) ? unsalt(tip) : null };
  }

  // Synthesize hover on the timestamp link: FB then (a) shows the exact date in a [role=tooltip] and
  // (b) swaps the "?__cft__…" placeholder href for the real permalink.
  // The feed is virtualized, so every post seen on the way goes into harvest.store (map() shows it as ↑),
  // and the scroll position is restored at the end. {post} limits it to one post ('#a3f9', selector).
  async function hoverDates({ limit = 12, all = false, budgetMs = 8000, post } = {}) {
    let fixed = 0, permalinks = 0, done = true;
    const results = [];
    const t0 = Date.now(), x0 = scrollX, y0 = scrollY;
    let roots;
    if (post !== undefined) { const r = await resolveLive(post); if (!r) return { datesFixed: 0, permalinksRevealed: 0, done: true, error: `nincs ilyen poszt: ${post}` }; roots = [r]; }
    else roots = findPostRoots().slice(0, limit);
    try {
      for (const root of roots) {
        if (Date.now() - t0 > budgetMs - 2200) { done = false; break; }
        if (!root.isConnected) continue; // dropped by the virtualized feed meanwhile
        const needDate = !extractDate(root).raw;
        const needUrl = !extractPostUrl(root) || /\/photo\/?\?/.test(extractPostUrl(root) || '');
        if (post === undefined && !all && !needDate && !needUrl) continue;
        const { tip } = await hoverOne(root, { needDate, needUrl });
        if (tip && needDate) { fixed++; results.push(tip); }
        if (needUrl && extractPostUrl(root) && !/\/photo\/?\?/.test(extractPostUrl(root))) permalinks++;
        try { harvest.collect(); } catch (e) { /* store is best-effort */ }
        await sleep(jitter(250, 150));
      }
    } finally {
      if (Math.abs(scrollY - y0) > 2 || Math.abs(scrollX - x0) > 2) window.scrollTo({ left: x0, top: y0, behavior: 'instant' });
    }
    return { datesFixed: fixed, permalinksRevealed: permalinks, done, samples: results.slice(0, 5) };
  }

  // ── q(): compact one-line-per-row query, sized for the ~1000 char tool-output limit ──
  // q('posts', ['author','date','text:80','reactions']) · q('harvest') · q('comments') · q('search') · q('groups') · q('media')
  // Never prints signed CDN URLs; urls are shortened to their path. Continue with {offset}.
  const Q_DEFAULTS = {
    posts: ['author', 'date', 'text:80', 'reactions', 'comments', 'url'],
    harvest: ['author', 'date', 'text:80', 'reactions', 'comments', 'id'],
    comments: ['author', 'date', 'text:100', 'depth', 'pinned'],
    search: ['title', 'kind', 'id', 'slug', 'subtitle:60'],
    groups: ['name', 'id', 'info:50'],
    media: ['type', 'postId', 'n', 'comment', 'alt:40'],
  };
  function q(what = 'posts', fields = null, opts = {}) {
    if (fields && !Array.isArray(fields)) { opts = fields; fields = null; }
    const { limit = 20, offset = 0, maxChars = 900, format = 'lines' } = opts;
    const clip = (v, n) => { let t = String(v ?? '').replace(/https?:\/\/\S*(?:fbcdn\.net|scontent|fbsbx\.com)\S*/gi, '[cdn]').replace(/\s+/g, ' ').trim(); return n && t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const shortUrl = u => {
      if (!u) return '';
      try {
        const x = new URL(u, location.href);
        // keep the query parameters that identify the target ("/photo" alone is useless; "/photo?fbid=…&set=…" is the photo)
        const keep = ['id', 'fbid', 'set', 'story_fbid', 'comment_id', 'multi_permalinks', 'v'].filter(k => x.searchParams.get(k)).map(k => k + '=' + x.searchParams.get(k));
        return (/facebook\.com$/i.test(x.hostname) ? '' : x.hostname) + x.pathname.replace(/\/$/, '') + (keep.length ? '?' + keep.join('&') : '');
      } catch (e) { return clip(u, 60); }
    };
    const day = p => dateLabel(p);
    const GET = {
      author: p => p.author, date: day, dateRaw: p => p.dateRaw, text: p => p.text, url: p => shortUrl(p.url), id: p => p.postId || p.id,
      reactions: p => p.counts?.reactions, comments: p => (Array.isArray(p.comments) ? p.comments.length : p.counts?.comments), shares: p => p.counts?.shares,
      images: p => p.images?.length, alt: p => { const i = p.images?.find?.(x => x.alt); return i ? i.alt + (i.altWeak ? ' ⚠nem leíró' : '') : p.alt; }, video: p => (p.hasVideo ? 'videó' : ''), sponsored: p => (p.sponsored ? '📣' : ''),
      link: p => (p.cards?.[0]?.domain || p.links?.[0] ? shortUrl(p.cards?.[0]?.url || p.links?.[0]) : ''),
      pinned: p => (p.pinned ? '📌' : '') + (p.isAuthor ? 'szerző' : ''), depth: p => p.depth, replyTo: p => p.replyTo,
      title: p => p.title, kind: p => p.kind, slug: p => p.slug, subtitle: p => p.subtitle, name: p => p.name, info: p => p.info,
      type: p => p.type, postId: p => p.postId, n: p => p.n, comment: p => p.comment,
    };
    let rows;
    if (what === 'posts') rows = findPostRoots().slice(0, 100).map(r => { try { return extractPost(r); } catch (e) { return null; } }).filter(r => r && isRealPost(r));
    else if (what === 'harvest') rows = [...harvest.store.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.position || 0) - (b.position || 0));
    else if (what === 'comments') { const root = resolvePost(opts.post); rows = root ? extractPost(root, { comments: true, maxComments: opts.maxComments || 200 }).comments || [] : []; }
    else if (what === 'search') rows = extractSearchResults({ images: false });
    else if (what === 'groups') rows = listGroups();
    else if (what === 'media') rows = (window.__fbReader.mediaList() || []).map(m => ({ ...m, url: undefined })); // signed URLs only via download()
    else return `q(what): ${Object.keys(Q_DEFAULTS).join('|')}`;
    const fl = (fields && fields.length ? fields : Q_DEFAULTS[what]).map(f => { const [k, n] = String(f).split(':'); return { k, n: n ? +n : null }; });
    const unknown = fl.filter(f => !GET[f.k]).map(f => f.k);
    if (unknown.length) return `ismeretlen mező: ${unknown.join(', ')} · elérhető: ${Object.keys(GET).join(', ')}`;
    const total = rows.length;
    const sel = rows.slice(offset, offset + limit);
    const val = (r, f) => { const v = GET[f.k](r); return v === null || v === undefined || v === '' ? '-' : clip(v, f.n || (f.k === 'text' ? 80 : 60)); };
    if (format === 'json') {
      // one stable shape: FULL absolute URLs, ISO dates with an explicit approximation flag and the raw label, paging info
      const JGET = { ...GET, url: p => p.url || null, link: p => p.cards?.[0]?.url || p.links?.[0] || null, date: p => p.date || null };
      const rowsJ = sel.map(r => {
        const o = Object.fromEntries(fl.map(f => [f.k, JGET[f.k](r) ?? null]));
        if (fl.some(f => f.k === 'date')) { o.dateApprox = !!r.dateApprox; o.dateRaw = r.dateRaw ?? null; if (r.dateConflict) o.dateConflict = true; }
        return o;
      });
      return JSON.stringify({ what, total, offset, count: rowsJ.length, rows: rowsJ }, (k, v) => (typeof v === 'string' && !/^https?:\/\//.test(v) ? clip(v, 400) : v));
    }
    const head = `# ${what} ${Math.min(offset + 1, total)}–${Math.min(offset + sel.length, total)}/${total} · ${fl.map(f => f.k + (f.n ? ':' + f.n : '')).join(' | ')}`;
    const lines = [head];
    let used = head.length, shown = 0;
    for (let i = 0; i < sel.length; i++) {
      const line = `${offset + i + 1}| ${fl.map(f => val(sel[i], f)).join(' | ')}`;
      if (used + line.length + 90 > maxChars && shown > 0) break;
      lines.push(line); used += line.length + 1; shown++;
    }
    if (offset + shown < total) lines.push(`… még ${total - offset - shown} sor: q('${what}', ${fields ? JSON.stringify(fields) : 'null'}, {offset:${offset + shown}})`);
    if (!total) lines.push('(nincs találat)');
    return lines.join('\n');
  }

  // ── Olvasási szintek: map → peek → thread → full (token-takarékos, horgonyokkal) ──────────
  // L0 map()    1 sor / poszt (~25 token): horgony, kor, szerző, 55 karakter, számlálók, jelzők
  // L1 peek(h)  1 poszt ~120 token: rövidített szöveg, média, link, 3 kiemelt komment
  // L2 thread(h) komment-vázlat (kiemelt/szerzői elöl), szűrők: only / match
  // L3 full(h[, 'c3'])  egyetlen elem teljes szövege, lapozva
  // Horgony = tartalom-hash (#a3f9, szerző + az első 60 karakter): görgetés, újrarenderelés, hoverDates
  // után is ugyanaz, így több hívás között is hivatkozható. Minden kimenet ≤ maxChars (alap 900).
  const TOK = n => Math.round(n / 3.2);
  const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).padStart(4, '0').slice(-4); };
  const clipS = (v, n) => { const t = String(v ?? '').replace(/https?:\/\/\S*(?:fbcdn\.net|scontent|fbsbx\.com)\S*/gi, '[cdn]').replace(/\s+/g, ' ').trim(); return n && t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const domOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const contentKey = p => `${fold(p.author)}|${fold(p.text || p.sharedText || '').slice(0, 60) || fold(p.images?.[0]?.alt || '').slice(0, 40) || (p.hasVideo ? 'video' : (p.cards?.[0]?.url || ''))}`;
  // localStorage can silently drop a freshly written key (observed in testing, root cause uncertain — see
  // selfTest().storagePersistent). Verify the write by reading it back; on failure (exception or mismatch)
  // fall back to sessionStorage, which at least survives for the tab's lifetime instead of losing the data.
  const storeSet = (key, value) => {
    try { localStorage.setItem(key, value); if (localStorage.getItem(key) === value) return true; } catch (e) { /* tiltva / teli */ }
    try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; }
  };
  const storeGet = key => {
    try { const v = localStorage.getItem(key); if (v != null) return v; } catch (e) { /* ignore */ }
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  };
  const storeRemove = key => { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } };
  const SEEN_KEY = 'fb-reader:seen';
  const seenSet = () => { try { return new Set(JSON.parse(storeGet(SEEN_KEY) || '[]')); } catch (e) { return new Set(); } };
  const markSeen = hs => { try { const s = seenSet(); hs.forEach(h => s.add(h)); storeSet(SEEN_KEY, JSON.stringify([...s].slice(-3000))); } catch (e) { /* storage tiltva */ } };
  const ago = p => {
    if (!p.date) return clipS(p.dateRaw, 9) || '?';
    const m = Math.round((Date.now() - new Date(p.date).getTime()) / 60000);
    const a = m < 1 ? 'most' : m < 60 ? m + 'p' : m < 1440 ? Math.round(m / 60) + 'ó' : m < 43200 ? Math.round(m / 1440) + 'n' : localYmd(new Date(p.date));
    return (p.dateApprox ? '~' : '') + a + (p.dateConflict ? '⚠' : '');
  };
  const cntOf = p => [p.counts?.reactions != null ? '👍' + p.counts.reactions : '', p.counts?.comments != null ? '💬' + p.counts.comments : '', p.counts?.shares ? '↗' + p.counts.shares : ''].filter(Boolean).join(' ');
  const linkDom = p => {
    const c = p.cards?.[0], h = domOf(c?.url || p.links?.[0] || '');
    const meta = (c?.domain || '').toLowerCase().replace(/^www\./, '').trim();
    if (h && !/(^|\.)facebook\.com$/.test(h)) return h;
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(meta) ? meta : h; // the card's own domain line when the href is still FB's shim
  };
  const flagsOf = p => [p.images?.length ? '📷' + (p.images.length + (p.hiddenImages || 0)) + (p.hiddenImages ? '⚠' : '') : '', p.hasVideo ? '🎬' : '', (p.cards?.length || p.links?.length) && linkDom(p) ? '🔗' + clipS(linkDom(p), 18) : '', p.sharedText ? '⇄' : '', p.textTruncated ? '…' : ''].filter(Boolean).join('');
  const headText = p => p.text || p.sharedText || (p.images?.find(i => i.alt)?.alt ? '[kép] ' + p.images.find(i => i.alt).alt : '') || p.cards?.[0]?.title || (p.hasVideo ? '[videó]' : p.images?.length ? '[kép]' : '');
  const scrollPct = () => Math.round(100 * scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight));

  // A poszt-sorok (DOM + harvest-tár) horgonyokkal. live=false → már kigörgetett, csak a tárban van.
  // Horgony elsődlegesen a poszt saját postId-jéből (pfbid / numerikus) képződik: ez ugyanaz marad a
  // hírfolyamban, az overlay-ben, a permalinkoldalon és a harvest tárban is. postId nélkül tartalom-hash
  // a kulcs (szerző + szöveg eleje), ütközésnél a stabil aria-posinset-tel megkülönböztetve, végső
  // tartalékként egy futó számlálóval — ez utóbbi (azonos kezdetű, postId nélküli posztoknál) nem
  // garantáltan stabil ugyanazon oldal két betöltése közt, ezért a feedRows().unstable számolja, a map()
  // pedig jelzi.
  const rootAnchor = new WeakMap(); // root element → {key, anchor, id}
  function feedRows() {
    const rows = [], used = new Set(), liveKeys = new Set();
    let unstable = 0;
    const give = (p, root) => {
      const k = contentKey(p), id = p.postId || null;
      const prev = root && rootAnchor.get(root);
      let h, n = 0;
      if (id) {
        h = hashStr('p' + id);
        while (used.has(h)) h = hashStr('p' + id + '#' + (++n)); // azonos postId-nak elvileg nem lenne szabad kétszer előfordulnia
      } else if (prev && !prev.id && prev.k.split('|')[0] === k.split('|')[0] && (k.startsWith(prev.k) || prev.k.startsWith(k) || k.split('|')[1].slice(0, 12) === prev.k.split('|')[1].slice(0, 12)) && !used.has(prev.h)) {
        // FB fills a post's text in late: the same DOM node keeps its anchor while its key only grows/shrinks (same author, same text start)
        h = prev.h;
      } else {
        h = hashStr(k);
        if (used.has(h) && p.position != null) h = hashStr(k + '#pos' + p.position); // aria-posinset stabil akkor is, ha egy korábbi poszt kikerül a DOM-ból
        if (used.has(h)) { unstable++; while (used.has(h)) h = hashStr(k + '#' + (++n)); }
      }
      if (root) rootAnchor.set(root, { k, h, id });
      used.add(h); return h;
    };
    for (const root of findPostRoots()) {
      let p; try { p = extractPost(root); } catch (e) { continue; }
      if (!isRealPost(p)) continue;
      liveKeys.add(contentKey(p));
      rows.push({ h: give(p, root), p, root, live: true });
    }
    const off = [];
    for (const p of harvest.store.values()) if (!liveKeys.has(contentKey(p))) off.push({ h: give(p), p, root: null, live: false });
    off.sort((a, b) => (a.p.position || 0) - (b.p.position || 0));
    const result = off.concat(rows);
    result.unstable = unstable;
    return result;
  }
  function pick(ref) {
    const rows = feedRows();
    if (ref == null) { const r = resolvePost(); return rows.find(x => x.root && x.root === r) || null; }
    const h = String(ref).replace(/^#/, '').toLowerCase();
    return rows.find(x => x.h === h) || null;
  }
  const withComments = row => {
    if (row.live) row.p.comments = flagDateConflicts(row.p, extractComments(row.root, 80, row.p.author));
    return row.p.comments || [];
  };
  const noRow = ref => `nincs ilyen horgony: ${ref == null ? '(nincs poszt a nézetben)' : ref} · map() listázza az elérhetőket${pageInfo().type === 'photo' ? ' · fotóoldal: a valódi poszt a „Bejegyzés megtekintése” linken át érhető el: nav.photoPost()' : ''}`;
  // sorok → ≤ maxChars szöveg; lines[0] a fejléc, foot(shown) a lábléc. A fejlécbe ~tok kerül.
  function fitLines(headOf, lines, foot, maxChars) {
    const hd = n => (typeof headOf === 'function' ? headOf(n) : headOf);
    const out = []; let used = hd(lines.length).length + 12;
    for (let i = 0; i < lines.length; i++) {
      const f = foot ? foot(i + 1) : '';
      if (out.length && used + lines[i].length + 1 + (f ? f.length + 1 : 0) > maxChars) break;
      out.push(lines[i]); used += lines[i].length + 1;
    }
    const f = foot ? foot(out.length) : '', head = hd(out.length);
    const body = out.join('\n') + (f ? '\n' + f : '');
    return `${head} · ~${TOK(head.length + body.length)}tok\n${body}`.slice(0, Math.max(maxChars + 60, 200));
  }

  // A row that the virtualized feed dropped from the DOM is scrolled back toward its recorded position
  // (aria-posinset) until it renders again; if that fails the stored copy is used.
  async function ensureLive(ref, budgetMs = 6000) {
    const row = pick(ref);
    if (!row || row.live) return row;
    const t0 = Date.now(), target = row.p.position;
    for (let i = 0; i < 10 && Date.now() - t0 < budgetMs - 1200; i++) {
      const live = findPostRoots().map(r => ({ pos: +r.getAttribute('aria-posinset'), top: r.getBoundingClientRect().top })).filter(x => x.pos);
      const pos = live.map(x => x.pos);
      const dir = target == null || !pos.length ? -1 : target < Math.min(...pos) ? -1 : target > Math.max(...pos) ? 1 : 0;
      if (dir === 0 && i > 1) break;
      // jump by the estimated distance (px per post from two rendered posts), at least 0.8 viewport
      let step = innerHeight * 0.8;
      if (target != null && live.length >= 2) {
        const a = live[0], b = live[live.length - 1], per = b.pos !== a.pos ? Math.abs((b.top - a.top) / (b.pos - a.pos)) : 0;
        const near = live.reduce((m, x) => (Math.abs(x.pos - target) < Math.abs(m.pos - target) ? x : m));
        if (per > 20) step = Math.max(step, Math.abs((target - near.pos) * per) - innerHeight * 0.2);
      }
      window.scrollBy({ top: (dir || -1) * step, behavior: 'instant' });
      await sleep(jitter(650, 200));
      const r2 = pick(ref);
      if (r2 && r2.live) { r2.root.scrollIntoView({ block: 'center' }); return r2; }
    }
    return pick(ref) || row;
  }
  // Photo page of a post's picture: its own comments are empty, the real post is behind "Bejegyzés megtekintése".
  function photoPostHref() {
    const a = [...document.querySelectorAll('a[href]')].find(e => VIEW_POST_RE.test(unsalt(e.innerText || e.getAttribute('aria-label') || '').trim()));
    return a ? cleanUrl(a.href) : null;
  }
  // Facebook rounds relative times DOWN ("4 nap" = 4–5 days): the window in which the post can really lie.
  function dateWindow(p) {
    if (!p.date) return null;
    const hi = new Date(p.date).getTime();
    if (!p.dateApprox) return [hi, hi + 6e4];
    const m = /(\d+)\s*([^\d\s.,]+)/.exec(unsalt(p.dateRaw || ''));
    const u = m && UNIT[m[2].toLowerCase().replace(/\.$/, '')];
    return [hi - (u || 864e5), hi + 6e4];
  }
  function dayRange(s) {
    const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    const now = new Date();
    let y = m[1] ? +m[1] : now.getFullYear();
    let a = new Date(y, +m[2] - 1, +m[3]);
    if (!m[1] && a.getTime() > now.getTime() + 864e5) a = new Date(y - 1, +m[2] - 1, +m[3]);
    return [a.getTime(), a.getTime() + 864e5];
  }

  // map({limit=12, offset=0, w=55, unseen, ads, author, date:'10-19', by:'author'})
  function map(opts = {}) {
    const { limit = 12, offset = 0, w = 55, maxChars = 900, unseen = false, ads = false, author = null, by = null, date = null } = opts;
    const seen = seenSet(), pg = pageInfo();
    let rows = feedRows();
    const unstable = rows.unstable || 0;
    const adN = rows.filter(r => r.p.sponsored).length;
    if (!ads) rows = rows.filter(r => !r.p.sponsored);
    if (author) rows = rows.filter(r => fold(r.p.author).includes(fold(author)));
    let dayNote = '';
    if (date) {
      const dr = dayRange(date);
      if (!dr) return "map({date:'MM-DD' | 'YYYY-MM-DD'})";
      // approximate times ("~4n") are kept when the day can lie in their rounding window; confirm with await hoverDates({post:'#h'})
      rows = rows.filter(r => { const w = dateWindow(r.p); return !w || (w[0] < dr[1] && w[1] > dr[0]); });
      dayNote = ` · nap ${date}`;
    }
    const total = rows.length, newN = rows.filter(r => !seen.has(r.h)).length;
    if (unseen) rows = rows.filter(r => !seen.has(r.h));
    const meta = `${pg.type} · új ${newN}/${total}${dayNote}${adN && !ads ? ` · hirdetés kihagyva ${adN}` : ''}${unstable ? ` · ⚠ ${unstable} poszt azonos kezdettel, a horgony nem stabil` : ''} · ${scrollPct()}%`;
    if (!total) return `map ${pg.type} · nincs poszt a DOM-ban / tárban — görgess, navigálj, vagy selfTest()${pg.warning ? ' · ⚠ ' + pg.warning : ''}`;
    if (by === 'author') {
      const g = new Map();
      for (const r of rows) { const k = r.p.author || '?'; (g.get(k) || g.set(k, []).get(k)).push(r.h); }
      const lines = [...g.entries()].sort((a, b) => b[1].length - a[1].length).map(([a, hs]) => `${clipS(a, 24)} ×${hs.length} · ${hs.slice(0, 4).map(h => '#' + h).join(' ')}`);
      return fitLines(`map by author · ${meta}`, lines, n => (n < lines.length ? `… +${lines.length - n} szerző` : ''), maxChars);
    }
    const sel = rows.slice(offset, offset + limit);
    const lines = sel.map(r => {
      const p = r.p;
      return `${r.h}${r.live ? '' : '↑'}${seen.has(r.h) ? '' : '•'} ${ago(p)} ${clipS(p.author, 18) || '?'}: ${clipS(headText(p), w) || '-'} ${cntOf(p)} ${flagsOf(p)}`.replace(/\s+$/, '');
    });
    if (!lines.length) return `map ${meta} · (a szűrésnek nincs találata)`;
    return fitLines(n => `map ${meta} · ${offset + 1}–${offset + n}`, lines,
      n => (offset + n < rows.length ? `… +${rows.length - offset - n}: map({offset:${offset + n}}) · peek('#h')` : 'vége · peek("#h") / thread("#h")'), maxChars);
  }

  // peek(ref?, {chars=350, comments=3, cchars=90})  — ref nélkül: a nézet közepéhez legközelebbi poszt
  async function peek(ref, opts = {}) {
    const { chars = 350, comments = 3, cchars = 90, maxChars = 1400 } = opts;
    const row = await ensureLive(ref);
    if (!row) return noRow(ref);
    const p = row.p; markSeen([row.h]);
    const t = p.text || '';
    const L = [`#${row.h} · ${p.author || '?'}${p.authorVerified ? '✔' : ''} · ${ago(p)} · ${cntOf(p)} · ${flagsOf(p)}${p.sponsored ? ' · 📣HIRDETÉS' : ''}${row.live ? '' : ' · ↑(nem a DOM-ban)'}`];
    if (t) L.push(`„${clipS(t, chars)}"${t.length > chars ? ` [+${t.length - chars} kar]` : ''}${p.textTruncated ? ' [csonkolt: expandSeeMore()]' : ''}`);
    if (p.sharedText) L.push(`⇄ ${clipS(p.sharedText, 110)}`);
    const alts = (p.images || []).map(i => i.alt).filter(Boolean);
    if (p.images?.length) L.push(`🖼 ${p.images.length}${p.hiddenImages ? `+${p.hiddenImages} rejtett (⚠ becslés: a „+N” csempe felirata) → fénykép nézegető: photoSet()` : ''} kép${alts.length ? ': ' + alts.slice(0, 2).map(a => clipS(a, 60)).join(' | ') : ''}${(p.images || []).every(i => !i.alt || i.altWeak) ? ' ⚠alt nem leíró: a képet nézd meg' : ''}`);
    if (p.cards?.length) L.push(`🔗 ${clipS(p.cards[0].title || p.cards[0].url, 70)} (${linkDom(p)})`);
    else if (p.links?.length) L.push(`🔗 ${p.links.slice(0, 2).map(domOf).join(', ')}`);
    const cs = comments ? withComments(row) : [];
    if (cs.length) {
      const idx = cs.map((c, i) => ({ c, i })).sort((a, b) => ((b.c.pinned || b.c.isAuthor ? 1 : 0) - (a.c.pinned || a.c.isAuthor ? 1 : 0)) || a.i - b.i).slice(0, comments);
      for (const { c, i } of idx) L.push(`💬 c${i + 1}${c.pinned ? '📌' : ''}${c.isAuthor ? '✍' : ''}${c.dateConflict ? '⚠' : ''} ${clipS(c.author, 16)}: ${clipS(c.text || (c.media?.length ? '[média]' : ''), cchars)}`);
      const rest = (p.counts?.comments ?? cs.length) - idx.length;
      if (rest > 0) L.push(`💬 +${rest} komment`);
    }
    L.push(`→ full('#${row.h}') · thread('#${row.h}') · go('#${row.h}')`);
    const s = L.join('\n');
    return `${s}\n~${TOK(s.length)}tok`.slice(0, maxChars);
  }

  // thread(ref?, {top=8, offset, chars=100, only:'author'|'media'|'links'|'replies', match})
  async function thread(ref, opts = {}) {
    const { top = 8, offset = 0, chars = 100, only = null, match = null, maxChars = 900 } = opts;
    const row = await ensureLive(ref);
    if (!row) return noRow(ref);
    markSeen([row.h]);
    const all = withComments(row).map((c, i) => ({ c, n: i + 1 }));
    const m = match == null ? null : match instanceof RegExp ? c => match.test(c.text || '') : (s => c => fold(c.text).includes(s))(fold(String(match)));
    const okOnly = { author: c => c.pinned || c.isAuthor, media: c => c.media?.length, links: c => c.links?.length, replies: c => c.depth > 0 }[only];
    let sel = all.filter(({ c }) => (!okOnly || okOnly(c)) && (!m || m(c)));
    sel = sel.map((x, i) => ({ ...x, i })).sort((a, b) => ((b.c.pinned || b.c.isAuthor ? 1 : 0) - (a.c.pinned || a.c.isAuthor ? 1 : 0)) || a.i - b.i);
    const total = sel.length;
    const lines = sel.slice(offset, offset + top).map(({ c, n }) =>
      `c${n}${c.pinned ? '📌' : ''}${c.isAuthor ? '✍' : ''}${c.dateConflict ? '⚠' : ''} ${c.depth ? '↳' + (c.replyTo ? clipS(c.replyTo, 12) + '←' : '') : ''}${clipS(c.author, 16)}: ${clipS(c.text || '', chars)}${c.media?.length ? ' 📷' + c.media.length : ''}${c.links?.length ? ' 🔗' : ''}`);
    const loaded = all.length, declared = row.p.counts?.comments;
    const ex = lastExpand.get(contentKey(row.p)), gap = declared != null ? declared - loaded : 0;
    const inOverlay = !!row.root && (row.root.matches(SEL.dialog) || !!row.root.closest(SEL.dialog));
    const gapNote = gap > 0 ? (row.live && !inOverlay && loaded === 0
      ? `⤵ ${gap} komment: a hírfolyamban nincs komment-lista. Nyisd meg a posztot (commentBox('#${row.h}') → openWith → kattintás), a thread() az overlayben olvas`
      : ex && ex.clicked === 0 && ex.done
      ? `${gap} hiányzik: valószínűleg törölt/rejtett/szűrt (a számláló válaszokat és eltávolítottakat is számolhat), nincs több gomb`
      : `⤵ ${gap} nincs betöltve: await expandComments({post:'#${row.h}'})`) : '';
    const head = `thread #${row.h} · ${total}${only || m ? ' szűrt' : ''}/${loaded} betöltve${declared != null && declared > loaded ? ` (${declared} van)` : ''}`;
    if (!lines.length) return `${head} · (nincs komment${declared ? ' — ' + (gapNote || 'a számláló szerint van') : ''})`;
    return fitLines(head, lines, n => [offset + n < total ? `… +${total - offset - n}: thread('#${row.h}',{offset:${offset + n}})` : '', gapNote, `teljes: full('#${row.h}','c3')`].filter(Boolean).join(' · '), maxChars);
  }

  // full(ref, item?, {offset, maxChars})  — egy poszt / komment (item: 'c3') teljes szövege, lapozva
  async function full(ref, item = null, opts = {}) {
    const { offset = 0, maxChars = 900 } = opts;
    const row = await ensureLive(ref);
    if (!row) return noRow(ref);
    markSeen([row.h]);
    let text, label = `#${row.h}`;
    if (item) {
      const n = +String(item).replace(/^c/i, ''), c = withComments(row)[n - 1];
      if (!c) return `${label}: nincs ${item} komment (${withComments(row).length} betöltve)`;
      text = `${c.author || '?'} · ${c.dateRaw || ''}\n${c.text || ''}${c.media?.length ? `\n[média: ${c.media.map(x => x.kind + (x.alt ? ' ' + clipS(x.alt, 60) : '')).join(', ')}]` : ''}${c.links?.length ? `\n[link: ${c.links.slice(0, 3).join(' ')}]` : ''}`;
      label += '/' + String(item).toLowerCase();
    } else {
      const p = row.p;
      text = `${p.author || '?'} · ${p.dateRaw || ''}\n${p.text || ''}${p.sharedText ? '\n⇄ ' + p.sharedText : ''}${p.cards?.length ? '\n🔗 ' + p.cards.map(c => `${c.title || ''} ${c.url || ''}`).join(' · ') : ''}`;
    }
    text = clipS(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'), 0).replace(/https?:\/\/\S*(?:fbcdn\.net|scontent|fbsbx\.com)\S*/gi, '[cdn]');
    const seg = text.slice(offset, offset + maxChars), end = offset + maxChars >= text.length;
    return `${label} [${offset}–${Math.min(offset + maxChars, text.length)}/${text.length}]\n${seg}${end ? '' : `\n… tovább: full('#${row.h}',${item ? `'${item}'` : 'null'},{offset:${offset + maxChars}})`}`;
  }

  // grep(minta, {where:'posts'|'comments'|'all', ctx=35, limit=8})  — találat-kivonat horgonnyal, olvasás nélkül
  function grep(pat, opts = {}) {
    const { where = 'posts', ctx = 35, limit = 8, maxChars = 900 } = opts;
    if (pat == null || pat === '') return 'grep(minta|/regex/i, {where:"posts|comments|all", ctx, limit})';
    const re = pat instanceof RegExp ? new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g') : null;
    const needle = re ? null : fold(String(pat));
    const snip = t => {
      if (!t) return null;
      if (re) { re.lastIndex = 0; const m = re.exec(t); return m ? { i: m.index, len: m[0].length } : null; }
      const f = fold(t), i = f.indexOf(needle);
      if (i < 0) return null;
      return { i: f.length === t.length ? i : Math.round(i * t.length / Math.max(1, f.length)), len: needle.length };
    };
    const show = (t, s) => (s.i > ctx ? '…' : '') + clipS(t.slice(Math.max(0, s.i - ctx), s.i + s.len + ctx), 0) + (s.i + s.len + ctx < t.length ? '…' : '');
    const hits = [];
    for (const row of feedRows()) {
      if (where !== 'comments') {
        const t = [row.p.text, row.p.sharedText, ...(row.p.cards || []).map(c => c.title), ...(row.p.images || []).map(i => i.alt)].filter(Boolean).join(' ¶ ');
        const s = snip(t); if (s) hits.push(`#${row.h} ${clipS(row.p.author, 14)}: ${show(t, s)}`);
      }
      if (where !== 'posts') {
        for (const [i, c] of withComments(row).entries()) { const s = snip(c.text); if (s) hits.push(`#${row.h}/c${i + 1} ${clipS(c.author, 14)}: ${show(c.text, s)}`); }
      }
    }
    if (!hits.length) return `grep ${re ? pat : JSON.stringify(pat)} · 0 találat (${where})`;
    return fitLines(`grep ${re ? pat : JSON.stringify(pat)} · ${hits.length} találat`, hits.slice(0, limit), n => (hits.length > n ? `… +${hits.length - n}: grep(…,{limit:${limit + 8}})` : ''), maxChars);
  }

  // go(ref) — a poszt a nézetbe görgetve (a "navigálj a posztra" horgonya); nem kattint semmire.
  // Kigörgetett posztot visszagörget; ha a link még rejtett vagy csak fotó-link, felfedi a valódi permalinket (fókusz-hover).
  async function go(ref, { budgetMs = 6000 } = {}) {
    const row = await ensureLive(ref, budgetMs);
    if (!row) return noRow(ref);
    if (!row.live) return `#${row.h} nincs a DOM-ban, a görgetés sem hozta elő${row.p.url ? ' → navigálj: ' + row.p.url : ''}`;
    const top = () => { row.root.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); };
    top();
    const isPhoto = u => /\/photo\/?\?/.test(u || '');
    let url = extractPostUrl(row.root);
    if (!url || isPhoto(url)) { await hoverOne(row.root, { needDate: false, needUrl: true }); top(); url = extractPostUrl(row.root); }
    const note = !url ? 'link rejtett' : isPhoto(url) ? 'fotó-link: a fotóoldalon a „Bejegyzés megtekintése” (nav.photoPost()) a valódi poszt' : '';
    return `#${row.h} a nézetben · ${scrollPct()}% · ${url || '-'}${note ? ' · ' + note : ''}`;
  }

  // where() — hol vagyok: oldal, görgetés, mennyi poszt, mi látszik, mi az új; ~60 token
  function where() {
    const pg = pageInfo();
    if (pg.type === 'notifications') { const r = notifRows(), s = `notifications · ${r.length} betöltve · ${r.filter(x => x.unread).length} olvasatlan · ${inbox().split(' · ').slice(1, 3).join(' · ')}`; return `${s} · ~${TOK(s.length)}tok`; }
    if (pg.type === 'messages') { const r = threadRows(), open = THREAD_PATH_RE.test(location.pathname); const s = `messages · ${r.length} szál betöltve · ${r.filter(x => x.unread).length} olvasatlan${open ? ' · szál nyitva: msgThread()' : ''}`; return `${s} · ~${TOK(s.length)}tok`; }
    if (pg.type === 'marketplace') { const item = /\/marketplace\/item\//.test(location.pathname); const r = item ? [] : mkRows(); const s = item ? 'marketplace · hirdetés-oldal · listing()' : `marketplace · ${r.filter(x => !x.sponsored).length} hirdetés a DOM-ban (${r.filter(x => x.sponsored).length} szponzorált) · market() / listing('$ref')`; return `${s} · ~${TOK(s.length)}tok`; }
    const seen = seenSet(), rows = feedRows();
    const vis = rows.filter(r => { if (!r.root) return false; const b = r.root.getBoundingClientRect(); return b.height > 0 && b.bottom > 0 && b.top < innerHeight; }).map(r => '#' + r.h);
    const s = `${pg.type}${pg.heading ? ' · ' + clipS(pg.heading, 40) : ''} · ${scrollPct()}% · DOM ${rows.filter(r => r.live).length} · tár ${harvest.store.size} · új ${rows.filter(r => !seen.has(r.h)).length}/${rows.length} · látszik: ${vis.slice(0, 4).join(' ') || '-'}${pg.dialogOpen ? ' · 🗗 overlay nyitva' : ''}${pg.type === 'photo' ? ' · fotóoldal, poszt: ' + clipS(photoPostHref() || 'nincs link', 80) : ''}${pg.warning ? ' · ⚠ ' + pg.warning : ''}`;
    return `${s} · ~${TOK(s.length)}tok`;
  }
  const forgetSeen = () => { storeRemove(SEEN_KEY); return 'látott-lista törölve'; };

  // ── Self-test: which DOM anchors still exist on the current page? ─────────
  // langProbe(): what does the reader NOT understand on this page? Run it on a page in a new Facebook language, then
  // add the missing words to a pack (references/i18n.md). Read-only; clicks and types nothing.
  function langProbe({ limit = 12 } = {}) {
    const lg = lang(), roots = findPostRoots(), posts = [];
    for (const r of roots) { try { posts.push(extractPost(r)); } catch (e) { /* skip */ } }
    const uniq = a => [...new Set(a)];
    const dateFail = uniq(posts.filter(p => p.dateRaw && !p.date).map(p => p.dateRaw)).slice(0, limit);
    const dateOk = posts.filter(p => p.date).length;
    const known = new RegExp('^(?:' + [...rAll('moreComments'), ...rAll('publish'), ...rAll('reaction'), ...rAll('pinned'), ...rAll('authorBadge'), ...rAll('uiLine'),
      ...wAll('seeMore'), ...wAll('seeLess'), ...wAll('translate'), ...wAll('noise'), ...wAll('sponsored')].map(x => x.replace(/^\^|\$$/g, '')).join('|') + ')$', 'i');
    const labels = uniq([...document.querySelectorAll('[role="button"], [role="menuitem"], [role="tab"]')]
      .map(b => unsalt(b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length <= 40 && /\p{L}/u.test(t) && !/^\d/.test(t))).filter(t => { try { return !known.test(t); } catch (e) { return true; } });
    const noCounts = posts.filter(p => !p.counts || (p.counts.reactions == null && p.counts.comments == null)).length;
    const res = { lang: lg, posts: posts.length, dates: { parsed: dateOk, failedSamples: dateFail }, countsMissing: noCounts, unknownButtonLabels: labels.slice(0, limit * 2),
      hint: lg.supported ? 'a csomag létezik: a hiányzó szavakat bővítsd (registerLang vagy a PACKS tábla)' : 'nincs csomag: másold a hu/en bejegyzést, fordítsd le a szavakat (references/i18n.md)' };
    res.text = `langProbe · ${lg.page || '?'} (${lg.supported ? 'van csomag' : 'NINCS csomag'}) · ${posts.length} poszt · dátum ${dateOk}/${posts.length}${dateFail.length ? ' · nem értett: ' + dateFail.join(' | ') : ''} · számláló nélkül ${noCounts}` +
      (labels.length ? `\nismeretlen gombfeliratok: ${labels.slice(0, limit * 2).join(' | ')}` : '') + `\n${res.hint}`;
    return res;
  }
  function selfTest({ format = 'text' } = {}) {
    const q = sel => document.querySelectorAll(sel).length;
    const anchors = {
      'feed[aria-posinset]': q(SEL.feedPost), dialog: q(SEL.dialog), article: q(SEL.article),
      story_message: q(SEL.message), profile_name: q(SEL.profileName),
      like_button: q('[data-ad-rendering-role="like_button"]'), comment_button: q('[data-ad-rendering-role="comment_button"]'),
      'aria-labelledby': q('[aria-labelledby]'),
      'comment-article': [...document.querySelectorAll(SEL.article)].filter(isCommentArticle).length,
      permalink: q('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"]'),
      contenteditable: q('[contenteditable="true"]'),
    };
    const roots = findPostRoots();
    const posts = [];
    for (const r of roots) { try { posts.push(extractPost(r)); } catch (e) { /* counted below */ } }
    const n = posts.length, cnt = f => posts.filter(f).length;
    const ex = { roots: roots.length, posts: n, author: cnt(p => p.author), text: cnt(p => p.text), date: cnt(p => p.date || p.dateRaw),
      url: cnt(p => p.url), counts: cnt(p => p.counts && p.counts.reactions != null), images: cnt(p => p.images.length) };
    const warnings = [];
    if (!roots.length) warnings.push('HIBA: nincs poszt-gyökér (aria-posinset / dialog / article) — nincs betöltve poszt, vagy a Facebook átírta a horgonyokat');
    else {
      if (roots.length !== n) warnings.push(`HIBA: ${roots.length - n} poszt kinyerése kivételt dobott`);
      if (!ex.author) warnings.push('HIBA: egyik poszthoz sincs szerző (profile_name / fejléc horgony)');
      if (!ex.text && !ex.images && !posts.some(p => p.hasVideo)) warnings.push('HIBA: egyik poszthoz sincs szöveg/kép/videó');
      if (!anchors.story_message && ex.text) warnings.push('FIGYELEM: story_message horgony 0, a szöveg a tartalék ágon jön');
      if (ex.date < n) warnings.push(`FIGYELEM: ${n - ex.date}/${n} poszt dátuma hiányzik (hoverDates segíthet)`);
      if (ex.url < n) warnings.push(`FIGYELEM: ${n - ex.url}/${n} poszt linkje hiányzik (hoverDates fókusszal felfedi)`);
      if (ex.counts < n) warnings.push(`FIGYELEM: ${n - ex.counts}/${n} poszt számlálója hiányzik`);
      if (!anchors.like_button) warnings.push('FIGYELEM: like_button horgony 0 (a react() tartalék keresésre esik vissza)');
    }
    const unstableAnchors = feedRows().unstable || 0;
    if (unstableAnchors) warnings.push(`FIGYELEM: ${unstableAnchors} ütköző tartalomkulcsú poszt (azonos szerző+szövegkezdet, postId nélkül) — a horgonyuk újratöltés között nem garantált stabil`);
    // localStorage can silently lose a freshly written key (observed in testing, root cause uncertain):
    // write a probe and read it straight back rather than trusting the API blindly.
    let storagePersistent = true;
    try {
      const pk = '__fbr_probe__', pv = String(Date.now());
      localStorage.setItem(pk, pv);
      storagePersistent = localStorage.getItem(pk) === pv;
      localStorage.removeItem(pk);
    } catch (e) { storagePersistent = false; }
    if (!storagePersistent) warnings.push('FIGYELEM: a localStorage nem tartós ezen az oldalon — az olvasási lista / követés elveszhet (markSeen/trkSave sessionStorage-ra esik vissza)');
    const page = pageInfo();
    const lg = lang();
    if (lg.code && !lg.supported) warnings.push(`FIGYELEM: a Facebook nyelve „${lg.page}” — nincs hozzá nyelvi csomag (${lg.packs.join(', ')}); a dátumok, számlálók és gombfeliratok nem biztos, hogy felismerhetők. Segítség: langProbe() és references/i18n.md`);
    else if (lg.code && !lg.verified) warnings.push(`FIGYELEM: a „${lg.code}” nyelvi csomag még nincs valódi Facebook-felületen ellenőrizve (langProbe() megmutatja, mit nem ismer fel)`);
    const res = {
      ok: !warnings.some(w => w.startsWith('HIBA')), clean: warnings.length === 0, version: VERSION, build: BUILD, lang: document.documentElement.lang || null, language: lg,
      page: page.type, extension: !!window.__fbReaderExt, writeModule: window.__fbReader?.writeModule || null, anchors, extraction: ex, unstableAnchors, storagePersistent, warnings,
    };
    if (format === 'object') return res;
    return `selfTest ${res.clean ? '✓' : res.ok ? '⚠' : '✗'} · fb-reader ${VERSION}+${BUILD} · ${res.lang || '?'} · ${page.type} · bővítmény: ${res.extension ? 'igen' : 'nem'} · írási modul: ${res.writeModule ? 'van' : 'nincs'}\n` +
      `horgonyok: ${Object.entries(anchors).map(([k, v]) => `${k} ${v}`).join(', ')}\n` +
      `kinyerés: ${n}/${ex.roots} poszt — szerző ${ex.author}, szöveg ${ex.text}, dátum ${ex.date}, link ${ex.url}, számláló ${ex.counts}, kép ${ex.images}` +
      (warnings.length ? '\n' + warnings.join('\n') : '');
  }

  // ── Snapshot: anonymised structural copy of a post, for the regression suite ──
  // Letters become x/X except UI words, dates and numbers; ids/hrefs/images are neutralised; computed
  // display:none / visibility / opacity are written back as inline style, so decoys survive. Geometry is not
  // captured (scrambled-glyph decoding needs a real layout), so use it for anchor/structure tests.
  const anonWord = w => /^[\d.,:;()·•\-–—/#@!?+*'"„”…͏​-‏⁠﻿]*$/.test(w) ? w.replace(/\d{8,}/g, m => '1'.repeat(m.length))
    : KEEP_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')) ? w
    : w.replace(/\p{Lu}/gu, 'X').replace(/\p{Ll}/gu, 'x').replace(/\d{8,}/g, m => '1'.repeat(m.length));
  const anonText = t => String(t).split(/(\s+)/).map(w => (/^\s+$/.test(w) ? w : anonWord(w))).join('');
  const anonHref = h => {
    try {
      const u = new URL(h, location.href); const q = [...u.searchParams.keys()].filter(k => /^(id|story_fbid|fbid|comment_id|multi_permalinks|v)$/.test(k)).map(k => `${k}=${'1'.repeat(10)}`).join('&');
      const path = u.pathname.split('/').map(seg => (!seg || /^(groups|posts|permalink|permalink\.php|photo|profile\.php|user|videos|reel|watch|hashtag|search|people|pages|events|marketplace|ads|about)$/.test(seg) ? seg : /^\d+$/.test(seg) || /^pfbid/.test(seg) ? '1'.repeat(10) : 'x')).join('/');
      return (/facebook\.com$/i.test(u.hostname) ? 'https://www.facebook.com' : 'https://example.com') + path + (q ? '?' + q : '');
    } catch (e) { return '#'; }
  };
  function snapshot({ post, maxChars = 120000 } = {}) {
    const root = resolvePost(post);
    if (!root) return '';
    const orig = [root, ...root.querySelectorAll('*')];
    const clone = root.cloneNode(true);
    const copy = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < copy.length; i++) {
      const el = copy[i], o = orig[i];
      if (/^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(el.tagName)) { el.remove(); continue; }
      const cs = i ? getComputedStyle(o) : null; // the root's own visibility is irrelevant (isShown stops at the root)
      const st = [];
      if (cs) { if (cs.display === 'none') st.push('display:none'); if (cs.visibility === 'hidden') st.push('visibility:hidden'); if (+cs.opacity === 0) st.push('opacity:0'); if (parseFloat(cs.fontSize) === 0) st.push('font-size:0'); }
      for (const a of [...el.attributes]) {
        const n = a.name;
        if (n === 'href') el.setAttribute('href', anonHref(a.value));
        else if (n === 'src' || n === 'srcset' || n === 'xlink:href' || n === 'poster') el.setAttribute(n === 'src' || n === 'srcset' ? n : n, 'https://scontent.xx.fbcdn.net/v/x.jpg');
        else if (n === 'alt' || n === 'aria-label' || n === 'title' || n === 'aria-placeholder' || n === 'placeholder') el.setAttribute(n, anonText(a.value));
        else if (/^(role|tabindex|dir|contenteditable|type|id|aria-[a-z]+|data-ad-[a-z-]+|data-visualcompletion|lang)$/.test(n)) { /* keep */ }
        else el.removeAttribute(n);
      }
      if (st.length) el.setAttribute('style', st.join(';'));
      if (el.tagName === 'svg' || el.tagName === 'SVG') el.innerHTML = '';
    }
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const tn = []; while (walker.nextNode()) tn.push(walker.currentNode);
    for (const t of tn) t.nodeValue = anonText(t.nodeValue);
    const inner = clone.outerHTML;
    const wrap = clone.matches?.(SEL.dialog) ? inner : `<div role="main"><div role="feed">${inner}</div></div>`;
    const html = `<!doctype html><meta charset="utf-8"><title>fb-reader snapshot</title><!-- fb-reader ${VERSION}+${BUILD} snapshot of ${location.pathname.replace(/\d{6,}/g, '1')} (anonymised) -->\n${wrap}`;
    return html.length > maxChars ? html.slice(0, maxChars) + `\n<!-- csonkolva: ${html.length} karakterből ${maxChars} -->` : html;
  }

  // ── Harvest: survive FB's virtualized feed ────────────────────────────────
  const harvest = {
    store: new Map(),
    observer: null,
    opts: {},
    key(p) { return p.postId || p.url || `${p.author}|${(p.text || '').slice(0, 80)}`; },
    collect() {
      let added = 0;
      for (const root of findPostRoots()) {
        let p;
        try { p = extractPost(root, this.opts); } catch { continue; }
        if (!isRealPost(p)) continue;
        const k = this.key(p);
        const old = this.store.get(k);
        if (!old) { this.store.set(k, p); added++; continue; }
        // merge: keep the richer version of every field
        if ((p.text || '').length > (old.text || '').length) { old.text = p.text; old.textTruncated = p.textTruncated; }
        if (!old.date && p.date) Object.assign(old, { date: p.date, dateApprox: p.dateApprox, dateRaw: p.dateRaw, dateMethod: p.dateMethod });
        old.links = [...new Set([...old.links, ...p.links])];
        if (p.images.length > old.images.length) old.images = p.images;
        if ((p.comments?.length || 0) > (old.comments?.length || 0)) old.comments = p.comments;
        for (const c of ['reactions', 'comments', 'shares']) if (old.counts[c] == null) old.counts[c] = p.counts[c];
      }
      return added;
    },
    start(opts = {}) {
      this.opts = opts;
      if (!opts.keep) this.store.clear();
      this.observer?.disconnect();
      let t = null;
      this.observer = new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => this.collect(), 300); });
      this.observer.observe(document.body, { childList: true, subtree: true });
      const added = this.collect();
      return { started: true, collected: this.store.size, added };
    },
    // One call must finish inside the browser tool's time limit (~10 s): stop at budgetMs and
    // return {done:false, next} so the model can call again in a loop.
    async scroll({ steps = 3, pause = 1500, expand = true, comments = false, until = null, budgetMs = 8000 } = {}) {
      const t0 = Date.now();
      let idle = 0, lastH = 0, lastN = this.store.size;
      for (let i = 0; i < steps; i++) {
        if (Date.now() - t0 + pause + 600 > budgetMs) return { collected: this.store.size, done: false, next: i, reason: 'budget' };
        if (expand) await expandSeeMore({ rounds: 1, budgetMs: 1500 });
        if (comments) await expandComments({ post: 'all', sort: null, rounds: 1, budgetMs: 2000 });
        this.collect();
        if (until && this.store.size >= until) break;
        window.scrollBy({ top: Math.round(innerHeight * 0.85), behavior: 'smooth' });
        await sleep(jitter(pause));
        this.collect();
        const h = document.body.scrollHeight;
        idle = this.store.size === lastN && h === lastH ? idle + 1 : 0;
        lastN = this.store.size; lastH = h;
        if (idle >= 4) return { collected: this.store.size, steps: i + 1, end: true, done: true };
      }
      return { collected: this.store.size, end: false, done: true };
    },
    stop() { this.observer?.disconnect(); this.observer = null; return { collected: this.store.size }; },
    dump({ format = 'json', limit = 200, since = null, offset = 0, maxChars = 60000 } = {}) {
      let posts = [...this.store.values()];
      posts.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.position || 0) - (b.position || 0));
      if (since) posts = posts.filter(p => !p.date || p.date >= new Date(since).toISOString());
      const total = posts.length;
      posts = posts.slice(offset, offset + limit);
      const result = { tool: 'fb-reader', version: VERSION, extractedAt: new Date().toISOString(), page: pageInfo(), posts, warnings: total > offset + limit ? [`További ${total - offset - limit} poszt: dump({offset:${offset + limit}})`] : [] };
      if (format === 'md') return toMarkdown(result, { maxChars });
      return format === 'object' ? result : cdnSafeJson(result);
    },
  };

  // ── Locating posts ──────────────────────────────────────────────────────
  const fold = t => unsalt(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/(\d)[\s., ](?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ').trim();
  let lastFound = null;

  // findPost({text, imageAlt, author, url}) → first matching post in the DOM, else in harvest.store
  function findPost(q = {}) {
    if (typeof q === 'string') q = { text: q };
    const want = Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'mark').map(([k, v]) => [k, fold(v)]));
    const hit = p => (!want.text || fold([p.text, p.sharedText, ...(p.cards || []).map(c => c.title)].join(' ')).includes(want.text) || fold((p.images || []).map(i => i.alt).join(' ')).includes(want.text))
      && (!want.imagealt && !want.imageAlt || fold((p.images || []).map(i => i.alt).join(' ')).includes(want.imageAlt || want.imagealt))
      && (!want.author || fold(p.author).includes(want.author))
      && (!want.url || fold(p.url).includes(want.url) || fold(p.postId).includes(want.url));
    for (const root of findPostRoots()) {
      let p; try { p = extractPost(root); } catch { continue; }
      if (!hit(p)) continue;
      lastFound = root;
      root.scrollIntoView({ block: 'center' });
      if (q.mark) mark(root);
      return { found: true, inDom: true, url: p.url, postId: p.postId, author: p.author, date: p.dateRaw, snippet: (p.text || '').slice(0, 120), images: p.images.map(i => i.alt).filter(Boolean).slice(0, 2) };
    }
    for (const p of harvest.store.values()) if (hit(p)) return { found: true, inDom: false, url: p.url, postId: p.postId, author: p.author, date: p.dateRaw, snippet: (p.text || '').slice(0, 120), hint: p.url ? 'navigálj a url-re' : 'görgess vissza / harvest' };
    return { found: false };
  }

  // resolvePost(sel): undefined → open overlay or post nearest the viewport centre; 'last' → findPost hit;
  // number → index in findPostRoots(); string → postId / url fragment; object → findPost(object)
  function resolvePost(sel) {
    const roots = findPostRoots();
    if (sel && typeof sel === 'object' && sel.nodeType === 1) return sel;
    if (sel === 'last') return lastFound && lastFound.isConnected ? lastFound : null;
    if (typeof sel === 'number') return roots[sel] || null;
    if (typeof sel === 'string' && /^#[0-9a-z]{4}$/i.test(sel)) return feedRows().find(r => r.live && r.h === sel.slice(1).toLowerCase())?.root || null; // map() horgony
    if (typeof sel === 'string') return roots.find(r => [...r.querySelectorAll('a[href]')].some(a => a.href.includes(sel))) || null;
    if (sel && typeof sel === 'object') return findPost(sel).found ? lastFound : null;
    const dlg = roots.find(r => r.matches?.(SEL.dialog) || r.closest?.(SEL.dialog));
    if (dlg) return dlg;
    const mid = innerHeight / 2;
    return roots.map(r => [r, r.getBoundingClientRect()]).filter(([, b]) => b.height > 0)
      .sort((a, b) => Math.abs((a[1].top + a[1].bottom) / 2 - mid) - Math.abs((b[1].top + b[1].bottom) / 2 - mid))[0]?.[0] || null;
  }
  // Like resolvePost, but a '#horgony' that only lives in the harvest store (not currently in the DOM) is
  // scrolled back first (ensureLive): resolvePost itself can only ever return an element, and an off-DOM
  // row has none yet. Everything else (number, 'last', url fragment, object, viewport-centre/overlay) is
  // synchronous and delegates straight to resolvePost.
  async function resolveLive(sel) {
    if (typeof sel === 'string' && /^#[0-9a-z]{4}$/i.test(sel)) {
      const row = await ensureLive(sel);
      return row && row.live ? row.root : null;
    }
    return resolvePost(sel);
  }

  // Visual aid for screenshots: outline an element (pointer-events none, removed by unmark()).
  function mark(el, color = '#e11d48') {
    if (!el) return null;
    unmark();
    const b = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = 'fb-reader-mark';
    box.style.cssText = `position:fixed;left:${b.left - 3}px;top:${b.top - 3}px;width:${b.width + 6}px;height:${b.height + 6}px;border:3px solid ${color};border-radius:6px;z-index:2147483646;pointer-events:none`;
    document.body.appendChild(box);
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
  }
  function unmark() { document.getElementById('fb-reader-mark')?.remove(); return 'jelölés eltávolítva'; }

  // ── Pinned / author comments (prompt-sharing pages keep the real content there) ──
  async function extractPinnedComments({ post, expand = true, authorComments = true, max = 80, budgetMs = 7000 } = {}) {
    const root = await resolveLive(post);
    if (!root) return { found: false, comments: [] };
    const t0 = Date.now();
    if (expand) {
      // open "Továbbiak" inside the comments of this post only
      for (let r = 0; r < 3 && Date.now() - t0 < budgetMs - 1200; r++) {
        let n = 0;
        for (const b of root.querySelectorAll('[role="button"], div[tabindex="0"], span[tabindex="0"]')) {
          if (!b.closest(SEL.article) || !SEE_MORE.includes(unsalt(b.innerText || '').trim().toLowerCase()) || !safeToClick(b)) continue;
          b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); n++;
        }
        if (!n) break;
        await sleep(900);
      }
    }
    let p; try { p = extractPost(root); } catch { p = {}; }
    const comments = flagDateConflicts(p, extractComments(root, max, p.author)).filter(c => c.pinned || (authorComments && c.isAuthor));
    return { found: true, post: { url: p.url, author: p.author, date: p.dateRaw, imageAlt: (p.images || []).map(i => i.alt).filter(Boolean)[0] || null }, comments };
  }

  // Prompt record for the current / given post: pinned or author comment, else a "prompt" post text
  async function extractPrompt(opts = {}) {
    const r = await extractPinnedComments(opts);
    if (!r.found) return { found: false };
    const root = await resolveLive(opts.post);
    let p; try { p = extractPost(root); } catch { p = {}; }
    const cand = r.comments.map(c => ({ text: c.text || '', source: c.pinned ? 'pinned-comment' : 'author-comment' }))
      .concat(/prompt/i.test(p.text || '') ? [{ text: p.text, source: 'post-text' }] : [])
      .sort((a, b) => b.text.length - a.text.length)[0];
    // chars (default 2000; 0 = everything) + offset page through long prompts: {promptChars, truncated, nextOffset}
    const { chars = 2000, offset = 0 } = opts, whole = cand?.text || null;
    const part = whole == null ? null : (chars > 0 ? whole.slice(offset, offset + chars) : whole.slice(offset));
    const end = whole == null ? 0 : offset + (part || '').length;
    const alt = (p.images || []).find(i => i.alt);
    return { found: !!cand, postUrl: p.url || null, date: p.date || null, dateApprox: !!p.dateApprox, dateRaw: p.dateRaw || null, author: p.author || null,
      imageAlt: r.post.imageAlt, imageAltWeak: alt ? !!alt.altWeak : null, prompt: part, source: cand?.source || null,
      promptChars: whole ? whole.length : 0, truncated: !!whole && end < whole.length, nextOffset: whole && end < whole.length ? end : null };
  }

  function promptsToMarkdown(list) {
    return list.filter(x => x && x.prompt).map((x, i) => [`## ${i + 1}. ${x.author || ''} — ${x.dateRaw || x.date || ''}`, x.imageAlt ? `_Kép: ${x.imageAlt}_` : '', x.postUrl ? `Link: ${x.postUrl}` : '', `Forrás: ${x.source}`, '', '```text', x.prompt, '```', x.truncated ? `_… csonkolt: összesen ${x.promptChars} kar. — extractPrompt({offset:${x.nextOffset}})_` : ''].filter(Boolean).join('\n')).join('\n\n');
  }

  // ── Navigation: URL builders (open them with the browser's navigate tool) ──
  const FB = 'https://www.facebook.com';
  const enc = encodeURIComponent;
  const gid = g => String(g).replace(/^https?:\/\/[^/]+\/groups\//, '').replace(/[/?#].*$/, '');
  const SEARCH_TYPES = ['top', 'posts', 'people', 'photos', 'videos', 'groups', 'pages', 'places', 'events', 'marketplace'];
  // ── Inbox: notifications + Messenger (read only) ───────────────────────────────────────────────────────────
  // Notifications: rows are [role=listitem] holding a link with notif_id / notif_t (the type: feedback_reaction_generic,
  // comment_mention, group_activity, event_…). Messenger: thread rows are [role=row] holding a /messages/(e2ee/)t/ID link.
  // Reading the LIST sends nothing. OPENING a thread marks it read and the sender sees "Seen" (also in E2EE chats):
  // msgOpen() only returns the URL and says so. Everything here is read-only; sending goes through the write protocol.
  const NOTIF_KINDS = [
    [/mention/, 'említés'], [/reaction|(^|_)like/, 'reakció'], [/comment|reply/, 'komment'], [/tag/, 'címke'], [/share/, 'megosztás'],
    [/group/, 'csoport'], [/event/, 'esemény'], [/friend/, 'ismerős'], [/birthday/, 'szülinap'], [/memor/, 'emlék'],
    [/page|business/, 'oldal'], [/live|video|reel/, 'videó'],
  ];
  const NOTIF_TEXT_KINDS = [
    [/megemlített|említett|mentioned/i, 'említés'], [/reagált|reacted/i, 'reakció'], [/hozzászólt|válaszolt|commented|replied/i, 'komment'],
    [/megjelölt|tagged/i, 'címke'], [/megosztotta|shared/i, 'megosztás'], [/csoport|group/i, 'csoport'], [/esemény|event/i, 'esemény'],
    [/ismerősnek|friend request|ismerős/i, 'ismerős'], [/születésnap|birthday/i, 'szülinap'],
  ];
  // "my posts": reactions, comments, mentions, tags and shares (heuristic; a comment on a post you merely follow also counts)
  const NOTIF_MINE = new Set(['reakció', 'komment', 'említés', 'címke', 'megosztás']);
  const agoOf = t => { const d = parseFbDate(t); return ago({ date: d.iso, dateApprox: d.approx, dateRaw: t }); };
  const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const textLines = el => unsalt(el.innerText || '').split('\n').map(s => s.replace(/ /g, ' ').trim()).filter(Boolean);

  function notifRows() {
    const seenId = new Set(), rows = [], used = new Set();
    for (const a of document.querySelectorAll('a[href*="notif_id="]')) {
      let u; try { u = new URL(a.href, location.href); } catch (e) { continue; }
      const id = u.searchParams.get('notif_id');
      if (!id || seenId.has(id)) continue;
      let li = a.closest('[role="listitem"], [role="row"]');
      if (!li) { li = a; for (let i = 0; i < 8 && li.parentElement && li.parentElement.querySelectorAll('a[href*="notif_id="]').length <= 1; i++) li = li.parentElement; }
      if (!vis(li)) continue;
      seenId.add(id);
      const t = (u.searchParams.get('notif_t') || '').toLowerCase();
      const lines = textLines(li).filter(l => !/^(olvasatlan|unread)$/i.test(l) && l !== '·');
      let cut = lines.findIndex(l => NOTIF_TIME_RE.test(l));
      if (cut < 0) cut = lines.length;
      const text = lines.slice(0, cut).join(' '), meta = lines.slice(cut + 1).filter(l => l !== '·').join(' ');
      const btns = [...li.querySelectorAll('[role="button"][aria-label], [aria-label]')].map(b => unsalt(b.getAttribute('aria-label') || ''));
      const timeLab = btns.find(l => plausibleDate(l)) || lines[cut] || '';
      const unread = btns.some(l => /^(megjelölés olvasottként|mark as read)/i.test(l)) || /(^|\n)\s*(olvasatlan|unread)\s*(\n|$)/i.test(li.innerText || '');
      let kind = (NOTIF_KINDS.find(([re]) => re.test(t)) || [])[1] || (NOTIF_TEXT_KINDS.find(([re]) => re.test(text)) || [])[1] || 'egyéb';
      const clean = cleanUrl(a.href);
      let h = hashStr('n' + id), n = 0; while (used.has(h)) h = hashStr('n' + id + '#' + (++n)); used.add(h);
      rows.push({ ref: '@' + h, id, notifT: t || null, kind, mine: NOTIF_MINE.has(kind), unread, text, meta, when: timeLab ? agoOf(timeLab) : '?', whenRaw: timeLab || null,
        url: clean, postId: fbIdOf2(clean), root: li });
    }
    return rows;
  }
  // post / comment id of a notification target (permalink, multi_permalinks, comment_id)
  const fbIdOf2 = url => { try { const u = new URL(url); return u.searchParams.get('comment_id') || u.searchParams.get('multi_permalinks') || facebookIdOf(url) || null; } catch (e) { return null; } };
  const facebookIdOf = url => { const m = /\/(?:posts|permalink|reel|videos)\/(pfbid\w+|\d+)/.exec(url); return m ? m[1] : null; };

  // header counters (bell / Messenger / tab title). A missing number means "zero or not shown".
  function inboxCounts() {
    const bar = document.querySelector('[role="banner"]') || document;
    const labels = [...bar.querySelectorAll('[aria-label]')].map(e => unsalt(e.getAttribute('aria-label') || ''));
    const pick = re => { const m = labels.map(l => re.exec(l)).find(Boolean); return m ? +m[2] : null; };
    const title = /^\((\d+)\)/.exec(document.title);
    return { bell: pick(/^(Értesítések|Notifications)\s*[,:]\s*(\d+)/i), msg: pick(/^(Messenger|Üzenetek|Messages)\s*[,:]\s*(\d+)/i), title: title ? +title[1] : null,
      ready: !!document.querySelector('[role="banner"]') && labels.length >= 2 };
  }
  function inbox() {
    const { bell, msg, title } = inboxCounts();
    const pg = pageInfo();
    const s = `inbox · 🔔 ${bell ?? '?'} olvasatlan értesítés · ✉ ${msg ?? 0} olvasatlan üzenet${title != null ? ` · cím: (${title})` : ''} · oldal: ${pg.type}`
      + (bell == null && title != null ? ' · a harang száma nem látszik: az értesítés-oldalon az „Olvasatlan” szűrő pontos' : '');
    return `${s} · ~${TOK(s.length)}tok`;
  }
  // for the extension's background watch: counters only, no names, no message text, never opens a thread or the bell panel
  function watchPeek() {
    const pg = pageInfo(), c = inboxCounts();
    const stop = /\/(login|checkpoint|recover)\b/.test(location.pathname) || pg.loggedOut || /checkpoint/.test(pg.warning || '');
    if (stop) return { ok: false, stop: true, problem: pg.warning || 'nincs bejelentkezve / ellenőrző oldal' };
    if (!c.ready) return { ok: false, problem: 'a fejléc még nem töltődött be' };
    const notifs = c.bell != null ? c.bell : (c.msg == null && c.title != null ? c.title : Math.max(0, (c.title || 0) - (c.msg || 0)));
    return { ok: true, page: pg.type, bell: c.bell, msg: c.msg, title: c.title, notifs, msgs: c.msg || 0 };
  }

  function notifs({ unread = false, kind = null, match = null, limit = 8, offset = 0, chars = 90, maxChars = 900 } = {}) {
    const all = notifRows();
    if (!all.length) {
      const hint = pageInfo().type === 'notifications' ? 'görgess / várj a betöltésre' : `nyisd meg: navigate ${FB}/notifications (vagy a harang-panelt)`;
      return `notifs · nincs értesítés a DOM-ban · ${hint}`;
    }
    const m = match == null ? null : (s => r => fold(r.text).includes(s))(fold(String(match)));
    const kinds = kind === 'mine' ? null : kind;
    const sel = all.filter(r => (!unread || r.unread) && (kind === 'mine' ? r.mine : !kinds || r.kind === kinds) && (!m || m(r)));
    const lines = sel.slice(offset, offset + limit).map(r => `${r.ref}${r.unread ? '•' : ' '} ${r.when} ${r.kind}${r.mine ? '★' : ''}: ${clipS(r.text, chars)}${r.meta ? ' ⟨' + clipS(r.meta, 30) + '⟩' : ''}`);
    const un = all.filter(r => r.unread).length;
    const head = `notifs · ${sel.length}${unread || kind || m ? ' szűrt' : ''}/${all.length} betöltve · ${un} olvasatlan`;
    if (!lines.length) return `${head} · (nincs találat)`;
    return fitLines(head, lines, n => [offset + n < sel.length ? `… +${sel.length - offset - n}: notifs({offset:${offset + n}})` : '', `notif('${sel[offset]?.ref || '@…'}') részletek`, pageInfo().type === 'notifications' ? 'korábbiak: notifMore()' : ''].filter(Boolean).join(' · '), maxChars);
  }

  function notif(ref) {
    const all = notifRows();
    const r = ref == null ? all[0] : all.find(x => x.ref === String(ref).replace(/^#?@?/, '@'));
    if (!r) return `nincs ilyen értesítés: ${ref} · notifs() listázza az elérhetőket`;
    return `${r.ref} · ${r.kind}${r.mine ? ' · a te bejegyzésedhez' : ''} · ${r.whenRaw || r.when}${r.unread ? ' · olvasatlan' : ''}${r.notifT ? ' · ' + r.notifT : ''}\n${r.text}${r.meta ? '\n' + r.meta : ''}\n→ ${r.url}${r.postId ? ' (id ' + r.postId + ')' : ''}\nmegnyitás: navigate erre az URL-re; a tisztított link nem jelöli olvasottnak az értesítést`;
  }

  // ── Messenger ──
  const THREAD_PATH_RE = /\/(?:messages\/)?(e2ee\/)?t\/(\d+)/;
  function threadRows() {
    const out = [], seenT = new Set(), used = new Set();
    for (const a of document.querySelectorAll('a[href*="/t/"]')) {
      let u; try { u = new URL(a.href, location.href); } catch (e) { continue; }
      const m = THREAD_PATH_RE.exec(u.pathname); if (!m || seenT.has(m[2])) continue;
      const row = a.closest('[role="row"], [role="listitem"]'); if (!row || !vis(row)) continue; // the open thread's header links are no list rows
      seenT.add(m[2]);
      const lines = textLines(row);
      const unread = lines.some(l => /^(olvasatlan üzenet|unread message)\s*:?$/i.test(l));
      const body = lines.filter(l => !/^(olvasatlan üzenet|unread message)\s*:?$/i.test(l) && !/^(most aktív|aktív|active now|active)\b.*$/i.test(l) && l !== '·');
      const labels = [...row.querySelectorAll('[aria-label]')].map(e => unsalt(e.getAttribute('aria-label') || ''));
      const timeLab = labels.find(l => plausibleDate(l)) || '';
      const timeLine = body.findIndex(l => NOTIF_TIME_RE.test(l) && l.length <= 14);
      const parts = body.filter((l, i) => i !== timeLine);
      const name = parts[0] || '?', preview = parts.slice(1).join(' ');
      const group = labels.some(l => /^(csoportos chat|group chat)/i.test(l));
      let h = hashStr('t' + m[2]), n = 0; while (used.has(h)) h = hashStr('t' + m[2] + '#' + (++n)); used.add(h);
      out.push({ ref: '^' + h, id: m[2], e2ee: !!m[1], unread, group, name, preview, mine: /^(te|you)\s*:/i.test(preview), when: timeLab ? agoOf(timeLab) : (timeLine >= 0 ? body[timeLine] : '?'),
        path: u.pathname, url: location.origin + u.pathname, root: row });
    }
    return out;
  }

  function msgs({ unread = false, q = null, group = null, limit = 8, offset = 0, chars = 60, maxChars = 900 } = {}) {
    const all = threadRows();
    if (!all.length) return `msgs · nincs beszélgetés a DOM-ban · ${pageInfo().type === 'messages' ? 'várj a betöltésre / görgess a listában' : `nyisd meg: navigate ${FB}/messages/ (vagy messenger.com)`}`;
    const s = q == null ? null : fold(String(q));
    const sel = all.filter(r => (!unread || r.unread) && (group == null || r.group === group) && (!s || fold(r.name + ' ' + r.preview).includes(s)));
    const lines = sel.slice(offset, offset + limit).map(r => `${r.ref}${r.unread ? '•' : ' '} ${r.when} ${r.group ? '👥' : ''}${r.e2ee ? '🔒' : ''}${clipS(r.name, 22)}: ${clipS(r.preview, chars)}`);
    const un = all.filter(r => r.unread).length;
    const head = `msgs · ${sel.length}${unread || s || group != null ? ' szűrt' : ''}/${all.length} betöltve · ${un} olvasatlan`;
    if (!lines.length) return `${head} · (nincs találat${s ? '; csak a betöltött lista nevében és előnézetében keres: a teljes tartalomhoz a Messenger keresője kell: msgSearch()' : ''})`;
    return fitLines(head, lines, n => [offset + n < sel.length ? `… +${sel.length - offset - n}: msgs({offset:${offset + n}})` : '', `msgOpen('${sel[offset]?.ref || '^…'}') · ⚠ megnyitás = látásjelzés`, s ? 'tartalomban keres: msgSearch()' : ''].filter(Boolean).join(' · '), maxChars);
  }

  // URL of a thread; opening an UNREAD thread marks it read for the other side (read receipt), E2EE chats too
  function msgOpen(ref) {
    const all = threadRows();
    const r = all.find(x => x.ref === String(ref).replace(/^#?\^?/, '^'));
    if (!r) return `nincs ilyen beszélgetés: ${ref} · msgs() listázza az elérhetőket`;
    return `${r.ref} · ${r.group ? 'csoport' : 'chat'}${r.e2ee ? ' · végpontig titkosított' : ''} · ${r.name}${r.unread ? ' · OLVASATLAN' : ''}\n→ ${r.url}\n${r.unread ? '⚠ A szál megnyitása olvasottnak jelöli, a másik fél „Látta” jelzést kap. Csak a felhasználó jóváhagyásával nyisd meg.' : 'olvasott szál: a megnyitás nem küld újabb jelzést.'}`;
  }

  // Reads the thread that is ALREADY open (never opens one): last N messages, sender and time from each message's aria-label.
  function msgThread({ last = 8, chars = 100, offset = 0, maxChars = 900 } = {}) {
    const main = document.querySelector('[role="main"]') || document;
    const arts = [...main.querySelectorAll('[role="article"]')].filter(a => !a.parentElement?.closest('[role="article"]'));
    const pm = THREAD_PATH_RE.exec(location.pathname);
    if (!pm) return 'msgThread · nincs megnyitott beszélgetés ezen az oldalon · msgs() → msgOpen(ref) → navigate';
    const compose = [...main.querySelectorAll('[contenteditable="true"]')].map(c => unsalt(c.getAttribute('aria-label') || '')).find(Boolean) || '';
    const nm = /^(?:írás nekik|írj neki|írj nekik|write to|message)\s*:?\s*([^:\s].*)$/i.exec(compose);
    const name = nm ? nm[1] : (([...main.querySelectorAll('h3')].map(h => textLines(h)[0]).find(t => t && t.length < 60 && !/információ|information|details|beszélgetés|chat/i.test(t))) || '?');
    const msgsOut = arts.map(a => {
      const lab = [a, ...a.querySelectorAll('[aria-label]')].map(e => unsalt(e.getAttribute('aria-label') || '')).find(l => /\d{1,2}:\d{2}/.test(l) && l.includes(','));
      let time = '', sender = '', text = '';
      if (lab) { const m = /^(.*?),\s*([^:]+?)(?::\s*([\s\S]*))?$/.exec(lab); if (m) { time = m[1].replace(/-(kor|nál)$/i, '').trim(); sender = m[2].trim(); text = (m[3] || '').trim(); } }
      if (!sender) sender = unsalt(a.querySelector('h4')?.innerText || '').trim();
      if (!text) text = textLines(a).filter(l => l !== sender && l !== 'Te küldted' && !/^(belépés|enter)/i.test(l) && !/^\d{1,2}:\d{2}$/.test(l)).join(' ');
      const media = a.querySelectorAll('img').length > 1 || (!text && a.querySelector('img,video')) ? ' [csatolmány]' : '';
      return { sender: /^(te|you)$/i.test(sender) ? 'Te' : sender || '?', time, text: text + media };
    }).filter(m => m.text || m.sender !== '?');
    if (!msgsOut.length) return `msgThread · ${name} · nincs üzenet a DOM-ban (görgess feljebb / várj)`;
    const total = msgsOut.length, from = Math.max(0, total - last - offset), to = total - offset;
    const lines = msgsOut.slice(from, to).map((m, i) => `m${from + i + 1} ${m.sender}${m.time ? ' ' + clipS(m.time, 16) : ''}: ${clipS(m.text, chars)}`);
    const head = `msgThread · ${clipS(name, 30)}${pm[1] ? ' 🔒' : ''} · ${from + 1}–${to}/${total} betöltve`;
    return fitLines(head, lines, () => from > 0 ? `régebbi: msgThread({offset:${offset + last}}) (előbb görgess feljebb a betöltéshez)` : '', maxChars);
  }


  // ── The logged-in account (read from Facebook's own page data, never from a hard-coded name) ──
  // Used to bind "message to myself" to the ACCOUNT: the id is compared, the name only proposes candidates.
  function me() {
    const s = [...document.scripts].map(x => x.textContent || '').find(x => x.includes('CurrentUserInitialData'));
    const seg = s ? s.slice(s.indexOf('CurrentUserInitialData'), s.indexOf('CurrentUserInitialData') + 900) : '';
    const id = (/"USER_ID":"(\d+)"/.exec(seg) || /"ACCOUNT_ID":"(\d+)"/.exec(seg) || [])[1] || null;
    const nm = /"NAME":"((?:[^"\\]|\\.)*)"/.exec(seg);
    let name = null; if (nm) { try { name = JSON.parse('"' + nm[1] + '"'); } catch (e) { name = nm[1]; } }
    return { ok: !!id, id, name };
  }
  // Candidates for the user's own (notes-to-self) thread: a 1:1 thread whose name equals the account's name,
  // and/or the open thread when its header says so. A candidate is a PROPOSAL: the user confirms it once
  // (fb-approve.mjs --register-self); the registered thread URL + account id are what the exception is bound to.
  function selfThread() {
    const m = me();
    if (!m.ok) return 'selfThread · a fiók nem azonosítható az oldalról (nem Facebook-oldal vagy nincs bejelentkezve)';
    const f = fold(m.name || ''), lines = [];
    const rows = threadRows().filter(r => !r.group && f && fold(r.name) === f);
    for (const r of rows) lines.push(`${r.ref} ${r.e2ee ? '🔒' : ''}${r.name} → ${r.url}`);
    const pm = THREAD_PATH_RE.exec(location.pathname);
    const main = document.querySelector('[role="main"]') || document;
    const head = [...main.querySelectorAll('h3, h1, h2')].map(h => textLines(h)[0]).find(x => x && fold(x) === f);
    const open = pm && head ? `${location.origin}${location.pathname.replace(/\/*$/, '/')}` : null;
    // name-free proof: the open thread's panel links to a profile whose id IS the logged-in account
    const proof = !!pm && [...main.querySelectorAll('a[href]')].some(a => { try { const u = new URL(a.href, location.href); return u.pathname.replace(/\//g, '') === m.id || u.searchParams.get('id') === m.id; } catch (e) { return false; } });
    const tail = `account ${m.id}${m.name ? ' · ' + m.name : ''}`;
    if (!lines.length && !open && !proof) return `selfThread · nincs jelölt a betöltött listában és a megnyitott szál sem a saját szál · ${tail} · nyisd meg a Messenger-listát (nav.messages()), vagy a saját szálat`;
    return `selfThread · ${tail}\n` + (open || proof ? `megnyitott szál = ${proof ? 'BIZONYÍTOTT saját szál (a profil-link a fiók azonosítójára mutat)' : 'név-egyezés'} → ${location.origin}${location.pathname.replace(/\/*$/, '/')}\n` : '') + lines.join('\n') + `\n⚠ név-egyezés csak jelölt (a „BIZONYÍTOTT” sor erősebb): a felhasználó egyszer megerősíti (fb-approve.mjs --register-self --url <szál> --account ${m.id})`;
  }

  // ── Marketplace (read only): search results, listing page ─────────────────────────────────────────────────
  // Result cards are links to /marketplace/item/<id>/ with text lines [badge?] price [old price] title location; sponsored cards
  // carry "Partneri hirdetés". Filters are URL parameters (nav.marketplace). Nothing here clicks; messaging a seller or saving a
  // search alert are writes (fb-reader-write: marketControl + the message protocol).
  const MK_CUR = /(ft|huf|eur|€|\$|usd|ron|lei|czk|pln|zł|kč)/i;
  const mkIsPrice = s => /^(ingyenes|free)$/i.test(s) || (s.length <= 24 && /\d/.test(s) && MK_CUR.test(s) && !/[a-záéíóöőúüű]{5,}/i.test(s.replace(MK_CUR, '')));
  const mkPriceNum = s => { if (/^(ingyenes|free)$/i.test(s || '')) return 0; const d = String(s || '').replace(/[^\d]/g, ''); return d ? +d : null; };
  // One "line" of a single-listing page can hold the current price and the struck-through old price with no
  // separator between them ("25 000 Ft250 000 Ft"): split it back into its price tokens instead of treating
  // it as one price.
  const MK_PRICE_TOKEN = /(?:ingyenes|free|[\d\s.,]+\s*(?:ft|huf|eur|€|\$|usd|ron|lei|czk|pln|zł|kč))/gi;
  const mkSplitPrices = s => (s ? (s.match(MK_PRICE_TOKEN) || []).map(t => t.trim()).filter(Boolean) : []);
  const MK_BADGE = /^(az imént meghirdetve|meghirdetve|\d+\s*(perce|órája|napja|hete|hónapja|éve)\b|just listed|listed\b|kiemelt|csökkentett ár|ára csökkent|price drop|akció)/i;
  const MK_SPONS = /^(partneri hirdetés|szponzorált|sponsored|hirdetés)$/i;
  const MK_STORE = { key: '', rows: new Map() };
  function mkRows() {
    const key = location.pathname + location.search;
    if (MK_STORE.key !== key) { MK_STORE.key = key; MK_STORE.rows = new Map(); }
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      const m = /\/marketplace\/item\/(\d+)/.exec(a.getAttribute('href') || ''); if (!m || seen.has(m[1]) || !vis(a)) continue;
      seen.add(m[1]);
      const lines = textLines(a);
      const sponsored = lines.some(l => MK_SPONS.test(l));
      const body = lines.filter(l => !MK_SPONS.test(l));
      const badge = body.filter(l => !mkIsPrice(l) && MK_BADGE.test(l)).join(' ') || null;
      const rest = body.filter(l => !MK_BADGE.test(l) || mkIsPrice(l));
      const prices = rest.filter(mkIsPrice);
      const text = rest.filter(l => !mkIsPrice(l));
      let title = text[0] || '', loc = text.length > 1 ? text[text.length - 1] : '';
      if (!title) { const ar = unsalt(a.getAttribute('aria-label') || ''); const mm = /^(.*?)\s*,\s*([^,]*?(?:Ft|€)[^,]*),\s*(.*?),?\s*(?:apróhirdetés|listing)\b/i.exec(ar); if (mm) { title = mm[1]; loc = mm[3]; } else title = ar.split(',')[0]; }
      const price = prices[0] || null;
      const row = { id: m[1], ref: '$' + hashStr('m' + m[1]), title, price: price || '?', priceNum: price ? mkPriceNum(price) : null, oldPrice: prices[1] || null,
        free: price ? /^(ingyenes|free)$/i.test(price) : false, loc, badge, sponsored, url: `${location.origin}/marketplace/item/${m[1]}/` };
      MK_STORE.rows.set(m[1], row);
      out.push({ ...row, root: a });
    }
    return out;
  }
  function mkContext() {
    const txt = e => unsalt(e.innerText || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const btn = re => { const e = [...document.querySelectorAll('[role="button"], [role="combobox"]')].find(x => re.test(txt(x))); return e ? txt(e) : null; };
    // The sort button shows only "Rendezés:"; the chosen value is the checked radio in the (hidden) listbox next to it.
    const sortBtn = [...document.querySelectorAll('[role="button"]')].find(x => /^(Rendezés|Sort)/i.test(txt(x)));
    let sort = sortBtn ? txt(sortBtn).replace(/^(Rendezés|Sort( by)?)\s*:+\s*/i, '') : '';
    if (!sort && sortBtn) {
      const radios = [...(sortBtn.parentElement || document).querySelectorAll('[role="radio"]')];
      const on = radios.find(r => r.getAttribute('aria-checked') === 'true');
      if (on) sort = txt(on);
    }
    sort = sort || null;
    // The location button's text is "Dunaújváros · 65 km-en belül"; the "Helyszín: …" form lives in its aria-label.
    const lab = x => (x.getAttribute('data-fbr-orig') && x.getAttribute('data-fbr-orig') !== '\u0000' ? x.getAttribute('data-fbr-orig') : x.getAttribute('aria-label')) || '';
    const locEl = [...document.querySelectorAll('[role="button"]')].find(x => /^(Helyszín|Location)\s*:/i.test(lab(x)));
    const where = locEl ? lab(locEl).replace(/\s*\[fbr:[^\]]*\]/g, '').replace(/^(Helyszín|Location)\s*:\s*/i, '').trim() || null : null;
    const q = new URLSearchParams(location.search).get('query');
    return { sort, where, q };
  }
  async function marketScroll({ steps = 3, budgetMs = 9000, format = 'text' } = {}) {
    const t0 = Date.now(); let stale = 0, before = mkRows().length;
    const known = new Set(MK_STORE.rows.keys());              // what the store held before this call: the rest is NEW
    for (let i = 0; i < steps && Date.now() - t0 < budgetMs && stale < 2; i++) {
      scrollBy(0, Math.round(innerHeight * 0.9)); await new Promise(r => setTimeout(r, 900));
      const n = mkRows().length; stale = n > before ? 0 : stale + 1; before = Math.max(before, n);
    }
    const fresh = [...MK_STORE.rows.values()].filter(r => !known.has(r.id));
    const res = { loaded: MK_STORE.rows.size, added: fresh.length, newRefs: fresh.map(r => r.ref), done: stale >= 2, scrollPct: scrollPct(), ms: Date.now() - t0 };
    if (format === 'json') return res;
    const s = `marketScroll · +${res.added} új · ${res.loaded} betöltve (a tárban) · ${res.scrollPct}%${res.done ? ' · nincs több' : ''}`;
    return `${s} · ~${TOK(s.length)}tok`;
  }
  // ready(): wait until the page content is really there (the title alone is not content). Read-only; polls every 250 ms.
  // Run it after every navigation, before market() / listing() / map(): reading too early returns empty or title-only pages.
  async function ready({ budgetMs = 6000, format = 'text' } = {}) {
    const t0 = Date.now(), p = location.pathname;
    const kind = /\/marketplace\/item\//.test(p) ? 'listing' : /\/marketplace\//.test(p) ? 'marketplace' : /^\/notifications\b/.test(p) ? 'notifications' : /^\/messages\b/.test(p) ? 'messages' : 'feed';
    const probe = () => {
      if (document.readyState === 'loading') return [0, 'a dokumentum még tölt'];
      if (kind === 'listing') { const x = listingPage(); return [x && x.title && x.price ? 1 : 0, x && x.title ? 'cím van, ár még nincs' : 'a hirdetés tartalma még nincs a DOM-ban']; }
      if (kind === 'marketplace') { const n = mkRows().length; return [n, n ? '' : /nem található|no results|nincs találat/i.test((document.querySelector('[role="main"]') || document.body).innerText || '') ? 'üres találati lista' : 'még nincs hirdetés a DOM-ban']; }
      if (kind === 'notifications') { const n = notifRows().length; return [n, n ? '' : 'még nincs értesítés a DOM-ban']; }
      if (kind === 'messages') { const n = threadRows().length; return [n, n ? '' : 'még nincs szál a DOM-ban']; }
      const n = findPostRoots().length; return [n, n ? '' : 'még nincs poszt a DOM-ban'];
    };
    let r = probe();
    while (!r[0] && Date.now() - t0 < budgetMs && !/üres találati/.test(r[1])) { await new Promise(x => setTimeout(x, 250)); r = probe(); }
    const body = (document.body?.innerText || '').trim().length;
    const res = { ready: !!r[0] || /üres találati/.test(r[1]), page: kind, items: r[0] || 0, waitedMs: Date.now() - t0, why: r[0] ? null : r[1], bodyChars: body, title: document.title.slice(0, 60) };
    if (!res.ready && body < 200) res.why = (res.why ? res.why + ' · ' : '') + 'csak a lap címe / üres törzs: ha nem javul, a navigáció még folyamatban van vagy bejelentkezési fal';
    if (format === 'json') return res;
    return `ready · ${res.ready ? 'igen' : 'NEM'} · ${kind} · ${res.items} elem · ${res.waitedMs} ms${res.why ? ' · ' + res.why : ''}`;
  }
  function market({ q = null, min = null, max = null, free = null, sponsored = false, by = null, limit = 8, offset = 0, chars = 58, maxChars = 900, format = 'text' } = {}) {
    const live = mkRows(), liveIds = new Set(live.map(r => r.id));
    const all = [...live, ...[...MK_STORE.rows.values()].filter(r => !liveIds.has(r.id))];
    const ctx = mkContext();
    if (!all.length && format === 'json') return { page: 'marketplace', query: ctx.q, loaded: 0, matched: 0, count: 0, rows: [], why: 'nincs hirdetés a DOM-ban: ready() majd újra' };
    if (!all.length) {
      const empty = /nem található|no results|nincs találat/i.test((document.querySelector('[role="main"]') || document.body).innerText || '');
      return `market · ${empty ? 'nincs találat erre a keresésre/szűrőre' : 'nincs hirdetés a DOM-ban'} · ${/\/marketplace\//.test(location.pathname) ? 'várj a betöltésre / lazíts a szűrőn' : `nyisd meg: navigate nav.marketplace({q:'…'})`}`;
    }
    const s = q == null ? null : fold(String(q));
    let sel = all.filter(r => (sponsored || !r.sponsored) && (!s || fold(r.title + ' ' + r.loc).includes(s)) && (min == null || (r.priceNum != null && r.priceNum >= min)) && (max == null || (r.priceNum != null && r.priceNum <= max)) && (free == null || r.free === free));
    if (by === 'price') sel = [...sel].sort((a, b) => (a.priceNum ?? 1e12) - (b.priceNum ?? 1e12));
    else if (by === 'price-desc') sel = [...sel].sort((a, b) => (b.priceNum ?? -1) - (a.priceNum ?? -1));
    if (format === 'json') {
      // one record shape for every ad, FULL url, no text parsing needed
      const rows = sel.slice(offset, offset + limit).map(r => ({ ref: r.ref, id: r.id, title: r.title, price: r.price === '?' ? null : r.price, priceNum: r.priceNum, oldPrice: r.oldPrice, free: r.free, location: r.loc || null, badge: r.badge, sponsored: r.sponsored, url: r.url }));
      return { page: 'marketplace', query: ctx.q, sort: ctx.sort, place: ctx.where, loaded: all.length, matched: sel.length, sponsoredSkipped: sponsored ? 0 : all.filter(r => r.sponsored).length, offset, count: rows.length, nextOffset: offset + rows.length < sel.length ? offset + rows.length : null, rows };
    }
    const lines = sel.slice(offset, offset + limit).map(r => `${r.ref} ${r.price}${r.oldPrice ? ' (volt ' + r.oldPrice + ')' : ''} ${clipS(r.title, chars)}${r.loc ? ' · ' + clipS(r.loc, 22) : ''}${r.badge ? ' ⟨' + clipS(r.badge, 20) + '⟩' : ''}${r.sponsored ? ' [szponzorált]' : ''}`);
    const spon = all.filter(r => r.sponsored).length;
    const filt = s || min != null || max != null || free != null;
    const head = `market${ctx.q ? ' „' + clipS(ctx.q, 24) + '”' : ''} · ${sel.length}${filt ? ' szűrt' : ''}/${all.length} betöltve${spon && !sponsored ? ` (${spon} szponzorált kihagyva)` : ''}${ctx.sort ? ' · ' + clipS(ctx.sort, 46) : ''}${ctx.where ? ' · ' + clipS(ctx.where, 34) : ''}`;
    if (!lines.length) return `${head} · (nincs találat a szűrőkre) · ${all.length < 60 ? 'több: marketScroll()' : ''}`;
    return fitLines(head, lines, n => [offset + n < sel.length ? `… +${sel.length - offset - n}: market({offset:${offset + n}})` : 'több hirdetés: await marketScroll()', `listing('${sel[offset]?.ref || '$…'}') → navigate → listing()`].join(' · '), maxChars);
  }

  // listing page (/marketplace/item/<id>/): the item itself, never the "related / sponsored" cards below it
  function listingPage() {
    const m = /\/marketplace\/item\/(\d+)/.exec(location.pathname); if (!m) return null;
    const main = document.querySelector('[role="main"]') || document.body;
    const L = textLines(main);
    const h1 = main.querySelector('h1');
    const title = (h1 ? textLines(h1)[0] : '') || L[0] || '';
    const ti = Math.max(0, L.indexOf(title));
    const priceLine = L.slice(ti + 1, ti + 9).find(mkIsPrice) || null;
    const priceParts = mkSplitPrices(priceLine); // current price, then the struck-through old price if both share one line
    const price = priceParts[0] || null, oldPrice = priceParts[1] || null;
    let when = null, loc = null, deliv = null;
    const mi = L.findIndex((l, i) => i > ti && /^(meghirdetve|listed)\b/i.test(l));
    if (mi >= 0) {
      const mm = /^(?:meghirdetve|listed)\s*:?\s*(.*?),\s*(?:itt|in)\s*:\s*(.+)$/i.exec(L[mi]) || /^(?:meghirdetve|listed)\s*:?\s*(.+)$/i.exec(L[mi]);
      if (mm) { when = mm[1]; loc = mm[2] || null; }
      const nx = L[mi + 1]; if (nx && /átadás|átvétel|szállítás|pickup|shipping|delivery|pick-up/i.test(nx)) deliv = nx;
    }
    const di = L.findIndex(l => /^(részletek|details)$/i.test(l));
    const endRe = /(a hely közelítőlegesen|location is approximate|approximate)|^(hirdetés|eladó adatai|seller information)$/i;
    let details = {}, desc = '', approx = null;
    if (di >= 0) {
      let ei = L.findIndex((l, i) => i > di && endRe.test(l)); if (ei < 0) ei = Math.min(L.length, di + 30);
      const seg = L.slice(di + 1, ei).filter(l => !/^(továbbiak megtekintése|see more|továbbiak)$/i.test(l));
      let i = 0;
      while (seg.length - i >= 3 && seg[i].length <= 32 && seg[i + 1].length <= 60) { details[seg[i]] = seg[i + 1]; i += 2; }
      desc = seg.slice(i).join(' ');
      const al = L[ei]; if (al) { const am = /^(.+?)\s*·\s*(?:a hely közelítőlegesen|location is approximate)/i.exec(al); if (am) approx = am[1]; }
    }
    const sellerA = [...main.querySelectorAll('a[href*="/marketplace/profile/"]')].find(a => textLines(a)[0] && !/^(eladó adatai|seller information)$/i.test(textLines(a)[0]));
    const seller = sellerA ? { name: textLines(sellerA)[0], profile: new URL(sellerA.href, location.href).pathname, joined: L.find(l => /^(ekkor csatlakozott|joined)/i.test(l)) || null } : null;
    const images = [...main.querySelectorAll('img')].filter(i => i.width > 150 && i.alt && !/,\s*(itt|in):/i.test(i.alt)).length;
    return { id: m[1], title, price, priceNum: price ? mkPriceNum(price) : null, oldPrice, when, loc: loc || approx, delivery: deliv, details, desc, seller, images, url: `${location.origin}/marketplace/item/${m[1]}/` };
  }
  function listing(ref, { chars = 320, format = 'text' } = {}) {
    if (ref && typeof ref === 'object') { format = ref.format || format; chars = ref.chars || chars; ref = null; }
    if (ref == null || ref === '') {
      const x = listingPage();
      if (format === 'json') return x ? { ok: true, ...x, price: x.price, sellerName: x.seller?.name || null } : { ok: false, why: 'ez nem hirdetés-oldal' };
      if (!x) return `listing · ez nem hirdetés-oldal · market() listázza a találatokat, listing('$ref') adja a címet`;
      const det = Object.entries(x.details).map(([k, v]) => `${k}: ${v}`).join('; ');
      const s = `listing · ${clipS(x.title, 70)} · ${x.price || '?'}${x.oldPrice ? ' (volt ' + x.oldPrice + ')' : ''}${x.when ? ' · ' + x.when : ''}${x.loc ? ' · ' + clipS(x.loc, 30) : ''}${x.delivery ? '\n' + clipS(x.delivery, 50) : ''}${det ? '\n' + clipS(det, 220) : ''}${x.desc ? '\nLeírás: ' + clipS(x.desc, chars) : ''}${x.seller ? `\nEladó: ${clipS(x.seller.name, 30)}${x.seller.joined ? ' (' + clipS(x.seller.joined.replace(/^(ekkor csatlakozott a facebookhoz|joined facebook in)\s*:?\s*/i, 'csatlakozott: ').replace(/\.$/, ''), 34) + ')' : ''}` : ''}\n→ ${x.url} · 📷${x.images}`;
      return `${s} · ~${TOK(s.length)}tok`;
    }
    const all = [...mkRows(), ...MK_STORE.rows.values()];
    const r = all.find(x => x.ref === String(ref).replace(/^#?\$?/, '$') || x.id === String(ref));
    if (!r) return format === 'json' ? { ok: false, why: `nincs ilyen hirdetés: ${ref}` } : `nincs ilyen hirdetés: ${ref} · market() listázza az elérhetőket`;
    if (format === 'json') { const { root, ...rest } = r; return { ok: true, ...rest, detailsOnPage: false }; }
    return `${r.ref} · ${r.title} · ${r.price}${r.loc ? ' · ' + r.loc : ''}${r.sponsored ? ' · szponzorált' : ''}\n→ ${r.url}\nrészletek: navigate erre az URL-re, majd listing()`;
  }

  // ── Tracking own listings / sale posts (read only) ───────────────────────────────────────────────────────────
  // The list lives in this browser profile's localStorage (per account/browser, never sent anywhere). Checking = the page is open
  // (navigate to the item's URL) and trackCheck() compares it with the last snapshot: price/status/counters of a Marketplace
  // listing, reactions/comments/shares + NEW comments of a group sale post. Nothing here clicks, types or sends.
  const TRK_KEY = 'fb-reader:track';
  const trkLoad = () => { try { const a = JSON.parse(storeGet(TRK_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const trkSave = a => storeSet(TRK_KEY, JSON.stringify(a.slice(-40)));
  const TRK_SOLD = /(?:^|[^\p{L}])(eladva|elkelt|sold|foglalt|lefoglalva|reserved|függőben|pending)(?![\p{L}])/iu;
  const TRK_STATS = /(\d[\d\s.,]*)\s*(megtekintés|kattintás|érdeklődő|mentés|megosztás|views?|clicks?|interested|saves?|shares?)(?![\p{L}])/giu;
  const TRK_INQ = /(még (elérhető|megvan|eladó)|érdekel|lefoglal|foglal(t|om)|mennyi|alku|cserél|átvétel|küldesz|küldene|available|interested|how much|price)/i;
  function trkPage(u) {
    let url; try { url = new URL(u || location.href, location.href); } catch (e) { return null; }
    const p = url.pathname + url.search;
    let m = /\/marketplace\/item\/(\d+)/.exec(p); if (m) return { id: 'm' + m[1], kind: 'marketplace', url: `${url.origin}/marketplace/item/${m[1]}/` };
    m = /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/.exec(p); if (m) return { id: 'g' + m[2], kind: 'group', group: m[1], url: `${url.origin}/groups/${m[1]}/posts/${m[2]}/` };
    m = /[?&](?:story_fbid|multi_permalinks|fbid)=(\d+)/.exec(p) || /\/posts\/(\w+)/.exec(p);
    if (m) return { id: 'p' + m[1], kind: 'post', url: url.origin + url.pathname + (url.search ? url.search.split('&').filter(x => /(story_fbid|multi_permalinks|fbid|id)=/.test(x)).join('&').replace(/^(?!\?)/, '?') : '') };
    return null;
  }
  function trkSnap(pg) {
    const main = document.querySelector('[role="main"]') || document.body;
    if (pg.kind === 'marketplace') {
      const x = listingPage(); if (!x) return null;
      const head = unsalt(main.innerText || '').slice(0, 1500), stats = {};
      for (const m of head.matchAll(TRK_STATS)) stats[m[2].toLowerCase()] = +m[1].replace(/\D/g, '');
      const sold = TRK_SOLD.exec(unsalt(main.innerText || '').slice(0, 400));
      return { title: x.title, price: x.price || null, priceNum: x.priceNum, sold: sold ? sold[1].toLowerCase() : null, stats };
    }
    const root = findPostRoots()[0]; if (!root) return null;
    const c = extractCounts(root), px = extractPost(root), cm = commentArticles(root).map(commentInfo);
    const sold = TRK_SOLD.exec((px.text || '').slice(0, 400));
    const pr = /(\d[\d\s.]*\d|\d)\s*(ft|huf|eur|€)/i.exec(px.text || '');
    return { title: (px.text || '').slice(0, 70), price: pr ? pr[0].trim() : null, priceNum: pr ? +pr[1].replace(/\D/g, '') : null, sold: sold ? sold[1].toLowerCase() : null,
      reactions: c.reactions, comments: c.comments, shares: c.shares, cm: cm.map(a => ({ h: hashStr((a.author || '') + '|' + (a.text || '')), a: a.author || '?', t: (a.text || '').slice(0, 90) })) };
  }
  function trkDiff(old, now) {
    const changes = [], fresh = [];
    if (!old) return { first: true, changes, fresh };
    if (old.price !== now.price) changes.push(`ár ${old.price || '?'} → ${now.price || '?'}`);
    if (old.title !== now.title && now.title && old.title && !old.title.startsWith(now.title.slice(0, 30))) changes.push('a cím/szöveg módosult');
    if ((old.sold || null) !== (now.sold || null)) changes.push(now.sold ? `állapot: ${now.sold}` : 'állapot: újra elérhető');
    for (const k of Object.keys({ ...old.stats, ...now.stats })) { const a = old.stats?.[k] ?? 0, b = now.stats?.[k] ?? 0; if (a !== b) changes.push(`${k} ${a} → ${b}`); }
    for (const k of ['reactions', 'comments', 'shares']) if (old[k] != null && now[k] != null && old[k] !== now[k]) changes.push(`${{ reactions: 'reakció', comments: 'komment', shares: 'megosztás' }[k]} ${old[k]} → ${now[k]}`);
    if (now.cm) { const seen = new Set((old.cm || []).map(c => c.h)); for (const c of now.cm) if (!seen.has(c.h)) fresh.push({ ...c, inq: TRK_INQ.test(c.t) }); }
    return { first: false, changes, fresh };
  }
  function trackAdd(o = {}) {
    const pg = trkPage(o.url); if (!pg) return 'trackAdd · nem hirdetés-/poszt-cím: adj url-t (…/marketplace/item/<id>/ vagy …/groups/<csoport>/posts/<id>/), vagy nyisd meg az oldalt';
    const list = trkLoad(); let it = list.find(x => x.id === pg.id);
    const here = !o.url || trkPage()?.id === pg.id;
    let title = o.title, price = o.price;
    if (here && (!title || !price)) { const s = trkSnap(pg); if (s) { title = title || s.title; price = price || s.price; } }
    if (!it) { it = { id: pg.id, kind: pg.kind, url: pg.url, group: pg.group || o.group || null, title: title || null, price: price || null, addedAt: Date.now(), checkedAt: null, changedAt: null, note: o.note || null, snap: null }; list.push(it); }
    else { it.title = title || it.title; it.price = price || it.price; it.note = o.note || it.note; }
    return trkSave(list) ? `⌗${it.id} követve · ${it.kind} · ${clipS(it.title || '?', 50)}${it.price ? ' · ' + it.price : ''} · ${list.length} követett` : 'trackAdd · a böngészőtár nem írható';
  }
  function trackList({ hours = 6 } = {}) {
    const list = trkLoad(); if (!list.length) return 'track · nincs követett hirdetés · trackAdd() egy hirdetés-/poszt-oldalon, vagy myListings({track:true})';
    const ago = t => { if (!t) return 'még nem'; const m = Math.round((Date.now() - t) / 60000); return m < 90 ? m + ' perce' : m < 2880 ? Math.round(m / 60) + ' órája' : Math.round(m / 1440) + ' napja'; };
    const lines = list.map(x => `⌗${x.id} ${x.kind}${x.price ? ' ' + x.price : ''} ${clipS(x.title || '?', 42)} · ell.: ${ago(x.checkedAt)}${!x.checkedAt || Date.now() - x.checkedAt > hours * 36e5 ? ' ⏰' : ''}${x.changedAt ? ' · ⚑ változott ' + ago(x.changedAt) : ''}${x.snap?.sold ? ' · ' + x.snap.sold : ''} → ${new URL(x.url).pathname}`);
    const s = `track · ${list.length} követett (⏰ = esedékes ${hours} óránál régebbi)\n${lines.join('\n')}\nellenőrzés: navigate az url-re, 3–4 s várás, trackCheck()`;
    return `${s} · ~${TOK(s.length)}tok`;
  }
  function trackRemove(id) {
    const list = trkLoad(), k = String(id || '').replace(/^⌗/, ''), n = list.filter(x => x.id !== k);
    if (n.length === list.length) return `trackRemove · nincs ilyen: ${id}`; trkSave(n); return `⌗${k} nem követett többé · ${n.length} követett`;
  }
  function trackCheck({ format = 'text', save = true } = {}) {
    const fail = problem => (format === 'object' ? { ok: false, problem } : `trackCheck · ${problem}`);
    const pg = trkPage(); if (!pg) return fail('ez nem hirdetés-/poszt-oldal');
    const list = trkLoad(), it = list.find(x => x.id === pg.id);
    if (!it) return fail(`nem követett (⌗${pg.id}) · trackAdd()`);
    const now = trkSnap(pg); if (!now) return fail('az oldal még nem töltött be vagy nem olvasható: várj 3–4 s, majd újra');
    const d = trkDiff(it.snap, now);
    if (save) { it.snap = now; it.checkedAt = Date.now(); if (d.changes.length || d.fresh.length) it.changedAt = Date.now(); it.title = it.title || now.title; it.price = now.price || it.price; trkSave(list); }
    const changed = !!(d.changes.length || d.fresh.length), inq = d.fresh.filter(c => c.inq).length;
    if (format === 'object') return { ok: true, id: it.id, kind: it.kind, title: it.title, first: d.first, changed, changes: d.changes, fresh: d.fresh, inquiries: inq, sold: now.sold, url: it.url };
    const head = `⌗${it.id} ${clipS(it.title || '?', 46)}${now.price ? ' · ' + now.price : ''}`;
    if (d.first) return `${head} · első mérés rögzítve${now.comments != null ? ` (${now.comments} komment, ${now.reactions ?? '?'} reakció)` : ''}${now.sold ? ' · ' + now.sold : ''}`;
    if (!changed) return `${head} · nincs változás`;
    const lines = [`${head} · ⚑ ${[...d.changes, d.fresh.length ? `${d.fresh.length} új komment${inq ? ' (' + inq + ' érdeklődés-jelzés)' : ''}` : ''].filter(Boolean).join('; ')}`];
    for (const c of d.fresh.slice(0, 6)) lines.push(`  ↳ ${c.inq ? '❓' : ''}${clipS(c.a, 24)}: ${clipS(c.t, 80)}`);
    return lines.join('\n');
  }
  // the seller's dashboard (/marketplace/you/selling): own listings with whatever status/counter text the cards carry
  function myListings({ track = false } = {}) {
    const rows = mkRows().filter(r => !r.sponsored);
    if (!rows.length) { const t = (document.querySelector('[role="main"]') || document.body).innerText || ''; return `myListings · ${/amikor elkezded az értékesítést|when you start selling/i.test(t) ? 'még nincs hirdetésed' : 'nincs hirdetés a DOM-ban (várj / nyisd meg: …/marketplace/you/selling)'}`; }
    const out = rows.map(r => {
      const txt = unsalt((r.root || document.body).innerText || ''), stats = []; for (const m of txt.matchAll(TRK_STATS)) stats.push(`${m[2].toLowerCase()} ${m[1].replace(/\D/g, '')}`);
      const st = (/(aktív|active|eladva|sold|függőben|pending|lejárt|expired|elutasítva|hiányos)/i.exec(txt) || [])[1];
      if (track) trackAdd({ url: r.url, title: r.title, price: r.price });
      return `${r.id} ${r.price} ${clipS(r.title, 46)}${st ? ' · ' + st : ''}${stats.length ? ' · ' + stats.join(', ') : ''}`;
    });
    const s = `myListings · ${rows.length} hirdetés${track ? ' (mind követve)' : ' · myListings({track:true}) követésbe veszi'}\n${out.join('\n')}`;
    return `${s} · ~${TOK(s.length)}tok`;
  }
  // where does my price stand among the loaded results (run on a search page after marketScroll; same item type + condition!)
  function priceCheck({ price = null, id = null } = {}) {
    const seen = new Set(), rows = [...mkRows(), ...MK_STORE.rows.values()].filter(r => !seen.has(r.id) && seen.add(r.id) && !r.sponsored && r.priceNum > 0);
    if (rows.length < 3) return `priceCheck · csak ${rows.length} ár látszik: nav.marketplace({q}) + marketScroll(), majd újra`;
    const a = rows.map(r => r.priceNum).sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
    let mine = price != null ? +price : null; if (mine == null && id) { const it = trkLoad().find(x => x.id === String(id).replace(/^⌗/, '')); mine = it?.snap?.priceNum ?? mkPriceNum(it?.price); }
    const f = n => n.toLocaleString('hu-HU').replace(/[\u00a0\u202f]/g, ' ') + ' Ft', ctx = mkContext();
    let s = `priceCheck${ctx.q ? ' „' + clipS(ctx.q, 24) + '”' : ''} · ${a.length} ár · min ${f(a[0])} · Q1 ${f(q(0.25))} · medián ${f(q(0.5))} · Q3 ${f(q(0.75))} · max ${f(a[a.length - 1])}`;
    if (mine != null) { const pct = Math.round(100 * a.filter(x => x < mine).length / a.length); s += `\nsaját ár ${f(mine)}: a látott hirdetések ${pct}%-a olcsóbb · ${pct >= 75 ? 'drága: árcsökkentés megfontolható' : pct <= 25 ? 'olcsó: az ár emelhető' : 'versenyképes sáv'}`; }
    return `${s}\n⚠ csak azonos típusú/állapotú tárgyakra értelmes; a ~1 Ft-os "kérj ajánlatot" árak torzítanak`;
  }

  const nav = {
    photoPost: () => photoPostHref(),
    searchTypes: SEARCH_TYPES,
    search: (q, type = 'top') => {
      if (!SEARCH_TYPES.includes(type)) throw new Error('type: ' + SEARCH_TYPES.join('|'));
      if (type === 'marketplace') return nav.marketplace({ q });
      return `${FB}/search/${type}/?q=${enc(q)}`;
    },
    // reels have no own search tab — they come up under videos; hashtags work too
    hashtag: tag => `${FB}/hashtag/${enc(String(tag).replace(/^#/, ''))}`,
    group: (g, { chronological = false } = {}) => `${FB}/groups/${gid(g)}/${chronological ? '?sorting_setting=CHRONOLOGICAL' : ''}`,
    groupSearch: (g, q) => `${FB}/groups/${gid(g)}/search/?q=${enc(q)}`,
    groupAbout: g => `${FB}/groups/${gid(g)}/about/`,
    groupMedia: g => `${FB}/groups/${gid(g)}/media/`,
    groupMembers: g => `${FB}/groups/${gid(g)}/members/`,
    groupFiles: g => `${FB}/groups/${gid(g)}/files/`,
    groupEvents: g => `${FB}/groups/${gid(g)}/events/`,
    groupsJoined: () => `${FB}/groups/joins/`,
    groupsFeed: () => `${FB}/groups/feed/`,
    profile: u => /^\d+$/.test(String(u)) ? `${FB}/profile.php?id=${u}` : `${FB}/${String(u).replace(/^@/, '')}`,
    // page or profile from a search result's id / slug (or a full URL)
    page: x => {
      const v = typeof x === 'object' && x ? (x.id || x.slug || x.url) : x;
      if (/^https?:/.test(String(v))) return cleanUrl(v);
      return /^\d+$/.test(String(v)) ? `${FB}/profile.php?id=${v}` : `${FB}/${String(v).replace(/^@/, '')}`;
    },
    profileTab: (u, tab = 'photos') => /^\d+$/.test(String(u)) ? `${FB}/profile.php?id=${u}&sk=${tab}` : `${FB}/${String(u).replace(/^@/, '')}/${tab}`,
    // Marketplace search; filters are URL parameters (verified live: query, minPrice, maxPrice, sortBy, daysSinceListed, itemCondition, deliveryMethod, exact; sortBy distance_ascend is verified: „Távolság: a legközelebbi elsőként”)
    marketplace: (o = {}) => {
      if (typeof o === 'string') o = { q: o };
      const SORT = { new: 'creation_time_descend', newest: 'creation_time_descend', price: 'price_ascend', cheap: 'price_ascend', 'price-desc': 'price_descend', expensive: 'price_descend', distance: 'distance_ascend', near: 'distance_ascend' };
      const COND = { new: 'new', 'like-new': 'used_like_new', likenew: 'used_like_new', good: 'used_good', fair: 'used_fair' };
      const DELIV = { pickup: 'local_pick_up', local: 'local_pick_up', shipping: 'shipping', ship: 'shipping' };
      const pr = [`query=${enc(o.q || '')}`];
      if (o.min != null) pr.push(`minPrice=${+o.min}`);
      if (o.max != null) pr.push(`maxPrice=${+o.max}`);
      if (o.sort) { const v = SORT[o.sort] || (/_(ascend|descend)$/.test(o.sort) ? o.sort : null); if (!v) throw new Error('sort: ' + Object.keys(SORT).join('|')); pr.push(`sortBy=${v}`); }
      if (o.days) pr.push(`daysSinceListed=${[1, 7, 30].includes(+o.days) ? +o.days : (() => { throw new Error('days: 1|7|30'); })()}`);
      if (o.condition) pr.push(`itemCondition=${[].concat(o.condition).map(c => COND[c] || (() => { throw new Error('condition: ' + Object.keys(COND).join('|')); })()).join('%2C')}`);
      if (o.delivery) pr.push(`deliveryMethod=${DELIV[o.delivery] || (() => { throw new Error('delivery: pickup|shipping'); })()}`);
      if (o.exact) pr.push('exact=true');
      const base = o.location ? `${FB}/marketplace/${enc(String(o.location))}/search/` : `${FB}/marketplace/search/`;
      return `${base}?${pr.join('&')}`;
    },
    marketplaceCreate: (type = 'item') => { if (!['item', 'vehicle', 'rental'].includes(type)) throw new Error('type: item|vehicle|rental'); return `${FB}/marketplace/create/${type}`; },
    marketplaceSelling: () => `${FB}/marketplace/you/selling`,
    marketplaceItem: id => `${FB}/marketplace/item/${String(id).replace(/\D/g, '')}/`,
    notifications: () => `${FB}/notifications`,
    messages: () => `${FB}/messages/`,
    messenger: () => 'https://www.messenger.com/',
    thread: (id, { e2ee = false, host = 'facebook' } = {}) => host === 'messenger' ? `https://www.messenger.com/${e2ee ? 'e2ee/' : ''}t/${id}/` : `${FB}/messages/${e2ee ? 'e2ee/' : ''}t/${id}/`,
    reel: id => `${FB}/reel/${id}`,
    video: id => `${FB}/watch/?v=${id}`,
  };

  // ── Search result pages (people, groups, pages, events, places…) ─────────
  const ACTION_RE = /^(üzenet|message|csatlakozás|join( group)?|követés|follow|ismerősnek jelölés|add friend|profil megtekintése|view profile|csoport megtekintése|view group|tetszik|like|érdekel|interested|megyek|going|megtekintés|view|látogatás|visit|további|more|see all|az összes megtekintése)$/i;
  // numeric id and vanity slug of a profile / page / group URL
  function fbIdOf(u) {
    try {
      const url = new URL(u, location.href);
      if (!/facebook\.com$/i.test(url.hostname)) return { id: null, slug: null };
      const qid = url.searchParams.get('id');
      if (/profile\.php$/.test(url.pathname) && qid) return { id: qid, slug: null };
      let m = /^\/groups\/([^/?#]+)/.exec(url.pathname);
      if (m) return /^\d+$/.test(m[1]) ? { id: m[1], slug: null } : { id: null, slug: m[1] };
      m = /^\/people\/([^/]+)\/(\d+)/.exec(url.pathname);
      if (m) return { id: m[2], slug: m[1] };
      m = /^\/(?:pages\/[^/]+\/)?(\d{6,})\/?$/.exec(url.pathname);
      if (m) return { id: m[1], slug: null };
      m = /^\/([A-Za-z0-9.\-_]{3,})\/?$/.exec(url.pathname);
      if (m && !/^(search|groups|watch|reel|events|marketplace|hashtag|photo|stories|friends|messages|notifications|bookmarks|gaming|profile\.php)$/.test(m[1])) return { id: null, slug: m[1] };
    } catch { /* ignore */ }
    return { id: null, slug: null };
  }

  function kindOfUrl(u) {
    if (!u) return 'unknown';
    if (/\/groups\//.test(u)) return 'group';
    if (/\/events\//.test(u)) return 'event';
    if (/\/reel\//.test(u)) return 'reel';
    if (/\/videos\/|\/watch/.test(u)) return 'video';
    if (/\/photo/.test(u)) return 'photo';
    if (/\/posts\/|permalink|story_fbid/.test(u)) return 'post';
    if (/\/marketplace\//.test(u)) return 'listing';
    if (/\/pages\/|\/p\//.test(u)) return 'page';
    if (isFbUrl(u)) return 'profile-or-page';
    return 'external';
  }
  function extractSearchResults({ limit = 50, images = 'safe' } = {}) {
    const main = document.querySelector('[role="main"]') || document.body;
    const feed = main.querySelector('[role="feed"]') || main;
    let items = [...feed.querySelectorAll('[role="article"]')].filter(a => !a.parentElement?.closest('[role="article"]'));
    if (!items.length) items = [...feed.querySelectorAll('[role="listitem"]')];
    const out = [];
    for (const it of items.slice(0, limit)) {
      if (it.querySelector(SEL.message)) continue; // a post — use extract() for those
      // result titles are often aria-hidden duplicates of the avatar link — visibility is what counts here
      const links = [...it.querySelectorAll('a[href]')].filter(a => isShown(a, it));
      const titleA = links.find(a => { const t = unsalt(a.innerText || '').trim(); return t && !ACTION_RE.test(t); });
      if (!titleA) continue;
      const title = unsalt(titleA.innerText).trim().split('\n')[0];
      const url = cleanUrl(titleA.href);
      const lines = unsalt(it.innerText || '').split('\n').map(x => x.trim()).map(x => x.startsWith(title) ? x.slice(title.length).trim() : x).filter(x => x && !ACTION_RE.test(x) && x !== '·');
      const svgImg = it.querySelector('image');
      const img = svgImg?.getAttribute('xlink:href') || svgImg?.getAttribute('href') || it.querySelector('img')?.src || null;
      const actions = [...it.querySelectorAll('[role="button"], a[role="link"]')].map(b => unsalt(b.innerText || b.getAttribute('aria-label') || '').trim()).filter(t => ACTION_RE.test(t));
      const { id, slug } = fbIdOf(url);
      const image = images === false || images === 'none' ? undefined : images === 'full' ? img : cdnSafe(img);
      out.push({ title, url, id, slug, kind: kindOfUrl(url), subtitle: [...new Set(lines)].join(' · ') || null, ...(image !== undefined ? { image } : {}), actions: [...new Set(actions)] });
    }
    const seen = new Set();
    return out.filter(r => !seen.has(r.url) && seen.add(r.url));
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  function listGroups({ limit = 500 } = {}) {
    const main = document.querySelector('[role="main"]') || document.body;
    const map = new Map();
    for (const a of main.querySelectorAll('a[href*="/groups/"]')) {
      const m = /\/groups\/([^/?#]+)\/?(?:[?#]|$)/.exec(a.href);
      if (!m || ['feed', 'joins', 'discover', 'create', 'search', 'notifications'].includes(m[1])) continue;
      const name = unsalt(a.innerText || '').trim().split('\n')[0];
      const g = map.get(m[1]) || { id: m[1], name: null, url: `${FB}/groups/${m[1]}/`, info: null };
      if (name && !ACTION_RE.test(name) && !g.name) g.name = name;
      const li = a.closest('[role="listitem"]');
      if (li && !g.info) g.info = unsalt(li.innerText).split('\n').map(x => x.trim()).filter(x => x && x !== g.name && !ACTION_RE.test(x)).join(' · ') || null;
      map.set(m[1], g);
    }
    return [...map.values()].filter(g => g.name).slice(0, limit);
  }

  function groupInfo() {
    const main = document.querySelector('[role="main"]') || document.body;
    const name = unsalt(main.querySelector('h1')?.innerText || '').trim() || null;
    const txt = unsalt(main.innerText || '');
    const privacy = /privát csoport|private group/i.test(txt) ? 'private' : /nyilvános csoport|public group/i.test(txt) ? 'public' : null;
    const members = (/([\d][\d\s.,]*\s*(?:E|K|M|ezer)?)\s*(?:tag|members?)\b/i.exec(txt) || [])[1] || null;
    // description lives outside the feed (about card / about tab), never inside a post
    const about = [...main.querySelectorAll('[dir="auto"]')].filter(e => !e.closest('[aria-posinset], [role="article"], [role="feed"]'))
      .map(e => unsalt(e.innerText).trim()).filter(t => t.length > 40).sort((a, b) => b.length - a.length)[0] || null;
    const id = (/\/groups\/([^/?#]+)/.exec(location.pathname) || [])[1] || null;
    const member = !![...main.querySelectorAll('[role="button"]')].find(b => /^(csatlakoztál|joined|tag vagy)$/i.test(unsalt(b.innerText || '').trim()));
    return { id, name, privacy, members: members ? parseCount(members) : null, about, isMember: member || !!document.querySelector(SEL.feedPost) };
  }

  // ── Media grids (group /media, profile /photos /videos /reels, search photos/videos) ─
  function extractMediaGrid({ limit = 200 } = {}) {
    const main = document.querySelector('[role="main"]') || document.body;
    const map = new Map();
    for (const a of main.querySelectorAll('a[href*="/photo"], a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch"]')) {
      const url = cleanUrl(a.href);
      if (map.has(url) || /\/hashtag\//.test(url)) continue;
      const img = a.querySelector('img');
      map.set(url, { kind: kindOfUrl(url), url, id: postIdFromUrl(url), thumb: cdnSafe(img?.currentSrc || img?.src || null), alt: unsalt(img?.alt || a.getAttribute('aria-label') || '').trim() || null });
    }
    return [...map.values()].slice(0, limit);
  }

  // Everything downloadable from extracted posts (+ their comments) — feed it to fb_tool.py media
  function mediaList(source) {
    const posts = source?.posts || (harvest.store.size ? [...harvest.store.values()] : extract({ format: 'object', comments: true }).posts);
    const rows = [];
    for (const p of posts) {
      p.images?.forEach((im, i) => rows.push({ type: 'image', url: im.src, postId: p.postId, postUrl: p.url, n: i + 1, alt: im.alt }));
      p.videos?.forEach(v => rows.push({ type: /\/reel\//.test(v) ? 'reel' : 'video', url: v, postId: p.postId, postUrl: p.url }));
      if (p.hasVideo && !p.videos?.length && p.url) rows.push({ type: 'video', url: p.url, postId: p.postId, postUrl: p.url });
      p.comments?.forEach((c, ci) => c.media?.forEach((m, mi) => rows.push({ type: m.kind === 'video' ? 'video' : m.kind, url: m.kind === 'video' ? m.link : m.src, postId: p.postId, postUrl: p.url, comment: ci + 1, n: mi + 1, alt: m.alt })));
    }
    return rows.filter(r => r.url);
  }

  // Save JSON to the user's Downloads folder (ask the user before calling this)
  function download(data, filename = 'fb-reader.json') {
    const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return `letöltés indítva: ${filename}`;
  }

  // downloadImages({post, rows, dest:'downloads'|'view', limit=12, budgetMs=20000}) — ask the user before calling this.
  // Fetches each image's BYTES inside the page itself (fetch runs in the page's own origin/session; the
  // signed fbcdn URL never has to leave the browser as text, so the chat/tool output never sees it and the
  // "[BLOCKED: Cookie/query string data]" output filter never fires on it):
  //   dest:'downloads' (default) — Blob + <a download>, the same trick download() uses for JSON, one real
  //     file per image (needs the fetch to succeed: NOT yet confirmed against a live fbcdn response — some
  //     CDN hosts refuse cross-origin fetch reads even though <img> loads fine; a failed item is reported
  //     with its filename and error, never silently dropped, and the summary points at the fb_tool.py /
  //     mediaList()+download() JSON fallback that already works).
  //   dest:'view' — no fetch at all (plain <img src> never needs CORS): shows the image(s) full-size in the
  //     __fbReader overlay so the agent can screenshot/zoom and actually look at the picture ("to chat for
  //     processing") without saving anything to disk; close with hide().
  // `post`: one already-read post (map()/peek() anchor, selector, or omitted = nearest/overlay), only its
  // own images. `rows`: an explicit mediaList()-shaped array (e.g. from photoSet()). Neither given → every
  // image currently extracted/harvested (mediaList()).
  async function downloadImages(opts = {}) {
    const { post, rows: given, dest = 'downloads', limit = 12, budgetMs = 20000 } = opts;
    let rows;
    if (given) rows = given;
    else if (post !== undefined) {
      const row = await ensureLive(post);
      if (!row) return noRow(post);
      rows = mediaList({ posts: [row.p] });
    } else rows = mediaList();
    const images = rows.filter(r => r.url && r.type === 'image').slice(0, limit);
    const others = rows.filter(r => r.url && r.type && r.type !== 'image');
    if (!images.length) return `downloadImages · nincs kép${others.length ? ` (${others.length} videó/reel: fb_tool.py media --url …)` : ''}`;
    const t0 = Date.now();
    const ok = [], failed = [], views = [];
    for (let i = 0; i < images.length; i++) {
      if (Date.now() - t0 > budgetMs) { failed.push({ ...images[i], error: 'időkeret lejárt — hívd újra a maradékkal' }); continue; }
      const im = images[i];
      const name = `${im.postId || 'fb'}${im.comment ? '_c' + im.comment : ''}_${im.n || i + 1}.jpg`;
      if (dest === 'view') { views.push({ name, url: im.url, alt: im.alt }); ok.push(name); continue; }
      try {
        const res = await fetch(im.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        ok.push(name);
      } catch (e) { failed.push({ ...im, name, error: String(e?.message || e) }); }
      await sleep(jitter(350, 200));
    }
    if (dest === 'view' && views.length) {
      let el = document.getElementById('fb-reader-out');
      if (!el) { el = document.createElement('article'); el.id = 'fb-reader-out'; document.body.prepend(el); }
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;overflow:auto;padding:12px';
      const esc = t => String(t || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      el.innerHTML = views.map(v => `<figure style="margin:0 0 16px"><img src="${v.url}" style="max-width:100%;display:block" alt=""><figcaption style="font:12px monospace;color:#555">${esc(v.name)}${v.alt ? ' · ' + esc(v.alt) : ''}</figcaption></figure>`).join('');
    }
    const s = `downloadImages · ${ok.length}/${images.length} kép ` +
      (dest === 'view' ? 'megjelenítve a nézegetőben (screenshot / zoom a nézéshez, __fbReader.hide() a bezáráshoz)' : 'letöltve a Letöltések mappába') +
      (failed.length ? ` · ⚠ ${failed.length} hiba (fetch/CORS) → fb_tool.py media -val vagy mediaList()+download() JSON-exporttal` : '') +
      (others.length ? ` · ${others.length} videó/reel kihagyva: fb_tool.py media --url …` : '');
    return s;
  }

  // nearest/open photo-viewer overlay's "next" control (Következő fénykép / Next photo); scoped to the
  // dialog so it never matches an unrelated "Következő"/"Next" elsewhere on the page.
  function nextPhotoButton() {
    const scope = document.querySelector(SEL.dialog) || document.querySelector('[role="main"]') || document.body;
    return [...scope.querySelectorAll('[role="button"], a[role="link"], div[tabindex="0"]')]
      .find(b => isShown(b, scope) && NEXT_PHOTO_RE.test(unsalt(b.getAttribute('aria-label') || b.innerText || '').trim()));
  }
  // one item of the open viewer: the big visible image, or (if a <video> tag / a /reel//videos/ URL is
  // showing instead) a video/reel row with no fetchable image src.
  function viewerItem() {
    const scope = document.querySelector(SEL.dialog) || document.querySelector('[role="main"]') || document.body;
    const url = cleanUrl(location.href);
    if (scope.querySelector('video') || /\/reel\//.test(url) || /\/videos\//.test(url)) {
      return { kind: /\/reel\//.test(url) ? 'reel' : 'video', url, postId: postIdFromUrl(url), alt: null };
    }
    const imgs = [...scope.querySelectorAll('img')].filter(i => isShown(i, scope) && isFbCdn(i.currentSrc || i.src || ''));
    const big = imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
    if (!big) return null;
    const src = big.currentSrc || big.src;
    return { kind: 'image', url: src, postId: postIdFromUrl(url), alt: (big.getAttribute('alt') || '').trim() || null };
  }
  // photoSet({limit=10, budgetMs=15000, download=false, dest='downloads'}) — walks the OPEN photo/video
  // viewer's set=pcb.… carousel forward (never opens one), one item per step, up to `limit`; a set mixing
  // photos with a video/reel is common (FB keeps them in the same set) and those are flagged separately —
  // they have no fetchable image src, only their own page link (hand that to fb_tool.py / yt-dlp instead).
  // Not yet confirmed against a live viewer DOM: if `nextPhotoButton` finds nothing on the first item,
  // the aria-label wording differs from the hu/en pack (registerLang / add the real label to i18n.md).
  async function photoSet(opts = {}) {
    const { limit = 10, budgetMs = 15000, download = false, dest = 'downloads' } = opts;
    if (pageInfo().type !== 'photo') return `photoSet · ez nem fotó-nézegető oldal (jelenleg: ${pageInfo().type}) — nyisd meg a /photo/?fbid=…&set=… linket`;
    const t0 = Date.now();
    const rows = []; const seenKeys = new Set();
    for (let i = 0; i < limit && Date.now() - t0 < budgetMs; i++) {
      const it = viewerItem();
      if (!it || seenKeys.has(it.url)) break; // nincs több elem / körbeértünk a set elején
      seenKeys.add(it.url);
      rows.push(it);
      if (rows.length >= limit) break;
      const btn = nextPhotoButton();
      if (!btn) break;
      btn.click();
      let waited = 0;
      while (waited < 2500) { await sleep(150); waited += 150; const now = viewerItem(); if (now && now.url !== it.url) break; }
      await sleep(jitter(250, 150));
    }
    const postUrl = photoPostHref();
    const images = rows.filter(r => r.kind === 'image').map((r, i) => ({ type: 'image', url: r.url, postId: r.postId, postUrl, n: i + 1, alt: r.alt }));
    const others = rows.filter(r => r.kind !== 'image');
    window.__fbReader.lastSet = images;
    let dl = '';
    if (download && images.length) dl = ' · ' + await downloadImages({ rows: images, dest, limit: images.length });
    const s = `photoSet · ${rows.length} elem a nézegetőben` +
      (others.length ? ` · ⚠ ${others.length} videó/reel a setben (külön letöltés: fb_tool.py media --url …): ${others.map(o => `${o.kind} ${cdnSafe(o.url)}`).slice(0, 3).join(' · ')}` : '') +
      (postUrl ? ` · poszt: ${clipS(postUrl, 70)}` : '') + dl +
      (!download && images.length ? ` · letöltés: downloadImages({rows:__fbReader.lastSet})` : '');
    return s;
  }

  if (window.__fbReader?.harvest?.observer) window.__fbReader.harvest.observer.disconnect();
  window.__fbReader = {
    version: VERSION,
    build: BUILD,
    lang, registerLang, langProbe, extract, expandSeeMore, expandComments, hoverDates, hoverReveal: hoverDates, harvest, selfTest, snapshot, q,
    map, peek, thread, full, grep, go, where, forgetSeen, setCommentSort,
    inbox, watchPeek, notifs, notif, msgs, msgOpen, msgThread, me, selfThread, market, marketScroll, ready, listing, trackAdd, trackList, trackRemove, trackCheck, myListings, priceCheck,
    nav, extractSearchResults, listGroups, groupInfo, extractMediaGrid, mediaList, download, downloadImages, photoSet, kindOfUrl, fbIdOf, cdnSafe,
    findPost, resolvePost, mark, unmark, extractPinnedComments, extractPrompt, promptsToMarkdown,
    pageInfo, findPostRoots, extractPost, parseFbDate, decodeScrambled, visibleText, cleanUrl, unwrapUrl, toMarkdown,
    // javascript_tool output is cut at ~1000 chars: park the result on the page and
    // read it with get_page_text, or page through it with chunk().
    render(text) {
      if (text == null) text = harvest.store.size ? harvest.dump({ format: 'md' }) : extract({ format: 'md' });
      window.__fbReader.last = text;
      let el = document.getElementById('fb-reader-out');
      if (!el) { el = document.createElement('article'); el.id = 'fb-reader-out'; document.body.prepend(el); }
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;color:#111;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;padding:16px';
      el.textContent = text;
      return `render kész: ${text.length} karakter → olvasd get_page_text-tel, utána __fbReader.hide()`;
    },
    hide() { document.getElementById('fb-reader-out')?.remove(); return 'overlay eltávolítva'; },
    chunk(i = 0, size = 900, text = null) {
      const t = text ?? window.__fbReader.last ?? '';
      const n = Math.max(1, Math.ceil(t.length / size));
      return `[${i + 1}/${n}] ` + t.slice(i * size, (i + 1) * size);
    },
    // internals shared with the optional write module (fb-reader-write.js)
    _i: { SEL, unsalt, norm, isShown, isDecoy, extractPost, extractCounts, commentArticles, commentInfo, isCommentArticle, pageInfo, findPostRoots, resolvePost, mark, sleep, PUBLISH_RE, COMPOSER_SEL, safeToClick, cdnSafe },
    status: () => {
      const pg = pageInfo();
      return `fb-reader ${VERSION} betöltve · oldal: ${pg.type}${pg.warning ? ' · ⚠ ' + pg.warning : ''} · látható posztok: ${findPostRoots().length} · írási modul: ${window.__fbReader?.composeCheck ? 'van' : 'nincs'}`;
    },
  };
})();
window.__fbReader.status();
