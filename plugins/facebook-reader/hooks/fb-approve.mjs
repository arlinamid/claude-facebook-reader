#!/usr/bin/env node
// fb-approve.mjs — record WHAT the user approved to write on Facebook.
//
//   node fb-approve.mjs --kind comment --url <post url> [--url <page url>] --as "Minta Anna" --text "…"   (or --text-file f)
//   node fb-approve.mjs --kind react --url <post url> --react love
//   node fb-approve.mjs --status | --clear
//
// Selling (Marketplace or a group): ONE approval for the whole listing — the guard lets exactly these texts be typed (each into its field),
// exactly these photos be uploaded and exactly these dropdown values be chosen. Publishing is ALWAYS asked separately.
//   node fb-approve.mjs --kind listing --url <https://www.facebook.com/marketplace/create/item | group url> --as "Minta Anna" --target-name "Marketplace|<csoport>"
//        --title "…" --price 45000 [--description-file f | --description "…"] [--category "…"] [--condition "…"] [--photo <path> …]
//
// Message to the user's OWN Messenger thread (e.g. "the task is done"): an exception from the per-message approval, bound to
// the ACCOUNT (id read from the page by __fbReader.me()) and to ONE thread URL that the user confirmed once.
//   node fb-approve.mjs --register-self --url <own thread url> --account <account id> [--max-chars 500]   (asks the user once)
//   node fb-approve.mjs --self-notify --account <account id> --text-file <file>                           (no prompt, only if registered)
//   node fb-approve.mjs --unregister-self
//
// The write guard then lets `computer type` through ONLY if the typed text is, character for character,
// the approved text (in order, chunks allowed) and DENIES anything else. Running this command is itself
// gated: the guard asks the user (showing the exact text and target) before it executes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { audit, loadApproval, saveApproval, clearApproval, norm, sha, TEXT_KINDS, loadSelf, saveSelf, clearSelf } from './fb-guard-lib.mjs';

const argv = process.argv.slice(2);
const get = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const all = k => argv.flatMap((v, i) => (v === '--' + k && argv[i + 1] ? [argv[i + 1]] : []));
const out = o => { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); };

if (argv.includes('--status')) {
  const a = loadApproval();
  const sf = loadSelf();
  if (sf) out({ self: { registered: true, accountId: sf.accountId, threadUrl: sf.threadUrl, maxChars: sf.maxChars } });
  out(a ? { active: true, kind: a.kind, urls: a.urls, as: a.as, react: a.react, textLength: a.text.length, typed: a.typed.length, ...(a.kind === 'listing' ? { fields: a.fields.map(f => `${f.name} ${f.typed.length}/${f.text.length}`), photos: `${(a.uploaded || []).length}/${(a.photos || []).length}` } : {}), expiresAt: a.expiresAt } : { active: false });
  process.exit(0);
}
if (argv.includes('--clear')) { clearApproval(); audit({ event: 'approval-cleared' }); out({ cleared: true }); process.exit(0); }

