# Receptek és navigáció

Full-extraction recipes (JS for `javascript_tool`, after the loader). The cheap path comes first: `map()` → `peek()` →
`thread()` → `full()` (SKILL.md, "Read cheap"); use these only when everything is needed (export, report, backlog).

**Visible posts on any page (feed, group, profile, search posts):**
```js
await __fbReader.expandSeeMore(); await __fbReader.hoverDates({limit:15});
__fbReader.render(__fbReader.extract({format:'md', limit:20}))
```
→ `get_page_text` → `__fbReader.hide()`

**Longer feed / whole group backlog (survives virtualization):** one call starts, then loop.
```js
__fbReader.harvest.start(); JSON.stringify(await __fbReader.harvest.scroll({steps:3}))   // repeat this line…
JSON.stringify(await __fbReader.harvest.scroll({steps:3}))   // …until end:true or enough posts
__fbReader.harvest.collect(); __fbReader.render(__fbReader.harvest.dump({format:'md', limit:40}))
```
Page with `dump({offset:40, limit:40})`. Filter by date with `dump({since:'2026-10-01'})`.

**Find a specific post** ("a 12.500 followeres poszt"): `JSON.stringify(__fbReader.findPost({text:'12500 follower', mark:true}))`
(searches text, link titles and image alt text; digits are matched without separators). The hit is
scrolled into view and becomes `post:'last'` for later calls.

**Pinned / author comments and prompts** (prompt-sharing pages keep the real content in the pinned
comment): on the post (or its overlay)
```js
__fbReader.render(__fbReader.promptsToMarkdown([await __fbReader.extractPrompt({post:'last'})]))
```
`await __fbReader.extractPinnedComments({post})` returns the 📌 pinned and author comments with
"Továbbiak" expanded. Prompt collection for a whole page is in `references/analysis.md`.

**One post with its comments and comment media:** open the post URL (or click its comment count
to open the overlay), then
```js
await __fbReader.expandComments({post:'#a3f9', rounds:4});   // post: anchor from map(); without it only the open overlay / the post in view
__fbReader.render(__fbReader.extract({format:'md', comments:true, maxComments:150}))
```
Comment lines carry author, `→ replyTo`, exact date, text, `[image: alt]`, `[gif]`, `[sticker]`,
`[video]` and external links.

**Search:** navigate to `__fbReader.nav.search(q, type)` (types: `top posts people photos videos
groups pages places events marketplace`; reels show up under `videos` and on hashtag pages). Then:
- people / groups / pages / events / places → `__fbReader.render(JSON.stringify(__fbReader.extractSearchResults({limit:30}), null, 1))`
  (each result has `id` (numeric, e.g. from `profile.php?id=`) and `slug`. Open it with `nav.page(result)`;
  never cut URLs at `?` yourself)
- posts / top → `extract({format:'md'})` (post results are real posts)
- photos / videos → `extractMediaGrid()`

**Groups:** joined groups → `nav.groupsJoined()` + scroll + `listGroups()`; one group → `groupInfo()`
then posts as above (use `nav.group(id,{chronological:true})` for newest-first); inside a group search
→ `nav.groupSearch(id, q)`; group media → `nav.groupMedia(id)` + `extractMediaGrid()`.

**Media download:** signed image URLs must not pass through the chat. Ask the user, then
`__fbReader.download(__fbReader.mediaList(), 'fb-media.json')` saves the full list into their
Downloads folder, and `scripts/fb_tool.py media <that file>` downloads on a machine that may contact
Facebook (see `references/media.md`). Videos/reels only need their page URLs (safe in chat).
Public reels/videos work without cookies. For private-group videos use `--cookies-from-browser chrome`
**only on the user's own computer** (Claude Code CLI, or the linked-computer shell).

## Navigációs csalólap (`__fbReader.nav.*` vagy `fb_tool.py urls`)

| Goal | URL |
|---|---|
| search | `/search/{type}/?q=…` |
| hashtag | `/hashtag/{tag}` |
| group feed (newest first) | `/groups/{id}/?sorting_setting=CHRONOLOGICAL` |
| search inside group | `/groups/{id}/search/?q=…` |
| group about / media / members / files / events | `/groups/{id}/about/` `…/media/` `…/members/` `…/files/` `…/events/` |
| my groups / groups feed | `/groups/joins/` · `/groups/feed/` |
| profile tabs | `/{user}/photos` `/{user}/videos` `/{user}/reels` (numeric: `profile.php?id=…&sk=photos`) |
| page/profile from a search result | `nav.page(result)` / `nav.page(id)` / `nav.page(slug)` |

## Notifications and messages (on request)

- *"Jött értesítés a posztomra?"* → `inbox()` → `nav.notifications()` (wait 3 s) → `notifs({kind:'mine', unread:true})` → `notif('@ref')` only for the interesting ones; summarise as "N reakció, M komment, K említés" and open the post link only if asked.
- *"Van új üzenetem?"* → `inbox()` → `nav.messages()` → `msgs({unread:true})`. Report who wrote (names and the preview the list shows); do **not** open unread threads without asking (read receipt).
- *"Keress az üzeneteimben X-re"* → `msgs({q:'X'})` (loaded list) → if not enough, `msgSearch()` → click → type X (hook asks) → `msgs()`.
- *"Válaszolj Annának"* → §5 "Message (Messenger) reply": recipient first, draft, approval, `composeReport()` with the "Címzett" line, final OK.

## Marketplace (on request)

- "Keress használt hegyi biciklit 50 ezer alatt": `navigate nav.marketplace({q:'hegyi bicikli', max:50000, sort:'new', condition:['good','like-new']})` → wait 3 s → `market()` → `marketScroll()` → `market({by:'price'})`.
- Always `await ready()` after the navigation, then read. `market({format:'json'})` / `listing({format:'json'})` give one record shape per ad (full URLs); `marketScroll({format:'json'})` counts the new ads.
- "Mi ez a hirdetés?": `listing('$ref')` → `navigate` → `ready()` → `listing()`.
- "Hasonlítsd össze a három legolcsóbbat": `market({by:'price', limit:3})` → open each → one line per listing (price, condition, place, age, seller).
- "Írj az eladónak" / "Értesíts, ha új jön": §5 protocol (`marketControl('message' | 'alert')`), approval first.

## Selling and tracking (on request)

- "Add el a biciklit a Marketplace-en": draft → approval (`--kind listing`) → `navigate nav.marketplaceCreate()` → `sellCheck()` → fill → `sellReport()` → user OK → publish → `trackAdd()`.
- "Tedd ki az adok-veszek csoportba": same, but the group page: composer "Eladó tárgy" → "Eladó tárgy"; target = the group URL; check `sellCheck().target.name`.
- "Mi újság a hirdetéseimmel?": `trackList()` → for each ⏰ item `navigate` + 3–4 s + `trackCheck()`; summarise ⚑ changes and ❓ inquiries; do not open unread message threads.
- "Mennyiért add?": `navigate nav.marketplace({q, condition})` → `marketScroll()` → `priceCheck({price})`.
- "Ellenőrizd naponta": ask whether the extension switch (popup) or a scheduled task (needs the computer) is wanted; create nothing without the user's request.
