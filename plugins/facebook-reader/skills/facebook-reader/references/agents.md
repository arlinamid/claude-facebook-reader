# Browser adapters and other hosts (Codex)

The reader is page JavaScript, independent of the model. Use only browser tools that are actually
available; names below are adapters, not requirements to install every provider. Instructions such as
`navigate`, `find`, `computer type` and `zoom` elsewhere in the skill mean the corresponding host action.
Browser-tool access checks and host instructions still apply.

## Native Codex plugin (recommended)

The same plugin directory (`plugins/facebook-reader/`) serves both hosts. Claude reads `.claude-plugin/`;
Codex reads `.codex-plugin/plugin.json` and the repository's `.agents/plugins/marketplace.json`.

```bash
codex plugin marketplace add arlinamid/claude-facebook-reader
codex plugin add facebook-reader@arlinamid-plugins
```

From a local clone: `codex plugin marketplace add .`. Restart Codex or open a new chat if the plugin does not
appear. **Review and trust the bundled hooks in Codex's `/hooks` interface:** installation does not trust
hooks, and untrusted hooks are skipped. Node must be available to run the guard.

Codex loads `hooks/hooks.json` from a plugin by default. That file is the Claude configuration (its guard
answers `ask`, which Codex does not support: the hook run is marked failed and the tool call continues).
`.codex-plugin/plugin.json` therefore selects `hooks/codex-hooks.json` explicitly. It runs
`fb-codex-guard.mjs`, a thin adapter over the shared `fb-write-guard.mjs`: Codex's `expression` / browser
actions are translated into the existing reader policy, Claude approval tokens are ignored, and every
`ask` / `deny` result is emitted as Codex's supported `deny`. State is isolated per session.

**Codex mode is read-only:** possible Facebook typing, publication, uploads and ambiguous clicks are denied;
use reader helpers for expansions and navigation. Browser batches are not supported by the adapter, so use
individual calls. It is a guardrail for matched browser calls, not a browser/network sandbox or a guarantee
against arbitrary code in other tools. A separate browser connection is still required.

Status: the adapter is covered by synthetic hook-event tests (`tests/test_codex_hooks.py`); it has not yet
been run against a live Codex for Chrome session, and the tool names it matches are taken from its docs.

