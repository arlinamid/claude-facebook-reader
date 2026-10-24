"""Native Codex adapter checks using synthetic hook events only."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT / 'plugins' / 'facebook-reader'
GUARD = PLUGIN / 'hooks' / 'fb-codex-guard.mjs'


class CodexHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fb-codex-test-')
        self.addCleanup(self.temp.cleanup)
        self.env = dict(os.environ, TMPDIR=self.temp.name, TEMP=self.temp.name, TMP=self.temp.name,
                        HOME=self.temp.name, USERPROFILE=self.temp.name)
        self.session = str(uuid.uuid4())

    def hook(self, name, args, post=False, response=None, guard=GUARD, session=None):
        event = {'session_id': session or self.session, 'cwd': str(ROOT), 'tool_name': name,
                 'hook_event_name': 'PostToolUse' if post else 'PreToolUse', 'tool_input': args}
        if post:
            event['tool_response'] = response
        result = subprocess.run(['node', str(guard)], input=json.dumps(event), capture_output=True,
                                text=True, encoding='utf-8', env=self.env, timeout=12)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def navigate(self, url='https://www.facebook.com/groups/peldacsoport/', tab=1, session=None):
        self.hook('mcp__codex_chrome__browser_navigate', {'tabId': tab, 'url': url},
                  post=True, response={'content': [{'type': 'text', 'text': 'ok'}]}, session=session)

    def assert_denied(self, output):
        specific = output['hookSpecificOutput']
        self.assertEqual(specific['hookEventName'], 'PreToolUse')
        self.assertEqual(specific['permissionDecision'], 'deny')
        self.assertTrue(specific['permissionDecisionReason'])

    def test_compact_reader_expressions_pass(self):
        self.navigate()
        for expression in ('window.__fbReader.where()', 'window.__fbReader.map({limit:8})',
                           "await window.__fbReader.peek('#abcd')"):
            self.assertEqual(self.hook('mcp__codex_chrome__browser_evaluate',
                                      {'tabId': 1, 'expression': expression}), {})

    def test_expression_writes_are_denied(self):
        self.navigate()
        for expression in ('document.querySelector("button").click()',
                           'document.querySelector("input").value = "test"'):
            self.assert_denied(self.hook('mcp__codex_chrome__browser_evaluate',
                                        {'tabId': 1, 'expression': expression}))

    def test_typing_click_upload_and_enter_are_denied(self):
        self.navigate()
        for name, args in (
            ('browser_type', {'text': 'post text', 'elementId': 'send', 'submit': True}),
            ('browser_click', {'elementId': 'send'}),
            ('file_upload', {'paths': ['test.png']}),
            ('computer', {'action': 'key', 'text': 'Enter'}),
        ):
            self.assert_denied(self.hook('mcp__codex_chrome__' + name, {'tabId': 1, **args}))

    def test_known_other_site_passes_but_unknown_tab_is_guarded(self):
        self.navigate('https://example.com/', tab=2)
        self.assertEqual(self.hook('mcp__codex_chrome__browser_type', {'tabId': 2, 'text': 'search'}), {})
        self.assert_denied(self.hook('mcp__codex_chrome__browser_type', {'tabId': 99, 'text': 'post'}))

    def test_sessions_do_not_share_tab_state(self):
        self.navigate('https://example.com/', tab=2, session='other-session')
        self.assert_denied(self.hook('mcp__codex_chrome__browser_type', {'tabId': 2, 'text': 'post'}))

    def test_structured_tab_list_is_tracked(self):
        self.hook('mcp__codex_chrome__browser_tabs_list', {}, post=True, response={
            'content': [{'type': 'text', 'text': json.dumps({'tabs': [
                {'id': 5, 'url': 'https://example.com/'}]})}]})
        self.assertEqual(self.hook('mcp__codex_chrome__browser_type', {'tabId': 5, 'text': 'search'}), {})

    def test_failed_navigation_does_not_change_known_target(self):
        self.navigate()
        self.hook('mcp__codex_chrome__browser_navigate', {'tabId': 1, 'url': 'https://example.com/'},
                  post=True, response={'isError': True})
        self.assert_denied(self.hook('mcp__codex_chrome__browser_type', {'tabId': 1, 'text': 'post'}))

    def test_batches_and_approval_commands_cannot_reuse_claude_tokens(self):
        self.assert_denied(self.hook('mcp__codex_chrome__browser_batch', {'actions': []}))
        self.assert_denied(self.hook('Bash', {'command': 'node fb-approve.mjs --kind post --text test'}))
        self.assertEqual(self.hook('Bash', {'command': 'python --version'}), {})

    def test_exact_reader_bundle_passes_from_path_with_spaces(self):
        import shutil
        target = pathlib.Path(self.temp.name) / 'plugin with spaces'
        shutil.copytree(PLUGIN, target, ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
        expression = (target / 'skills' / 'facebook-reader' / 'scripts' / 'fb-reader.min.js').read_text(encoding='utf-8')
        self.assertEqual(self.hook('mcp__codex_chrome__browser_evaluate',
                                  {'tabId': 1, 'expression': expression},
                                  guard=target / 'hooks' / 'fb-codex-guard.mjs'), {})

    def test_claude_guard_recognises_reader_bundle_from_path_with_spaces(self):
        import shutil
        target = pathlib.Path(self.temp.name) / 'plugin with spaces'
        shutil.copytree(PLUGIN, target, ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
        code = (target / 'skills' / 'facebook-reader' / 'scripts' / 'fb-reader.min.js').read_text(encoding='utf-8')
        self.navigate()
        self.assertEqual(self.hook('mcp__claude-in-chrome__javascript_tool', {'tabId': 1, 'text': code},
                                  guard=target / 'hooks' / 'fb-write-guard.mjs'), {})

    def test_malformed_event_blocks_with_supported_exit_code(self):
        result = subprocess.run(['node', str(GUARD)], input='{broken', capture_output=True,
                                text=True, encoding='utf-8', env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('hook failed', result.stderr)

    def test_codex_manifest_selects_native_hooks_not_the_claude_ones(self):
        manifest = json.loads((PLUGIN / '.codex-plugin' / 'plugin.json').read_text(encoding='utf-8'))
        # Codex loads hooks/hooks.json by default; that is the Claude file (answers "ask", which Codex fails open on).
        self.assertEqual(manifest['hooks'], './hooks/codex-hooks.json')
        hooks = json.loads((PLUGIN / manifest['hooks']).read_text(encoding='utf-8'))
        self.assertIn('PreToolUse', hooks['hooks'])
        self.assertIn('PostToolUse', hooks['hooks'])
        import re
        for event, groups in hooks['hooks'].items():
            for group in groups:
                self.assertTrue(re.search(group['matcher'], 'mcp__codex_chrome__browser_navigate'))
                for handler in group['hooks']:
                    self.assertNotIn('--dangerously', handler['command'])
                    self.assertIn('fb-codex-guard.mjs', handler['command'])
                    self.assertTrue((PLUGIN / 'hooks' / 'fb-codex-guard.mjs').exists())

    def test_manifests_and_marketplaces_agree(self):
        claude = json.loads((PLUGIN / '.claude-plugin' / 'plugin.json').read_text(encoding='utf-8'))
        codex = json.loads((PLUGIN / '.codex-plugin' / 'plugin.json').read_text(encoding='utf-8'))
        self.assertEqual((claude['name'], claude['version']), (codex['name'], codex['version']))
        for rel in ('.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'):
            market = json.loads((ROOT / rel).read_text(encoding='utf-8'))
            entry = [p for p in market['plugins'] if p['name'] == codex['name']][0]
            source = entry['source'] if isinstance(entry['source'], str) else entry['source']['path']
            self.assertEqual((ROOT / source).resolve(), PLUGIN.resolve(), rel)
        self.assertEqual(json.loads((ROOT / '.claude-plugin' / 'marketplace.json').read_text(encoding='utf-8'))['name'],
                         json.loads((ROOT / '.agents' / 'plugins' / 'marketplace.json').read_text(encoding='utf-8'))['name'])

    def test_shared_guard_is_not_forked(self):
        # the adapter must call the one guard in this directory, not a copy
        self.assertTrue((PLUGIN / 'hooks' / 'fb-write-guard.mjs').exists())
        self.assertIn("path.join(here, 'fb-write-guard.mjs')", GUARD.read_text(encoding='utf-8'))
        self.assertEqual(sorted(p.name for p in ROOT.rglob('fb-write-guard.mjs')), ['fb-write-guard.mjs'])

    def test_claude_approval_tokens_do_not_unlock_codex(self):
        # a valid Claude approval/self registration in the temp dir / HOME must be ignored by the adapter
        self.navigate()
        (pathlib.Path(self.temp.name) / '.fb-reader').mkdir()
        (pathlib.Path(self.temp.name) / '.fb-reader' / 'self.json').write_text(json.dumps({
            'enabled': True, 'accountId': '1', 'threadUrl': 'https://www.facebook.com/messages/t/1/'}), encoding='utf-8')
        expiry = '2999-01-01T00:00:00Z'
        (pathlib.Path(self.temp.name) / 'fb-reader-approval.json').write_text(json.dumps({
            'kind': 'comment', 'text': 'x', 'expiresAt': expiry, 'url': 'https://www.facebook.com/'}), encoding='utf-8')
        self.assert_denied(self.hook('mcp__codex_chrome__browser_type', {'tabId': 1, 'text': 'x'}))

if __name__ == '__main__':
    unittest.main()
