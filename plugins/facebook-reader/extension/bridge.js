// facebook-reader – híd (ISOLATED világ): a követett hirdetések listáját (a Facebook-oldal localStorage-ában,
// 'fb-reader:track') átmásolja a bővítmény tárába, hogy a háttérellenőrzés lássa. Csak olvas; az oldalt nem módosítja.
(() => {
  'use strict';
  const KEY = 'fb-reader:track';
  const pick = x => ({ id: x.id, kind: x.kind, url: x.url, title: x.title || null, price: x.price || null, group: x.group || null, checkedAt: x.checkedAt || null, changedAt: x.changedAt || null, sold: x.snap && x.snap.sold || null });
  let last = '';
  const sync = () => {
    let list = [];
    try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(a)) list = a.filter(x => x && x.id && /^https:\/\//.test(x.url || '')).map(pick); } catch (e) { return; }
    const s = JSON.stringify(list);
    if (s === last) return;
    last = s;
    try { chrome.runtime.sendMessage({ type: 'track-sync', list }).catch(() => {}); } catch (e) { /* a bővítmény újratöltődött */ }
  };
  sync();
  setInterval(sync, 15000);
})();