if (argv.includes('--unregister-self')) { clearSelf(); audit({ event: 'self-unregistered' }); out({ selfNotify: 'unregistered' }); process.exit(0); }
if (argv.includes('--register-self')) {
  const url = get('url'), acc = get('account');
  if (!url || !/^https:\/\/(www\.|web\.)?(facebook\.com\/messages|messenger\.com)\/(e2ee\/)?t\/\d+\/?$/i.test(url)) { out({ error: '--url: a saját Messenger-szál címe kell (…/messages/t/<id> vagy …/messages/e2ee/t/<id>)' }); process.exit(2); }
  if (!/^\d{5,20}$/.test(acc || '')) { out({ error: '--account: a fiók azonosítója kell (__fbReader.me().id)' }); process.exit(2); }
  const maxChars = Math.min(Math.max(parseInt(get('max-chars') || '500', 10) || 500, 20), 1000);
  const s = { enabled: true, accountId: acc, threadUrl: url.replace(/\/*$/, '/'), maxChars, registeredAt: new Date().toISOString() };
  saveSelf(s); audit({ event: 'self-registered', accountId: acc, threadUrl: s.threadUrl, maxChars });
  out({ selfNotify: 'registered', accountId: acc, threadUrl: s.threadUrl, maxChars });
  process.exit(0);
}
if (argv.includes('--self-notify')) {
  const s = loadSelf();
  if (!s) { out({ error: 'nincs regisztrált saját szál (előbb: --register-self, a felhasználó jóváhagyásával)' }); process.exit(3); }
  if (String(get('account') || '') !== String(s.accountId)) { out({ error: 'a bejelentkezett fiók nem egyezik a regisztrálttal: nem küldök (a kivétel egy fiókhoz kötött)' }); audit({ event: 'self-notify-refused', reason: 'account-mismatch' }); process.exit(3); }
  const tf = get('text-file');
  if (!tf) { out({ error: '--text-file kell' }); process.exit(2); }
  const text = norm(fs.readFileSync(tf, 'utf8')).replace(/\n+$/, '');
  if (!text) { out({ error: 'üres szöveg' }); process.exit(2); }
  if (text.length > s.maxChars) { out({ error: `a szöveg ${text.length} karakter, a határ ${s.maxChars}` }); audit({ event: 'self-notify-refused', reason: 'too-long', length: text.length }); process.exit(3); }
  if (/[\n\r]/.test(text)) { out({ error: 'egysoros szöveg kell: az újsor beírása a Messengerben azonnal küldene' }); process.exit(2); }
  const a = { id: crypto.randomBytes(4).toString('hex'), kind: 'message', urls: [s.threadUrl], as: 'önértesítés (saját szál)', react: null, self: true, sent: false, text, typed: '',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
  saveApproval(a);
  audit({ event: 'approval', id: a.id, kind: 'message', self: true, urls: a.urls, textLength: text.length, textHash: sha(text), text: text.slice(0, 2000), ttlMin: 10 });
  out({ approved: true, self: true, id: a.id, threadUrl: s.threadUrl, textLength: text.length, expiresAt: a.expiresAt });
  process.exit(0);
}

const kind = get('kind');
if (!['comment', 'reply', 'post', 'message', 'react', 'listing'].includes(kind || '')) { out({ error: '--kind comment|reply|post|message|react|listing' }); process.exit(2); }
const urls = all('url');
if (!urls.length || !urls.every(u => /^https?:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com)\//i.test(u))) { out({ error: 'legalább egy --url kell, facebook.com cím' }); process.exit(2); }
let text = get('text-file') ? fs.readFileSync(get('text-file'), 'utf8') : get('text');
text = norm(text ?? '').replace(/\n+$/, '');
if (TEXT_KINDS.has(kind) && !text) { out({ error: 'szöveges művelethez --text vagy --text-file kell' }); process.exit(2); }
if (kind === 'react' && !get('react')) { out({ error: '--react love|like|care|haha|wow|sad|angry' }); process.exit(2); }
let listing = null;
if (kind === 'listing') {
  const title = norm(get('title') ?? '').replace(/\n+/g, ' ').trim(), price = String(get('price') ?? '').replace(/\s/g, '');
  const dsc = norm(get('description-file') ? fs.readFileSync(get('description-file'), 'utf8') : (get('description') ?? '')).replace(/\n+$/, '');
  if (!title || title.length > 100) { out({ error: '--title kell (legfeljebb 100 karakter)' }); process.exit(2); }
  if (!/^\d{1,9}$/.test(price)) { out({ error: '--price kell: csak számjegyek (0 = ingyen)' }); process.exit(2); }
  if (dsc.length > 5000) { out({ error: 'a leírás legfeljebb 5000 karakter' }); process.exit(2); }
  const photos = all('photo');
  if (photos.some(x => /^(https?:|data:)/i.test(x) || x.includes('\n'))) { out({ error: '--photo: helyi fájl útvonala kell, nem URL' }); process.exit(2); }
  listing = {
    fields: [{ name: 'title', text: title, typed: '' }, { name: 'price', text: price, typed: '' }, ...(dsc ? [{ name: 'description', text: dsc, typed: '' }] : [])],
    photos, uploaded: [], choices: { category: get('category') || null, condition: get('condition') || null }, targetName: get('target-name') || null,
  };
}
const ttl = Math.min(Math.max(parseInt(get('ttl') || '20', 10) || 20, 1), 60);
const a = {
  id: crypto.randomBytes(4).toString('hex'), kind, urls, as: get('as') || null, react: get('react') || null,
  text, typed: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttl * 60000).toISOString(), ...(listing || {}),
};
saveApproval(a);
audit({ event: 'approval', id: a.id, kind, urls, as: a.as, react: a.react, textLength: text.length, textHash: sha(text), text: text.slice(0, 2000), ttlMin: ttl, ...(listing ? { listing: { fields: listing.fields.map(f => ({ name: f.name, text: f.text.slice(0, 600) })), photos: listing.photos, choices: listing.choices, targetName: listing.targetName } } : {}) });
out({ approved: true, id: a.id, kind, urls, as: a.as, react: a.react, textLength: text.length, ...(listing ? { fields: listing.fields.map(f => `${f.name}: ${f.text.length} kar.`), photos: listing.photos.length, choices: listing.choices } : {}), expiresAt: a.expiresAt });
