#!/usr/bin/env python3
"""Release helper: bump the version everywhere, rebuild, test, validate, package.

    python3 release.py --bump patch|minor|major      (or --set 0.3.0)
    options: --dry-run   show what would change, touch nothing
             --no-tests  skip tests/run_tests.py
             --commit    git commit + tag vX.Y.Z (no push)
             --github    gh release create vX.Y.Z with the .plugin file and the CHANGELOG section

Version lives in: scripts/fb-reader.js (VERSION), plugin.json, .codex-plugin/plugin.json, marketplace.json, SKILL.md metadata.
CHANGELOG.md: the "## [Unreleased]" block becomes "## [X.Y.Z] - date".
"""
import argparse, datetime, json, pathlib, re, shutil, subprocess, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent
PLUGIN = ROOT / 'plugins' / 'facebook-reader'
SCRIPTS = PLUGIN / 'skills' / 'facebook-reader' / 'scripts'
FILES = {
    'core': SCRIPTS / 'fb-reader.js',
    'plugin': PLUGIN / '.claude-plugin' / 'plugin.json',
    'codex': PLUGIN / '.codex-plugin' / 'plugin.json',
    'market': ROOT / '.claude-plugin' / 'marketplace.json',
    'skill': PLUGIN / 'skills' / 'facebook-reader' / 'SKILL.md',
    'changelog': ROOT / 'CHANGELOG.md',
}


def run(*cmd, check=True, **kw):
    print('  $', ' '.join(map(str, cmd)))
    return subprocess.run(cmd, check=check, cwd=ROOT, **kw)


def current():
    return re.search(r"const VERSION = '([^']+)'", FILES['core'].read_text(encoding='utf-8')).group(1)


def bump(v, how):
    a, b, c = map(int, v.split('.'))
    return {'major': f'{a + 1}.0.0', 'minor': f'{a}.{b + 1}.0', 'patch': f'{a}.{b}.{c + 1}'}[how]


def sub(path, pattern, repl, count=1):
    t = path.read_text(encoding='utf-8')
    n, k = re.subn(pattern, repl, t, count=count)
    if not k:
        sys.exit(f'pattern not found in {path.name}: {pattern}')
    path.write_text(n, encoding='utf-8')


def changelog_section(version):
    t = FILES['changelog'].read_text(encoding='utf-8')
    m = re.search(rf'## \[{re.escape(version)}\][^\n]*\n(.*?)(?=\n## \[|\Z)', t, re.S)
    return m.group(1).strip() if m else ''


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--bump', choices=['major', 'minor', 'patch'])
    g.add_argument('--set')
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--no-tests', action='store_true')
    ap.add_argument('--commit', action='store_true'); ap.add_argument('--github', action='store_true')
    a = ap.parse_args()

    old = current()
    new = a.set or bump(old, a.bump)
    if not re.fullmatch(r'\d+\.\d+\.\d+', new):
        sys.exit('version must be X.Y.Z')
    print(f'{old} → {new}')
    unreleased = re.search(r'## \[Unreleased\]\s*\n(.*?)(?=\n## \[|\Z)', FILES['changelog'].read_text(encoding='utf-8'), re.S)
    if not unreleased or not unreleased.group(1).strip():
        sys.exit('CHANGELOG.md: the [Unreleased] block is empty, describe the changes first')
    if a.dry_run:
        print('dry run: would update', ', '.join(p.name for p in FILES.values()), '+ build, tests, validate, package'); return

    sub(FILES['core'], r"const VERSION = '[^']+'", f"const VERSION = '{new}'")
    sub(FILES['plugin'], r'"version":\s*"[^"]+"', f'"version": "{new}"')
    sub(FILES['codex'], r'"version":\s*"[^"]+"', f'"version": "{new}"')
    sub(FILES['market'], r'"version":\s*"[^"]+"', f'"version": "{new}"')
    sub(FILES['skill'], r'version:\s*"[^"]+"', f'version: "{new}"')
    sub(FILES['changelog'], r'## \[Unreleased\]', f'## [Unreleased]\n\n## [{new}] - {datetime.date.today().isoformat()}')

    run(sys.executable, str(ROOT / 'tests' / 'privacy_scan.py'))   # publishing gate: no personal data in the repo
    run(sys.executable, str(SCRIPTS / 'build.py'))
    if not a.no_tests:
        run(sys.executable, str(ROOT / 'tests' / 'run_tests.py'))
    if shutil.which('claude'):
        run('claude', 'plugin', 'validate', '.')
        run('claude', 'plugin', 'validate', str(PLUGIN))
    else:
        print('  (claude CLI not found: skipped `claude plugin validate`)')

    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    out = dist / f'facebook-reader-{new}.plugin'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(PLUGIN.rglob('*')):
            if f.is_file() and '__pycache__' not in f.parts and f.suffix != '.pyc':
                z.write(f, f.relative_to(PLUGIN))
    print(f'package: {out} ({out.stat().st_size // 1024} KB)')

    if a.commit:
        run('git', 'add', '-A'); run('git', 'commit', '-m', f'Release v{new}'); run('git', 'tag', f'v{new}')
    if a.github:
        notes = changelog_section(new) or f'facebook-reader {new}'
        (dist / 'notes.md').write_text(notes, encoding='utf-8')
        run('gh', 'release', 'create', f'v{new}', str(out), '--title', f'facebook-reader {new}', '--notes-file', str(dist / 'notes.md'))
    print('done. Next: git push --follow-tags' if a.commit else 'done.')


if __name__ == '__main__':
    main()
