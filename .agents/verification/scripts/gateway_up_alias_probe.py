#!/usr/bin/env python3
"""Gateway-running check for issue #1 (approved 2026-10-30: one live run through the real gateway).

Starts the real gateway with a recording forwarder as its upstream. Runs `claude -p` under strace with the
README alias environment (base URL to the gateway, proxy settings to closed port 9). The prompt holds a
synthetic fake key. The check passes only when the reply carries the marker, a Messages request reached the
upstream with a placeholder and without the fake key, and Claude Code made no remote connect().
The forwarder refuses to forward a request that still holds the fake key. Evidence stores booleans, statuses
and addresses only. The fake key, prompt and reply text are never stored.
"""
import json
import os
import re
import secrets
import signal
import socket
import string
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from auth_probe import clean_environment
from gateway_down_connect_probe import parse_connects, proxy_environment
from gateway_down_probe import EFFORT, MODEL, closed_port

REPO_ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-up-alias.json'
UPSTREAM = 'https://api.anthropic.com'
MARKER = 'GATEWAY-UP-CHECK'
PROXY_PORT = 9
HOP_BY_HOP = {'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
              'upgrade', 'content-length', 'accept-encoding'}
state = {'fake': '', 'records': []}
lock = threading.Lock()


class Forwarder(BaseHTTPRequestHandler):
    def _relay(self):
        length = self.headers.get('Content-Length')
        body = self.rfile.read(int(length)) if length else b''
        text = body.decode('utf-8', 'replace')
        record = {'method': self.command, 'path': self.path.split('?')[0],
                  'authorization_header_present': 'authorization' in {k.lower() for k in self.headers},
                  'fake_value_present': state['fake'] in text,
                  'placeholder_present': 'SECRET_' in text}
        if record['fake_value_present']:
            record['forwarded'] = False
            with lock:
                state['records'].append(record)
            self.send_error(502)
            return
        record['forwarded'] = True
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        request = urllib.request.Request(UPSTREAM + self.path, data=body or None,
                                         headers=headers, method=self.command)
        try:
            upstream = urllib.request.urlopen(request, timeout=120)
        except urllib.error.HTTPError as error:
            upstream = error
        except urllib.error.URLError:
            record['status'] = 502
            with lock:
                state['records'].append(record)
            self.send_error(502)
            return
        record['status'] = upstream.status
        with lock:
            state['records'].append(record)
        self.send_response(upstream.status)
        for name, value in upstream.headers.items():
            if name.lower() not in HOP_BY_HOP:
                self.send_header(name, value)
        self.send_header('Connection', 'close')
        self.end_headers()
        reader = getattr(upstream, 'read1', upstream.read)
        while True:
            chunk = reader(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
        self.close_connection = True

    do_POST = do_GET = do_HEAD = _relay

    def log_message(self, *args):
        pass


def fake_anthropic_key():
    alphabet = string.ascii_letters + string.digits + '_-'
    return 'sk-ant-api03-' + ''.join(secrets.choice(alphabet) for _ in range(93)) + 'AA'


def port_listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def wait_for_port(port, process, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if port_listening(port):
            return True
        time.sleep(0.2)
    return False


def start_gateway(port, upstream_port, data_dir):
    environment = {k: v for k, v in os.environ.items() if 'PROXY' not in k.upper()}
    environment.update({'HOST': '127.0.0.1', 'PORT': str(port),
                        'UPSTREAM_BASE_URL': f'http://127.0.0.1:{upstream_port}',
                        'GATEWAY_DATA_DIR': str(data_dir)})
    return subprocess.Popen(['bun', 'run', 'start'], cwd=REPO_ROOT, env=environment,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def stop_gateway(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def verdict(result):
    if 'exit_code' not in result:
        return 'FAIL', result['reason']
    if result['fake_value_seen_upstream'] or result['fake_value_blocked_at_forwarder']:
        return 'FAIL', 'the gateway sent the fake key upstream: masking failed'
    if result['exit_code'] != 0 or not result['marker_in_reply']:
        return 'FAIL', 'no successful reply with the marker'
    if result['forwarded_messages'] == 0:
        return 'FAIL', 'no Messages request reached the upstream'
    if not result['placeholder_seen_upstream']:
        return 'FAIL', 'no placeholder reached the upstream'
    if not result['trace_captured'] or not result['gateway_connect_attempted']:
        return 'FAIL', 'the trace does not show a connect to the gateway'
    if result['remote_destinations']:
        return 'FAIL', 'a remote connect() was attempted outside the gateway'
    return 'PASS', 'reply with marker; Messages reached upstream with placeholder and without the fake key; no remote connect'


def run():
    fake = fake_anthropic_key()
    state['fake'] = fake
    prompt = f'Reply with exactly: {MARKER}. Synthetic config line: ANTHROPIC_API_KEY={fake}'
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'status': 'FAIL',
              'requested_model': MODEL, 'requested_effort': EFFORT,
              'alias_environment': ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
                                    'NODE_USE_ENV_PROXY'],
              'auth_method': 'claude.ai subscription login (via Claude Code)'}
    if port_listening(PROXY_PORT):
        result['reason'] = f'port {PROXY_PORT} has a listener, so the proxy setting would not be closed'
        return write_and_report(result)
    forwarder = ThreadingHTTPServer(('127.0.0.1', 0), Forwarder)
    threading.Thread(target=forwarder.serve_forever, daemon=True).start()
    gateway_port = closed_port()
    result['gateway_port_used'] = gateway_port
    with tempfile.TemporaryDirectory() as data_dir:
        gateway = start_gateway(gateway_port, forwarder.server_port, Path(data_dir))
        try:
            if not wait_for_port(gateway_port, gateway):
                result['reason'] = 'the gateway did not start listening'
            else:
                trace_file = Path(data_dir) / 'connect.trace'
                environment = clean_environment(gateway_port)
                environment.update(proxy_environment(PROXY_PORT))
                command = ['strace', '-f', '-e', 'trace=connect', '-o', str(trace_file),
                           'claude', '-p', prompt, '--model', MODEL, '--effort', EFFORT,
                           '--output-format', 'json']
                started = datetime.now(timezone.utc)
                try:
                    completed = subprocess.run(command, env=environment, capture_output=True, text=True,
                                               timeout=240, cwd=REPO_ROOT / '.agents/verification/scripts')
                except subprocess.TimeoutExpired:
                    result['reason'] = 'claude -p through the gateway timed out after 240 seconds'
                else:
                    result['exit_code'] = completed.returncode
                    try:
                        reply = json.loads(completed.stdout)
                    except json.JSONDecodeError:
                        reply = {}
                    result['claude_is_error'] = reply.get('is_error')
                    result['marker_in_reply'] = MARKER in str(reply.get('result', ''))
                    result['models_used'] = sorted((reply.get('modelUsage') or {}).keys())
                result['duration_seconds'] = round((datetime.now(timezone.utc) - started).total_seconds(), 1)
                destinations, unix_count = parse_connects(trace_file.read_text() if trace_file.exists() else '')
                remote = sorted((address, p) for address, p in destinations
                                if not address.startswith('127.') and address != '::1')
                result['trace_captured'] = bool(destinations or unix_count)
                result['gateway_connect_attempted'] = ('127.0.0.1', gateway_port) in destinations
                result['proxy_connect_attempted'] = ('127.0.0.1', PROXY_PORT) in destinations
                result['remote_destinations'] = [f'{address}:{p}' for address, p in remote]
        finally:
            stop_gateway(gateway)
            forwarder.shutdown()
            forwarder.server_close()
    with lock:
        records = list(state['records'])
    messages = [r for r in records if r['path'].endswith('/messages')]
    forwarded = [r for r in messages if r['forwarded']]
    result['forwarded_messages'] = len(forwarded)
    result['upstream_statuses'] = sorted({r.get('status') for r in forwarded if r.get('status') is not None})
    result['authorization_header_present'] = any(r['authorization_header_present'] for r in forwarded)
    result['placeholder_seen_upstream'] = any(r['placeholder_present'] for r in forwarded)
    result['fake_value_seen_upstream'] = any(r['fake_value_present'] and r['forwarded'] for r in records)
    result['fake_value_blocked_at_forwarder'] = any(r['fake_value_present'] and not r['forwarded'] for r in records)
    if 'trace_captured' not in result:
        result['trace_captured'] = False
    result['status'], result['reason'] = verdict(result) if 'reason' not in result else ('FAIL', result['reason'])
    return write_and_report(result)


def write_and_report(result):
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print(f'Evidence: {EVIDENCE}')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(run())
