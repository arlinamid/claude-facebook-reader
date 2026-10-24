# facebook-reader – Chrome-bővítmény (opcionális)

Minden facebook.com oldalbetöltéskor betölti a `window.__fbReader` objektumot (mag + írási modul),
így nem kell kézzel beilleszteni a szkriptet, nincs betöltő és nincs „ELAVULT CACHE”.

**Telepítés (egyszer):**
1. Chrome → `chrome://extensions` → jobb felül *Fejlesztői mód*.
2. *Kicsomagolt bővítmény betöltése* → válaszd ezt a `extension/` mappát.
3. Új szkriptverzió után: a bővítmény kártyáján *Frissítés* (↻), majd töltsd újra a Facebook-lapot.

A bővítmény csak betölti a szkriptet az oldal saját környezetébe (`world: "MAIN"`), hálózati hívást nem
végez, adatot nem gyűjt, és semmit nem küld sehova. Az írási műveletekre a plugin hookja és a jóváhagyási
protokoll továbbra is vonatkozik. Ellenőrzés: `__fbReader.status()` vagy `__fbReader.selfTest()`.

A `scripts/build.py` generálja a `fb-reader.core.js`, `fb-reader.write.js` és `manifest.json` fájlokat (ezeket ne szerkeszd kézzel); a `bridge.js`, `background.js`, `popup.html`, `popup.js` kézzel írt fájlok.

## Követés-segítő (opcionális, alapból KI)

A bővítmény segíti a hirdetések követését: a `bridge.js` a Facebook-oldal tárából (`fb-reader:track`, amit a `trackAdd` tölt) átmásolja a követett hirdetések listáját a bővítmény tárába, a `background.js` pedig – **csak ha a felugró ablakban bekapcsolod** – ~20 percenként legfeljebb egy esedékes hirdetést nyit meg háttérlapon (nem aktív), lefuttatja a `trackCheck()`-et (csak olvasás), bezárja a lapot, és változás esetén (ár, állapot, új komment/érdeklődés) értesít. Csendes órák: 22–8, napi korlát, a gyakoriság 3–24 óra; belépési/ellenőrzési oldalra irányításnál magától kikapcsol. Semmit nem küld, nem ír a Facebookra, az adatok csak ebben a böngészőben vannak.

## Értesítés- és Messenger-figyelés (opcionális, alapból KI)

A felugró ablakban külön kapcsolható: 🔔 új értesítések, ✉ új Messenger-üzenetek. A `background.js` a facebook.com fejlécének **olvasatlan-számlálóit** nézi (`watchPeek()`), és ha a szám nőtt a legutóbbi mérés óta, böngészőértesítést ad és jelvényt tesz az ikonra. Az első mérés csak alapszint (nincs riasztás).

- **Nyitott Facebook-lap esetén** azt olvassa (5 percenként, nincs extra kérés). Ha nincs ilyen, **legfeljebb 15–120 percenként** (alap: 30, ±25% szórással, napi korláttal) nyit egy nem aktív háttérlapot a főoldalra, leolvassa a számlálókat és bezárja.
- **Csak számok.** Nem nyit meg Messenger-szálat (így nincs „Látta" jelzés, a végpontig titkosított szálaknál sem), nem tölti be az Értesítések oldalt (az kinullázná a harang számát), üzenet- és értesítés-szöveget nem olvas, nem tárol és nem mutat. A részletekhez kérdezd Claude-ot („jött értesítés a posztomra?", „van új üzenetem?"), ő a plugin olvasó funkcióival, a te jóváhagyásoddal nézi meg.
- Csendes órák (22–8) alatt nem fut; belépési/ellenőrzési oldalra irányításnál magától kikapcsol, és szól.
- Az értesítésre kattintva a saját böngésződben megnyílik az Értesítések / Üzenetek oldal; ezt te döntöd el.
- Bekapcsoláskor új alapmérés indul, hogy a régi számokra ne kapj riasztást.

Engedélyek: `storage` (lista, beállítás), `alarms` (ütemezés), `notifications` (értesítés), `scripting` + `tabs` + `https://www.facebook.com/*` (a háttérlap megnyitása és a `trackCheck()` lefuttatása).
