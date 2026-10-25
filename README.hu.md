# facebook-reader — Claude plugin

> [English](README.md) · **Magyar** (ez a fájl) — a plugin jelenleg a **magyar** Facebook-felületen ellenőrzött; más nyelvekhez lásd a *Nyelvi támogatás* szakaszt.

Claude (és más modellek) nehezen olvassák a Facebookot. A felület szándékosan obfuszkált:
- az osztálynevek naponta változnak;
- a dátum egybetűs, összekevert spanekből áll, láthatatlan U+034F karakterekkel;
- csali „Facebook” blokkok és álkártyák vannak a posztokban;
- a linkek `l.facebook.com`-on keresztül mennek;
- a feed virtualizált, a permalinkek pedig csak hoverre jelennek meg.

Ez a plugin egy skillt ad Claude-nak, amely a **saját, bejelentkezett böngésződben** azt olvassa ki,
amit egy ember lát, és tiszta Markdownt/JSON-t ad vissza.

## Mit tud

- **Posztok:** szerző, ellenőrzött jelvény, pontos vagy közelítő dátum, teljes szöveg („Továbbiak”
  kibontva), megosztott tartalom, link-előnézetek, hashtagek, képek a Facebook saját képleírásával,
  videók/reelek, reakciók típusonként, kommentek és megosztások száma, hirdetésjelölés.
- **Kommentek:** szerző, kinek válaszol, dátum, szöveg, képek/GIF/matrica/videó, linkek. A „Több
  hozzászólás” is kibontható.
- **Keresés:** posztok, emberek, csoportok, oldalak, fotók, videók, események, helyek, piactér;
  hashtag és csoporton belüli keresés.
- **Csoportok:** a csatlakozott csoportok listája, csoport-infó (privát/nyilvános, taglétszám,
  leírás, tagság), kronologikus feed, médiatár.
- **Navigáció:** URL-építők minden fenti oldalhoz.
- **Médialetöltés:** képek közvetlenül, videók és reelek `yt-dlp`-vel (`fb_tool.py media`).
- **Írás (csak jóváhagyással):** komment, válasz egy adott kommentre (`replyBox`), reakció és poszt. A modul csak
  megkeresi és jelenti a célt (kinek a nevében, kinek válaszol, csatolmányok, küldés gomb, figyelmeztetések),
  a kattintás és a gépelés Claude-é, a hook felügyelete és a te jóváhagyásod mellett. Lásd: *Írásvédelem*.
  **A csatolt képnek JPG/PNG/GIF-nek kell lennie** — a Facebook posztszerkesztője elutasítja a `.webp`
  feltöltést ("A fájlodat nem sikerült feltölteni"); jóváhagyás előtt konvertáld, pl. `magick in.webp out.jpg`.
- **Offline:** mentett HTML vagy a `facebook-private-group-scraper` `posts.json` exportja → Markdown.

## Írásvédelem (biztonsági hook)

A plugin egy `PreToolUse` hookot is telepít (`hooks/fb-write-guard.mjs`). Ez megállít és jóváhagyást
kér minden olyan böngészőművelet előtt, amely a Facebookon módosítana:
- szövegbeírás vagy Enter;
- posztolás, komment, válasz, üzenet, reakció, megosztás;
- csatlakozás, jóváhagyás, törlés;
- **fájl- vagy médiacsatolás**;
- írásra képes JavaScript.

A kérésben látod a céloldalt, a műveletet és a beírandó szöveget vagy fájlt. Az olvasás, a görgetés,
a képernyőkép és a plugin saját, ellenőrzött olvasószkriptje akadály nélkül fut.

Ehhez társul a skill írási protokollja:
1. A Claude pontosan megnevezi a célt (oldal, csoport, profil vagy a megválaszolt komment), azt,
   hogy kinek a nevében ír, és a közönséget.
2. A piszkozatot és a csatolandó fájlokat először a chatben mutatja meg.
3. A böngészőben előkészíti a bejegyzést, de még nem teszi közzé.
4. A `composeReport()` előnézetével és egy képernyőképpel megmutatja, mi kerülne ki valójában.
5. Csak a kifejezett „mehet” után nyomja meg a közzétételt, majd ellenőrzi az eredményt.

