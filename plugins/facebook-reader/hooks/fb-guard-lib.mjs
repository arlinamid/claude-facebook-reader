// fb-guard-lib.mjs — shared by fb-write-guard.mjs and fb-approve.mjs
// Approval token (what the user approved to be typed/posted) + append-only audit log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const APPROVAL_FILE = path.join(os.tmpdir(), 'fb-reader-approval.json');
export const AUDIT_DIR = path.join(os.homedir(), '.fb-reader');
export const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');
// Self-notification (message to the user's OWN Messenger thread): registered once, bound to the account id + thread URL.
export const SELF_FILE = path.join(AUDIT_DIR, 'self.json');
export function loadSelf() {
  if (process.env.FB_READER_DISABLE_APPROVALS === '1') return null;   // Codex adapter: read-only, no Claude tokens
  try {
    const s = JSON.parse(fs.readFileSync(SELF_FILE, 'utf8'));
    return s && s.enabled && /^\d+$/.test(String(s.accountId)) && /^https:\/\//.test(s.threadUrl || '') ? s : null;
  } catch { return null; }
}
export const saveSelf = s => { fs.mkdirSync(AUDIT_DIR, { recursive: true }); fs.writeFileSync(SELF_FILE, JSON.stringify(s, null, 2)); };
export const clearSelf = () => { try { fs.unlinkSync(SELF_FILE); } catch { /* none */ } };

export const norm = s => String(s ?? '').normalize('NFC').replace(/\r\n/g, '\n');
export const sha = s => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 10);
export const TEXT_KINDS = new Set(['comment', 'reply', 'post', 'message']);

export function audit(rec) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* the log is best-effort, never blocks */ }
}

export function loadApproval() {
  if (process.env.FB_READER_DISABLE_APPROVALS === '1') return null;   // Codex adapter: read-only, no Claude tokens
  try {
    const a = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8'));
    if (!a || Date.parse(a.expiresAt) < Date.now()) return null;
    return a;
  } catch { return null; }
}
export const saveApproval = a => fs.writeFileSync(APPROVAL_FILE, JSON.stringify(a));
export const clearApproval = () => { try { fs.unlinkSync(APPROVAL_FILE); } catch { /* none */ } };

// Same FB page? ignore www./web./m., trailing slash, tracking params; ids in the query must match.
export function sameTarget(approvedUrls, current) {
  if (!current) return null; // unknown → caller decides
  const key = u => {
    try {
      const x = new URL(/^https?:/i.test(u) ? u : 'https://' + u);
      const q = ['id', 'story_fbid', 'fbid', 'multi_permalinks', 'v'].map(k => x.searchParams.get(k) ? `${k}=${x.searchParams.get(k)}` : '').filter(Boolean).join('&');
      return x.pathname.replace(/\/+$/, '') + (q ? '?' + q : '');
    } catch { return String(u); }
  };
  const c = key(current);
  return (approvedUrls || []).some(u => { const k = key(u); return k === c || c.startsWith(k + '/') || k.startsWith(c + '/'); });
}

// First differing position, for the denial message.
export function firstDiff(expected, got) {
  let i = 0;
  while (i < expected.length && i < got.length && expected[i] === got[i]) i++;
  return { at: i, expectedNext: expected.slice(i, i + 24), gotNext: got.slice(i, i + 24) };
}

// ── Listing approval (selling on Marketplace / in a group) ──────────────────────────────────────────────────────
// kind 'listing' holds several approved texts (title, price, description), approved photo paths and approved dropdown choices.
// A typed chunk is accepted only as the continuation of ONE approved field; publishing is never auto-allowed.
export const photoKey = p => String(p ?? '').replace(/\\/g, '/').trim().toLowerCase();
export function listingField(ap, chunk) {
  const f = ap.fields || [], c = norm(chunk);
  return f.find(x => x.typed === '' && x.text === c) || f.find(x => x.typed.length < x.text.length && x.text.startsWith(x.typed + c)) || null;
}
export const listingTyped = ap => (ap.fields || []).every(x => x.typed === x.text);
export const listingPhotosDone = ap => (ap.photos || []).every(p => (ap.uploaded || []).includes(photoKey(p)));
export const listingProgress = ap => `${(ap.fields || []).map(x => `${x.name} ${x.typed.length}/${x.text.length}`).join(', ')}${(ap.photos || []).length ? ` · fotók ${(ap.uploaded || []).length}/${ap.photos.length}` : ''}`;
export const uploadPaths = i => [].concat(i?.paths ?? i?.path ?? i?.files ?? i?.filePath ?? i?.file_paths ?? []).filter(x => typeof x === 'string');
const fold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
export function listingChoiceIn(ap, summary) {
  const s = fold(summary), ch = ap.choices || {};
  return Object.values(ch).some(v => v && fold(v).length >= 3 && s.includes(fold(v)));
}

