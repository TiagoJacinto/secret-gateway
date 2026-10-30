#!/usr/bin/env python3
"""Authentication feasibility probe for issue #1 (approved probe: subscription login, synthetic content, Haiku 5.5 medium effort).

Runs `claude -p` with ANTHROPIC_BASE_URL pointed at a loopback forwarder that relays
to the real Anthropic API. Evidence records metadata only: request paths, statuses and
which auth header NAMES were present. Header values, bodies and stderr are never recorded.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM = 'https://api.anthropic.com'
MODEL = 'claude-haiku-5-5'
EFFORT = 'medium'
PROMPT = 'Reply with exactly: PROBE-OK'
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence/auth-probe.json'
HOP_BY_HOP = {'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
              'upgrade', 'content-length', 'accept-encoding'}
records = []
lock = threading.Lock()


class Forwarder(BaseHTTPRequestHandler):
    def _relay(self):
        length = self.headers.get('Content-Length')
        body = self.rfile.read(int(length)) if length else b''
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        record = {'method': self.command, 'path': self.path.split('?')[0],
                  'authorization_header_present': 'authorization' in {k.lower() for k in self.headers},
                  'x_api_key_header_present': 'x-api-key' in {k.lower() for k in self.headers}}
        request = urllib.request.Request(UPSTREAM + self.path, data=body or None,
                                         headers=headers, method=self.command)
        try:
            upstream = urllib.request.urlopen(request, timeout=120)
        except urllib.error.HTTPError as error:
            upstream = error
        except urllib.error.URLError:
            record['status'] = 502
            with lock:
                records.append(record)
            self.send_error(502)
            return
        record['status'] = upstream.status
        record['content_type'] = upstream.headers.get('Content-Type', '')
        with lock:
            records.append(record)
        self.send_response(upstream.status)
        for name, value in upstream.headers.items():
            if name.lower() not in HOP_BY_HOP:
                self.send_header(name, value)
        self.send_header('Connection', 'close')
        self.end_headers()
        while True:
            chunk = upstream.read1(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
        self.close_connection = True

    do_POST = do_GET = do_HEAD = _relay

    def log_message(self, *args):
        pass


def clean_environment(port):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith('CLAUDE_CODE_') and k not in {
               'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT',
               'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'}}
    env['ANTHROPIC_BASE_URL'] = f'http://127.0.0.1:{port}'
    return env


def run():
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'status': 'FAIL',
              'requested_model': MODEL, 'requested_effort': EFFORT,
              'auth_method': 'claude.ai subscription login (via Claude Code)'}
    server = ThreadingHTTPServer(('127.0.0.1', 0), Forwarder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_port
    command = ['claude', '-p', PROMPT, '--model', MODEL, '--effort', EFFORT,
               '--output-format', 'json']
    started = time.monotonic()
    try:
        completed = subprocess.run(command, env=clean_environment(port), capture_output=True,
                                   text=True, timeout=240, cwd=Path(__file__).parent)
        result['exit_code'] = completed.returncode
        result['duration_seconds'] = round(time.monotonic() - started, 1)
        try:
            reply = json.loads(completed.stdout)
        except json.JSONDecodeError:
            reply = {}
        result['claude_is_error'] = reply.get('is_error')
        result['claude_subtype'] = reply.get('subtype')
        result['claude_result_text'] = str(reply.get('result', ''))[:200]
        result['models_used'] = sorted((reply.get('modelUsage') or {}).keys())
    except subprocess.TimeoutExpired:
        result['reason'] = 'claude -p timed out after 240 seconds'
    finally:
        server.shutdown()
        server.server_close()
    with lock:
        result['forwarded_requests'] = list(records)
    base_url_honoured = len(records) > 0
    authenticated_ok = any(r.get('status') == 200 and r.get('authorization_header_present')
                           and not r.get('x_api_key_header_present') for r in records)
    result['base_url_honoured'] = base_url_honoured
    result['bearer_forwarded_and_200'] = authenticated_ok
    if result.get('exit_code') == 0 and authenticated_ok and result.get('claude_is_error') is False \
            and 'PROBE-OK' in result['claude_result_text']:
        result['status'] = 'PASS'
    elif not base_url_honoured:
        result['reason'] = result.get('reason', 'no request reached the forwarder; base URL ignored')
    else:
        result.setdefault('reason', 'claude reply was not a successful PROBE-OK response')
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print(f'Evidence: {EVIDENCE}')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(run())
