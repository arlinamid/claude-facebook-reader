# Változásnapló

A formátum a [Keep a Changelog](https://keepachangelog.com/) szerint, a verziózás SemVer. A kiadást a `release.py` készíti el:
az `[Unreleased]` blokk tartalma kerül az új verzió alá.

## [Unreleased]

## [0.14.0] - 2026-10-26

### Hozzáadva (reel-támogatás — fixture-teszteken ellenőrizve, **élő reel-oldalon még nem**)
- **`activeReel()` / reel-oldal olvasása:** `/reel/<id>` oldalon a `pageInfo().type` mostantól `'reel'` (nem `'video'`); `activeReel()` a több előtöltött szomszédos reel közül a lejátszást / képernyő-középpontot figyelembe véve választja ki az aktívat, sosem egy előtöltött szomszédot. `findPostRoots()`, `extractPost()`, `map()`, `peek()`, `thread()`, `full()`, `where()`, `go()` ezen keresztül mind működik reel-oldalon is, külön kezelés nélkül; az új poszt-mező `kind:'reel'`, és megjelenik a `chapters` (felirat-fejezetek), `hashtags`, `audio` ("Eredeti hang"), `duration` mező is.
- **`reel({budgetMs})`:** mint `extractPost()` az aktív reelen, de előbb kinyitja a "Továbbiak"-ot a feliratban.
- **Reel-kommentpanel:** a komment-oldalpanel (`[role="complementary"]`) felismerése és lapozása (`expandComments()` gombos lapozás-ágra vált reel-oldalon, max. 4 kattintás/hívás, 1,5–2,5 s szünetekkel, `done:false` ha elfogy a kattintás-költségvetés); `thread()` reel-fejléce jelzi a panel és a sáv komment-számának eltérését.
- **Kulcsszó-horgász-felismerés (🎣):** ha a kitűzött komment „írd be X és…” mintára illik és a válaszok ≥60%-a ugyanazt az egy szót ismétli, a `thread()` egy `🎣 kulcsszó-kampány: …` összefoglaló sorba fogja össze őket (a kitűzött kérés és a szerző tipikus válasza látható, az ismétlődő válaszok nem sorolódnak fel egyenként) és kiemeli az ettől eltérő, valódi hozzászólásokat; `thread({bait:false})` a teljes, szűrés nélküli listát adja, `thread({only:'other'})` csak a nem-kulcsszavas hozzászólásokat.
- **`nav.reelNext` / `nav.reelPrev` / `nav.reelComments`:** a következő/előző videó nyilát és a komment-gombot csak megjelölik (`[fbr:…]`), sosem kattintanak rá.
- **`map({background:true})`:** a reel-nézegető mögött betöltve maradt hírfolyam-posztot is listázza (külön jelölve), alapból rejtve marad.
- Új i18n kulcsok (hu+en): `reelNext`, `reelPrev`, `originalAudio`, `baitAsk`, `viewReplies`; `langProbe()` reel-oldalon a hiányzó kulcsot `⚠ reel: …` előtaggal jelzi. `selfTest()` reel-diagnosztika (aktív videó/egység/rail+felirat/számlálók).
- **`fb_tool.py transcribe`:** a videóban lévő szöveg kinyerése — `--subs` (Facebook saját feliratai, yt-dlp), `--speech` (beszédfelismerés `.srt`+`.txt`, faster-whisper), `--ocr N` (N másodpercenkénti képkocka + OCR, ffmpeg+tesseract, `ocr.md`); `media --url … --transcribe` egy lépésben letölt és átír. Tesseract/faster-whisper hiányában hibát ír ki és nem áll meg csendben (mint `ensure_playable()`).

## [0.13.3] - 2026-10-25

### Hozzáadva (élő használati visszajelzés alapján: képletöltés, fénykép-nézegető — **még nem élőben tesztelve**, első valódi használatkor ellenőrizendő)
- **`downloadImages({post, rows, dest, limit, budgetMs})`:** eddig a `download()` csak a signed URL-eket mentette JSON-ba, a tényleges képfájlt a felhasználó gépén futó `fb_tool.py`-nak kellett letöltenie. Most a böngésző maga is tud valódi fájlt menteni: a kép bájtjait a lap saját kontextusában olvassa (`fetch` → `Blob` → `<a download>`, ugyanaz a trükk, mint a `download()`-ban), így a signed fbcdn URL sosem kerül vissza szövegként a chatbe, és a „[BLOCKED: Cookie/query string data]” szűrő nem tudja elkapni. `dest:'view'` nem is fetchel (egy `<img src>` sosem igényel CORS-t), csak megjeleníti a képet a `__fbReader` overlay-ben — a Claude ekkor `screenshot`/`zoom`-mal tényleg megnézheti a fotót, fájl nélkül. **Kockázat:** a `dest:'downloads'` fetch-je CORS-t igényel az fbcdn-től; ha egy host blokkolja, a hiba jelentve van (fájlnévvel), sosem hallgatva el, és a hibaüzenet a bevált `fb_tool.py` / `mediaList()+download()` útra irányít.
- **`photoSet({limit, budgetMs, download, dest})`:** a `/photo/?fbid=…&set=pcb.…` nézegetőben a "Következő fénykép" gombon végiglépked, begyűjti a setet (max `limit` elem), és **külön jelzi, ha a setben videó/reel van** (ezeknek nincs letölthető kép-src, csak saját link, amit a `fb_tool.py media --url …`-nak kell átadni) — eddig csak a rácsnézet (`extractMediaGrid`) volt kezelve, a nézegető nem. `download:true` esetén a begyűjtött képeket egyben leküldi `downloadImages()`-nek; a `postOf`-nak megfelelő `nav.photoPost()` már eddig is létezett, csak nem volt eléggé látható — innen is hivatkozva.
- **„+N” rejtett kép a rácsban:** egy 4-nél több fotós rács utolsó csempéjén lévő „+N” felirat mögötti képeknek nincs `<img>`-jük, ezért a `📷`-szám (`map()`, `flagsOf`) eddig alulszámolt; most a csempe feliratát is beleszámítja (`peek()` ⚠-vel jelzi, hogy ez becslés).

## [0.13.2] - 2026-10-24

### Javítva (élő teszt: J&A AI Imaging profil, azonos kezdetű posztok)
- **Fő hiba — horgony-ütközés azonos kezdetű posztoknál:** a `map()` horgonya eddig tisztán tartalom-hash (szerző + szöveg első 60 karaktere) volt, ütközésnél egy renderelési-sorrendtől függő futó számlálóval megkülönböztetve. Emiatt ugyanaz a poszt más horgonyt kapott a hírfolyamban és a permalinkoldalon, és a horgony két oldalbetöltés között sem volt garantáltan stabil. Mostantól a horgony elsődlegesen a poszt saját `postId`-jéből (pfbid / numerikus) képződik — ez minden nézetben (hírfolyam, overlay, permalink, harvest tár) ugyanaz —, `postId` nélkül a tartalom-hash másodlagosan a stabil `aria-posinset` pozícióval, végső tartalékként a régi számlálóval különbözteti meg az ütköző posztokat; `map()` fejléce jelzi, ha ütköző, nem garantáltan stabil horgony maradt (`⚠ N poszt azonos kezdettel`).
- **`resolveLive()`:** a `#horgony`-val hivatkozott, de a DOM-ból kigörgetett (csak a harvest tárban élő) posztot most már `expandComments`, `setCommentSort`, `extractPinnedComments`, `extractPrompt` és `hoverDates` is vissza tudja görgetni a nézetbe, mielőtt dolgozna vele (eddig csak `go()`/`peek()`/`thread()`/`full()` tudta ezt).
- **`expandComments` `modal-mismatch`:** a frissen megnyílt overlay szövege/postId-ja néha még nem töltődött be a végleges-poszt-összevetés pillanatában, ami hamis egyezés-hibát adott; most néhányszor újrapróbálja, mielőtt eltérést jelentene.
- **Komment-dátum ellentmondás:** a posztnál már létező `⚠korábbi, mint a poszt` jelzés mostantól a `thread()` és `peek()` komment-soraiban is megjelenik (a felismerés maga már korábban is működött, csak nem volt látható).
- **`where()` téves oldalcímke:** a láthatatlan, csak képernyőolvasóknak szóló `<h1>` elemek (pl. egy rejtett „Értesítések” címke) eddig felülírhatták a tényleges oldalcímet; most csak ténylegesen látható `<h1>` számít.
- **`listing()` ár-összefolyás:** egyetlen hirdetés-oldalon az aktuális és a régi (áthúzott) ár néha elválasztás nélkül egy "sorban" jelent meg (`25 000 Ft250 000 Ft`); most szétválasztva, `(volt …)` formában jelenik meg, ahogy a `market()` listasorban is.
- **`localStorage` tartósság:** az olvasási lista (`markSeen`) és a hirdetés-követés (`trkSave`) mostantól írás után visszaolvassa a kulcsot, és ha a böngésző mégis elveszítené, `sessionStorage`-ra esik vissza ahelyett, hogy csendben adatot vesztene; `selfTest()` jelzi, ha a `localStorage` nem tartós az adott oldalon, és azt is, ha ütköző (nem garantáltan stabil) tartalomkulcsú posztot talál.

## [0.13.1] - 2026-10-24

### Javítva (élő Marketplace-teszt, 1TB NVMe SSD)
- **`market()` fejléc/JSON `sort` és `place` az igazi oldalon `null` volt:** a rendezés gombja csak „Rendezés:”-t mutat, az érték a mellette lévő rejtett lista bejelölt rádiógombja; a helyszín gombjának szövege „Város · N km-en belül”, a „Helyszín: …” alak az aria-labelben van. Mindkettőt olvassa; a címkézett (`[fbr:…]`) gomb eredeti felirata sem szivárog ki.
- **`marketControl('location')` az igazi oldalon „nincs” volt:** a név az aria-labelben van; most a szöveg és az (eredeti) aria-label alapján is keres, és másodszori hívásra is megtalálja a már megjelölt vezérlőt.
- A teszt-fixture az igazi DOM-ot követi (külön tesztek: bejelölt rádió → `sort`, aria-label → `place`, címke szivárgás nélkül).


## [0.13.0] - 2026-10-24

### Hozzáadva (Codex Marketplace-review alapján)
- **`ready({budgetMs, format})`**: az oldal tartalmának tényleges megjelenéséig vár (hirdetés: cím + ár; találati lista: ≥1 kártya vagy üres-lista szöveg; hírfolyam: ≥1 poszt; értesítés/üzenet lista), és kimondja, mi hiányzik; a csak címet tartalmazó oldalt nem tekinti késznek. Navigáció után, olvasás előtt kell futtatni (a „túl korai olvasás”, üres szövegválasz ellen). A hook olvasó-hívásként engedi.
- **Egységes JSON-rekord a Marketplace-hez:** `market({format:'json'})` (hirdetésenként azonos mezők, teljes URL, keresés/rendezés/hely, lapozás, kihagyott szponzoráltak), `listing('$ref'|undefined, {format:'json'})`, `marketScroll({format:'json'})` (`loaded`, `added`, `newRefs`, `done`); a szöveges `marketScroll` is kiírja: `+N új`.
- Dokumentáció: tesztprotokoll új hoszthoz (`agents.md`: status → ready → market → listing → marketScroll → marketControl, és mit kell rögzíteni); hibaelhárítás a Codex Browser Use `Raw CDP is unavailable while Browser Use is resolving a paused document response` hibájához (a host hibája, nem a Readeré) és a túl korai olvasáshoz.

## [0.12.1] - 2026-10-24

### Javítva (a Codex élő használatból származó review alapján)
- **Dátum:** a közelítő dátum (relatív: „3 hét”, vagy óra nélküli: „okt. 3.”) már nem jelenik meg kitalált időponttal (`~2026-10-03 14:00`), hanem dátumként és az eredeti címkével: `~2026-10-03 (3 hét)`; csak az egy napnál frissebb marad óra:perc pontossággal. Az időpontok helyi időben vannak (eddig `q()` UTC-ben írt). **Dátum-ellentmondás:** ha egy komment korábbi a posztnál (a dátumok pontosságán túl), `dateConflict: true` és ` ⚠korábbi, mint a poszt` jelzés (`extract`, `q`, `thread`).
- **Linkvesztés:** `go()` a teljes linket adja (eddig 90 karakterre vágta); `q()` sorformában megtartja az azonosító query-paramétereket (`/photo?fbid=…` a puszta `/photo` helyett); `q({format:'json'})` teljes, abszolút URL-eket ad.
- **`extractPrompt`:** `chars` (alap 2000, `0` = a maradék) és `offset` lapozás; `promptChars`, `truncated`, `nextOffset` a válaszban; a markdown-export jelzi a csonkolást.
- **Gyenge alt-szöveg:** a Facebook automatikus „szöveg” / „Lehet, hogy ez szöveg” leírásai `altWeak`-nek jelölve (`extract`, `q` alt mező, `peek`: „⚠alt nem leíró: a képet nézd meg”, `extractPrompt.imageAltWeak`).

### Változott
- `q({format:'json'})` egységes objektumot ad (`what, total, offset, count, rows`), korábban csak a sorok tömbjét.

## [0.12.0] - 2026-10-24

### Hozzáadva
- **Codex-támogatás ugyanabból a plugin-mappából** (nincs másolat): `.codex-plugin/plugin.json`, gyökér `.agents/plugins/marketplace.json` (`codex plugin marketplace add arlinamid/claude-facebook-reader`, `codex plugin add facebook-reader@arlinamid-plugins`). A Codex alapból a `hooks/hooks.json`-t (a Claude-os őrt) töltené be, amelynek `ask` válaszát a Codex nem támogatja (a hook hibásnak számít, az eszközhívás megy tovább), ezért a manifest a `hooks/codex-hooks.json`-t választja: `fb-codex-guard.mjs`, vékony adapter a közös `fb-write-guard.mjs` fölött (`ask`/`deny` → Codex `deny`, a Claude jóváhagyási tokenek és az önértesítés nem érvényesek, munkamenetenként külön állapot). **Codexben csak olvasás.** Szimulált hook-eseményekkel tesztelve, élő Codex for Chrome-mal még nem.
- `references/agents.md`: böngésző-adapterek (Codex for Chrome: `expression`, Claude: `text`), natív Codex-plugin, skill-only használat, CLI-tartalék.
- `tests/test_codex_hooks.py` (a fő tesztkészlet része): olvasó-kifejezések átengedése, írás/kattintás/feltöltés/Enter tiltása, ismeretlen fül, munkamenet-izoláció, batch, Claude-tokenek kizárása, manifest- és marketplace-egyezés, egyetlen közös őr.
- `.gitattributes` (`* text=auto eol=lf`), a CI-munkafolyamat a gyökér `.github/workflows/test.yml`-ben.

### Javítva
- **Hook: az olvasó-csomag felismerése szóközt vagy ékezetet tartalmazó útvonalon** (pl. Windows felhasználónév szóközzel): a hook a plugin saját `fb-reader*.js` fájljait `URL.pathname`-ből olvasta (százalékkódolt), így ilyen útvonalon nem ismerte fel, és minden betöltésnél rákérdezett. Mostantól `fileURLToPath`.
- `release.py` a Codex-manifest verzióját is lépteti.

## [0.11.0] - 2026-10-24

### Hozzáadva
- **Nyelvi csomagok (többnyelvű kiadás előkészítése):** a Facebook-felület nyelvfüggő szavai (hónapnevek, relatív idők, számláló-utótagok, reakciónevek, gombfeliratok, jelvények, rendezés-menü, hirdetés/ellenőrzött jelzés, kommentcímke-minták, a kattintás-védelem közzétételi szavai) a `fb-reader.js` elején lévő `PACKS` táblába kerültek (`hu` ellenőrzött, `en`). Az olvasó az összes csomag unióját használja. Új API: `lang()`, `registerLang(pack)` (érvényesíti a csomagot; `r.publish` nélkül elutasítja), `langProbe()` (mit nem ért meg az oldal nyelvéből). A `selfTest()` figyelmeztet, ha az oldal nyelvéhez nincs vagy nincs ellenőrizve csomag. Új útmutató: `references/i18n.md` (formátum, nyelv hozzáadása, mi van még a csomagokon kívül).
- Általánosabb dátum-felismerés: évvel kezdődő, hónappal kezdődő és napokkal kezdődő alakok bármely regisztrált nyelven; „vor 3 Stunden”-szerű előtag-szavak; az idő a dátum előtt is érthető („10:15 du. okt. 3.”).
- **Adatvédelmi ellenőrző** (`tests/privacy_scan.py`): e-mail, abszolút felhasználói útvonal, valódi-formájú azonosító, Facebook-slug, süti/token keresése a repóban; opcionális helyi tiltólista (`--deny`). A tesztkészlet és a CI futtatja.
- Angol `README.md`; a magyar `README.hu.md` néven megmaradt.

### Változott
- A tesztek fixture-jeiből és a dokumentációból minden valódi név, azonosító, csoportnév, helyszín és útvonal kitalált mintaadatra cserélve; a licenc és a csomag-metaadatok szerzője a GitHub-azonosító (`arlinamid`).

## [0.10.0] - 2026-10-24

### Hozzáadva
- **Értesítés- és Messenger-figyelés a Chrome-bővítményben (opcionális, alapból KI):** a felugró ablakban külön kapcsolható 🔔 és ✉. A háttér a facebook.com fejlécének olvasatlan-számlálóit nézi (új `watchPeek()`), és növekedésnél böngészőértesítést és jelvényt ad; az első mérés alapszint. Nyitott Facebook-lapot használ (nincs extra kérés), ennek híján legfeljebb 15–120 percenként (alap 30, ±25%) nyit egy háttérlapot a főoldalra. Csak számokat kezel: nem nyit meg Messenger-szálat (nincs „Látta” jelzés), nem tölti be az Értesítések oldalt (nem nullázza a harang számát), szöveget nem olvas és nem tárol. Csendes órák 22–8, napi korlát, belépési/ellenőrzési oldalon magától kikapcsol; a bekapcsolás új alapmérést indít. Az értesítésre kattintva az Értesítések / Üzenetek oldal nyílik meg.

### Változott
- `inbox()` a számláló-olvasást közös `inboxCounts()`-ból végzi (viselkedés változatlan).

## [0.9.0] - 2026-10-24

### Hozzáadva
- **Eladás (Marketplace és csoport), jóváhagyási protokollal:**
  - `sellCheck()` / `sellForm()` (író modul): a megnyitott hirdetésfeladó űrlap (Marketplace-oldal vagy a csoport „Eladó tárgy” ablaka) értékeinek olvasása (megnevezés, ár, kategória, állapot, leírás, fotók száma, kapcsolók, a közzététel helyei), a vezérlők megjelölése (`[fbr:sell-…]`), hiányzó kötelező mezők és figyelmeztetések; nem kattint és nem gépel.
  - `sellReport()`: magyar előnézet a jóváhagyáshoz (hova, kinek a nevében, mezők, fotók, ellenőrzőlista).
  - `fb-approve.mjs --kind listing`: **egyetlen jóváhagyás a teljes hirdetésre** (cím, ár, leírás, fotók útvonala, kategória/állapot). A hook csak pontosan ezeket engedi: a szöveget mezőnként betűre, csak a jóváhagyott fotókat, csak a jóváhagyott legördülő-értékeket; a „Tovább” lépés a teljes tartalom beírása után kérdés nélkül megy; a **közzététel mindig külön kérdez** (a „Tovább és közzététel” megfogalmazás sem megy át). Más oldalon, más szöveggel tiltva/kérdez.
  - `nav.marketplaceCreate()`, `nav.marketplaceSelling()`.
- **Követés (csak olvasás):** `trackAdd`, `trackList`, `trackRemove`, `trackCheck` (ár, állapot-szó, számlálók, reakció/komment/megosztás, új kommentek, ❓ érdeklődés-jelzés; `format:'object'`), `myListings({track})`, `priceCheck({price})` (kvartilisek és a saját ár helye). A lista a böngészőprofil `localStorage`-ában él.
- **Chrome-bővítmény követés-segítő:** `bridge.js` (a követett lista átmásolása a bővítmény tárába), `background.js` (**opcionális, alapból kikapcsolt** háttérellenőrzés: ~20 percenként legfeljebb egy esedékes hirdetés háttérlapon, csendes órák 22–8, napi korlát, belépési/ellenőrzési oldalra irányításnál leáll, értesítés és jelvény változáskor), `popup.html` (kapcsoló, gyakoriság, lista). Új engedélyek: `storage`, `alarms`, `notifications`, `scripting`, `tabs`, `https://www.facebook.com/*`.
- A hook SAFE_API listája bővült az új olvasó/jelölő hívásokkal; tesztek: űrlap-fixture-ök, követés, a service worker egy valódi (helyi HTTPS) „facebook.com”-mal, a felugró ablak, a listing-jóváhagyás hookja.

### Javítva
- `listing()`: az ár a cím utáni 8 sor között keresett (egy „Eladva” jelzés már nem tolja el).

## [0.8.0] - 2026-10-24

### Hozzáadva
- **Marketplace keresés (csak olvasás):**
  - `nav.marketplace({q, min, max, sort, days, condition, delivery, exact, location})`: szűrők URL-paraméterként (élőben ellenőrizve, a `sortBy=distance_ascend` is); ismeretlen érték hibát dob. A `nav.search(q,'marketplace')` ezt használja.
  - `market()`: tömör találati lista (`$ref ár (volt régi) cím · hely ⟨jelzés⟩`), azonosító szerinti duplikátum-szűréssel; a szponzorált („Partneri hirdetés”) kártyák alapból kimaradnak; helyi szűrők (`q` ékezetfüggetlen, `min`, `max`, `free`, `by:'price'`).
  - `marketScroll()`: a virtualizált rács betöltése (≤4 lépés/hívás), a tár megőrzi a korábbi sorokat.
  - `listing()`: hirdetés-oldal értelmezése (cím, ár, kor, hely, átvétel, részletek, leírás, eladó neve és csatlakozási éve, képek száma); a hirdetések és a kapcsolódó kártyák kimaradnak. `listing('$ref')` csak a címet adja, nem navigál.
  - `marketControl(name)` (író modul): helyszín/rendezés/szállítás/állapot/dátum/elérhetőség/eladó-típus szűrők, valamint az **Üzenet** (eladónak írás) és **Értesítést kérek** gombok megkeresése és jelölése, `write:true` jelzéssel; sosem kattint.
  - A hook SAFE_API listája bővült (`market`, `marketScroll`, `listing`, `marketControl`). Az eladónak írás és a keresési értesítés mentése változatlanul az írási protokollon (jóváhagyás) megy át.

## [0.7.2] - 2026-10-24

### Javítva (élő használat: az önértesítés feleslegesen kérdezett)
- **A mezőre kattintás kérdést váltott ki:** a kattintás leírása („Focuses the message box…”) a hook írás-szavai között szereplő „message” szót tartalmazta. Mostantól friss önértesítés-jóváhagyás mellett, a regisztrált szálon, még be nem írt szövegnél a fókusz-kattintás kérdés nélkül megy. Küldés-, Tetszik-, csatolás-szerű leírás, más szál vagy már megkezdett beírás továbbra is kérdez.
- Dokumentáció: a `--self-notify` parancsot önálló Bash-hívásként kell futtatni (láncolva vagy a fájl létrehozásával együtt nem ismeri fel, ezért rákérdez), a szöveges fájlt előbb a Write eszközzel kell megírni; hibaelhárítási sor az audit naplóval.

## [0.7.1] - 2026-10-24

### Hozzáadva
- `selfThread()`: ha a megnyitott szál paneljének profil-linkje a bejelentkezett fiók azonosítójára mutat, „BIZONYÍTOTT saját szál”-ként jelzi (név nélküli bizonyíték, élő Facebookon ellenőrizve); a névegyezés továbbra is csak jelölt.

## [0.7.0] - 2026-10-24

### Hozzáadva
- **Önértesítés: üzenet a saját Messenger-szálra, kérdés nélkül** (pl. „a feladat kész"). Kivétel az üzenetenkénti jóváhagyás alól, de szűken és a **fiókhoz kötve, nem névhez**:
  - `me()`: a bejelentkezett fiók azonosítója és neve a Facebook saját oldaladatából (`CurrentUserInitialData`), beégetett név nélkül; ezért a plugin megosztható, mindenki a saját fiókjával működik.
  - `selfThread()`: a saját szál jelöltjei (1:1 szál, amelynek neve megegyezik a fiók nevével, és/vagy a megnyitott szál). A névegyezés csak javaslat.
  - `fb-approve.mjs --register-self --url <saját szál> --account <id>`: **egyszer** rákérdez a felhasználóra, majd a `~/.fb-reader/self.json` fájlba menti a fiók azonosítóját és az egyetlen szál címét (alapértelmezett hossz-határ 500 karakter).
  - `fb-approve.mjs --self-notify --account <id> --text-file <fájl>`: kérdés nélkül lefut, de csak regisztrált szálra, egyező fiókkal, egysoros szöveggel a határon belül; ellenkező esetben hibát ad, és naplóz. A hook csak a pontos parancsalakot engedi át, láncolt vagy inline `--text`-es változatot nem.
  - A hook ekkor a jóváhagyott szöveg beírása után **egyszer** engedi az Entert vagy a küldés-kattintást, kizárólag a regisztrált szálon; a második küldés, a „Tetszik/emoji/matrica/GIF" kattintás, más szál és más szöveg továbbra is kérdez vagy tilt. `--unregister-self` visszavonja; a `self.json` kézi módosítása kérdést vált ki.
- Teszt: 25 új ellenőrzés (regisztráció, fiók-eltérés, hosszhatár, újsor, láncolt parancs, egyszeri küldés, másik szál, visszavonás).

### Javítva (élő használat, Messenger, saját szál)
- **Üres címzett-név:** a saját szál üzenetmezőjének felirata „Írás nekik:" név nélkül; a kód ezt „:" nevű címzettnek olvasta és hamis néveltérést jelzett (`composeCheck`, `msgThread`). Mostantól a szál fejlécéből veszi a nevet.

## [0.6.0] - 2026-10-24

### Hozzáadva
- **Értesítések és üzenetek (Messenger), csak olvasás, csak kérésre:** nincs időzítés és nincs háttérfigyelés, minden hívás a felhasználó kérésére fut.
  - `inbox()`: harang- és Messenger-számláló egy sorban (a banner feliratából és a lapcímből).
  - `notifs({unread, kind, match, limit, offset})`: értesítések 1 sorban (`@ref`, kor, fajta, `★` = a te bejegyzésedhez: reakció, komment, említés, címke, megosztás); a `kind` a `notif_t` típusból jön, szövegből tartalék. `notif('@ref')`: részletek és a tisztított cél-link (olvasottnak nem jelöl).
  - `msgs({unread, q, group, limit, offset})`: beszélgetések (`^ref`, 👥 csoport, 🔒 végpontig titkosított, `•` olvasatlan), helyi keresés névben és előnézetben. `msgOpen('^ref')` csak az URL-t adja és **figyelmeztet**: olvasatlan szál megnyitása olvasottnak jelöli, a másik fél „Látta" jelzést kap (E2EE-nél is). `msgThread({last})`: a már megnyitott szál utolsó üzenetei (feladó, idő, szöveg).
  - Keresők és gombok keresése, kattintás nélkül: `msgSearch()` (Messenger kereső), `msgRequests()` (Üzenetkérések), `threadActions()` (elfogadás / elutasítás, találgatott felirattal), `notifMore()` („Korábbi értesítések megjelenítése").
  - `nav.notifications()`, `nav.messages()`, `nav.messenger()`, `nav.thread(id, {e2ee, host})`; a `pageInfo()` és a `where()` ismeri az értesítés- és üzenet-oldalakat.
- **Üzenetküldés a védelmi protokollal:** a `composeCheck()` / `composeReport()` üzenetnél „Címzett" sort ad (név a doboz „Írás nekik: …" feliratából és a szál fejlécéből, csoport, E2EE, gazdagép). Figyelmeztet, ha a név nem azonosítható, ha a doboz és a fejléc neve eltér, és mindig, ha csoportos chat („a küldés MINDEN tagnak megy"). Messengerben az Enter küld, ezért a hiányzó küldés gomb itt nem hiba (`sendHint`).
- **messenger.com:** a bővítmény és a hook is kezeli (a hook `FB_RE`-je eddig is tartalmazta). A Meta bejelentése szerint a különálló messenger.com 2026 áprilisától a facebook.com/messages oldalra irányít át, ezért az API ugyanaz marad és a facebook.com/messages az elsődleges út.
- Védelmi hook: az új olvasó hívások (`inbox`, `notifs`, `notif`, `msgs`, `msgOpen`, `msgThread`, `msgSearch`, `msgRequests`, `threadActions`, `notifMore`) átmennek; gépelés (a Messenger kereső mezőjébe is) és Enter továbbra is kérdez, és a facebook.com-ra szóló jóváhagyás nem érvényes a messenger.com-on.
- Tesztek: `tests/pages/notifications.html`, `tests/pages/messages.html` és új „inbox" szakasz (értesítés-duplikáció, rejtett panel, olvasatlan szűrés, kind, ékezetmentes keresés, csoport/E2EE jelölés, szálolvasás, címzett-ellenőrzés, hook messenger.com).

### Ellenőrizetlen az élő oldalon (jelezve a dokumentációban)
- Az „Üzenetkérések" menüpont útvonala, az elfogadás/elutasítás gombok feliratai és Messenger küldés gombja: a címkék találgatottak.
- A harang számlálója az élő bannerben; ha nem látszik, a lapcím `(N)` és az Értesítések oldal „Olvasatlan" szűrője pontos.

## [0.5.2] - 2026-10-24

### Javítva (élő teszt Claude in Chrome-mal, Facebook Csoportok poszt-overlay)
- **`setCommentSort` / `expandComments` sosem találta a rendezés-választót:** a Facebook valódi feliratai „A legrelevánsabbak" / „A legújabbak" / „Az összes hozzászólás" (többes szám, névelővel); a minta csak az egyes számú alakot ismerte. Ez volt a „rendezés magától visszaáll" jelenség oka.
- **Küldés gomb:** a „Hozzászólás matricával" / „… GIF-fel" gombot találgatásként küldésnek vette, mert a tiltó minta ragozatlan szótöveket várt („matrica" ≠ „matricával"). Szótövek kerültek be, és a felirat nélküli ikon az egyetlen megengedett tipp. Ha nincs küldő nyíl (üres doboz), a `publishButton` üres és figyelmeztetés jön.
- **Rejtett panel „overlay":** a rejtett „Értesítések" panel `role=dialog` volt, ezért a `where()` „overlay nyitva"-t írt, és a poszt-keresés a hírfolyam posztjai helyett ezt kezelte overlaynek. Csak látható dialógus számít.
- **Horgony változik a szöveg késői betöltődésekor:** ugyanaz a DOM-elem megtartja a horgonyát, ha a kulcsa csak bővül (`#gekm` → `#s5mi` korábban). Az overlayben megnyitott poszt más horgonyt kap (a dialógus címe más szerzőt mutat); az újat a `where()` adja.
- **`thread()` a hírfolyamban:** ha a posztnál nincs komment-lista, már nem „valószínűleg törölt/rejtett" a hiba, hanem azt mondja, hogy nyisd meg a posztot (`commentBox` → `openWith`).
- Dokumentáció: a `c`-számok az `expandComments` után eltolódnak (válaszok kerülnek közéjük): válaszdoboznál névvel vagy friss `thread()` után használd őket.

## [0.5.1] - 2026-10-24

### Hozzáadva
- **`replyBox(post, 'c3', {mark})`:** egy adott komment válaszdobozát keresi meg (`c`-szám a `thread()`-ből, szerzőnév vagy szövegrészlet is jó). Zárt doboznál a komment saját „Válasz" gombját adja (`[fbr:reply-c3]`), nyitottnál a dobozt (`[fbr:reply-box]`) a ténylegesen megszólított szerzővel. Más komment dobozát soha nem adja vissza.

### Javítva (élő Claude in Chrome használat visszajelzése #2)
- **`composeCheck().replyTo`:** a doboz elején lévő említésből (a Facebook oda írja a megszólított nevét) olvassa ki a célt, `c`-számmal és szövegrészlettel; említés híján a fölötte álló komment, figyelmeztetéssel. A párbeszédablak fő „Hozzászólás írása" mezője nem válasz: címzett nélkül marad.
- **Csatolmányok és küldés gomb:** csak a szerkesztő saját keretében keres (korábban az egész dialógusban: „Csatolmányok (7)", és a fő mező „Hozzászólás írása" feliratát találta küldés gombnak). A felirat nélküli ikonos nyilat `guessed:true` jelzéssel adja.
- **`warnings[]`:** a `composeCheck` és a `composeReport` felsorolja, ami közzététel előtt tisztázandó (ismeretlen címzett, említés ≠ a doboz helye, hiányzó vagy találgatott küldés gomb, ismeretlen identitás).
- A védelmi hook engedélylistája ismeri a `replyBox`, `setCommentSort` és az olvasási szintek hívásait.

## [0.5.0] - 2026-10-24

### Javítva (élő Claude in Chrome használat visszajelzése)
- **`expandComments` rossz posztot nyitott meg:** nem ismerte a `post` opciót, ezért a hírfolyam minden posztján kattintott. Mostantól `post:'#horgony'` (alapból a megnyitott overlay, ennek híján a nézet közepén lévő poszt; `'all'` a régi viselkedés). Ismeretlen poszt hiba, és ha a kattintás másik poszt overlay-ét nyitja meg, `modal-mismatch` hibával megáll. A rendezés-választó (`aria-haspopup`) többé nem számít „több komment" gombnak.
- **Eltűnő poszt `hoverDates` után:** a `hoverDates` visszaállítja a görgetési pozíciót, és minden érintett posztot beír a `harvest.store`-ba (a `map` ↑ jellel mutatja). `peek`, `thread`, `full`, `go` a DOM-ból kikerült posztot magától visszagörgeti (az `aria-posinset` alapján becsült távolsággal). Új: `hoverDates({post})`.
- **`go()` fotó-linket adott:** a valódi permalinket (fókusz-hover) felfedi, és csak utána jelenti. Fotóoldalon `nav.photoPost()` adja a „Bejegyzés megtekintése" linket, a `where()` és a hibaüzenet is utal rá.
- **Félrevezető kommentszám:** ha az `expandComments` nem talált több gombot, de a számláló nagyobb, a `thread` ezt írja: „N hiányzik: valószínűleg törölt/rejtett/szűrt". Új: `setCommentSort('all'|'newest'|'relevant', {post})`, az `expandComments` alapból „Összes hozzászólás"-ra vált.
- **Link-kártya domainje:** ha a href még a Facebook átirányítója, a kártya saját domain-sora jelenik meg (`🔗github.com`), nem a `facebook.com`.

### Hozzáadva
- `map({date:'MM-DD'})`: a Facebook lefelé kerekíti a relatív időt („4 nap" = 4–5 nap), ezért az időablak alapján szűr; a pontos dátumhoz `hoverDates({post})`.
- Hibaelhárítás: modalban a `get_page_text` hibázik → `full()`/`thread()`; modal-mismatch; fotóoldal; kerekített dátum.

### Módosítva
- **Törő változás:** `peek`, `thread`, `full`, `go` aszinkron (`await` kell). A `map`, `grep`, `where` szinkron maradt.

## [0.4.2] - 2026-10-24

### Módosítva
- **Ikon:** a lencse mögé egy „f" betű került (saját, lekerekített vonalvégű forma, világos kékeszöld árnyalatban), a háttér változatlan. A kis méretű változat is tartalmazza.

## [0.4.1] - 2026-10-24

### Hozzáadva
- **Ikonok:** eredeti arculat (borostyán olvasólencse a szétszórt jelek fölött, benne rendezett szövegsorok). `.claude-plugin/icon.png` (1024 px) a bővítménylistához, `extension/icons/` 16/32/48/128 px a Chrome-bővítményhez (a kis méretek egyszerűsített rajzból). Forrás és generátor: `assets/` (`make_icons.py`).

## [0.4.0] - 2026-10-24

### Hozzáadva
- **Olvasási szintek** (token-takarékos olvasás horgonyokkal): `where()`, `map()` (1 sor / poszt, ~25 token), `peek()` (~120 token), `thread()` (komment-vázlat szűrőkkel), `full()` (egy elem teljes szövege, lapozva), `grep()` (találat-kivonat `#horgony` / `#horgony/c3` jelöléssel), `go()`, `forgetSeen()`. Minden kimenet ≤ 900 karakter, `~Ntok` becsléssel és a következő hívás megnevezésével.
- **Horgonyok:** a poszt tartalom-hash azonosítót kap (`#a3f9`), amely görgetés, újrarenderelés és `hoverDates()` után is ugyanaz; a `resolvePost` (és így `react`, `extractPinnedComments`, `commentBox`, `snapshot`) elfogadja.
- **Olvasott-jelölés:** `peek/thread/full` után a poszt „olvasott" (`•` jelzi az újat), így `map({unseen:true})` csak a nem látott posztokat adja. Hirdetések kimaradnak és meg vannak számolva.
- Teszt: 40 posztos hírfolyam nyers szövege ~9500 token, a `map()` első oldala ~280.

### Módosítva
- **SKILL.md** 269 → ~180 sor: a receptek és a hibaelhárítás a `references/recipes.md` és `references/troubleshooting.md` fájlba költöztek, az első út az olvasási szintek.

## [0.3.0] - 2026-10-24

### Hozzáadva
- **Chrome-bővítmény** (`plugins/facebook-reader/extension/`): minden facebook.com oldalon betölti a `__fbReader` objektumot, nincs szükség beillesztésre és betöltőre. A betöltő felismeri, ha a bővítmény aktív.
- **Célelem-jelölés:** a `react`, `commentBox` és `composeCheck` az `aria-label` végére `[fbr:…]` címkét tesz, így `find` → `ref` → kattintás koordináta-átszámolás nélkül megy. `untag()` állítja vissza.
- **Jóváhagyási token** (`hooks/fb-approve.mjs`): a hook csak a jóváhagyott szöveget engedi beírni, bármi mást TILT. Az approval rögzítését a hook megerősítéshez köti.
- **Audit napló:** `~/.fb-reader/audit.log` (döntések és végrehajtott írások).
- **`selfTest()`:** megmutatja, mely DOM-horgonyok adnak 0 találatot. **`snapshot()`:** anonimizált DOM-minta a tesztkészlethez.
- **`q()`:** tömör, soronkénti lekérdezés a ~1000 karakteres kimeneti korláthoz.
- **Tesztkészlet** (`tests/run_tests.py`, szintetikus oldalakon) és GitHub Actions CI.
- `release.py` kiadási segéd, LICENSE.

### Javítva
- `hoverDates()` fókuszálással felfedi a valódi permalinket; ha nem sikerül, a poszt URL-je a fotólink.
- A „– szerző” jelvény már nem kerül a kommentszöveg elejére.
- `react`/`reactionState`: a valódi „Tetszik” gombot találja meg (a `like_button` jelölő üres div).
- A koordináták mellett `vw`/`vh` is van (a képernyőkép kicsinyítve érkezik).

## [0.2.0] - 2026-10-23

### Hozzáadva
- `await`-tel induló betöltő, szimmetrikus localStorage ↔ IndexedDB szinkron, darabolt telepítés, külön írási modul.
- `budgetMs` időkeret az aszinkron hívásokon, aláírt CDN-URL-ek kiszűrése a kimenetből, `id`/`slug` a keresési találatokban, `nav.page()`.
- `findPost`, `extractPinnedComments`, `extractPrompt`, `promptsToMarkdown`, `commentBox`, `react`, `reactionState`.
- Lejátszható videók: H.264 előnyben, AV1 automatikus átkódolása.

## [0.1.0] - 2026-10-23
- Első kiadás: olvasás, komment, csoport, keresés, médialetöltés, írásvédelmi hook.
