#!/usr/bin/env node
// Native Codex PreToolUse/PostToolUse adapter. Facebook access is read-only.
// Codex does not support PreToolUse "ask" (or bare "allow"): never forward those outputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const legacy = path.join(here, 'fb-write-guard.mjs');
const fallback = 'https://www.facebook.com/';
let event;

function block(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } }));
}

function run(input, flags = []) {
  const child = spawnSync(process.execPath, [legacy, ...flags], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 8000,
    env: { ...process.env, FB_READER_DISABLE_APPROVALS: '1', FB_READER_GUARD_STATE_DIR: stateDir },
  });
  if (child.error || child.status !== 0) throw new Error('Reader policy process failed.');
  return child.stdout.trim() ? JSON.parse(child.stdout) : {};
}

function normalize(input) {
  const next = { ...input, tool_input: { ...(input.tool_input || {}) } };
  const name = input.tool_name || '';
  const args = next.tool_input;
  if (/browser_evaluate|javascript_tool$/.test(name)) {
    next.tool_name = 'mcp__facebook_reader__javascript_tool';
    args.text = args.expression ?? args.text ?? args.code ?? args.script ?? '';
  } else if (/browser_type$/.test(name)) {
    next.tool_name = 'mcp__facebook_reader__computer';
    args.action = 'type';
  } else if (/browser_click$/.test(name)) {
    next.tool_name = 'mcp__facebook_reader__computer';
    args.action = 'left_click';
    // Element IDs alone don't establish that a click is read-only.
    args.action_summary = args.action_summary || args.description || '';
  } else if (/browser_navigate$/.test(name)) {
    next.tool_name = 'mcp__facebook_reader__navigate';
  }
  return next;
}

// Structured tab lists from Codex for Chrome can be JSON in content[].text.
function tabLocations(value, found = [], depth = 0) {
  if (depth > 8 || value == null) return found;
  if (typeof value === 'string') {
    try { tabLocations(JSON.parse(value), found, depth + 1); } catch { /* plain text */ }
  } else if (Array.isArray(value)) {
    for (const item of value) tabLocations(item, found, depth + 1);
  } else if (typeof value === 'object') {
    const id = value.tabId ?? value.tab_id ?? value.id;
    if (id != null && typeof value.url === 'string' && /^https?:\/\//.test(value.url))
      found.push([String(id), value.url]);
    for (const key of ['tabs', 'content', 'text', 'structuredContent', 'result'])
      if (key in value) tabLocations(value[key], found, depth + 1);
  }
  return found;
}

let stateDir;
try {
  event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!event.tool_name || !event.hook_event_name) throw new Error('Missing hook event fields.');
  const post = event.hook_event_name === 'PostToolUse';
  if (!post && event.hook_event_name !== 'PreToolUse') process.exit(0);
  const key = crypto.createHash('sha256').update(String(event.session_id || event.cwd || 'default')).digest('hex').slice(0, 24);
  stateDir = path.join(os.tmpdir(), 'fb-reader-codex', key);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'fb-reader-guard-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { tabs: {}, last: null }; }
  state.tabs ||= {};
  const input = normalize(event);
  const name = event.tool_name;
  const tab = input.tool_input.tabId ?? input.tool_input.tab_id;

  if (post) {
    const response = event.tool_response;
    if (response?.isError) process.exit(0);
    const responseText = typeof response === 'string' ? response : JSON.stringify(response || {});
    if (/"isError"\s*:\s*true/.test(responseText)) process.exit(0);
    if (/navigate|tabs_create|browser_tabs_list|tabs_context/.test(name)) {
      for (const [id, url] of tabLocations(response)) state.tabs[id] = url;
      if (/navigate/.test(name) && /^https?:\/\//.test(input.tool_input.url || '')) {
        if (tab != null) state.tabs[String(tab)] = input.tool_input.url;
        state.last = input.tool_input.url;
      }
      fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    process.exit(0);
  }

  // An unknown tab is treated conservatively; never inherit another tab's non-Facebook URL.
  state.last = tab != null ? state.tabs[String(tab)] || fallback : state.last || fallback;
  if (tab != null && !state.tabs[String(tab)]) state.tabs[String(tab)] = fallback;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (/browser_batch|computer_batch/.test(name)) {
    block('Facebook Reader: use individual reader/navigation calls; browser batches are not supported by the Codex guard.');
    process.exit(0);
  }
  const output = run(input, name === 'Bash' ? ['--bash'] : []);
  const decision = output.hookSpecificOutput?.permissionDecision;
  if (decision === 'ask' || decision === 'deny' || decision === 'allow') {
    block('Facebook Reader: this Codex adapter is read-only. This action requires a write-capable integration.\n'
      + output.hookSpecificOutput.permissionDecisionReason);
  }
} catch (error) {
  if (event?.hook_event_name === 'PostToolUse') {
    process.stderr.write(`Facebook Reader tracking failed: ${error.message}\n`);
  } else {
    // Exit 2 is a supported Codex blocking result, including malformed events.
    process.stderr.write(`Facebook Reader hook failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
