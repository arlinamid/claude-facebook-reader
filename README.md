# facebook-reader — Claude plugin

> **English** (this file) · [Magyar](README.hu.md) — the plugin is currently verified against the **Hungarian** Facebook UI; see *Language support* for other languages.

Claude (and other models) struggle to read Facebook. The site is deliberately obfuscated:
- class names change daily;
- dates are made of single-character, shuffled spans with invisible U+034F characters;
- posts contain decoy "Facebook" blocks and fake cards;
- links go through `l.facebook.com`;
- the feed is virtualised and permalinks only appear on hover.

This plugin gives Claude a skill that reads what a human sees **in your own logged-in browser** and
returns clean Markdown/JSON.

## What it can do

- **Posts:** author, verified badge, exact or approximate date, full text ("See more" expanded), shared
  content, link previews, hashtags, images with Facebook's own alt text, videos/reels, reactions by type,
  comment and share counts, sponsored marker.
- **Comments:** author, who they reply to, date, text, images/GIFs/stickers/videos, links. "View more
  comments" can be expanded.
- **Search:** posts, people, groups, pages, photos, videos, events, places, Marketplace; hashtag and
  in-group search.
- **Groups:** list of joined groups, group info (private/public, member count, description, membership),
  chronological feed, media library.
- **Notifications and Messenger** (read-only, on request): counters, notification list ("mine" = on your
  own posts), conversation list, local search, opening a thread (with a read-receipt warning for unread ones).
- **Marketplace:** search with filters from the URL, result list (sponsored hidden), listing details,
  price comparison of similar listings.
- **Selling and tracking:** check/preview of the listing form (Marketplace or group), **one** approval for
  the whole listing (the publish click is always asked separately), tracking of your own listings and sale
  posts (price, status words, counters, new comments with an inquiry heuristic).
- **Navigation:** URL builders for all of the above.
- **Media download:** images directly, videos and reels with `yt-dlp` (`fb_tool.py media`).
- **Writing (only with approval):** comment, reply to one specific comment (`replyBox`), reaction, post,
  message. The module only locates and reports the target (on whose behalf, who is replied to, attachments,
  send button, warnings); the click and the typing are Claude's, under the hook's supervision and your
  approval. See *Write protection*.
- **Offline:** saved HTML or the `posts.json` export of `facebook-private-group-scraper` → Markdown.

## Write protection (security hook)

The plugin installs a `PreToolUse` hook (`hooks/fb-write-guard.mjs`). It stops and asks for approval before
every browser action that would change something on Facebook:
- typing text or pressing Enter;
- posting, commenting, replying, messaging, reacting, sharing;
- joining, approving, deleting;
- **attaching files or media**;
- JavaScript that is able to write.

The prompt shows the target page, the action and the text or file about to be entered. Reading, scrolling,
screenshots and the plugin's own vetted reader script run without friction.

The skill's write protocol goes with it:
1. Claude names the target exactly (page, group, profile or the comment being answered), on whose behalf it
   writes, and the audience.
2. The draft and any files to attach are shown in the chat first.
3. The post is prepared in the browser but not published yet.
4. A `composeReport()` preview and a screenshot show what would really go out.
5. Only after an explicit "go" does Claude press publish, then verifies the result.

The hook runs in Claude Code and needs Node (which comes with Claude Code). Where the surface does not run
plugin hooks, the protocol is the protection.

## Install (marketplace)

Claude Code:

```bash
claude plugin marketplace add arlinamid/claude-facebook-reader
claude plugin install facebook-reader@arlinamid-plugins
```

Within a session: `/plugin marketplace add arlinamid/claude-facebook-reader`, then
`/plugin install facebook-reader@arlinamid-plugins`.

From a local folder before publishing: `claude plugin marketplace add ./claude-facebook-reader` (the cloned folder).

In the Claude app (Cowork / claude.ai) the plugin can be uploaded as a `.plugin` file, or an organisation
admin can add it as a GitHub marketplace.

## Codex

