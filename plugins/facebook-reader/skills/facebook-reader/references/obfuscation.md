# Facebook DOM: obfuscation tricks and countermeasures

These notes come from two working tools, *facebook-private-group-scraper* (Playwright group archiver)
and *Shadowcast / fb-ytembed-plugin* (an MV3 extension that rewrites feed link cards), plus live
probing in October 2026 (hu-HU UI). Facebook changes markup often, so prefer the semantic anchors
below over anything visual.

## Stable anchors (use these)

| Anchor | Meaning |
|---|---|
| `[role="main"] [aria-posinset]` | one feed item (group, home, profile, page). **Not** `[role=article]` there: that is used for comments |
| `[role="dialog"]` containing `profile_name` / comment articles | an opened post overlay (permalink); can be nested twice |
| `[data-ad-rendering-role="profile_name"] a` | post author |
| `[data-ad-rendering-role="story_message"]` (+ `data-ad-preview="message"`, `data-ad-comet-preview="message"`) | post body text; a second one = shared/quoted post |
| `[data-ad-rendering-role="title" / "meta" / "description" / "image"]` | link-preview card: title, domain, description, thumbnail link |
| `[data-ad-rendering-role="like_button" / "comment_button" / "share_button"]` | action bar |
| `[role="article"][aria-label="X hozzászólása (5 órája)"]` | comment; `X válasza Y hozzászólására (…)` = reply to Y; EN `Comment by X …` |
| `a[href*="/posts/"]`, `permalink/`, `story_fbid=`, `post_insights/<id>` (admins), `pfbid…` | post ids / permalinks |
| `[aria-labelledby]` → `document.getElementById(id).textContent` | the **real** text of an obfuscated label (date, "Hirdetés") |
| `[role="tooltip"]` after hovering the timestamp link | full date ("2026. október 21., szerda, 21:10") |
| `[role="feed"] [role="article"]` on `/search/*` | one search result card |
| `a[href*="/groups/"]` + `[role="listitem"]` on `/groups/joins/` | joined groups list |

Generated classes (`x1i10hfl`, `xdj266r`, …) and `jrhKlE1p`-style per-session classes rotate. Do not use them.

## Tricks → countermeasures

1. **Scrambled timestamps / "Sponsored".** The date link contains 20–60 one-character spans in a
   `display:flex` box. CSS `order`, `position:absolute; top:3em` and hidden classes pick which glyphs
   show and in what order; the DOM text reads like `tnposrSodeugh9g1724f…`.
   → (a) `aria-labelledby` id lookup (best, exact), (b) `decodeScrambled()`: keep leaf spans that are
   rendered and inside the line box, sort by on-screen position, insert spaces at visual gaps,
   (c) hover the link and read `[role=tooltip]`.
2. **Invisible salt.** Each visible glyph is followed by U+034F COMBINING GRAPHEME JOINER (also ZWSP,
   soft hyphen, bidi marks), so regexes like `\d+ ó` fail. → strip `[͏­᠎​-‏‪-‮⁠-⁤﻿]` everywhere.
3. **Decoy text blocks.** `<div aria-hidden="true" data-0="0" … data-19="19"><blockquote>Facebook</blockquote>`
   repeated 20× at the top of posts. → ignore text under `[aria-hidden="true"]` for post bodies.
   Exception: search results, where the visible title link itself is `aria-hidden` (a duplicate of the
   avatar link). There, filter by visibility, not by aria-hidden.
4. **Decoy link cards.** A full `title/meta/description` card whose title is the viewer's own first
   name, the domain a random mixed-case `YqILqcKMcQ.com` and the description a 60-char random token,
   under a `display:none` ancestor. → skip cards that are not rendered *within the post*; offline,
   use the heuristic (random mixed-case domain + space-less 25+ char description).
5. **Off-screen posts are `display:none`, not removed.** A global visibility check (`checkVisibility`)
   would discard them. → visibility is checked only up to the post root.
6. **Virtualized feed.** Old posts leave the DOM. → MutationObserver harvest + merge by id.
7. **Truncated text.** "Továbbiak"/"See more" role=button inside the message. → dispatch a click
   (not inside an `<a>`), wait about 1 s, re-read. Strip a leftover trailing label.
8. **Link shims.** `l.facebook.com/l.php?u=<url>&h=…`. → unwrap when `u` is a URL. Newer shims carry
   an opaque token (`u=AUBK…`): keep the card's `meta` domain then. Strip `fbclid`, `__cft__[0]`,
   `__tn__`, `mibextid`, `rdid`, `share_url`, `utm_*`.
9. **Hidden permalinks.** Timestamp links have `href="?__cft__…"` until hovered; FB swaps in the real
   URL on mouseover. → `hoverDates()` fires pointer/mouse over events, then re-reads.
10. **Counts without labels.** The footer shows bare numbers (`2,2 E`, `267`, `15`) as role=button,
    in the order reactions · comments · shares; per-type reactions only in aria-labels
    (`Vicces: 1,9 E ember`). `E`/`ezer`/`K` = ×1000, `M` = ×1 000 000, decimal comma.
11. **Anonymous / page-as-author posts.** In an overlay the header `profile_name` may be the group;
    the dialog title `"<Név> bejegyzése"` / `"<Name>'s post"` names the real author
    (`Név nélküli résztvevő` = anonymous member).
12. **Navigation reloads the page.** Even FB's own links do full loads from extension-driven tabs →
    keep the extractor in `localStorage['fb-reader:src']` and `eval` it with the tiny loader (FB's CSP
    allows `eval`; CDP-evaluated code is not blocked).
13. **Login / checkpoint.** `/checkpoint/` URL, `#login_form`, or a group page showing only "Csatlakozás"
    (not a member). → report it, do not automate around it.

## Locale notes (hu-HU / en)

Relative time: `5 p.` perc, `3 ó.` óra, `2 n.` nap, `1 hét`, `5 éve`; in comments `5 órája`, `2 napja`,
`egy napja`, `1 hete`; absolute `2026. október 3., péntek 14:22`, `okt. 12.`, `Tegnap 14:00 órakor`.
EN: `3h`, `2d`, `1w`, `Yesterday at 2:22 PM`, `October 3, 2025 at 2:22 PM`, `5 hours ago`.
UI words used as anchors: Továbbiak / See more · Több hozzászólás / View more comments · N válasz /
N replies · Hirdetés / Sponsored · Ellenőrzött fiók / Verified account · Csatlakozás / Join.

## Debugging a breakage

```js
// what does the page expose right now?
({posinset: document.querySelectorAll('[role="main"] [aria-posinset]').length,
  roles: [...new Set([...document.querySelectorAll('[data-ad-rendering-role]')].map(e => e.getAttribute('data-ad-rendering-role')))],
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  lby: document.querySelectorAll('[aria-labelledby]').length})
```
Keep probes returning < 1000 characters. Patch `scripts/fb-reader.js`, run `python3 scripts/build.py`,
then re-inject `fb-reader.min.js`.
