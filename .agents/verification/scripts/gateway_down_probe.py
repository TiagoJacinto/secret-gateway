#!/usr/bin/env python3
"""Gateway-down check for issue #1 story 2 (approved 2026-10-30: one live run, synthetic prompt).

Runs `claude -p` with ANTHROPIC_BASE_URL pointed at a loopback port where nothing listens. The check
passes only when Claude Code fails and the marker is absent from its reply, so the request did not
reach the API directly. Evidence records metadata only: exit code, error flags and whether the marker
appeared. Reply text and stderr are never stored.
"""
import json
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from auth_probe import clean_environment

MODEL = 'claude-haiku-5-5'
EFFORT = 'medium'
MARKER = 'GATEWAY-DOWN-CHECK'
PROMPT = f'Reply with exactly: {MARKER}'
CONNECTION_ERRORS = ('ECONNREFUSED', 'Unable to connect', 'Connection refused')
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-down.json'


def closed_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def run():
    port = closed_port()
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'status': 'FAIL',
              'requested_model': MODEL, 'requested_effort': EFFORT,
              'base_url': f'http://127.0.0.1:{port}',
              'auth_method': 'claude.ai subscription login (via Claude Code)'}
    command = ['claude', '-p', PROMPT, '--model', MODEL, '--effort', EFFORT,
               '--output-format', 'json']
    started = datetime.now(timezone.utc)
    try:
        completed = subprocess.run(command, env=clean_environment(port), capture_output=True,
                                   text=True, timeout=240, cwd=Path(__file__).parent)
    except subprocess.TimeoutExpired:
        result['reason'] = 'claude -p timed out after 240 seconds'
    else:
        result['exit_code'] = completed.returncode
        result['connection_error_in_stderr'] = any(text in completed.stderr for text in CONNECTION_ERRORS)
        try:
            reply = json.loads(completed.stdout)
        except json.JSONDecodeError:
            reply = {}
        result['claude_is_error'] = reply.get('is_error')
        result['marker_in_reply'] = MARKER in str(reply.get('result', ''))
        result['models_used'] = sorted((reply.get('modelUsage') or {}).keys())
    result['duration_seconds'] = round((datetime.now(timezone.utc) - started).total_seconds(), 1)
    if result.get('marker_in_reply'):
        result['reason'] = 'claude -p got the marker reply with the gateway down: the request bypassed the gateway'
    elif result.get('exit_code') == 0:
        result['reason'] = 'claude -p exited 0 without the marker; the outcome is unexpected'
    elif 'exit_code' in result:
        result['status'] = 'PASS'
        result['reason'] = 'claude -p failed with the gateway down and gave no reply'
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print(f'Evidence: {EVIDENCE}')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(run())
