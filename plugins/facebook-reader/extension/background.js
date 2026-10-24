// facebook-reader – háttér (service worker): a követett hirdetések OPCIONÁLIS, ritka ellenőrzése. Alapból KI.
// Bekapcsolva ~20 percenként legfeljebb EGY esedékes hirdetést nyit meg háttérlapon (nem aktív), lefuttatja a trackCheck()-et
// (csak olvasás), bezárja a lapot, és ha változás van (ár, állapot, új komment/érdeklődés), értesít. Éjszaka nem fut,
// napi korláttal; belépési/ellenőrzési oldalra irányítás esetén azonnal kikapcsol. Semmit nem küld, nem ír a Facebookra.
// Ugyanígy OPCIONÁLIS (alapból KI) az értesítés- és Messenger-figyelés: a fejléc olvasatlan-számlálóit nézi (🔔 és ✉), és ha
// nőtt, értesít. Ha van nyitott facebook.com lapod, azt olvassa (nincs extra kérés); ha nincs, ritkán (alap: 30 perc, ±25%)
// nyit egy háttérlapot a főoldalra. SOSEM nyit meg Messenger-szálat (nincs „Látta" jelzés) és nem tölti be az Értesítések
// oldalt (az nullázná a harang számát), üzenet- vagy értesítés-szöveget nem olvas és nem tárol, csak számokat.
'use strict';

const DEFAULTS = { enabled: false, intervalHours: 6, quietFrom: 22, quietTo: 8, notify: true, maxPerDay: 12, watchNotifs: false, watchMsgs: false, watchEveryMin: 30, maxWatchPerDay: 24 };
const ALARM = 'fbr-track-tick', WALARM = 'fbr-watch-tick', WATCH_URL = 'https://www.facebook.com/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = async k => (await chrome.storage.local.get(k))[k];
const getSettings = async () => ({ ...DEFAULTS, ...((await store('settings')) || {}) });

function dueItems(list, now, intervalHours) {
  const iv = intervalHours * 3600e3;
  return (list || []).filter(x => x && x.url && (!x.checkedAt || now - x.checkedAt >= iv)).sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0));
}
const inQuiet = (h, from, to) => (from > to ? h >= from || h < to : h >= from && h < to);
function mergeLists(old, incoming) {
  const m = new Map((old || []).map(x => [x.id, x]));
  return (incoming || []).map(x => { const o = m.get(x.id); return o && (o.checkedAt || 0) > (x.checkedAt || 0) ? { ...x, checkedAt: o.checkedAt, changedAt: o.changedAt || x.changedAt } : x; });
}
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function ensureAlarm() {
  const s = await getSettings();
  if (s.enabled) await chrome.alarms.create(ALARM, { delayInMinutes: 5, periodInMinutes: 20 }); else await chrome.alarms.clear(ALARM);
  if (s.watchNotifs || s.watchMsgs) await chrome.alarms.create(WALARM, { delayInMinutes: 1, periodInMinutes: 5 }); else await chrome.alarms.clear(WALARM);
}

async function notify(id, title, message) {
  self.__lastNotify = { id, title, message };
  try { await chrome.notifications.create('fbr:' + id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message }); } catch (e) { /* nincs engedély */ }
}

async function waitComplete(tabId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await chrome.tabs.get(tabId); if (t.status === 'complete' && /^https?:/.test(t.url || '')) return t; await sleep(400); }
  return chrome.tabs.get(tabId);
}
const runCheck = async tabId => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
    try { return window.__fbReader && window.__fbReader.trackCheck ? window.__fbReader.trackCheck({ format: 'object' }) : { ok: false, problem: '__fbReader hiányzik az oldalról' }; } catch (e) { return { ok: false, problem: String(e) }; }
  } });
  return (r && r.result) || { ok: false, problem: 'üres válasz' };
};
async function openAndCheck(item, settleMs = 6500) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: item.url, active: false });
    const t = await waitComplete(tab.id, 35000);
    if (/\/(login|checkpoint|recover)\b/.test(t.url || '')) return { ok: false, stop: true, problem: 'a Facebook belépési/ellenőrzési oldalra irányított: ' + clip(t.url, 60) };
    await sleep(settleMs);
    const attempt = async () => { try { return await runCheck(tab.id); } catch (e) { return { ok: false, retry: true, problem: String((e && e.message) || e) }; } };
    let r = await attempt();
    if (!r.ok && (r.retry || /betölt|olvasható|hiányzik/.test(r.problem || ''))) {
      if (r.retry) { await chrome.tabs.update(tab.id, { url: item.url }); await waitComplete(tab.id, 35000); await sleep(settleMs); } else await sleep(6000);
      r = await attempt();
    }
    return r;
  } catch (e) { return { ok: false, problem: String((e && e.message) || e) }; } finally { if (tab && tab.id != null) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* már zárva */ } } }
}
const describe = r => [...(r.changes || []), (r.fresh || []).length ? `${r.fresh.length} új komment${r.inquiries ? ` (${r.inquiries} érdeklődés)` : ''}` : ''].filter(Boolean).join('; ');

