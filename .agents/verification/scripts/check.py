#!/usr/bin/env python3
"""Synthetic HTTP-boundary smoke check; no real API or login."""
import json
import os
from pathlib import Path
import re
import shlex
import sys
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence'
SECRET = 'synthetic-password-for-gateway-check-12345'
received = []


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        received.append((self.path, body))
        tokens = re.findall(r'⟦SECRET_[0-9a-f]{6}⟧', json.dumps(body, ensure_ascii=False))
        reply = {'id': 'msg_fake', 'type': 'message', 'role': 'assistant',
                 'model': 'synthetic-model', 'content': [{'type': 'tool_use',
                 'id': 'tool_fake', 'name': 'use_credential',
                 'input': {'credential': tokens[0] if tokens else 'MASKING_MISSING'}}],
                 'stop_reason': 'tool_use', 'stop_sequence': None,
                 'usage': {'input_tokens': 1, 'output_tokens': 1}}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def run():
    result = {'status': 'FAIL', 'phase': 'launch', 'checks': []}
    process = server = None
    try:
        command = shlex.split(os.environ.get('GATEWAY_COMMAND', 'bun run start'))
        if command == ['bun', 'run', 'start']:
            manifest = ROOT / 'package.json'
            if not manifest.exists() or not json.loads(manifest.read_text()).get('scripts', {}).get('start'):
                raise RuntimeError('Gateway missing: package.json has no start script; HTTP behavior cannot be exercised yet')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix='gateway-check-') as directory, tempfile.TemporaryFile() as logs:
            env = os.environ.copy()
            env.update(HOST='127.0.0.1', PORT=str(port), GATEWAY_DATA_DIR=directory,
                       UPSTREAM_BASE_URL=f'http://127.0.0.1:{server.server_port}')
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=logs,
                                       stderr=logs, start_new_session=True)
            result['phase'] = 'doctor'
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f'Gateway exited with code {process.returncode}')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Assigned port unavailable after 10 seconds')
                    time.sleep(0.05)
            result['checks'].append('launched process alive and assigned port reachable')
            result['phase'] = 'drive'
            payload = {'model': 'synthetic-model', 'max_tokens': 128,
                       'messages': [{'role': 'user', 'content': f'PASSWORD={SECRET}'}]}
            request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages',
                data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json',
                'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01'})
            with urllib.request.urlopen(request, timeout=15) as response:
                reply = json.load(response)
            assert len(received) == 1, 'Expected one upstream request'
            path, body = received[0]
            assert path == '/v1/messages', 'Wrong upstream route'
            forwarded = json.dumps(body, ensure_ascii=False)
            assert SECRET not in forwarded, 'Raw synthetic credential reached upstream'
            assert re.search(r'⟦SECRET_[0-9a-f]{6}⟧', forwarded), 'Placeholder missing'
            result['checks'].append('upstream masking')
            assert reply['content'][0]['input']['credential'] == SECRET, 'Tool input not restored'
            result['checks'].append('client tool input restored')
            assert body.get('system'), 'System prompt note missing'
            result['checks'].append('system note present; semantics need further coverage')
            result['status'] = 'PASS'
    except Exception as error:
        result['reason'] = str(error)
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except ProcessLookupError:
                pass
        if server is not None:
            server.shutdown()
            server.server_close()
        result['cleanup'] = 'run-owned processes stopped; temporary data removed'
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        evidence = EVIDENCE / 'http-smoke.json'
        evidence.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        print(f'Evidence: {evidence}')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    smoke_code = run()
    sys.path.insert(0, str(Path(__file__).parent))
    import journeys
    results, context = journeys.run_journeys()
    path, report = journeys.write_evidence(results, context)
    print(json.dumps({'journeys': report['status'], 'failed': [r['journey'] for r in results if r['status'] != 'PASS']}, indent=2))
    print(f'Journey evidence: {path}')
    import responses_check
    responses_check.run()
    raise SystemExit(0 if smoke_code == 0 and report['status'] == 'PASS' else 1)