Sources: [Codex plugin packaging](https://developers.openai.com/codex/plugins/build),
[Codex hook behavior and trust](https://learn.chatgpt.com/docs/hooks).

## Codex for Chrome

With the connected `mcp__codex_chrome__*` tools:

1. Call `browser_status({})`. If `connected:false`, tell the user to connect their Codex for Chrome
   extension. Do not retry page calls against a disconnected bridge.
2. Use `browser_tabs_list({})`, then the available new-tab/navigation tools. Check their actual schemas;
   tab creation and navigation arguments vary by tool version. Observe the new page once as required by
   the browser tools, then use the compact reader instead of repeatedly reading the whole page.
3. `browser_evaluate` (or its `javascript_tool` alias) takes **`expression`**, plus **`tabId`**. It does
   not take Claude's `text` argument. Always pass the tab ID from the tab tools.

Example tool arguments, substituting the actual numeric tab ID:

```json
{"tabId": 123, "expression": "typeof window.__fbReader === 'object' ? window.__fbReader.status() : 'FB_READER_MISSING'"}
```

After the reader is present:

```javascript
// Each expression is a separate browser_evaluate call on the same tab.
window.__fbReader.where()
window.__fbReader.map({limit: 8})
await window.__fbReader.peek('#anchor-from-map')
await window.__fbReader.thread('#anchor-from-map', {top: 5})
```

If the tool accepts expressions but not top-level `await`, use an async IIFE, for example
`(async () => await window.__fbReader.peek('#anchor-from-map'))()`, and wait for the returned promise.
Use returned stable element IDs for clicks and typing when the host supports them. A reader tag such as
`[fbr:comment-box]` is a locator hint, not automatically a valid host element ID.

## Load the reader

The optional **Facebook Reader extension** is separate from Codex for Chrome. Load the provided
`extension/` directory through Chrome's **Load unpacked**, then reload the Facebook tab. It injects
`window.__fbReader` in the MAIN world on matching pages, regardless of the agent controlling Chrome.
The source is `extension/` in the plugin directory.

Without that extension, read `scripts/fb-reader.loader.js` from disk and pass its contents verbatim to
the page-evaluation tool. If it reports missing/stale installation, run `scripts/fb-reader.min.js`;
for input-size limits, run one complete set of `scripts/install/fb-reader.part-N-of-M.js` files in numeric
order, with the same M for every part. Do not mix sets. The extension avoids copying these scripts.

After a full navigation, check again: the page global is recreated. Loading the core or its cache alone
does not grant permission to write. The optional write module contains target/preview helpers, not an
approval system.

## Claude and other browser agents

Claude in Chrome uses `tabs_context_mcp`, `tabs_create_mcp`, `navigate` and `javascript_tool` with its
own tool schemas (typically `text` for the JavaScript source). The Claude hooks and approval protocol apply.

For another browser MCP, map the same operations: list/create tabs, navigate, evaluate MAIN-world JS,
observe, click, type, screenshot. Some evaluators expect a function instead of an expression. Read the
tool's schema and adapt the wrapper; do not guess tool names or argument fields.

An isolated/read-only DOM sandbox may not expose the page's `window.__fbReader`. If the extension is
installed and the object is still invisible, do not repeatedly inject it into the wrong world. Use a
supported page-world evaluator or the local CLI below. A skill or extension alone does not connect a
normal ChatGPT web conversation to the user's signed-in Chrome session. Without a local browser/terminal
connection, work with a saved HTML or JSON export via `scripts/fb_tool.py` instead.

## Local CLI fallback (any agent with local shell access)

Run from the installed skill's **scripts directory** so Playwright is installed beside the importing
`fb-capture.mjs`. Installing it in an unrelated working directory does not make ESM imports resolve.

```bash
npm install --no-save --package-lock=false playwright
node fb-capture.mjs login --channel chrome
node fb-capture.mjs read "https://www.facebook.com/groups/peldacsoport/" --channel chrome --scroll 3 --md
```

`--channel chrome` uses installed Chrome with a dedicated `~/.fb-reader/profile`; it does not reuse
the user's ordinary Chrome login. The user completes login/2FA manually once. Keep this profile on
their computer. To use Playwright's bundled Chromium instead, run `npx playwright install chromium`
and omit `--channel chrome`. This CLI reads/exports content; it has no publishing command.

## Skill-only use (other agents)

Another skill-capable agent can load `plugins/facebook-reader/skills/facebook-reader/` as a plain skill
(Codex discovers `SKILL.md` under `.agents/skills`; copy the folder there if you do not install the plugin).
This registers no hooks and no browser extension. Do not enable both the plugin and a copied skill in Codex at
once, since both appear in its skill selector.

## Approval boundary

A skill-only installation does **not** register hooks, even if Node or approval-token files exist. Use the plugin route above to load the Codex adapter. `PLUGIN_ROOT` is supplied to Codex plugin hooks, with `CLAUDE_PLUGIN_ROOT` as a compatibility
alias. The current adapter keeps Facebook read-only. On other hosts, use their own authorization and
preview controls; the Claude self-notification exception does not transfer automatically.
Reading requests do not authorize comments, reactions, messages or publication.

## Test protocol for a new host (any agent)

Judge the reader only on a run where the script connection works. Host-adapter problems (CDP errors, paused documents,
empty AX snapshots) are the host's, not the reader's. Order:

1. `__fbReader.status()` on the target page: reader present, version. No answer = fix the connection first (extension route, page-world
   evaluator), do not continue with screenshots / AX trees and grade the reader on those.
2. `await __fbReader.ready()` after every navigation.
3. Marketplace: `market({format:'json'})` → `listing('$ref', {format:'json'})` → open the ad → `ready()` → `listing({format:'json'})` →
   `marketScroll({format:'json'})` (look at `added`, `newRefs`) → `marketControl('sort')` (target `[fbr:mk-sort]`).
4. Record: the same fields for every ad, size of the output, full URLs kept, new vs. duplicate ads per scroll, whether the `$ref` / `[fbr:…]`
   targets were usable by the host's click tool.