// one pass: the oldest due item (force = the popup's "check one now" button, ignores quiet hours / switch / random skip)
async function tick(force = false, settleMs) {
  const s = await getSettings(), now = Date.now();
  if (!force) {
    if (!s.enabled) return { skipped: 'kikapcsolva' };
    if (inQuiet(new Date().getHours(), s.quietFrom, s.quietTo)) return { skipped: 'csendes órák' };
    const log0 = (await store('log')) || [], day = new Date(); day.setHours(0, 0, 0, 0);
    if (log0.filter(e => e.at >= day.getTime()).length >= s.maxPerDay) return { skipped: 'napi korlát' };
    if (Math.random() < 0.3) return { skipped: 'véletlen kihagyás' };
  }
  const list = (await store('track')) || [], item = dueItems(list, now, force ? 0 : s.intervalHours)[0];
  if (!item) return { skipped: 'nincs esedékes hirdetés' };
  const r = await openAndCheck(item, settleMs);
  const log = (await store('log')) || [];
  log.push({ at: Date.now(), id: item.id, title: clip(item.title, 60), ok: !!r.ok, changed: !!r.changed, text: r.ok ? (r.first ? 'első mérés' : describe(r) || 'nincs változás') : r.problem });
  const mirror = ((await store('track')) || []).map(x => x.id === item.id && r.ok ? { ...x, checkedAt: Date.now(), changedAt: r.changed ? Date.now() : x.changedAt } : x);
  await chrome.storage.local.set({ log: log.slice(-50), track: mirror });
  if (r.stop) { await chrome.storage.local.set({ settings: { ...s, enabled: false } }); await ensureAlarm(); await notify('stop', 'facebook-reader: ellenőrzés leállítva', r.problem); }
  else if (r.ok && r.changed && s.notify) {
    const n = ((await store('unseen')) || 0) + 1; await chrome.storage.local.set({ unseen: n }); await chrome.action.setBadgeText({ text: String(n) });
    await notify(item.id, 'facebook-reader: változás — ' + clip(item.title, 40), clip(describe(r), 160));
  }
  return { checked: item.id, result: r };
}

// ── értesítés- és Messenger-figyelés (csak számlálók) ─────────────────────────
const peekIn = async tabId => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
    try { return window.__fbReader && window.__fbReader.watchPeek ? window.__fbReader.watchPeek() : { ok: false, missing: true, problem: '__fbReader hiányzik az oldalról' }; } catch (e) { return { ok: false, problem: String(e) }; }
  } });
  return (r && r.result) || { ok: false, problem: 'üres válasz' };
};
async function findFbTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
  return tabs.find(t => !t.discarded && t.status === 'complete' && !/\/(login|checkpoint|recover)\b/.test(t.url || ''));
}
async function openAndPeek(settleMs) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: WATCH_URL, active: false });
    const t = await waitComplete(tab.id, 35000);
    if (/\/(login|checkpoint|recover)\b/.test(t.url || '')) return { ok: false, stop: true, problem: 'a Facebook belépési/ellenőrzési oldalra irányított: ' + clip(t.url, 60) };
    await sleep(settleMs);
    let r = await peekIn(tab.id).catch(e => ({ ok: false, problem: String((e && e.message) || e) }));
    if (!r.ok && !r.stop) { await sleep(5000); r = await peekIn(tab.id).catch(e => ({ ok: false, problem: String((e && e.message) || e) })); }
    return r;
  } catch (e) { return { ok: false, problem: String((e && e.message) || e) }; } finally { if (tab && tab.id != null) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* már zárva */ } } }
}
// what changed between two measurements (increase only; the first measurement is a baseline)
function watchDiff(prev, r, s) {
  if (!prev || prev.at == null) return { first: true, n: 0, m: 0 };
  return { first: false, n: s.watchNotifs ? Math.max(0, r.notifs - (prev.notifs || 0)) : 0, m: s.watchMsgs ? Math.max(0, r.msgs - (prev.msgs || 0)) : 0 };
}
// one watch pass (force = the popup's "check now": ignores quiet hours, the switch and the navigation interval)
async function watchTick(force = false, settleMs = 6500) {
  const s = await getSettings(), now = Date.now();
  if (!force) {
    if (!(s.watchNotifs || s.watchMsgs)) return { skipped: 'kikapcsolva' };
    if (inQuiet(new Date().getHours(), s.quietFrom, s.quietTo)) return { skipped: 'csendes órák' };
  }
  const w = (await store('watch')) || {};
  let r = null, via = 'nyitott lap';
  const tab = await findFbTab();
  if (tab) {
    r = await peekIn(tab.id).catch(e => ({ ok: false, problem: String((e && e.message) || e) }));
    if (!r.ok && !r.stop && !r.missing) return { skipped: 'a nyitott lap fejléce még nem kész', result: r };
  }
  if (!r || (!r.ok && !r.stop)) {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const navs = ((await store('watchNav')) || []).filter(t => t >= day.getTime());
    if (!force) {
      if (w.navDue && now < w.navDue) return { skipped: 'nincs nyitott Facebook-lap, a következő háttérlap még nem esedékes' };
      if (navs.length >= s.maxWatchPerDay) return { skipped: 'napi korlát' };
    }
    via = 'háttérlap'; navs.push(now);
    await chrome.storage.local.set({ watchNav: navs.slice(-60) });
    r = await openAndPeek(settleMs);
    w.navDue = now + s.watchEveryMin * 60e3 * (0.75 + Math.random() * 0.5);
  }
  const wl = (await store('watchLog')) || [];
  if (r.stop) {
    await chrome.storage.local.set({ settings: { ...s, watchNotifs: false, watchMsgs: false }, watch: { navDue: w.navDue || null } }); await ensureAlarm();
    await notify('watch-stop', 'facebook-reader: figyelés leállítva', r.problem);
    wl.push({ at: now, via, text: 'leállítva: ' + r.problem }); await chrome.storage.local.set({ watchLog: wl.slice(-30) });
    return { stopped: true, result: r };
  }
  if (!r.ok) { wl.push({ at: now, via, text: 'hiba: ' + r.problem }); await chrome.storage.local.set({ watchLog: wl.slice(-30), watch: w }); return { ok: false, result: r }; }
  const d = watchDiff(w, r, s);
  await chrome.storage.local.set({ watch: { at: now, notifs: r.notifs, msgs: r.msgs, navDue: w.navDue || null } });
  wl.push({ at: now, via, text: d.first ? `első mérés: 🔔 ${r.notifs} · ✉ ${r.msgs}` : `🔔 ${r.notifs} · ✉ ${r.msgs}${d.n || d.m ? ` (+${d.n}/+${d.m})` : ''}` });
  await chrome.storage.local.set({ watchLog: wl.slice(-30) });
  if (s.notify && (d.n || d.m)) {
    const alerts = (d.n ? 1 : 0) + (d.m ? 1 : 0), u = ((await store('unseen')) || 0) + alerts;
    await chrome.storage.local.set({ unseen: u }); await chrome.action.setBadgeText({ text: String(u) });
    if (d.n) await notify('watch-n', 'facebook-reader: új értesítés', `${d.n} új olvasatlan értesítés (összesen ${r.notifs}). Részletek: kérdezd Claude-ot, pl. „jött értesítés a posztomra?”`);
    if (d.m) await notify('watch-m', 'facebook-reader: új üzenet', `${d.m} új olvasatlan Messenger-üzenet (összesen ${r.msgs}). A szálakat nem nyitottam meg, nincs „Látta” jelzés.`);
  }
  return { ok: true, via, result: r, diff: d };
}

