# fb-reader API reference

Everything lives on `window.__fbReader` after the loader / `fb-reader.min.js` ran (+ the write
functions after `fb-reader-write.min.js`). All functions are synchronous unless marked `async` (use
`await` in `javascript_tool`). **Async helpers stop at `budgetMs`** (default 6–8 s, below the browser
tool's time limit) and return `done:false`. Call them again in a loop instead of raising their counts.

## Reading posts

| Call | Returns |
|---|---|
| `extract({format, limit=100, comments=false, maxComments=50, maxChars=60000})` | posts currently in the DOM. `format`: `'json'` (string), `'md'`, `'object'` |
| `async expandSeeMore({rounds=3, budgetMs=6000})` | clicks "Továbbiak / See more" inside posts (never links, composers or publish-like buttons) → `{expanded}` |
| `async expandComments({post, rounds=3, budgetMs=7000, sort='all'})` | opens "Több hozzászólás / View more comments / N válasz" of **one** post: `post` = `'#a3f9'` / selector / `undefined` (open overlay, else the post nearest the screen centre) / `'all'` (every post in scope, old behaviour). First switches the comment sort to "all" (`sort:null` skips). Unknown post → `{error}`; an overlay that opens for a different post → `{error:'modal-mismatch', opened}` and nothing more is clicked. Sort-menu triggers (`aria-haspopup`) are never treated as expanders. Returns `{clicked, done, sort?}`; `clicked:0` + a count gap means the rest is deleted / hidden / filtered |
| `async setCommentSort('all'\|'newest'\|'relevant', {post})` | opens the sort menu of one post and picks the entry → `{changed, from, now}` or `{changed:false, note}` when the post has no sort control (open its page / overlay first) |
| `async hoverDates({limit=12, all=false, budgetMs=8000, post})` (alias `hoverReveal`) | synthetic hover/focus on timestamps: exact date tooltip **and** the real permalink (FB swaps it in on focus). `post:'#a3f9'` limits it to one post. Restores the scroll position afterwards and writes every post it passed into `harvest.store` (the virtualized feed drops them from the DOM) |
| `findPost({text, imageAlt, author, url, mark})` | first matching post in the DOM (then in `harvest.store`); digits match without separators ("12.500" = "12500"); scrolls it into view and remembers it as `'last'` → `{found, inDom, url, postId, author, date, snippet, images}` |
| `q(what, fields, {limit, offset, maxChars, format})` | one line per row, ≤ ~900 chars: `what` = `posts` (visible) · `harvest` · `comments` (of `opts.post`) · `search` · `groups` · `media` (no URLs). `fields` like `['author','date','text:80','reactions','comments','url','id','images','alt','video','sponsored','link','pinned','depth','replyTo']`; `{format:'json'}` → one stable object `{what,total,offset,count,rows:[…]}` with FULL absolute URLs, ISO `date` + `dateApprox` + `dateRaw` (+ `dateConflict`). In line format `url` keeps the identifying query (`/photo?fbid=…`). Truncated output ends with a ready-made `q(…,{offset:N})` continuation |
| `where()` | one line: page type, scroll %, posts in DOM / store / unread, anchors on screen, overlay, warnings (~60 tok) |
| `map({limit=12, offset, w=55, unseen, ads, author, date:'MM-DD', by:'author', maxChars=900, background})` | L0: one line per post, `#anchor` (content hash of author + first 60 chars, stable across scroll / re-render / hoverDates), age, author, text, 👍💬↗, 📷🎬🔗⇄…; `•` unread, `↑` only in the harvest store; ads skipped (counted); header carries `~Ntok`. On a reel page the feed behind the viewer is hidden by default; `background:true` reveals it (tagged `háttér`) |
| `async peek(ref?, {chars=350, comments=3, cchars=90})` | L1: shortened text, image alt, link, best comments (pinned / author first); marks the post read. No `ref` → post nearest the screen centre (on a reel page: the active reel) |
| `async thread(ref?, {top=8, offset, chars=100, only:'author'\|'media'\|'links'\|'replies'\|'other', match, bait=true})` | L2: comment outline with `c<n>` numbers, `↳Név←` replies, 📌✍; says how many comments are not loaded. On a reel, `bait!==false` folds a detected keyword-bait funnel into one `🎣` summary line (§ Reel below); `bait:false` lists everything, `only:'other'` only the non-bait replies |
| `async full(ref?, item?, {offset, maxChars=900})` | L3: complete text of one post, or of comment `'c3'`, paged |
| `grep(pattern, {where:'posts'\|'comments'\|'all', ctx=35, limit=8})` | folded (accent-insensitive) substring or `/regex/`; lines `#anchor` or `#anchor/c3` + context |
| `async go(ref)` | scroll the post into view (scrolls a dropped post back first, estimating the distance from `aria-posinset`), reveal and report the real permalink (never the photo link when a post link exists); never clicks. `peek`/`thread`/`full` do the same scroll-back automatically |
| `nav.photoPost()` | on a photo page: URL of "Bejegyzés megtekintése" / "View post" (the real post), else `null` |
| `forgetSeen()` | reset the read-list (`localStorage['fb-reader:seen']`, ≤ 3000 anchors) |
| `lang()` · `registerLang(pack)` · `langProbe()` | page language + known packs (`hu✓`, `en`) · add a language pack at runtime (refused without `r.publish`) · what this page's language still lacks (unparsed dates, unknown labels); see `i18n.md` |
| `selfTest({format})` | anchor counts (`story_message`, `like_button`, …) + extraction coverage + warnings (`HIBA`/`FIGYELEM`) → one text block, or `{format:'object'}` |
| `snapshot({post})` | anonymised HTML of a post (letters → x, ids/hrefs/images neutralised, hidden decoys kept as inline style); read with `render()` + `get_page_text`; for tests/bug reports. Geometry is not captured |
| `resolvePost(sel)` | `undefined` → open overlay or post nearest the viewport centre · `'last'` → last `findPost` hit · number → `findPostRoots()[n]` · `'#a3f9'` → `map()` anchor (live posts only) · string → postId/url fragment · object → `findPost(object)` |
| `async extractPinnedComments({post, expand=true, authorComments=true, max=80, budgetMs=7000})` | pinned ("Felül rögzített hozzászólás", "Kitűzött", "Pinned") and author ("Szerző") comments of one post, "Továbbiak" expanded → `{found, post:{url,author,date,imageAlt}, comments}` |
| `async extractPrompt({post, chars=2000, offset=0})` | `{postUrl, date, dateApprox, dateRaw, author, imageAlt, imageAltWeak, prompt, source: pinned-comment|author-comment|post-text, promptChars, truncated, nextOffset}`; `chars:0` = the rest; page with `offset:nextOffset` |
| `promptsToMarkdown(list)` | prompt records → Markdown blocks (```text …```) |
| `mark(el)` / `unmark()` | red outline around an element for screenshots (pointer-events none) |
| `extractPost(rootElement, {comments})` | one post object (roots come from `findPostRoots()`) |
| `findPostRoots()` | feed items `[aria-posinset]`; an open post overlay (`[role=dialog]`) takes priority; permalink pages fall back to top-level `[role=article]` |

### Harvest (virtualized feeds)

FB removes or `display:none`s posts that scrolled away. `harvest` keeps a Map keyed by postId/url and
merges the richest version of every field.

| Call | |
|---|---|
| `harvest.start({comments=false, keep=false})` | starts a MutationObserver collector |
| `async harvest.scroll({steps=3, pause=1500, expand=true, comments=false, until=null, budgetMs=8000})` | human-paced scrolling → `{collected, done, end, next}`; `done:false` = budget used up, call again; `end:true` = 4 idle steps (feed end) |
| `harvest.collect()` | collect now |
| `harvest.dump({format='json', limit=200, offset=0, since=null, maxChars})` | sorted newest first |
| `harvest.stop()` | disconnect observer |

## Output transport

| Call | |
|---|---|
| `render(text?)` | fixed full-screen `<article id="fb-reader-out">` with the text (default: harvest dump or extract as md); read with `get_page_text` |
| `hide()` | remove the overlay |
| `chunk(i=0, size=900, text?)` | `[i+1/n] …` slice of `__fbReader.last` (set by `render`) |
| `download(data, filename)` | saves JSON into the user's Downloads (a file download — ask first) |
| `status()` | one-line status incl. page type and warnings |

## Navigation, search, groups, media

| Call | |
|---|---|
| `nav.page(result | id | slug | url)` | page/profile URL from a search result (uses its `id` / `slug`) |
| `nav.search(q, type='top')` | `type ∈ top posts people photos videos groups pages places events marketplace` |
| `nav.hashtag(tag)`, `nav.profile(user)`, `nav.profileTab(user, 'photos'|'videos'|'reels'|'about'|'friends')` | |
| `nav.group(g, {chronological})`, `nav.groupSearch(g, q)`, `nav.groupAbout(g)`, `nav.groupMedia(g)`, `nav.groupMembers(g)`, `nav.groupFiles(g)`, `nav.groupEvents(g)` | `g` = id, slug or full URL |
| `nav.groupsJoined()`, `nav.groupsFeed()`, `nav.reel(id)`, `nav.video(id)` | |
| `extractSearchResults({limit=50, images='safe'|'full'|false})` | `[{title, url, id, slug, kind, subtitle, image, actions}]` for people/groups/pages/events/places results. `id` = numeric id (`profile.php?id=`, numeric group/page), `slug` = vanity name. `image` is query-stripped by default (`'full'` keeps the signed URL, do not print it). `kind ∈ group event reel video photo post listing page profile-or-page external` |
| `listGroups()` | on `/groups/joins/`: `[{id, name, url, info}]` (scroll first to load all) |
| `groupInfo()` | `{id, name, privacy, members, about, isMember}` |
| `extractMediaGrid({limit=200})` | on media/photos/videos/reels grids: `[{kind, url, id, thumb, alt}]` |
| `mediaList(dump?)` | flat download list from harvest/extract incl. comment media: `[{type, url, postId, postUrl, n, comment, alt}]`. Holds **signed** image URLs: pass it to `download()`, never into the chat |
| `async photoSet({limit=10, budgetMs=15000, download=false, dest='downloads'})` | on the open `/photo/?fbid=…&set=pcb.…` viewer: steps the "Next photo" control forward, one row per item (`{type:'image', url, postId, postUrl, n, alt}`), flags any video/reel in the set separately (own link only, no fetchable image). Stores the collected images on `__fbReader.lastSet`; `download:true` also runs `downloadImages()` on them. **Not yet confirmed against a live viewer DOM** |
| `async downloadImages({post, rows, dest='downloads'\|'view', limit=12, budgetMs=20000})` | fetches each image's bytes in the page itself and either saves a real file per image (`dest:'downloads'`, Blob + `<a download>`) or shows them in the `__fbReader` overlay for `screenshot`/`zoom` (`dest:'view'`, no fetch, no CORS needed) — ask the user before calling with `dest:'downloads'`. `post` = one already-read post; `rows` = an explicit `mediaList()`/`photoSet()`-shaped array; neither → every image currently extracted/harvested. Failed fetches (CORS) are reported per file, never dropped silently |
| `fbIdOf(url)` / `cdnSafe(url)` | `{id, slug}` of a profile/page/group URL · strip the query string of a CDN URL |

## Write module (`fb-reader-write.min.js`) — locate & report, never click

| Call | |
|---|---|
| `composeCheck()` | inspects the open composer / reply box: `{kind: post|comment|reply|message, page, where, audience, asWhom, replyTo:{author,ref,snippet,via,mention,note}, mention, post, text, media[], attachmentCount, linkPreview, publishButton:{label,disabled,guessed?,target}, warnings[], checklist}`. `asWhom` comes from the box label ("Hozzászólás mint …"); `replyTo` is read from the mention at the start of the box (`via:'említés'`), else from the comment above it (`via:'közelség'`, with a warning); `attachmentCount`/`publishButton` are searched **only in the composer's own wrapper** (never the dialog's gallery, main field, or the post's Like/Comment bar); a label-less icon button is reported with `guessed:true`. **`warnings` must be empty before publishing** |
| `composeReport()` | the same as a Markdown "ÍRÁSI ELŐNÉZET" for `render()`. Show it to the user before publishing |
| `commentBox(post, {mark})` | the post's comment box: `{found, label, asWhom, replyTo, text, x, y, dpr, post}`; when closed: `{found:false, openWith:{label,x,y}}` |
| `replyBox(post, ref, {mark})` | the reply box of ONE comment; `ref` = `'c3'` / `3` (numbers from `thread()`), an author name / text snippet, or `{author,text}`. Open: `{found:true, comment, label, asWhom, replyTo, text, x, y, target:{ref:'[fbr:reply-box]'}}`. Closed: `{found:false, comment, openWith:{label,x,y,target:{ref:'[fbr:reply-c3]'}}}` (the comment's own "Válasz" button; click, then call again). Another comment's open box is never returned |
| `async react(type, {post, mark=true, budgetMs=4000})` | `type ∈ like love care haha wow sad angry` (or HU names). Hovers the post's Like button, waits for the reaction bar → `{found, label, x, y, likeButton:{x,y,label,pressed}}`. **Does not click** |
| `reactionState(post)` | `{myReaction, pressed, buttonLabel, counts}`, for checking after the approved click |

**Target tags.** `commentBox`, `react` and `composeCheck` append `[fbr:<id>]` to the aria-label of the element they
point at (`like`, `love` … , `comment-box`, `reply-box`, `reply-c<N>`, `open-comment`, `send`) and return `target: {ref, find}`. Claude in Chrome's
`find`/`read_page` only see the accessible name, so `find "[fbr:love]"` returns a `ref_N` that `computer left_click`
accepts (verified live). `untag()` restores every original label; `unmark()` calls it too. Run it when done.

Coordinates are CSS pixels of the viewport; `vw`/`vh` give its size. Claude in Chrome screenshots are
often **downscaled** (live test: viewport 1920 px wide, screenshot 1568 px → factor 0.82), so convert:
`screenX = x * screenshotWidth / vw` (same for y with height). The more robust way: `mark:true` draws a
red/blue frame, take a screenshot and click the frame's centre as you see it.

fb-reader's own `expandSeeMore` / `expandComments` refuse to click anything inside a composer or any
button labelled like publish/send/like/join/delete.

Helpers: `parseFbDate(str)`, `cleanUrl(url)`, `unwrapUrl(url)`, `decodeScrambled(el)`,
`visibleText(el)`, `kindOfUrl(url)`, `pageInfo()`.

## Inbox: notifications + Messenger (read only; `fb-reader.min.js`)

| Call | |
|---|---|
| `watchPeek()` | object `{ok, page, bell, msg, title, notifs, msgs}` (vagy `{ok:false, stop:true}` belépési/ellenőrző oldalon): csak a fejléc számlálói, név és szöveg nélkül; a bővítmény háttérfigyelése használja, nem nyit meg semmit |
| `inbox()` | `inbox · 🔔 N olvasatlan értesítés · ✉ M olvasatlan üzenet · cím: (N) · oldal: type`; counters come from the banner labels ("Értesítések, 3 olvasatlan", "Messenger, 2 olvasatlan") |
| `notifs({unread, kind, match, limit=8, offset, chars=90})` | one line per notification `@ref• kor fajta★: szöveg ⟨meta⟩`; `kind ∈ említés reakció komment címke megosztás csoport esemény ismerős szülinap emlék oldal videó egyéb` or `'mine'` (= the first five, ★); rows are de-duplicated by `notif_id`, hidden panels are ignored |
| `notif(ref)` | text, time, `notif_t`, cleaned target URL (`postId`), how to open it |
| `msgs({unread, q, group, limit=8, offset})` | `^ref• kor 👥🔒név: előnézet`; `q` is a local accent-/case-insensitive search over the loaded rows (name + preview), not over message bodies |
| `msgOpen(ref)` | URL of the thread (never navigates) + **read-receipt warning** for unread threads |
| `msgThread({last=8, offset, chars})` | last N messages of the thread that is already open: `m3 Feladó idő: szöveg`, 🔒 for E2EE |
| `notifMore()`, `msgSearch()`, `msgRequests()`, `threadActions()` (write module) | locate & tag (`[fbr:notif-more]`, `[fbr:msg-search]`, `[fbr:msg-requests]`, `[fbr:req-accept]`, `[fbr:req-decline]`), never click. Labels of the last three are guessed. |
| `me()`, `selfThread()` | `me()` → `{ok, id, name}` of the logged-in account, read from Facebook's page data; `selfThread()` proposes the own notes thread (name equals the account name) and prints the `--register-self` command; see SKILL.md "Self-notification" |
| `nav.notifications()`, `nav.messages()`, `nav.messenger()`, `nav.thread(id,{e2ee,host})` | navigation helpers (`host:'messenger.com'` optional) |

`composeCheck()` in a Messenger box returns `kind:'message'` and `recipient:{name, threadHeading, group, e2ee, threadId, host}`; `sendHint` replaces the missing-send-button warning.

## Marketplace (read only; `fb-reader.min.js`, locators in the write module)

| Call | |
|---|---|
| `nav.marketplace({q, min, max, sort, days, condition, delivery, exact, location})` | URL with the verified parameters `query, minPrice, maxPrice, sortBy (creation_time_descend, price_ascend, price_descend, distance_ascend), daysSinceListed (1/7/30), itemCondition (new, used_like_new, used_good, used_fair; several joined with %2C), deliveryMethod (local_pick_up, shipping), exact`; an unknown sort/days/condition/delivery throws |
| `nav.marketplaceItem(id)` | `/marketplace/item/<id>/` |
| `ready({budgetMs=6000, format})` | **run after every navigation, before `market()` / `listing()` / `map()`**: waits (250 ms polling) until the page content is really in the DOM (listing: title + price; results: ≥1 card or an empty-results text; feed: ≥1 post; inbox lists) and says so: `ready · igen · marketplace · 24 elem · 1200 ms`. A title-only page is reported as NOT ready with the reason. `{format:'json'}` → `{ready, page, items, waitedMs, why, bodyChars, title}` |
| `market({q, min, max, free, sponsored, by, limit=8, offset, chars=58, maxChars=900, format})` | header `market „keresés” · N/M betöltve (S szponzorált kihagyva) · rendezés · helyszín`, lines `$ref ár (volt régi) cím · hely ⟨jelzés⟩ [szponzorált]`; cards are de-duplicated by listing id, `priceNum` drives `min/max/by`, `q` is an accent-insensitive local filter `{format:'json'}` → `{page, query, sort, place, loaded, matched, sponsoredSkipped, offset, count, nextOffset, rows:[{ref,id,title,price,priceNum,oldPrice,free,location,badge,sponsored,url}]}` with FULL URLs |
| `marketScroll({steps=3, budgetMs=9000, format})` | scrolls and stores the loaded cards; keep it ≤4 steps (45 s evaluate limit). Reports `+N új · M betöltve`; `{format:'json'}` → `{loaded, added, newRefs, done, scrollPct, ms}` (new = not in the store before this call; the store is de-duplicated by ad id) |
| `listing(ref?, {chars=320, format})` | no argument on an item page: parsed listing; with `$ref`: card data + URL, no navigation. `{format:'json'}` (also `listing({format:'json'})`) → one record: `{ok, id, title, price, priceNum, when, loc, delivery, details:{…}, desc, seller, sellerName, images, url}` |
| `marketControl(name)` (write module) | `location, sort, delivery, condition, date, availability, sellerType` (read), `alert, message` (**write**, `write:true`, with a note); tags `[fbr:mk-<name>]`, never clicks |

## Selling and tracking (`fb-reader.min.js` + write module)

| Call | |
|---|---|
| `nav.marketplaceCreate(type='item')`, `nav.marketplaceSelling()` | `/marketplace/create/item|vehicle|rental`, `/marketplace/you/selling` |
| `sellCheck()` / `sellForm()` (write module) | the open listing form (Marketplace page or the group's "Eladó tárgy" dialog): `{ok, step 1\|2, target:{kind marketplace\|group, name, audience}, seller, fields:{title, price, category, condition, description}, photos, photoMax, options:{hideFromFriends, boost}, checks[], controls:{title, price, category, condition, description, more, photos, next, publish, draft, back → {ref:'[fbr:sell-…]', disabled}}, missing[], warnings[], ready}`; tags the controls, never clicks or types |
| `sellReport()` | Hungarian preview (target, seller, fields, photos, warnings, checklist) to show before anything is published |
| `trackAdd({url?, title?, price?, note?})` | follow a Marketplace listing (`/marketplace/item/<id>`), a group post (`/groups/<g>/posts/<id>`) or a post link; store = this browser profile's localStorage `fb-reader:track` (max 40) |
| `trackList({hours=6})`, `trackRemove(id)` | `⌗id kind price title · ell.: N órája ⏰ · ⚑ változott … → path` |
| `trackCheck({format:'text'\|'object', save=true})` | on the item's page: diff against the last snapshot (price, title, status word eladva/foglalt/függőben, counters views/clicks/interested/saves, reactions/comments/shares, new comments with `inq` = inquiry-like). `format:'object'` → `{ok, id, kind, first, changed, changes[], fresh[{a,t,inq}], inquiries, sold, url}` (used by the extension) |
| `myListings({track})` | the seller dashboard rows (title, price, status, counters); `track:true` follows them all |
| `priceCheck({price?, id?})` | min / Q1 / median / Q3 / max of the loaded non-sponsored prices and the percentile of the own price (same item type + condition only) |

`fb-approve.mjs --kind listing --url … --as … --target-name … --title … --price <digits> [--description-file f | --description t] [--category c] [--condition c] [--photo path …]`: fields are typed in any order but each exactly; `--status` shows the progress (`title 12/12, price 0/5 …, photos 0/1`).

Extension helper (`extension/`): `bridge.js` (isolated world) mirrors the tracked list to `chrome.storage`; `background.js` runs the optional check pass (settings `enabled` (default false), `intervalHours`, quiet hours 22–8, `maxPerDay`), `popup.html` shows the list and the switch.

## Reel (`/reel/<id>`; `fb-reader.min.js`)

A reel page preloads several neighbouring reels at once; everything below works on the **active**
one only — the one actually playing, or (nothing playing) nearest the viewport centre, never a
preloaded neighbour. `findPostRoots()`, `extractPost()`, `map`/`peek`/`thread`/`full`/`where`/`go` all
work on a reel page without any special call — `pageInfo().type === 'reel'` routes them automatically.

| Call | |
|---|---|
| `activeReel()` | `{video, unit, id}` of the active reel: the `<video>` element, its post-root ancestor (holds the rail + caption), and the reel id from the URL. `null` off a reel page |
| `async reel({budgetMs=4000})` | the active reel as a normal post object (`kind:'reel'`; schema below), after expanding "Továbbiak" in the caption. Equivalent to `extractPost(activeReel().unit)` but awaits the caption expansion first |
| `nav.reelComments()` (write module locator) | tags `[fbr:reel-comments]` on the active reel's own comment button (never a neighbour's) — `find` → click to open the panel; never clicked by the reader |
| `nav.reelNext()`, `nav.reelPrev()` | tag the next/previous-video arrow `[fbr:reel-next\|reel-prev]` if the fixture/page has one, else report that none was found — never invented, never clicked |
| `async expandComments({budgetMs=7000})` on a reel | pages the **side comment panel** (`[role="complementary"]`), not the inline thread: clicks its "További hozzászólások N / M" button, ≤4 clicks per call, 1.5–2.5 s apart, then `{clicked, done}`. The panel must already be open (`nav.reelComments()` → click first) |
| `where()` on a reel | `reel <id> · <mm:ss> · lejátszás\|szünet · <n>/<total> betöltve · kommentpanel: zárva\|nyitva (<loaded>/<total>)` |

**Keyword-bait detection (🎣):** if the pinned comment reads like "írd be X és privátban elküldöm…" and
≥60% of the top-level replies just repeat that one word, `thread()` folds them into one line
(`🎣 kulcsszó-kampány: „X" matched/total · szerző válasza: „…" · egyéb hozzászólás: N`) instead of listing
each copy — the pinned ask and the author's own reply stay visible, only the copies are hidden.
`thread({bait:false})` restores the full listing; `thread({only:'other'})` keeps just the non-matching
replies (the genuine questions worth reading).

## Post object

```jsonc
{
  "kind": "reel" | undefined,            // only present on a reel's post object
  "postId": "1112223334" | "pfbid0…",   // numeric, pfbid, video/reel id
  "url": "https://www.facebook.com/groups/x/posts/…/",  // tracking stripped; may be null on home feed until hoverDates()
  "author": "Kovács Anna", "authorUrl": "…", "authorVerified": false,
  "authorBadges": ["A csoport szakértője"],   // header labels (admin, top fan, "megosztva itt: <group>")
  "sponsored": false,
  "date": "2026-10-03T12:22:00.000Z", "dateApprox": false,
  "dateRaw": "2026. október 3., péntek 14:22",
  "dateMethod": "aria-labelledby|aria-label|visual-decode|innerText|abbr-utime|aria-label-any",
  "text": "…", "textTruncated": false, "sharedText": "…" | null,
  "hashtags": ["#ai"],
  "chapters": [{"t": "5:29", "title": "Refrén"}],   // reel only: timestamp lines parsed out of the caption
  "audio": "Eredeti hang" | null,                   // reel only: the caption's audio-credit line, if any
  "duration": 42.3 | null,                          // reel only: video.duration, if known
  "links": ["https://external.site/…"],     // unwrapped, de-duplicated, no FB-internal links
  "cards": [{"url", "title", "domain", "description"}],   // link previews; decoy cards removed
  "images": [{"src", "alt"}],               // alt = FB's auto description
  "videos": ["https://www.facebook.com/reel/…"], "hasVideo": true,
  "counts": {"reactions": 2200, "comments": 267, "shares": 15, "reactionTypes": {"vicces": 1900, "tetszik": 184}},
  "position": 3,                            // aria-posinset in the feed; null on a reel
  "comments": [{
    "author", "authorUrl", "depth": 0, "replyTo": null | "Name",
    "text", "date", "dateRaw",
    "media": [{"kind": "image|gif|sticker|video", "src", "alt", "link"}],
    "links": ["https://…"], "url": "…?comment_id=…"
  }]
}
```

Envelope: `{tool, version, extractedAt, page: {url, title, heading, type, loggedOut, dialogOpen, warning}, posts, warnings}`.
`page.type ∈ home group group-search groups-index post video reel photo event marketplace search profile-or-page`.

## CLI (Claude Code on the user's machine) — `scripts/fb-capture.mjs`

```bash
npm i -D playwright                    # once
node fb-capture.mjs login              # headed window with ~/.fb-reader/profile — user logs in by hand
node fb-capture.mjs read <url> --scroll 8 --comments --md
node fb-capture.mjs group <id|slug|url> --chronological --scroll 6 --out g.json
node fb-capture.mjs group <id> --search "suno"
node fb-capture.mjs search "suno ai" --type groups
node fb-capture.mjs groups
node fb-capture.mjs mediagrid https://www.facebook.com/<user>/reels
```
Options: `--profile`, `--headless` (after the first successful login), `--channel chrome|msedge`,
`--executable <path>`, `--limit`, `--out`. JSON output feeds straight into `fb_tool.py media` / `to-md`.

## Offline — `scripts/fb_tool.py`

```bash
python3 fb_tool.py parse-html saved.html --format md     # Ctrl+S page or copied outerHTML
python3 fb_tool.py to-md dump.json                        # fb-reader JSON or scraper posts.json
python3 fb_tool.py media dump.json -o fb_media [--only image,video] [--cookies-from-browser chrome]
python3 fb_tool.py media --url https://www.facebook.com/reel/123 -o fb_media
python3 fb_tool.py clean-url "<url>"
python3 fb_tool.py urls search "query" --type people
python3 fb_tool.py transcribe --url https://www.facebook.com/reel/123 -o out --subs --speech   # captions + speech-to-text
python3 fb_tool.py transcribe downloaded.mp4 -o out --ocr 5                                     # on-screen text, one frame/5s
python3 fb_tool.py media --url https://www.facebook.com/reel/123 -o fb_media --transcribe --speech  # download + transcribe in one step
```
`transcribe` needs `yt-dlp` for `--subs` (and for `--url` downloads), `faster-whisper` for `--speech`
(`pip install faster-whisper`), and `ffmpeg` + `tesseract` (`eng+hun` language data) on `PATH` for
`--ocr`; a missing tool is reported in `manifest.json`'s per-step `status`, never silently skipped.

## Install & rebuild

- Loader: `scripts/fb-reader.loader.js`, run verbatim (it starts with `await`). It syncs
  localStorage ↔ IndexedDB both ways, calls `navigator.storage.persist()`, loads the core and the
  write module (if installed), and reports `cache OK` / `ELAVULT CACHE` / `ÍRÁSI MODUL ELAVULT`.
- Core install: `fb-reader.min.js` in one call, or `install/fb-reader.part-1-of-N.js … N-of-N.js`
  in order (≤12 KB each; the last part assembles, runs and caches the core).
- Write module install: `fb-reader-write.min.js` (needs the core).
- Edit `scripts/fb-reader.js` / `fb-reader-write.js`, then `python3 scripts/build.py` (needs
  `npx terser`). New build hashes make the loader report the old cache as outdated.
