'use strict';
const $ = id => document.getElementById(id);
const ask = m => chrome.runtime.sendMessage(m);
const ago = t => { if (!t) return 'még nem'; const m = Math.round((Date.now() - t) / 60000); return m < 90 ? m + ' perce' : m < 2880 ? Math.round(m / 60) + ' órája' : Math.round(m / 1440) + ' napja'; };
async function render() {
  const st = await ask({ type: 'get-state' });
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  $('enabled').checked = !!st.settings.enabled;
  $('notify').checked = !!st.settings.notify;
  $('intervalHours').value = String(st.settings.intervalHours);
  $('watchNotifs').checked = !!st.settings.watchNotifs; $('watchMsgs').checked = !!st.settings.watchMsgs; $('watchEveryMin').value = String(st.settings.watchEveryMin);
  const wl = (st.watchLog || [])[(st.watchLog || []).length - 1];
  $('wstatus').textContent = wl ? `Utolsó: ${ago(wl.at)} (${wl.via}) — ${wl.text}` : (st.watch && st.watch.at ? `Utolsó mérés: ${ago(st.watch.at)}` : '');
  const ul = $('list'); ul.textContent = '';
  if (!st.track.length) { const li = document.createElement('li'); li.className = 'mut'; li.textContent = 'Még nincs követett hirdetés.'; ul.append(li); }
  for (const x of st.track) {
    const li = document.createElement('li'), t = document.createElement('div'), m = document.createElement('div');
    t.className = 't'; t.textContent = (x.price ? x.price + ' · ' : '') + (x.title || x.id);
    m.className = 'mut'; m.textContent = `${x.kind === 'group' ? 'csoport' : x.kind === 'marketplace' ? 'Marketplace' : 'poszt'} · ellenőrizve: ${ago(x.checkedAt)}${x.sold ? ' · ' + x.sold : ''}`;
    if (x.changedAt) { const f = document.createElement('span'); f.className = 'flag'; f.textContent = ' · ⚑ változott ' + ago(x.changedAt); m.append(f); }
    li.append(t, m); ul.append(li);
  }
  const last = st.log[st.log.length - 1];
  $('status').textContent = last ? `Utolsó: ${ago(last.at)} — ${last.title}: ${last.text}` : '';
}
for (const id of ['enabled', 'notify', 'intervalHours', 'watchNotifs', 'watchMsgs', 'watchEveryMin']) $(id).addEventListener('change', async () => { await ask({ type: 'set-settings', settings: { enabled: $('enabled').checked, notify: $('notify').checked, intervalHours: +$('intervalHours').value, watchNotifs: $('watchNotifs').checked, watchMsgs: $('watchMsgs').checked, watchEveryMin: +$('watchEveryMin').value } }); render(); });
$('wnow').addEventListener('click', async () => { $('wstatus').textContent = 'Mérés…'; const r = await ask({ type: 'watch-now' }); if (r && r.skipped) $('wstatus').textContent = 'Nincs mit: ' + r.skipped; else render(); });
$('now').addEventListener('click', async () => { $('status').textContent = 'Ellenőrzés…'; const r = await ask({ type: 'check-now' }); $('status').textContent = r.skipped ? 'Nincs mit: ' + r.skipped : ''; render(); });
$('clear').addEventListener('click', async () => { await ask({ type: 'clear-badge' }); render(); });
render();