chrome.runtime.onInstalled.addListener(async () => { const s = await store('settings'); if (!s) await chrome.storage.local.set({ settings: DEFAULTS }); await ensureAlarm(); });
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) tick(false).catch(() => {}); else if (a.name === WALARM) watchTick(false).catch(() => {}); });
chrome.notifications.onClicked.addListener(async nid => { const id = String(nid).replace(/^fbr:/, ''); if (id === 'watch-n') return void chrome.tabs.create({ url: 'https://www.facebook.com/notifications/' }); if (id === 'watch-m') return void chrome.tabs.create({ url: 'https://www.facebook.com/messages/' }); const it = ((await store('track')) || []).find(x => x.id === id); if (it) chrome.tabs.create({ url: it.url }); });

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    if (msg.type === 'track-sync') { const cur = (await store('track')) || []; await chrome.storage.local.set({ track: mergeLists(cur, msg.list) }); return { ok: true }; }
    if (msg.type === 'get-state') return { settings: await getSettings(), track: (await store('track')) || [], log: (await store('log')) || [], unseen: (await store('unseen')) || 0, watch: (await store('watch')) || {}, watchLog: (await store('watchLog')) || [] };
    if (msg.type === 'set-settings') { const old = await getSettings(), s = { ...old, ...msg.settings }; s.watchEveryMin = Math.min(180, Math.max(15, +s.watchEveryMin || 30)); s.maxWatchPerDay = Math.min(60, Math.max(4, +s.maxWatchPerDay || 24));
      if ((s.watchNotifs || s.watchMsgs) && !(old.watchNotifs || old.watchMsgs)) await chrome.storage.local.set({ watch: {} }); /* friss alapmérés: régi számokra nincs riasztás */ s.intervalHours = Math.min(48, Math.max(2, +s.intervalHours || 6)); s.maxPerDay = Math.min(30, Math.max(1, +s.maxPerDay || 12)); await chrome.storage.local.set({ settings: s }); await ensureAlarm(); return { ok: true, settings: s }; }
    if (msg.type === 'check-now') return tick(true);
    if (msg.type === 'watch-now') return watchTick(true);
    if (msg.type === 'clear-badge') { await chrome.storage.local.set({ unseen: 0 }); await chrome.action.setBadgeText({ text: '' }); return { ok: true }; }
    return { ok: false };
  })().then(send);
  return true;
});