The same plugin directory also installs in Codex (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`):

```bash
codex plugin marketplace add arlinamid/claude-facebook-reader
codex plugin add facebook-reader@arlinamid-plugins
```

Review and trust the plugin's hooks in Codex's `/hooks` screen (installing does not trust them). In Codex the plugin is
**read-only**: `fb-codex-guard.mjs` lets reader calls pass and denies possible Facebook writes, because Codex does not
support the `ask` decision the Claude hook uses. It is tested with synthetic hook events, not yet on a live Codex for
Chrome session. Details and other agents: `plugins/facebook-reader/skills/facebook-reader/references/agents.md`.

## Chrome extension (recommended, optional)

`extension/` is a small MV3 extension that loads the `__fbReader` object on every facebook.com page load. No
pasting of the script, no stale cache. Install: `chrome://extensions` → Developer mode → *Load unpacked* → the
plugin's `extension/` folder. Details: `extension/README.md`.

It also contains two **opt-in** background helpers (both OFF by default, read-only): checking your tracked
listings, and watching the bell / Messenger counters (counters only; it never opens a thread and never reads
message text).

## Token-frugal reading

A raw Facebook page costs many tokens (40 posts ≈ 9,500 tokens). The plugin therefore reads in levels; every
output is ≤ 900 characters with a `~Ntok` estimate and the name of the next call:

| Level | Call | Cost |
|---|---|---|
| where am I | `where()` | ~60 tokens |
| L0 map | `map()` — 1 line / post, `#anchor`, age, author, 55 chars, counters, flags | ~25 tokens / post |
| L1 peek | `await peek('#a3f9')` — shortened text, media, 3 highlighted comments | ~120 tokens |
| L2 thread | `await thread('#a3f9', {only:'author', match:'…'})` | ~100 tokens |
| L3 full | `await full('#a3f9')` / `await full('#a3f9','c3')` — exactly one item | its length |
| search | `grep('word', {where:'all'})` — hit with ±35 characters | ~10 tokens / hit |

`peek`, `thread`, `full`, `go` are async: always `await` them. The anchor is a content hash, stable across
scrolling and re-rendering; a post that dropped out of the virtualised feed is scrolled back automatically.
Read posts are remembered (`•` = new); ads are skipped.

## Usage

Just ask naturally, for example:

- "Summarise what happened today in the Example Group."
- "Read this post with its comments: https://www.facebook.com/…"
- "Search Facebook for groups about artificial intelligence."
- "Which groups am I a member of?"
- "Download the reel: https://www.facebook.com/reel/…"
- "Any notifications on my posts?" / "Search Marketplace for used bicycles under 50,000."

Manual start: `/facebook-reader:facebook-reader`.

### Prerequisites

| Route | Needs |
|---|---|
| Browser (default) | Claude in Chrome extension or the Claude desktop built-in browser, with Facebook logged in |
| Claude Code CLI without a browser extension | Node 18+, `npm i -D playwright`, one-time `node scripts/fb-capture.mjs login` |
| Media download | Python 3.9+, `pip install -U yt-dlp` (for private videos `--cookies-from-browser chrome`, on your own machine only) |
| Parsing saved HTML | `pip install beautifulsoup4` |

## Language support

Everything in the reader that depends on the Facebook **UI language** (month names, relative times, button
labels, badges, count suffixes) lives in **language packs** (`PACKS` in `fb-reader.js`). The reader uses the
union of all packs, so no language detection is needed to read a page.

| Language | Status |
|---|---|
| Hungarian (`hu`) | verified against the real Facebook UI |
| English (`en`) | pack exists, not yet verified on the real UI |
| any other | `__fbReader.registerLang({…})` or a new entry in `PACKS`; `langProbe()` and `selfTest()` help |

Adding a language: [`references/i18n.md`](plugins/facebook-reader/skills/facebook-reader/references/i18n.md).
Note: the plugin's own *output messages* (status lines, hook prompts) are currently Hungarian; a message
catalogue is the next step.

## Changes

The full log is in [`CHANGELOG.md`](CHANGELOG.md) (Hungarian). Main milestones:

| Version | What changed |
|---|---|
| **0.11.0** | **Release preparation.** Language packs (hu verified, en) for the post-reading core, `registerLang`, `lang()`, `langProbe()`, a `selfTest()` language warning; `references/i18n.md`; English README (Hungarian in `README.hu.md`); a privacy scan in the test suite and `release.py`; all test fixtures and docs scrubbed of real names, ids, groups and paths |
| **0.10.0** | **Notification and Messenger watching in the Chrome extension** (opt-in, OFF by default): watches the unread counters in the header (`watchPeek`) and notifies when they grow; never opens a thread, never loads the Notifications page, never reads or stores text. |
| **0.9.0** | **Selling and tracking:** check/preview of the listing form (Marketplace and group) (`sellCheck`, `sellReport`), one approval for the whole listing (`fb-approve.mjs --kind listing`: text, photos, dropdown values; publishing is always asked separately), tracking (`trackAdd/List/Check/Remove`, `myListings`, `priceCheck`) and the extension's tracking helper (bridge, opt-in background check with notification, popup) |
| **0.8.0** | **Marketplace search** (read-only): `nav.marketplace` filter URL, `market()` result list (sponsored hidden), `marketScroll()`, `listing()` details, `marketControl()` control locator; messaging a seller and saving an alert only through the write protocol |
| **0.7.x** | Self-notification: a message to your own Messenger thread without a question ("task done"), bound to the account, not to a name (`me()`, `selfThread()`, `fb-approve.mjs --register-self / --self-notify`), single send allowed in the hook |
| **0.6.0** | Notifications and Messenger, read-only and on request: `inbox`, `notifs`, `notif`, `msgs`, `msgOpen`, `msgThread`; sending only through the write protocol ("Recipient" line, group and E2EE warnings) |
| **0.5.x** | `expandComments({post})`, `setCommentSort`, `replyBox` (reply box of one comment), `composeCheck` addressee from the mention, `warnings[]`, real sort labels from the live UI |
| **0.4.x** | Reading levels with anchors (`where/map/peek/thread/full/grep/go`), own icon |
| **0.3.0** | Chrome extension, target marking (`find` → `ref` → click), approval token and audit log, `selfTest`, `snapshot`, `q`, test suite + CI, `release.py` |
| **0.2.0** | `await` loader, synchronous cache, chunked install, separate write module, `budgetMs`, `commentBox`/`react`, playable (H.264) videos |
| **0.1.0** | First release: reading, comments, groups, search, media download, write-protection hook |

## Write protection details

- **Approval token.** `hooks/fb-approve.mjs` records the approved text and target. The hook ties the record
  to the permission and shows the exact text. Afterwards `type` may only pass this exact text; anything else
  is DENIED. Without a token the old behaviour remains (it asks).
- **Audit log:** `~/.fb-reader/audit.log` (one JSON per line). It contains the decisions (ask/deny/allow)
  and the writes that were actually executed. The log is best-effort and never blocks the hook.
- **Limit:** the hook guards Claude Code's tool calls. Someone typing by hand in the browser is not seen.

## Important

- **Never take cookies to the cloud.** If the session signs in from a cloud IP, Facebook asks for a security
  check and may lock the account. The plugin therefore uses your own browser or your own machine.
- On first run the script saves itself in facebook.com's `localStorage` and IndexedDB
  (`fb-reader:src`/`ver`, the write module's `wsrc`/`wver`). On later pages the ~1.5 KB loader is enough.
  To clear in DevTools: `localStorage.removeItem('fb-reader:src')` and `indexedDB.deleteDatabase('fb-reader')`.
- It works at a human pace in small scroll batches. It is meant for what you are entitled to see anyway.
  Copyright applies when re-publishing other people's content.

## Layout

```
plugins/facebook-reader/
├── .claude-plugin/plugin.json       # Claude Code / Cowork manifest
├── .codex-plugin/plugin.json        # Codex manifest (selects hooks/codex-hooks.json)
├── extension/                       # optional Chrome extension (generated by build.py + hand-written helpers)
├── hooks/                           # write protection: fb-write-guard.mjs · fb-approve.mjs · fb-guard-lib.mjs · Codex: fb-codex-guard.mjs + codex-hooks.json
└── skills/facebook-reader/
    ├── SKILL.md                     # instructions for Claude
    ├── references/                  # api.md · i18n.md · obfuscation.md · media.md · analysis.md · recipes.md · troubleshooting.md
    └── scripts/
        ├── fb-reader.js             # readable source (language packs at the top)
        ├── fb-reader-write.js       # write module (source; the build also makes .min.js)
        ├── fb-reader.min.js         # injectable, self-installing build
        ├── fb-reader.loader.js      # tiny loader for every page
        ├── build.py                 # source → min + loader (terser)
        ├── fb_tool.py               # media, to-md, parse-html, clean-url, urls
        └── fb-capture.mjs           # Playwright CLI with its own profile
```

The foundations come from two earlier projects: **facebook-private-group-scraper** (group archiver) and
**Shadowcast / fb-ytembed-plugin** (MV3 feed embedder). They were verified and extended against the live
Hungarian Facebook UI.

## Development

```bash
python3 plugins/facebook-reader/skills/facebook-reader/scripts/build.py   # sources → min files, install parts, extension
xvfb-run -a python3 tests/run_tests.py                                     # synthetic pages, hook, extension, privacy scan
python3 tests/privacy_scan.py [--deny local-denylist.txt]                  # no personal data in the repository
python3 release.py --bump minor                                            # build + tests + validate + .plugin package
```
