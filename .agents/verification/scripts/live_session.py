#!/usr/bin/env python3
"""One live masking session through a running gateway, or a no-model self-test of its stderr rule.

Usage:
  live_session.py claude|codex    run one live session through the masked CLI
  live_session.py --self-test     check the stderr rule without a model call

A session sends one synthetic GitHub-token-shaped value through the masked CLI, then records
booleans, counts and file paths only. The value and the reply text are never printed or kept.
Scratch files go to the system temporary directory (TMPDIR) and are removed at the end.
"""
import json
import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOME = Path.home()
EVIDENCE = HOME / '.agents/projects/secret-gateway/goals/issue-1/evidence'
PLACEHOLDER = re.compile(r'⟦SECRET_[0-9A-Za-z]+⟧')
ALNUM = string.ascii_letters + string.digits

SESSIONS = {
    'claude': {
        'model': 'claude-haiku-5-5',
        'data': HOME / '.local/share/secret-gateway',
        'route': '/v1/messages',
        'command': lambda prompt, out, work: ['claude-masked', '-p', '--model', 'claude-haiku-5-5',
                                              '--effort', 'low', '--no-session-persistence', prompt],
        'agent_dirs': [HOME / '.claude'],
    },
    'codex': {
        'model': 'gpt-5.6-terra',
        'data': HOME / '.local/share/secret-gateway',
        'route': '/codex/responses',
        'command': lambda prompt, out, work: ['codex-masked', 'exec', '--ephemeral', '--skip-git-repo-check',
                                              '-m', 'gpt-5.6-terra', '-o', str(out), '-C', str(work), prompt],
        'agent_dirs': [HOME / '.codex'],
    },
}


def new_value() -> str:
    return 'ghp_' + ''.join(secrets.choice(ALNUM) for _ in range(36))


def make_prompt(value: str) -> str:
    return ('Below is one line from a configuration file. Reply with only the value after the equals sign, '
            'exactly as written. Do not read files or run commands.\n'
            f'GITHUB_TOKEN={value}')


def stderr_leaks(tool: str, stderr: str, value: str) -> bool:
    """True when the value appears in stderr outside the prompt echo.

    `codex exec` prints its prompt to stderr, so the prompt's GITHUB_TOKEN line appears there.
    For codex, only that exact line (ignoring surrounding whitespace) is removed. Any other
    occurrence of the value is a leak. Claude stderr is checked in full.
    """
    if tool == 'codex':
        echo = f'GITHUB_TOKEN={value}'
        stderr = '\n'.join(line for line in stderr.splitlines() if line.strip() != echo)
    return any(needle in stderr for needle in (value, value[-20:]))


def self_test() -> int:
    value = new_value()
    prompt = make_prompt(value)
    cases = [
        ('codex: value only in the echo line', 'codex', f'user\n{prompt}\nprovider unreachable\n', False),
        ('codex: value outside the echo line', 'codex', f'{prompt}\nerror: {value}\n', True),
        ('codex: echo line with a prefix', 'codex', f'user GITHUB_TOKEN={value}\n', True),
        ('codex: no value', 'codex', 'provider unreachable\n', False),
        ('claude: value in stderr', 'claude', f'GITHUB_TOKEN={value}\n', True),
        ('claude: no value', 'claude', 'no output\n', False),
    ]
    failures = 0
    for name, tool, stderr, expected in cases:
        leak = stderr_leaks(tool, stderr, value)
        ok = leak == expected
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'} {name}: leak={leak} expected={expected}")
    print(f"self-test {'PASS' if failures == 0 else 'FAIL'}")
    return 0 if failures == 0 else 1


def run_session(tool: str) -> int:
    scratch = Path(tempfile.mkdtemp(prefix=f'live-{tool}-'))
    try:
        return _session(tool, scratch)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _session(tool: str, scratch: Path) -> int:
    config = SESSIONS[tool]
    work = scratch / 'work'
    work.mkdir()
    out = scratch / 'last-message.txt'

    value = new_value()
    prompt = make_prompt(value)
    needles = (value, value[-20:])

    data = config['data']
    log = data / 'gateway.log'
    log_offset = log.stat().st_size if log.exists() else 0
    started = time.time()

    exit_code = None
    stdout = stderr = ''
    try:
        result = subprocess.run(config['command'](prompt, out, work), stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=300)
        exit_code, stdout, stderr = result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        pass

    reply = stdout + (out.read_text() if out.exists() else '')
    new_log = log.read_bytes()[log_offset:].decode('utf-8', 'replace') if log.exists() else ''
    route_lines = [line for line in new_log.splitlines() if config['route'] in line]
    route_200 = [line for line in route_lines if re.search(re.escape(config['route']) + r' 200 ', line)]
    masked_counts = [int(m.group(1)) for line in route_200 if (m := re.search(r'masked=(\d+)', line))]

    def holds_value(path: Path) -> bool:
        try:
            blob = path.read_bytes()
        except OSError:
            return False
        return any(needle.encode() in blob for needle in needles)

    recent = []
    for root in [data, scratch, *config['agent_dirs']]:
        if not root.exists():
            continue
        candidates = [root] if root.is_file() else [p for p in root.rglob('*') if p.is_file()]
        for path in candidates:
            try:
                if path.stat().st_mtime >= started - 1 and holds_value(path):
                    recent.append(path)
            except OSError:
                continue

    value_store = data / 'values.sqlite'
    in_value_store = [p for p in recent if p.name.startswith('values.sqlite')]
    outside_value_store = [str(p) for p in recent if not p.name.startswith('values.sqlite')]

    echo = f'GITHUB_TOKEN={value}'
    report = {
        'tool': tool,
        'model': config['model'],
        'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'exit_code': exit_code,
        'placeholder_in_reply': bool(PLACEHOLDER.search(reply)),
        'reply_chars': len(reply),
        'value_in_reply': any(needle in reply for needle in needles),
        'codex_echo_line_in_stderr': (any(line.strip() == echo for line in stderr.splitlines())
                                      if tool == 'codex' else None),
        'value_in_stderr': stderr_leaks(tool, stderr, value),
        'gateway_route_lines': len(route_lines),
        'gateway_route_200_lines': len(route_200),
        'masked_counts_on_200': masked_counts,
        'value_in_new_gateway_log_lines': any(needle in new_log for needle in needles),
        'value_store_holds_value': bool(in_value_store),
        'value_store_mode_0600': value_store.exists() and (value_store.stat().st_mode & 0o777) == 0o600,
        'files_outside_value_store_holding_value': outside_value_store,
    }
    report['status'] = 'PASS' if (
        report['exit_code'] == 0
        and report['placeholder_in_reply']
        and not report['value_in_reply']
        and not report['value_in_stderr']
        and report['gateway_route_200_lines'] > 0
        and not report['value_in_new_gateway_log_lines']
        and report['value_store_holds_value']
        and report['value_store_mode_0600']
        and not outside_value_store
    ) else 'FAIL'

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / f'live-{tool}-session.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    print('route lines:')
    for line in route_lines:
        # A line that holds the value is hidden here; the report already marks it as FAIL.
        if not any(needle in line for needle in needles):
            print(line)
    return 0 if report['status'] == 'PASS' else 1


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in (*SESSIONS, '--self-test'):
        print(__doc__, file=sys.stderr)
        return 2
    if sys.argv[1] == '--self-test':
        return self_test()
    return run_session(sys.argv[1])


if __name__ == '__main__':
    sys.exit(main())
