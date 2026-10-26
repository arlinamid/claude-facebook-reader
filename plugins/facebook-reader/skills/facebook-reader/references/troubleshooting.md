# Hibaelhárítás

| Symptom | Fix |
|---|---|
| `látható posztok: 0` | wait 2–3 s or scroll once, re-run; on a group page check the membership warning |
| dates missing | `await __fbReader.hoverDates({all:true})`, then extract again |
| post `url` null (home feed, page/profile feed) | `await hoverDates()` focuses the timestamp, which makes FB swap in the real permalink; without it the photo link (`photo/?fbid=`) is used, or open the post's comment-count overlay |
| click landed next to the target | screenshot coordinates ≠ CSS px: use `mark:true` + screenshot and click the frame, or scale by `screenshotWidth / vw` |
| JS output `[TRUNCATED]` | use `render()` + `get_page_text`, or `chunk()` |
| loader returns `{}` | it was run without the leading `await`; run the file verbatim |
| `[BLOCKED: Cookie/query string data]` | a signed fbcdn URL reached the output: use `extract({format:'json'})`/`md`, `extractSearchResults()` (stripped), or `download()` for full URLs |
| Codex Browser Use: `Raw CDP is unavailable while Browser Use is resolving a paused document response` | host-adapter state, not the reader: the page's document response is still paused (navigation or redirect pending). Wait for the load to finish, then `await __fbReader.ready()`; try another call type or tab once. If it repeats, do not loop: use the Facebook Reader extension (the reader is then already on the page and needs no script injection), a page-world evaluator, or the local CLI (`fb-capture.mjs`); see `agents.md`. Report the host error, not a reader verdict |
| reads right after `navigate` return the title only / empty text | too early: `await __fbReader.ready()` (it waits for real content and says what is missing) before `market()` / `listing()` / `map()` |
| `Tool "javascript_tool" failed in the extension` | the call ran over the time limit: use `scroll({steps:3})` / default budgets and loop; never `steps:8` in one call |
| `NINCS TELEPÍTVE` right after a navigation | FB purged the cache: re-install (`fb-reader.min.js` or `install/` parts). Since v0.2.0 the loader re-syncs localStorage ↔ IndexedDB, so this should be rare |
| `profile.php` result without id | use the result's `id` field / `nav.page(result)`; do not cut the URL at `?` |
| `írási modul: nincs` | run `scripts/fb-reader-write.min.js` once |
| extraction suddenly empty/wrong | `__fbReader.selfTest()` lists which DOM anchors vanished; `render(snapshot())` → `get_page_text` gives an anonymised sample for a bug report / regression test |
| downloaded video "does not play" | it is AV1. `fb_tool.py media` now prefers H.264 and transcodes automatically; for an existing file see `references/media.md` → Playable output |
| `Inspected target navigated` | a click navigated; refresh `tabs_context_mcp`, run the loader again |
| selectors stopped working after an FB update | read `references/obfuscation.md`, probe with small JS, patch `scripts/fb-reader.js`, rebuild with `python3 scripts/build.py` |
| `expandComments` opened another post's overlay (`modal-mismatch`) | pass `post:'#anchor'` (without it only the overlay / post in view is used); close the overlay with Escape, `await go('#anchor')`, retry |
| `peek` said `nincs ilyen horgony` after scrolling | the feed is virtualized: `map()` shows posts seen earlier as `↑`; `await peek/thread/full/go('#a3f9')` scroll them back. Only posts that were extracted at least once have an anchor: run `harvest.collect()` / `hoverDates()` before leaving a long feed |
| `go()` landed on `photo/?fbid=…` ("Még nincs hozzászólás") | the post's permalink was still hidden: `await go()` now reveals it; on a photo page use `nav.photoPost()` ("Bejegyzés megtekintése") |
| `thread` says "N hiányzik: valószínűleg törölt/rejtett/szűrt" | the counter includes replies, deleted and filtered comments; `expandComments` found no more buttons. `await setCommentSort('all')` first, then `thread` again |
| date `~4n` does not match the real day | Facebook rounds relative times down: "4 nap" = 4–5 days. `map({date:'10-19'})` matches the rounding window; `await hoverDates({post:'#…'})` gives the exact date |
| `get_page_text` fails inside a modal / overlay | read through the API instead: `await full('#a3f9')`, `await thread('#a3f9')`; for long output `render(text)` is not needed, `full` pages with `{offset}` |
| link card shows `facebook.com` in the feed | the href is still FB's shim; the card's own domain line is used (`🔗github.com`); the real URL appears after `await hoverDates({post})` or on the post page |
| `composeCheck` says `replyTo: null` / `warnings` non-empty | The box has no recognisable mention and no comment article before it. Load the comments, open the box via `replyBox(post,'Név')`, check with a screenshot. Never publish while `warnings` is non-empty |
| `publishButton` empty or `guessed:true` | A reply box shows its send arrow only while it is focused and has text; an empty box has none. Focus it / type the approved text, call `composeCheck()` again. A label-less icon is only ever a guess: confirm by screenshot |
| `setCommentSort` / `expandComments` do not change the sort | FB's real labels are "A legrelevánsabbak" / "A legújabbak" / "Az összes hozzászólás" (plural, with article); 0.5.2 knows them. On an older build update, or pick the entry by hand |
| `thread` in the feed says "a hírfolyamban nincs komment-lista" | The home/group feed renders no comments; open the post (`commentBox('#h')` → `openWith` → click), then `thread()` reads the overlay. The overlay post has its own anchor: `where()` shows it |
| `where()` says "overlay nyitva" but nothing is open | Fixed in 0.5.2 (hidden panels such as "Értesítések" are `role=dialog`); on older builds close the panel / update |
| `c3` is another comment than before | `c` numbers shift when `expandComments` inserts replies: use the author name in `replyBox`, or read `thread()` again first |
| `notifs` says "nincs értesítés a DOM-ban" | Open the Notifications page (`nav.notifications()`), wait 3 s; the bell panel only renders rows while it is open. On a very old build the `ó` unit ("3 ó") was not recognised as a time: update |
| `inbox()` shows `🔔 ?` | The banner has no count label; read the title `(N)` or open the page and use `notifs({unread:true})` |
| `msgs` finds nothing for a name | `q` searches the loaded list only. Scroll the list, or use the Messenger search (`msgSearch()` → click → type) for older chats and message bodies |
| `msgThread` says "nincs megnyitott beszélgetés" | Navigate to the thread first (`msgOpen('^ref')` gives the URL); an unread thread is marked read on opening, so ask the user first |
| `composeCheck` in Messenger: `recipient.name` null / mismatch warning | The box label is "Írás nekik: <név>"; a nickname differs from the header's real name. Check by screenshot who the thread is with |
| the Messenger send button is not found | Messenger sends on Enter; there may be no button (`sendHint`). Press Enter once, only after the final approval |
| `--self-notify` says "nincs regisztrált saját szál" / "nem egyezik" | Register once with the user's OK (`selfThread()` → `--register-self --url … --account <me().id>`); the account must be the one that registered. Another browser profile / account needs its own registration |
| after sending, a second click sent a thumbs-up | The send arrow becomes the "Kedvelés küldése" button once the box is empty. Click send exactly once; the hook allows only one send per notification |
| the Messenger box is missing right after `navigate` | E2EE threads render late (4+ s). Wait, then `find` the box; do not guess coordinates |
| a self-notification still asks the user | (1) the `--self-notify` command was chained with another command or created the text file itself: run it alone, write the file with the Write tool first. (2) The click on the box is not a focus click (its summary mentions send / like / attach). (3) The plugin was updated but not reloaded, so the old hook runs. (4) The thread or account differs from the registered one: `fb-approve.mjs --status` shows the registration. Check `~/.fb-reader/audit.log` for the decision and its reason |
| `market()` says "nincs hirdetés a DOM-ban" | the page is still loading or is not a search page: wait 3–4 s, or `navigate nav.marketplace({q})` |
| `market()` shows few results | the grid is virtualised: `await marketScroll({steps:3})` a few times (≤4 steps per call), then `market()` |
| an expected result is missing | sponsored cards are skipped by default; `market({sponsored:true})` shows them |
| `listing()` says "nem hirdetés-oldal" | `navigate` to the item URL first (`listing('$ref')` prints it) |
| `sellCheck()` says "nincs megnyitott hirdetésfeladó űrlap" | open `nav.marketplaceCreate()`, or in a group click the composer's "Eladó tárgy" and then the type "Eladó tárgy" in the chooser |
| typing into the listing form is denied | the text differs from the approved one (the hook prints the first differing character) or the field is already complete: re-approve with `--kind listing` or type verbatim |
| photo upload shows "A fájlodat nem sikerült feltölteni" / "file format is not supported" | the Facebook post composer rejects `.webp` outright (listing/Marketplace photos too). Convert to JPG/PNG/GIF first, e.g. `magick in.webp out.jpg`, then attach the converted file |
| "Tovább" asks the user | the approved content is not fully typed/uploaded yet (`fb-approve.mjs --status` shows the progress), or the click summary mentions publish/send |
| `trackCheck()` says "nem követett" | `trackAdd()` first (on that page); the store is per browser profile |
| `trackCheck()` says the page is not readable | wait 3–4 s after `navigate`, then retry; a deleted/expired listing shows an error page |
| the extension never checks in the background | the popup switch is OFF by default; it also skips quiet hours (22–8), the daily cap and items checked within the interval; a login/checkpoint redirect switches it off again |
| `activeReel()` picked a preloaded neighbour, not the one in view | the neighbour was reported as "playing" (headless/background tabs often never autoplay anything, so this should not happen with real playback) — check `pageInfo().type === 'reel'` and that the active unit is actually in the viewport; report as a bug with `render(snapshot())` |
| `expandComments()` on a reel returns `{clicked:0, error:'a kommentpanel nincs nyitva…'}` | the side comment panel is not open yet: `nav.reelComments()` → `find "[fbr:reel-comments]"` → click, then retry |
| `nav.reelNext()` / `nav.reelPrev()` says "nincs ilyen gomb" | this reel has no next/previous arrow in the DOM (common on a single shared reel link, outside the swipe feed) — nothing to tag; navigate by URL instead |
| `thread()` on a reel hides a comment you wanted to see | a `🎣` keyword-bait line folds matching replies by design; `thread({bait:false})` lists everything, `thread({only:'other'})` lists only the non-matching ones |
| `where()` says `kommentpanel: zárva` right after `nav.reelComments()` | tagging never clicks, so the panel is still closed; click the tagged button first |
| `fb_tool.py transcribe --speech` says "faster-whisper nincs telepítve" | `pip install faster-whisper` |
| `fb_tool.py transcribe --ocr` says "tesseract nincs telepítve" | install Tesseract OCR with the `eng`+`hun` language data and put it on `PATH` (e.g. `apt install tesseract-ocr tesseract-ocr-hun` / the Windows installer's language-data option) |
| `fb_tool.py transcribe --subs` finds nothing | that upload has no Facebook-provided or auto-generated captions; use `--speech` instead |