A hook a Claude Code-ban fut, és Node kell hozzá (ez a Claude Code-dal együtt jár). Ahol a felület
nem futtat plugin-hookot, ott a protokoll a védelem.

## Telepítés (marketplace)

Claude Code:

```bash
claude plugin marketplace add arlinamid/claude-facebook-reader
claude plugin install facebook-reader@arlinamid-plugins
```

Egy session-ön belül ugyanez: `/plugin marketplace add arlinamid/claude-facebook-reader`, majd
`/plugin install facebook-reader@arlinamid-plugins`.

Helyi mappából, közzététel előtt: `claude plugin marketplace add ./claude-facebook-reader` (a klónozott mappa).

A Claude alkalmazásban (Cowork / claude.ai) a plugin `.plugin` fájlként is feltölthető, vagy a
szervezet admin felülete GitHub marketplace-ként is hozzáadhatja.

## Codex

Ugyanez a plugin-mappa Codexben is telepíthető (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`):

```bash
codex plugin marketplace add arlinamid/claude-facebook-reader
codex plugin add facebook-reader@arlinamid-plugins
```

A plugin hookjait a Codex `/hooks` képernyőjén kell jóváhagyni (a telepítés nem teszi megbízhatóvá őket). Codexben a plugin
**csak olvas**: az `fb-codex-guard.mjs` átengedi az olvasó hívásokat, a lehetséges Facebook-írásokat letiltja, mert a Codex nem
támogatja a Claude-hook `ask` döntését. Szimulált hook-eseményekkel tesztelve, élő Codex for Chrome munkamenettel még nem.
Részletek és más ágensek: `plugins/facebook-reader/skills/facebook-reader/references/agents.md`.

## Chrome-bővítmény (ajánlott, opcionális)

A `extension/` mappa egy kis MV3 bővítmény, amely minden facebook.com oldalbetöltéskor betölti a `__fbReader`
objektumot. Nem kell beilleszteni a szkriptet, és nincs „ELAVULT CACHE”. Telepítés: `chrome://extensions` →
Fejlesztői mód → *Kicsomagolt bővítmény betöltése* → a plugin `extension/` mappája. Részletek: `extension/README.md`.

## Token-takarékos olvasás

A nyers Facebook-oldal sokszoros tokenköltségű (40 poszt ≈ 9500 token). A plugin ezért szintekben olvas, mindegyik kimenet ≤ 900 karakter, `~Ntok` becsléssel és a következő hívás nevével:

| Szint | Hívás | Költség |
|---|---|---|
| hol vagyok | `where()` | ~60 token |
| L0 térkép | `map()` — 1 sor / poszt, `#horgony`, kor, szerző, 55 karakter, számlálók, jelzők | ~25 token / poszt |
| L1 betekintés | `await peek('#a3f9')` — rövidített szöveg, média, 3 kiemelt komment | ~120 token |
| L2 szál | `await thread('#a3f9', {only:'author', match:'…'})` | ~100 token |
| L3 teljes | `await full('#a3f9')` / `await full('#a3f9','c3')` — pontosan egy elem | a hossz |
| keresés | `grep('szó', {where:'all'})` — találat ±35 karakterrel | ~10 token / találat |

A `peek`, `thread`, `full`, `go` aszinkron: mindig `await`-tel hívd. A horgony tartalom-hash, görgetés és újrarenderelés után is ugyanaz; a virtualizált hírfolyamból kikerült posztot a hívás magától visszagörgeti. Az olvasott posztokat megjegyzi (`•` = új), a hirdetéseket kihagyja.

## Használat

Elég természetesen kérni, például:

- „Foglald össze, mi történt ma a Példa Csoport csoportban.”
- „Olvasd el ezt a posztot a kommentekkel együtt: https://www.facebook.com/…”
- „Keress rá Facebookon a ‘mesterséges intelligencia’ csoportokra.”
- „Milyen csoportokban vagyok tag?”
- „Töltsd le a reelt: https://www.facebook.com/reel/…”

Kézzel is indítható: `/facebook-reader:facebook-reader`.

### Előfeltételek

| Útvonal | Kell hozzá |
|---|---|
| Böngésző (alapértelmezett) | Claude in Chrome bővítmény vagy a Claude desktop beépített böngészője, bejelentkezett Facebookkal |
| Claude Code CLI, böngészőbővítmény nélkül | Node 18+, `npm i -D playwright`, egyszeri `node scripts/fb-capture.mjs login` |
| Médialetöltés | Python 3.9+, `pip install -U yt-dlp` (privát videókhoz `--cookies-from-browser chrome`, csak a saját gépen) |
| Mentett HTML feldolgozása | `pip install beautifulsoup4` |

## Változások

A teljes napló a [`CHANGELOG.md`](CHANGELOG.md)-ben van. A főbb állomások:

| Verzió | Mi változott |
|---|---|
| **0.7.0** | Önértesítés: üzenet a saját Messenger-szálra kérdés nélkül („a feladat kész”), fiókhoz kötve (`me()`, `selfThread()`, `fb-approve.mjs --register-self / --self-notify`), egyszeri küldés a hookban; a saját szál üres címzett-nevének javítása |
| **0.7.1** | `selfThread()`: a saját szál bizonyítása a profil-linkből (név nélkül) |
| **0.7.2** | az önértesítés fókusz-kattintása már nem kérdez feleslegesen; dokumentáció az önálló `--self-notify` hívásról |
| **0.8.0** | **Marketplace keresés** (csak olvasás): `nav.marketplace` szűrő-URL, `market()` találati lista (szponzoráltak kihagyva), `marketScroll()`, `listing()` hirdetés-részletek, `marketControl()` kezelőelem-kereső; eladónak írás és értesítés-kérés csak az írási protokollal |
| **0.9.0** | **Eladás és követés:** hirdetésfeladó űrlap (Marketplace és csoport) ellenőrzése/előnézete (`sellCheck`, `sellReport`), egyetlen jóváhagyás a teljes hirdetésre (`fb-approve.mjs --kind listing`: szöveg, fotók, legördülő-értékek; a közzététel mindig külön kérdez), követés (`trackAdd/List/Check/Remove`, `myListings`, `priceCheck`) és a Chrome-bővítmény követés-segítője (híd, opcionális háttérellenőrzés értesítéssel, felugró ablak) |
| **0.10.0** | **Értesítés- és Messenger-figyelés a Chrome-bővítményben** (opcionális, alapból ki): a fejléc olvasatlan-számlálóit figyeli (`watchPeek`), növekedésnél értesít; nem nyit meg szálat, nem tölti be az Értesítések oldalt, szöveget nem olvas és nem tárol |
| **0.6.0** | Értesítések és Messenger, csak olvasás és csak kérésre: `inbox`, `notifs`, `notif`, `msgs`, `msgOpen`, `msgThread`, kereső- és gomb-lokátorok; üzenet-küldés a védelmi protokollal („Címzett” sor, csoport- és E2EE-figyelmeztetés); messenger.com is; olvasatlan szál megnyitása előtt látásjelzés-figyelmeztetés |
| **0.5.2** | Élő teszt javításai: a rendezésváltás ismeri a Facebook valódi feliratait („A legrelevánsabbak" / „Az összes hozzászólás"); matrica/GIF gombot nem téveszt küldésnek; a rejtett „Értesítések" panel nem számít overlaynek; a horgony megmarad a szöveg késői betöltésekor; a `thread()` hírfolyamban azt mondja, hogy nyisd meg a posztot |
| **0.5.1** | `replyBox`: egy adott komment válaszdoboza; a `composeCheck` az említésből olvassa a címzettet, csak a szerkesztő saját keretében számol csatolmányt és keres küldés gombot, és `warnings[]`-t ad |
| **0.5.0** | `expandComments({post})` csak a megadott poszton kattint; `setCommentSort`; `hoverDates` visszaállítja a görgetést; `go()` valódi permalinket ad; `map({date})`; `peek/thread/full/go` aszinkron |
| **0.4.x** | Olvasási szintek horgonyokkal (`where/map/peek/thread/full/grep/go`), saját ikon (lencse + „f") |
| **0.3.0** | Chrome-bővítmény, célelem-jelölés (`find` → `ref` → kattintás), jóváhagyási token és audit napló, `selfTest`, `snapshot`, `q`, tesztkészlet + CI, `release.py` |
| **0.2.0** | `await`-es betöltő, szinkron cache, darabolt telepítés, külön írási modul, `budgetMs`, `commentBox`/`react`, lejátszható (H.264) videók |
| **0.1.0** | Első kiadás: olvasás, komment, csoport, keresés, médialetöltés, írásvédelmi hook |

## Írásvédelem részletei

- **Jóváhagyási token.** A `hooks/fb-approve.mjs` rögzíti a jóváhagyott szöveget és célt. A rögzítést a hook
  engedélyhez köti, és megmutatja a pontos szöveget. Utána a `type` csak erre a szövegre mehet át, bármi
  másra TILTÁS jön. Token nélkül a régi viselkedés marad (rákérdez).
- **Audit napló:** `~/.fb-reader/audit.log` (soronként egy JSON). Tartalmazza a döntéseket (kérdés/tiltás/engedély)
  és a ténylegesen végrehajtott írásokat is. A napló best-effort, a hookot nem blokkolja.
- **Korlát:** a hook a Claude Code eszközhívásait őrzi. Ha valaki a böngészőben kézzel ír, azt nem látja.

## Nyelvi támogatás

A Facebook-felület nyelvfüggő részei (hónapnevek, relatív idők, gombfeliratok, jelvények, számláló-utótagok) **nyelvi csomagokban** vannak (`PACKS` a `fb-reader.js`-ben). Az olvasó az összes csomag unióját használja, ezért nem kell nyelvet felismerni.

| Nyelv | Állapot |
|---|---|
| magyar (`hu`) | élő Facebook-felületen ellenőrzött |
| angol (`en`) | csomag van, valódi felületen még nem ellenőrzött |
| más nyelv | `__fbReader.registerLang({…})` vagy új bejegyzés a `PACKS` táblában; segít a `langProbe()` és a `selfTest()` |

Új nyelv hozzáadása: [`references/i18n.md`](plugins/facebook-reader/skills/facebook-reader/references/i18n.md). Fontos: a plugin *kimeneti üzenetei* (állapotsorok, hook-kérdések) jelenleg magyarul vannak; az üzenet-katalógus a következő lépés.

## Fontos

- **Cookie-t ne vigyél felhőbe.** Ha a session felhős IP-ről jelentkezik, a Facebook biztonsági
  ellenőrzést kér, és zárolhatja a fiókot. A plugin ezért a saját böngésződet vagy a saját gépedet
  használja.
- Az első futtatáskor a szkript a facebook.com `localStorage`-ába és IndexedDB-jébe menti magát
  (`fb-reader:src`/`ver`, az írási modul `wsrc`/`wver`). A következő oldalakon elég a kb. 1,5 KB-os
  betöltő. Törlés DevToolsban: `localStorage.removeItem('fb-reader:src')` és
  `indexedDB.deleteDatabase('fb-reader')`.
- Emberi tempóban dolgozik, kis görgetési adagokban. Arra való, amit amúgy is jogosult vagy látni.
  Mások tartalmának újraközlésénél a szerzői jogok érvényesek.

## Felépítés

```
plugins/facebook-reader/
├── .claude-plugin/plugin.json       # Claude Code / Cowork manifest
├── .codex-plugin/plugin.json        # Codex manifest (selects hooks/codex-hooks.json)
├── extension/                       # opcionális Chrome-bővítmény (generált, build.py)
├── hooks/                           # írásvédelem: fb-write-guard.mjs · fb-approve.mjs · fb-guard-lib.mjs
└── skills/facebook-reader/
    ├── SKILL.md                     # utasítások Claude-nak
    ├── references/                  # api.md · obfuscation.md · media.md · analysis.md
    └── scripts/
        ├── fb-reader.js             # olvasható forrás
        ├── fb-reader-write.js       # írási modul (forrás; a build .min.js-t is készít)
        ├── fb-reader.min.js         # injektálandó, önmagát telepítő build
        ├── fb-reader.loader.js      # mini betöltő minden oldalra
        ├── build.py                 # forrás → min + loader (terser)
        ├── fb_tool.py               # média, to-md, parse-html, clean-url, urls
        └── fb-capture.mjs           # Playwright CLI saját profillal
```

Az alapok két korábbi projektből jönnek: a **facebook-private-group-scraper** (csoportarchiváló)
és a **Shadowcast / fb-ytembed-plugin** (MV3 feed-beágyazó). Ezeket élő, magyar nyelvű Facebookon ellenőriztem és bővítettem.
