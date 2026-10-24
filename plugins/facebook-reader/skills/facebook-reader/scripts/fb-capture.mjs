#!/usr/bin/env node
// fb-capture.mjs — local, headless-capable Facebook reader for Claude Code (CLI) on YOUR machine.
// Uses a persistent browser profile (log in once by hand, 2FA ok) and injects fb-reader.js.
// Never run this from a cloud server with copied cookies: Facebook will lock the session (checkpoint).
//
//   npm i -D playwright            (once, in any folder; or: npx -y -p playwright node fb-capture.mjs …)
//   node fb-capture.mjs login                                   # opens a window — log in, then press ENTER
//   node fb-capture.mjs read  <url> [--scroll 8] [--comments] [--limit 50] [--md] [--out file]
//   node fb-capture.mjs search "<query>" [--type posts|people|groups|pages|photos|videos|events|top]
//   node fb-capture.mjs group <id|slug|url> [--search "<q>"] [--scroll 8] [--chronological] [--md]
//   node fb-capture.mjs groups                                  # joined groups
//   node fb-capture.mjs mediagrid <url>                         # /media, /photos, /videos, /reels pages
//
// Options: --profile <dir> (default ~/.fb-reader/profile)  --headless  --channel chrome|msedge  --executable <path>
// Output: JSON to stdout (or --out), Markdown with --md. Feed JSON to `fb_tool.py media` for downloads.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const READER = fs.readFileSync(path.join(__dirname, 'fb-reader.js'), 'utf8');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const VALUE_FLAGS = new Set(['profile', 'scroll', 'limit', 'out', 'type', 'search', 'channel', 'executable']);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(arr[i - 1].replace(/^--/, ''))));

const PROFILE = flag('profile', path.join(os.homedir(), '.fb-reader', 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FB = 'https://www.facebook.com';

async function launch(headless) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.error('Playwright hiányzik: npm i -D playwright  (vagy: npx -y -p playwright node fb-capture.mjs …)'); process.exit(2); }
  fs.mkdirSync(PROFILE, { recursive: true });
  const opts = { headless, viewport: { width: 1280, height: 900 }, locale: 'hu-HU', args: ['--lang=hu-HU'] };
  const channel = flag('channel');
  if (channel) opts.channel = channel;
  const exe = flag('executable') || process.env.FB_READER_CHROME;
  if (exe) opts.executablePath = exe;
  return chromium.launchPersistentContext(PROFILE, opts);
}

async function inject(page) {
  return page.evaluate(READER);
}

async function open(ctx, url) {
  const page = ctx.pages()[0] || await ctx.newPage();
  if (process.env.FB_READER_TEST_HTML) {
    const html = fs.readFileSync(process.env.FB_READER_TEST_HTML, 'utf8');
    await page.route('**/*', r => r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }));
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3500 + Math.random() * 1500);
  const status = await inject(page);
  if (/checkpoint/.test(page.url())) throw new Error('Facebook biztonsági ellenőrzés (checkpoint) — oldd fel a böngészőben: node fb-capture.mjs login');
  if (/Nincs bejelentkezve/.test(status)) throw new Error('Nincs bejelentkezve — futtasd: node fb-capture.mjs login');
  console.error(status);
  return page;
}

function emit(data) {
  const out = flag('out');
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (out) { fs.writeFileSync(out, text, 'utf8'); console.error(`→ ${out}`); }
  else process.stdout.write(text + '\n');
}

async function readPosts(page) {
  const scroll = +flag('scroll', 0) || 0;
  const comments = !!flag('comments', false);
  const limit = +flag('limit', 100);
  await page.evaluate(() => __fbReader.expandSeeMore());
  if (comments) await page.evaluate(() => __fbReader.expandComments({ rounds: 3 }));
  await page.evaluate(() => __fbReader.hoverDates({ limit: 20 }));
  if (scroll > 0) {
    await page.evaluate(o => __fbReader.harvest.start(o), { comments });
    await page.evaluate(o => __fbReader.harvest.scroll(o), { steps: scroll, comments });
    return page.evaluate(o => __fbReader.harvest.dump(o), { format: flag('md') ? 'md' : 'object', limit });
  }
  return page.evaluate(o => __fbReader.extract(o), { format: flag('md') ? 'md' : 'object', comments, limit });
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (cmd === 'login') {
    const ctx = await launch(false);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${FB}/login`, { waitUntil: 'domcontentloaded' });
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await new Promise(r => rl.question('Jelentkezz be a megnyílt ablakban (2FA is), majd nyomj ENTER-t… ', () => { rl.close(); r(); }));
    await ctx.close();
    console.error(`✓ Session elmentve: ${PROFILE}`);
    return;
  }
  const ctx = await launch(!!flag('headless', false));
  try {
    let page, result;
    switch (cmd) {
      case 'read': {
        page = await open(ctx, positional[0]);
        result = await readPosts(page);
        break;
      }
      case 'search': {
        const type = flag('type', 'top');
        page = await open(ctx, `${FB}/search/${type}/?q=${encodeURIComponent(positional[0] || '')}`);
        await page.evaluate(() => window.scrollBy(0, innerHeight * 2));
        await sleep(2500);
        result = type === 'posts' || type === 'top'
          ? { posts: await page.evaluate(() => __fbReader.extract({ format: 'object' }).posts), results: await page.evaluate(() => __fbReader.extractSearchResults()) }
          : await page.evaluate(() => __fbReader.extractSearchResults());
        if (flag('md')) result = JSON.stringify(result, null, 2);
        break;
      }
      case 'group': {
        const g = positional[0];
        const q = flag('search');
        const gid = String(g).replace(/^https?:\/\/[^/]+\/groups\//, '').replace(/[/?#].*$/, '');
        const url = q ? `${FB}/groups/${gid}/search/?q=${encodeURIComponent(q)}` : `${FB}/groups/${gid}/${flag('chronological') ? '?sorting_setting=CHRONOLOGICAL' : ''}`;
        page = await open(ctx, url);
        const info = await page.evaluate(() => __fbReader.groupInfo());
        const posts = await readPosts(page);
        result = flag('md') ? `${JSON.stringify(info)}\n\n${posts}` : { group: info, ...(posts.posts ? posts : { posts }) };
        break;
      }
      case 'groups': {
        page = await open(ctx, `${FB}/groups/joins/`);
        for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, innerHeight)); await sleep(1200); }
        result = await page.evaluate(() => __fbReader.listGroups());
        break;
      }
      case 'mediagrid': {
        page = await open(ctx, positional[0]);
        for (let i = 0; i < (+flag('scroll', 4) || 4); i++) { await page.evaluate(() => window.scrollBy(0, innerHeight)); await sleep(1500); }
        result = await page.evaluate(() => __fbReader.extractMediaGrid());
        break;
      }
      default:
        throw new Error(`Ismeretlen parancs: ${cmd} (help)`);
    }
    emit(result);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
