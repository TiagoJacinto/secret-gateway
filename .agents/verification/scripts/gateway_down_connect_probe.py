#!/usr/bin/env python3
"""Connect-level gateway-down check for issue #1 story 2 (approved 2026-10-30: one live run under strace).

Runs `claude -p` under strace with ANTHROPIC_BASE_URL pointed at a loopback port where nothing listens.
strace records only connect() calls, so the evidence shows which destinations Claude Code tried.
The check passes only when Claude Code gives no reply, the trace captured connects, the base URL was
tried, and no remote connect() on port 443 was attempted. Evidence stores addresses, ports and flags
only. Request and reply content are never stored.
"""
import argparse
import json
import re
import socket
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from auth_probe import clean_environment
from gateway_down_probe import EFFORT, MARKER, MODEL, PROMPT, closed_port

API_HOST = 'api.anthropic.com'
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-down-connect.json'
EVIDENCE_PROXY = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-down-connect-proxy.json'
INET_PORT = re.compile(r'sin6?_port=htons\((\d+)\)')
INET_ADDRESS = re.compile(r'inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"')


def api_addresses():
    try:
        infos = socket.getaddrinfo(API_HOST, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return set()
    return {info[4][0] for info in infos}


def parse_connects(trace_text):
    """Return the set of (address, port) inet destinations and the count of unix-socket connects."""
    destinations = set()
    unix_count = 0
    for line in trace_text.splitlines():
        if 'connect(' not in line or 'sa_family=' not in line:
            continue
        if 'sa_family=AF_UNIX' in line:
            unix_count += 1
            continue
        port = INET_PORT.search(line)
        address = INET_ADDRESS.search(line)
        if port and address:
            destinations.add((address.group(1) or address.group(2), int(port.group(1))))
    return destinations, unix_count


def verdict(result):
    if result.get('marker_in_reply'):
        return 'FAIL', 'reply received with the gateway down: the request bypassed the gateway'
    if 'exit_code' not in result:
        return 'FAIL', result['reason']
    if result['exit_code'] == 0:
        return 'FAIL', 'claude -p exited 0 without the marker; the outcome is unexpected'
    if not result['trace_captured']:
        return 'FAIL', 'strace captured no connect() calls; the trace is not usable'
    if not result['base_url_connect_attempted']:
        return 'FAIL', 'no connect() to the base URL; the run does not show base URL routing'
    if result['remote_443_destinations']:
        return 'FAIL', 'a remote connect() on port 443 was attempted; a direct API request is not ruled out'
    return 'PASS', 'no reply, base URL attempted, and no remote port-443 connect() attempted'


def proxy_environment(proxy_port):
    """Proxy variables for the variant run. The base URL stays direct so its connect is still traced."""
    proxy = f'http://127.0.0.1:{proxy_port}'
    return {'HTTPS_PROXY': proxy, 'HTTP_PROXY': proxy, 'NO_PROXY': '127.0.0.1,localhost',
            'NODE_USE_ENV_PROXY': '1'}


def run(proxy):
    port = closed_port()
    resolved = api_addresses()
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'status': 'FAIL',
              'requested_model': MODEL, 'requested_effort': EFFORT,
              'base_url': f'http://127.0.0.1:{port}', 'trace_method': 'strace -f -e trace=connect',
              'auth_method': 'claude.ai subscription login (via Claude Code)',
              'api_host_addresses': sorted(resolved), 'proxy_mode': proxy}
    environment = clean_environment(port)
    proxy_port = None
    if proxy:
        proxy_port = closed_port()
        environment.update(proxy_environment(proxy_port))
        result['proxy_variables'] = sorted(proxy_environment(proxy_port))
    command = ['claude', '-p', PROMPT, '--model', MODEL, '--effort', EFFORT, '--output-format', 'json']
    started = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as directory:
        trace_file = Path(directory) / 'connect.trace'
        traced = ['strace', '-f', '-e', 'trace=connect', '-o', str(trace_file)] + command
        try:
            completed = subprocess.run(traced, env=environment, capture_output=True,
                                       text=True, timeout=240, cwd=Path(__file__).parent)
        except subprocess.TimeoutExpired:
            result['reason'] = 'claude -p under strace timed out after 240 seconds'
        else:
            result['exit_code'] = completed.returncode
            try:
                reply = json.loads(completed.stdout)
            except json.JSONDecodeError:
                reply = {}
            result['claude_is_error'] = reply.get('is_error')
            result['marker_in_reply'] = MARKER in str(reply.get('result', ''))
            result['models_used'] = sorted((reply.get('modelUsage') or {}).keys())
        trace_text = trace_file.read_text() if trace_file.exists() else ''
        destinations, unix_count = parse_connects(trace_text)
    remote = sorted((address, p) for address, p in destinations
                    if not address.startswith('127.') and address != '::1')
    result['duration_seconds'] = round((datetime.now(timezone.utc) - started).total_seconds(), 1)
    result['trace_captured'] = bool(destinations or unix_count)
    result['base_url_connect_attempted'] = ('127.0.0.1', port) in destinations
    result['unix_socket_connects'] = unix_count
    result['remote_destinations'] = [f'{address}:{p}' for address, p in remote]
    result['remote_443_destinations'] = [f'{address}:{p}' for address, p in remote if p == 443]
    result['remote_443_matches_api_dns'] = any(address in resolved for address, p in remote if p == 443)
    if proxy:
        result['proxy_connect_attempted'] = ('127.0.0.1', proxy_port) in destinations
    result['status'], result['reason'] = verdict(result)
    evidence = EVIDENCE_PROXY if proxy else EVIDENCE
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print(f'Evidence: {evidence}')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Gateway-down connect check, optionally with a closed HTTPS proxy.')
    parser.add_argument('--proxy', action='store_true', help='also set HTTPS_PROXY to a closed loopback port')
    sys.exit(run(parser.parse_args().proxy))
