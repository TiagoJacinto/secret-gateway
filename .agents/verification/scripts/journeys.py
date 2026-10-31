#!/usr/bin/env python3
"""HTTP-boundary journeys for issue #1, run by check.py.

Each journey starts real gateway processes (bun run start) against a loopback fake upstream and asserts on
what the upstream received and what the client received. Synthetic fixtures only. Evidence records names,
counts and pass or fail reasons, never values. See .agents/verification/features/ for the mapped journeys.
"""
import base64
import hashlib
import hmac
import json
import os
import random
import re
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT =Path(__file__).resolve().parents[3]
FIXTURES = ROOT / '.agents/verification/fixtures'
EVIDENCE = Path.home() / '.agents/projects/secret-gateway/goals/issue-1/evidence'
PLACEHOLDER = re.compile(r'⟦SECRET_[0-9a-f]{6,64}⟧')
REVIEW_LINK = re.compile(r'\[⟦SECRET_[0-9a-f]{6,64}⟧\]\(http://127\.0\.0\.1:\d+/review/reveal/[0-9a-f]{64}\?token=[0-9a-f]{32}\)')
PROVIDER_KEY = re.compile(r'^(npg_|cfut_|GOCSPX-|ya29\.|ghp_|github_pat_|sk-ant-|AKIA|sk_live_)')
COMMAND = shlex.split(os.environ.get('GATEWAY_COMMAND', 'bun run start'))
TEXT_WITHHELD_MARK = 'withheld by secret-gateway: the secret scanner was unavailable'
WITHHELD_MARK = 'content withheld by secret-gateway'
NOTE_PHRASES = {
    'placeholders used as written': 'Use each placeholder exactly as written',
    'placeholder is not missing or broken': 'Do not treat a placeholder as missing, broken or unknown',
    'text, including accessibility trees, is masked': 'including command output, files and accessibility trees',
    'agent handles credentials through placeholders': 'Handle the credentials a task needs yourself',
    'verify after using a placeholder': 'check the result',
    'screenshots are not masked': 'are not masked. Prefer text sources, such as the accessibility tree,',
    'no screenshot while a credential is on screen': 'take a screenshot only when no credential value is on screen',
    'no deletion or revocation without approval': 'Do not delete, rotate or revoke a credential without',
}
REGISTRY = {'roots': [], 'data_dirs': []}


class Failed(AssertionError):
    pass


def ensure(condition, label):
    if not condition:
        raise Failed(label)
    return label


def case(cases, identifier):
    return next(c for c in cases if c['id'] == identifier)


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def http(method, url, body=None, headers=None, timeout=60):
    data = None
    request_headers = dict(headers or {})
    if isinstance(body, bytes):
        data = body
    elif body is not None:
        data = json.dumps(body).encode()
        request_headers.setdefault('Content-Type', 'application/json')
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        if block.get('type') == 'text':
            parts.append(block.get('text', ''))
        elif block.get('type') == 'tool_result':
            parts.append(text_of(block.get('content')))
    return '\n'.join(parts)


def echo_placeholders(body):
    text = ''
    for message in reversed(body.get('messages') or []):
        if message.get('role') == 'user':
            text = text_of(message.get('content'))
            break
    seen = []
    for placeholder in PLACEHOLDER.findall(text):
        if placeholder not in seen:
            seen.append(placeholder)
    return seen


def build_stream(echo, size):
    """The fake upstream's streamed reply. Fragments are split at `size` characters, so placeholders split."""
    events = []

    def emit(name, data):
        events.append(f'event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n')

    emit('message_start', {'type': 'message_start', 'message': {'id': 'msg_fake', 'type': 'message', 'role': 'assistant',
         'model': 'claude-haiku-5-5', 'content': [], 'stop_reason': None, 'stop_sequence': None,
         'usage': {'input_tokens': 1, 'output_tokens': 0}}})
    text = 'Text echo: ' + (echo[0] if echo else 'none')
    emit('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
    for piece in [text[i:i + size] for i in range(0, len(text), size)]:
        emit('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': piece}})
    emit('content_block_stop', {'type': 'content_block_stop', 'index': 0})
    for i, placeholder in enumerate(echo):
        index = i + 1
        emit('content_block_start', {'type': 'content_block_start', 'index': index,
             'content_block': {'type': 'tool_use', 'id': f'toolu_{i}', 'name': 'use_credential', 'input': {}}})
        partial = json.dumps({'credential': placeholder}, ensure_ascii=False)
        for piece in [partial[j:j + size] for j in range(0, len(partial), size)]:
            emit('content_block_delta', {'type': 'content_block_delta', 'index': index,
                 'delta': {'type': 'input_json_delta', 'partial_json': piece}})
        emit('content_block_stop', {'type': 'content_block_stop', 'index': index})
    emit('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None},
         'usage': {'output_tokens': 1}})
    emit('message_stop', {'type': 'message_stop'})
    return ''.join(events).encode()


class UpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, content_type, payload):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._send(200, 'application/json', b'{"ok": true}')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        with self.server.lock:
            self.server.received.append({'path': self.path, 'body': body, 'raw': raw,
                                         'headers': {k.lower(): v for k, v in self.headers.items()}})
        if not isinstance(body, dict):
            self._send(400, 'application/json', b'{"type": "error", "error": {"type": "invalid_request_error"}}')
            return
        echo = echo_placeholders(body)
        if body.get('stream'):
            payload = build_stream(echo, self.server.fragment)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.end_headers()
            self.wfile.write(payload)
            return
        message = {
            'id': 'msg_fake', 'type': 'message', 'role': 'assistant', 'model': 'claude-haiku-5-5',
            'content': [{'type': 'text', 'text': 'Text echo: ' + (echo[0] if echo else 'none')}]
            + [{'type': 'tool_use', 'id': f'toolu_{i}', 'name': 'use_credential', 'input': {'credential': p}}
               for i, p in enumerate(echo)],
            'stop_reason': 'tool_use', 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 1},
        }
        self._send(200, 'application/json', json.dumps(message).encode())


class FakeUpstream(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), UpstreamHandler)
        self.received = []
        self.lock = threading.Lock()
        self.fragment = 5

    @property
    def url(self):
        return f'http://127.0.0.1:{self.server_port}'

    def last(self):
        with self.lock:
            return self.received[-1]

    def clear(self):
        with self.lock:
            self.received.clear()


class Gateway:
    def __init__(self, url, port, data_dir, log_path, record_path):
        self.url = url
        self.port = port
        self.data_dir = data_dir
        self.log_path = log_path
        self.record_path = record_path

    def log(self):
        return self.log_path.read_text(errors='replace') if self.log_path.exists() else ''

    def notifications(self):
        if not self.record_path.exists():
            return []
        return [json.loads(line) for line in self.record_path.read_text().splitlines() if line.strip()]

    def items(self):
        return json.loads(http('GET', f'{self.url}/review/items', headers=self.host())[2])

    def host(self):
        return {'Host': f'127.0.0.1:{self.port}'}

    def token(self):
        _, _, page = http('GET', f'{self.url}/review', headers=self.host())
        match = re.search(rb'const TOKEN = "([0-9a-f]+)"', page)
        return match.group(1).decode() if match else None

    def answer(self, identity, status):
        return http('POST', f'{self.url}/review/answer', body={'id': identity, 'status': status},
                    headers={**self.host(), 'x-review-token': self.token()})

    def advance(self, ms):
        status, _, _ = http('POST', f'{self.url}/__test/advance?ms={ms}', body=b'', timeout=30)
        ensure(status == 200, f'clock advance by {ms} ms returned {status}')


def identity_of(data_dir, value):
    key = (Path(data_dir) / 'identity.key').read_bytes()
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()


def stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass


@contextmanager
def gateway(upstream_url, data_dir=None, env=None):
    port = free_port()
    scratch = Path(tempfile.mkdtemp(prefix='gateway-journey-'))
    REGISTRY['roots'].append(scratch)
    data = Path(data_dir) if data_dir else scratch / 'data'
    if data_dir:
        REGISTRY['data_dirs'].append(data)
    log_path = scratch / 'gateway.log'
    record_path = scratch / 'notifications.jsonl'
    environment = dict(os.environ)
    environment.update({'HOST': '127.0.0.1', 'PORT': str(port), 'GATEWAY_DATA_DIR': str(data),
                        'UPSTREAM_BASE_URL': upstream_url, 'GATEWAY_NOTIFY_RECORD': str(record_path)})
    environment.update(env or {})
    with open(log_path, 'wb') as log:
        process = subprocess.Popen(COMMAND, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                raise Failed(f'gateway exited early with code {process.returncode}')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise Failed('gateway port not reachable within 15 seconds')
                time.sleep(0.1)
        yield Gateway(f'http://127.0.0.1:{port}', port, data, log_path, record_path)
    finally:
        stop_process(process)


def messages_request(gw, messages, stream=False, system=None, session=None):
    payload = {'model': 'claude-haiku-5-5', 'max_tokens': 256, 'messages': messages}
    if system is not None:
        payload['system'] = system
    if stream:
        payload['stream'] = True
    headers = {'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01'}
    if session is not None:
        headers['x-claude-code-session-id'] = session
    return http('POST', f'{gw.url}/v1/messages', body=payload, headers=headers)


def user(text):
    return {'role': 'user', 'content': text}


def forwarded_text(upstream):
    return json.dumps(upstream.last()['body'], ensure_ascii=False)


def parse_sse(raw):
    events = []
    for block in raw.decode().split('\n\n'):
        name, data = None, None
        for line in block.split('\n'):
            if line.startswith('event:'):
                name = line[6:].strip()
            elif line.startswith('data:'):
                data = json.loads(line[5:].lstrip())
        if name is not None:
            events.append((name, data))
    return events


def tool_inputs_from_sse(events):
    partial = {}
    for name, data in events:
        if name == 'content_block_start' and data['content_block'].get('type') == 'tool_use':
            partial[data['index']] = ''
        elif name == 'content_block_delta' and data['delta'].get('type') == 'input_json_delta':
            partial[data['index']] = partial.get(data['index'], '') + data['delta']['partial_json']
    return [json.loads(text) for _, text in sorted(partial.items())]


def text_deltas_from_sse(events):
    return ''.join(data['delta']['text'] for name, data in events
                   if name == 'content_block_delta' and data['delta'].get('type') == 'text_delta')


def tail_leaked(secret, text):
    """True when the last 20 characters of a secret still appear in the text."""
    return secret[-20:] in text


# ---------------------------------------------------------------- journeys


def j_streaming(ctx):
    checks = []
    secret_case = case(ctx['text'], 'github-pat-env-assignment')
    secret = secret_case['secrets'][0]
    upstream = ctx['upstream']
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, raw = messages_request(gw, [user(secret_case['text'])], stream=True)
        ensure(status == 200, f'streaming request returned {status}')
        sent = forwarded_text(upstream)
        checks.append(ensure(secret not in sent and not tail_leaked(secret, sent),
                             'streamed request: upstream never receives the raw secret'))
        ensure(PLACEHOLDER.search(sent) is not None, 'streamed request: placeholder present upstream')
        events = parse_sse(raw)
        checks.append(ensure(tool_inputs_from_sse(events) == [{'credential': secret}],
                             'streamed tool input restored across fragment boundaries (fragments of 5 characters)'))
        text = text_deltas_from_sse(events)
        checks.append(ensure(REVIEW_LINK.search(text) is not None and secret not in text,
                             'streamed text blocks link the placeholder to its review page (tool input gets the value)'))
        echo = echo_placeholders(upstream.last()['body'])
        expected = [name for name, _ in parse_sse(build_stream(echo, upstream.fragment))]
        checks.append(ensure([name for name, _ in events] == expected,
                             'streamed event sequence is unchanged apart from the restored tool input and text links'))
    return checks


def j_non_streaming(ctx):
    checks = []
    secret_case = case(ctx['text'], 'anthropic-yaml-pair')
    secret = secret_case['secrets'][0]
    upstream = ctx['upstream']
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, raw = messages_request(gw, [user(secret_case['text'])])
        ensure(status == 200, f'non-streaming request returned {status}')
        reply = json.loads(raw)
        tool_inputs = [b['input'] for b in reply['content'] if b['type'] == 'tool_use']
        checks.append(ensure(tool_inputs == [{'credential': secret}], 'non-streaming tool input restored for the client'))
        texts = [b['text'] for b in reply['content'] if b['type'] == 'text']
        checks.append(ensure(len(texts) == 1 and REVIEW_LINK.search(texts[0]) is not None and secret not in texts[0],
                             'non-streaming text block links the placeholder to its review page'))
    return checks


def j_prompt_note(ctx):
    checks = []
    upstream = ctx['upstream']
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, _ = messages_request(gw, [user('hello')], system='Keep answers short.')
        ensure(status == 200, f'prompt note request returned {status}')
        system = upstream.last()['body']['system']
        ensure(system[0] == {'type': 'text', 'text': 'Keep answers short.'}, 'original system prompt is kept first')
        note = ' '.join(block['text'] for block in system[1:])
        for label, phrase in NOTE_PHRASES.items():
            checks.append(ensure(phrase in note, f'prompt note covers: {label}'))
        messages_request(gw, [user('hello again')])
        system_again = upstream.last()['body']['system']
        checks.append(ensure(any('Secret masking is active' in b.get('text', '') for b in system_again),
                             'prompt note is added when the request has no system prompt'))
    return checks


def j_detection_fixtures(ctx):
    checks = []
    upstream = ctx['upstream']
    positives = [c for c in ctx['text'] if c['kind'] == 'positive']
    negatives = [c for c in ctx['text'] if c['kind'] == 'negative']
    masked, leaked = [], []
    with gateway(upstream.url, env=ctx['env']) as gw:
        for item in positives:
            upstream.clear()
            status, _, _ = messages_request(gw, [user(item['text'])])
            ensure(status == 200, f"fixture {item['id']} returned {status}")
            sent = forwarded_text(upstream)
            secret = item['secrets'][0]
            (leaked if (secret in sent or tail_leaked(secret, sent)) else masked).append(item['id'])
        checks.append(ensure(not leaked, f'every positive fixture: raw tail never reaches upstream (leaked: {leaked or "none"})'))
        for item in negatives:
            upstream.clear()
            if item['gitContext']:
                messages = [
                    {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_git', 'name': 'Bash',
                                                       'input': {'command': 'git log --oneline'}}]},
                    {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_git', 'content': item['text']}]},
                ]
                status, _, _ = messages_request(gw, messages)
                ensure(status == 200, f"negative {item['id']} returned {status}")
                sent = upstream.last()['body']['messages'][1]['content'][0]['content']
            else:
                status, _, _ = messages_request(gw, [user(item['text'])])
                ensure(status == 200, f"negative {item['id']} returned {status}")
                sent = upstream.last()['body']['messages'][0]['content']
            ensure(sent == item['text'], f"negative {item['id']} is forwarded unchanged")
        checks.append(f'negative fixtures forwarded unchanged: {len(negatives)} of {len(negatives)}')
    checks.append(f'positive fixtures masked at the HTTP boundary: {len(masked)} of {len(positives)}')
    ctx['metrics']['positives_masked'] = len(masked)
    ctx['metrics']['positives_total'] = len(positives)
    return checks


def j_canonical_forms(ctx):
    checks = []
    upstream = ctx['upstream']
    secret = ctx['github']
    percent = ''.join('%%%02X' % ord(ch) for ch in secret)
    encoded = base64.b64encode(secret.encode()).decode()
    text = f'plain {secret}\nquoted "   {secret}   "\npercent {percent}\nbase64 {encoded}'
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, _ = messages_request(gw, [user(text)])
        ensure(status == 200, f'canonical-form request returned {status}')
        sent = forwarded_text(upstream)
        ensure(secret not in sent and percent not in sent and encoded not in sent,
               'canonical forms: no raw, percent-encoded or base64 copy reaches upstream')
        found = PLACEHOLDER.findall(sent)
        checks.append(ensure(len(set(found)) == 1 and len(found) >= 4,
                             f'quoted, padded, percent-encoded and base64 copies share one placeholder ({len(found)} occurrences)'))
    return checks


def j_exemptions_and_formats(ctx):
    checks = []
    upstream = ctx['upstream']
    uuid_value = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    blob = base64.b64encode(hashlib.sha256(b'synthetic-blob').digest()[:24]).decode()
    marker = '⟦SECRET_123abc⟧'
    github = ctx['github']
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, _ = messages_request(gw, [user(f'session id {uuid_value}\nJWT {jwt}\nblob {blob}')])
        ensure(status == 200, f'format request returned {status}')
        sent = forwarded_text(upstream)
        checks.append(ensure(uuid_value not in sent, 'UUID stays masked'))
        checks.append(ensure(jwt not in sent, 'JWT stays masked'))
        checks.append(ensure(blob not in sent, 'base64 blob stays masked'))
        unknown = 'Zq8Lw2Rt7Vb3Nc9Xm4Hk6Pd1Js5Ta0Yf'
        upstream.clear()
        messages_request(gw, [user(f'the value {unknown} came from a vendor export with no known name')])
        sent = forwarded_text(upstream)
        checks.append(ensure(unknown not in sent, 'random token of 20 or more characters with no known format or name is masked'))

        upstream.clear()
        history = [
            {'role': 'assistant', 'content': [{'type': 'text', 'text': f'the marker is {marker}'},
                                               {'type': 'tool_use', 'id': 'toolu_1', 'name': 'Bash',
                                                'input': {'command': 'echo ' + github}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_1', 'content': 'done ' + github}]},
            user('continue'),
        ]
        status, _, _ = messages_request(gw, history)
        ensure(status == 200, f'history request returned {status}')
        sent = json.dumps(upstream.last()['body']['messages'], ensure_ascii=False)
        checks.append(ensure(github not in sent, 'tool_use input and tool_result in history are masked'))
        checks.append(ensure(marker in sent, 'gateway placeholders in history are not re-masked'))

        upstream.clear()
        git_output = 'commit 3f6c2a9b8d1e4f7a0c5b6d9e2f1a8c7b4d3e6f09 (HEAD -> main)'
        messages_request(gw, [
            {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_g', 'name': 'Bash',
                                               'input': {'command': 'git log -1'}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_g', 'content': git_output}]},
        ])
        sent = upstream.last()['body']['messages'][1]['content'][0]['content']
        checks.append(ensure(sent == git_output, 'a git SHA in git output is exempt'))
    return checks


def j_identity_restart(ctx):
    checks = []
    upstream = ctx['upstream']
    secret = ctx['github']
    data = Path(tempfile.mkdtemp(prefix='gateway-identity-')) / 'data'
    REGISTRY['data_dirs'].append(data)
    placeholders = []
    for _ in range(2):
        with gateway(upstream.url, data_dir=data, env=ctx['env']) as gw:
            upstream.clear()
            messages_request(gw, [user(f'token {secret}')])
            placeholders.append(PLACEHOLDER.findall(forwarded_text(upstream))[0])
    checks.append(ensure(placeholders[0] == placeholders[1], 'same secret keeps its placeholder across a restart'))
    key_mode = os.stat(data / 'identity.key').st_mode & 0o777
    dir_mode = os.stat(data).st_mode & 0o777
    checks.append(ensure(key_mode == 0o600, f'identity key is owner-only (mode {oct(key_mode)})'))
    checks.append(ensure(dir_mode == 0o700, f'data directory is owner-only (mode {oct(dir_mode)})'))
    (data / 'identity.key').unlink()
    with gateway(upstream.url, data_dir=data, env=ctx['env']) as gw:
        upstream.clear()
        messages_request(gw, [user(f'token {secret}')])
        rotated = PLACEHOLDER.findall(forwarded_text(upstream))[0]
        checks.append(ensure(rotated != placeholders[0], 'a rotated key gives a new placeholder'))
        checks.append(ensure(any(i['status'] == 'pending' for i in gw.items()),
                             'a rotated key is asked about again (new pending item)'))
    return checks


def j_review(ctx):
    checks = []
    upstream = ctx['upstream']
    values = {
        'github': ctx['github'],
        'anthropic': case(ctx['text'], 'anthropic-yaml-pair')['secrets'][0],
        'cloudflare': case(ctx['text'], 'cloudflare-json-field')['secrets'][0],
    }
    data = Path(tempfile.mkdtemp(prefix='gateway-review-')) / 'data'
    REGISTRY['data_dirs'].append(data)
    with gateway(upstream.url, data_dir=data, env=ctx['env']) as gw:
        upstream.clear()
        started = time.monotonic()
        status, _, _ = messages_request(gw, [user(f'a {values["github"]}'), user(f'b {values["anthropic"]}'),
                                             user(f'c {values["cloudflare"]}')])
        elapsed = time.monotonic() - started
        ensure(status == 200, f'review request returned {status}')
        checks.append(ensure(elapsed < 10, f'pending detections do not block the request ({elapsed:.2f} s)'))
        sent = forwarded_text(upstream)
        checks.append(ensure(all(v not in sent for v in values.values()), 'pending items stay masked upstream'))

        items = gw.items()
        ids = {name: identity_of(data, value) for name, value in values.items()}
        checks.append(ensure(sorted(ids.values()) == sorted(i['id'] for i in items) and len(items) == 3,
                             'review lists exactly the three identities, computed from the key'))
        checks.append(ensure(all(i['source'] and i['length'] > 0 for i in items),
                             'review items show source and length'))
        listing = http('GET', f'{gw.url}/review/items', headers=gw.host())[2].decode()
        checks.append(ensure(not any(v in listing or v[-20:] in listing for v in values.values()),
                             'review item listing contains no values'))
        _, _, page = http('GET', f'{gw.url}/review', headers=gw.host())
        checks.append(ensure(b'Secret review' in page and not any(v.encode() in page for v in values.values()),
                             'review page renders and contains no values'))

        token = gw.token()
        status, _, _ = http('POST', f'{gw.url}/review/answer', body={'id': ids['github'], 'status': 'secret'},
                            headers={**gw.host(), 'Content-Type': 'application/json'})
        checks.append(ensure(status == 403, 'answer without the review token is refused'))
        status, _, _ = http('POST', f'{gw.url}/review/answer', body={'id': ids['github'], 'status': 'secret'},
                            headers={**gw.host(), 'x-review-token': token, 'Origin': 'http://evil.test'})
        checks.append(ensure(status == 403, 'answer from a foreign origin is refused'))
        status, _, _ = http('POST', f'{gw.url}/review/answer', body={'id': ids['github'], 'status': 'maybe'},
                            headers={**gw.host(), 'x-review-token': token})
        checks.append(ensure(status == 400, 'answer with an unknown status is refused'))
        status, _, _ = http('GET', f'{gw.url}/review', headers={'Host': f'evil.example:{gw.port}'})
        checks.append(ensure(status == 403, 'review page refuses a foreign Host (DNS rebinding)'))

        status, _, body = gw.answer(ids['github'], 'not_secret')
        checks.append(ensure(status == 200 and json.loads(body)['updated'] is True, 'answer "Not a secret" is accepted'))
        gw.answer(ids['anthropic'], 'secret')

        history = [user(f'a {values["github"]}'), user(f'b {values["anthropic"]}'), user(f'c {values["cloudflare"]}')]
        placeholder = f'⟦SECRET_{ids["github"][:6]}⟧'
        upstream.clear()
        messages_request(gw, history)
        sent = forwarded_text(upstream)
        checks.append(ensure(values['github'] not in sent and placeholder in sent,
                             '"Not a secret" keeps messages sent before the answer masked'))
        checks.append(ensure(values['anthropic'] not in sent and values['cloudflare'] not in sent,
                             '"Secret" keeps its value masked, and the pending item stays masked'))

        upstream.clear()
        messages_request(gw, history + [{'role': 'assistant', 'content': 'ok'}, user(f'd {values["github"]}')])
        sent = forwarded_text(upstream)
        newest = json.dumps(upstream.last()['body']['messages'][-1], ensure_ascii=False)
        checks.append(ensure(values['github'] in newest and sent.count(values['github']) == 1 and placeholder in sent,
                             '"Not a secret" unmasks only the message sent after the answer'))

        upstream.clear()
        messages_request(gw, [user(f'a {values["github"]}')], session='another-conversation')
        checks.append(ensure(values['github'] in forwarded_text(upstream),
                             'another conversation sees "Not a secret" unmasked from its first message'))

        reveal = {name: f'/review/reveal/{ids[name]}?token={token}' for name in values}
        _, _, page = http('GET', f'{gw.url}/review', headers=gw.host())
        checks.append(ensure(all(f'href="{link}"'.encode() in page for link in reveal.values()),
                             'review page links each held value to its reveal page'))
        status, headers, body = http('GET', f'{gw.url}{reveal["github"]}', headers=gw.host())
        checks.append(ensure(status == 200 and f'a <mark>{values["github"]}</mark>'.encode() in body,
                             'reveal page with the token shows the value highlighted in its line'))
        checks.append(ensure(headers.get('cache-control') == 'no-store' and headers.get('referrer-policy') == 'no-referrer',
                             'reveal page is served no-store and no-referrer'))
        status, _, body = http('GET', f'{gw.url}/review/reveal/{ids["github"]}', headers=gw.host())
        checks.append(ensure(status == 403 and values['github'].encode() not in body,
                             'reveal without the review token is refused, with no value'))
        status, _, body = http('GET', f'{gw.url}/review/reveal/{ids["github"]}?token=wrong', headers=gw.host())
        checks.append(ensure(status == 403 and values['github'].encode() not in body,
                             'reveal with a wrong token is refused, with no value'))
        status, _, _ = http('GET', f'{gw.url}{reveal["github"]}', headers={'Host': f'evil.example:{gw.port}'})
        checks.append(ensure(status == 403, 'reveal page refuses a foreign Host'))
        messages_request(gw, [user(f'd {values["cloudflare"]} {values["anthropic"]}')])
        _, _, body = http('GET', f'{gw.url}/review/reveal/{ids["cloudflare"]}?token={token}', headers=gw.host())
        checks.append(ensure(f'<mark>{values["cloudflare"]}</mark>'.encode() in body and values['anthropic'].encode() not in body
                             and '⟦SECRET_'.encode() in body,
                             'reveal line shows another masked value on the same line as a placeholder'))
        messages_request(gw, [user(f'first line\nsecond line\nthird {values["cloudflare"]}\n'
                                   f'fourth {values["anthropic"]}\nfifth line\nsixth line')])
        _, _, body = http('GET', f'{gw.url}/review/reveal/{ids["cloudflare"]}?token={token}', headers=gw.host())
        checks.append(ensure(b'second line' in body and b'fourth' in body and b'first line' not in body
                             and b'fifth line' not in body, 'reveal shows the nearest non-empty line above and below'))
        gap = '\n' * 5
        messages_request(gw, [user(f'The command printed:{gap}DATABASE_URL={values["cloudflare"]}{gap}The output follows')])
        _, _, body = http('GET', f'{gw.url}/review/reveal/{ids["cloudflare"]}?token={token}', headers=gw.host())
        checks.append(ensure(f'The command printed:{gap}DATABASE_URL=<mark>{values["cloudflare"]}</mark>{gap}The output follows'
                             .encode() in body, 'reveal keeps empty lines between the context lines and the value'))
        checks.append(ensure(b'user message, message' in body, 'each appearance shows where it is in the session'))
        checks.append(ensure(values['anthropic'].encode() not in body,
                             'lines above and below mask other secrets as placeholders'))
        checks.append(ensure(b'<h2>Value</h2>' not in body and b'<h2>Where it appears</h2>' in body,
                             'reveal page shows only the lines where the value appears'))
        _, _, reply = messages_request(gw, [user(f'link {values["cloudflare"]}')])
        text = ''.join(block['text'] for block in json.loads(reply)['content'] if block['type'] == 'text')
        expected_link = (f'[⟦SECRET_{ids["cloudflare"][:6]}⟧](http://127.0.0.1:{gw.port}'
                         f'/review/reveal/{ids["cloudflare"]}?token={token})')
        checks.append(ensure(expected_link in text, 'reply links the placeholder to the reveal page of its identity'))
        pending_before = len(gw.items())
        upstream.clear()
        status, _, _ = messages_request(gw, [
            {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]},
            user('continue'),
        ])
        sent = forwarded_text(upstream)
        checks.append(ensure(status == 200, 'a reply with a reveal link is accepted when sent back as history'))
        checks.append(ensure(token not in sent and expected_link not in sent,
                             'a reveal link sent back as history is reduced to its placeholder, so the review token stays local'))
        checks.append(ensure(f'⟦SECRET_{ids["cloudflare"][:6]}⟧' in sent, 'the placeholder of a reveal link stays in history'))
        checks.append(ensure(len(gw.items()) == pending_before, 'a reveal link sent back as history adds no review item'))

    with gateway(upstream.url, data_dir=data, env=ctx['env']) as gw:
        status_by_id = {i['id']: i['status'] for i in gw.items()}
        checks.append(ensure(status_by_id.get(ids['github']) == 'not_secret'
                             and status_by_id.get(ids['anthropic']) == 'secret',
                             'answers persist across a restart'))
        status, _, body = http('GET', f'{gw.url}/review/reveal/{ids["github"]}?token={gw.token()}', headers=gw.host())
        checks.append(ensure(status == 404 and b'not held in memory' in body and values['github'].encode() not in body,
                             'after a restart, reveal says the value is not held in memory, with no value'))
        upstream.clear()
        messages_request(gw, history + [{'role': 'assistant', 'content': 'ok'}, user(f'd {values["github"]}')])
        sent = forwarded_text(upstream)
        newest = json.dumps(upstream.last()['body']['messages'][-1], ensure_ascii=False)
        checks.append(ensure(values['github'] in newest and placeholder in sent and sent.count(values['github']) == 1,
                             'after a restart, "Not a secret" still masks messages sent before the answer'))
        checks.append(ensure(values['anthropic'] not in sent, '"Secret" stays masked after a restart'))
    return checks


def image_block(data):
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                        'data': base64.b64encode(data).decode()}}


def forwarded_image(upstream, message_index=0, block_index=0):
    block = upstream.last()['body']['messages'][message_index]['content'][block_index]
    return base64.b64decode(block['source']['data'])


def j_images(ctx):
    # Decision: screenshots are not masked (no local OCR). Secrets visible in them reach the provider.
    checks = []
    upstream = ctx['upstream']
    images = ctx['images']
    with gateway(upstream.url, env=ctx['env']) as gw:
        for item in images:
            original = (FIXTURES / item['file']).read_bytes()
            upstream.clear()
            status, _, _ = messages_request(gw, [{'role': 'user', 'content': [image_block(original),
                                                                             {'type': 'text', 'text': 'read it'}]}])
            ensure(status == 200, f"image {item['id']} returned {status}")
            checks.append(ensure(forwarded_image(upstream) == original,
                                 f"{item['id']}: screenshot forwarded byte for byte"))
            ctx['secrets'].update(value for value in item['keys'] if PROVIDER_KEY.match(value))

        first = (FIXTURES / images[0]['file']).read_bytes()
        positive = next(case for case in ctx['text'] if case['kind'] == 'positive')
        upstream.clear()
        messages_request(gw, [{'role': 'user', 'content': [image_block(first),
                                                           {'type': 'text', 'text': positive['text']}]}])
        checks.append(ensure(positive['secrets'][0] not in forwarded_text(upstream) and forwarded_image(upstream) == first,
                             'text beside a screenshot is masked, and the screenshot is forwarded unchanged'))

        upstream.clear()
        messages_request(gw, [{'role': 'user', 'content': [{'type': 'image', 'source': {
            'type': 'url', 'url': 'https://images.invalid/shot.png'}}]}])
        flat = forwarded_text(upstream)
        checks.append(ensure(WITHHELD_MARK in flat and 'images.invalid' not in flat,
                             'an image given by URL is withheld and not forwarded'))
    return checks


def j_notifications(ctx):
    checks = []
    upstream = ctx['upstream']
    rng = random.Random(7)
    alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    values = ['ghp_' + ''.join(rng.choice(alphabet) for _ in range(36)) for _ in range(7)]
    ctx['secrets'].update(values)
    env = {**ctx['env'], 'GATEWAY_CLOCK': 'manual', 'GATEWAY_TEST_CONTROL': '1'}
    with gateway(upstream.url, env=env) as gw:
        messages_request(gw, [user(f'token {v}') for v in values[:5]])
        checks.append(ensure(gw.notifications() == [], 'no notification before the batch window closes'))
        gw.advance(9_999)
        checks.append(ensure(gw.notifications() == [], 'still no notification at 9.999 s'))
        gw.advance(1)
        batch = gw.notifications()
        items = [n for n in batch if n['title'] == 'Secret review: new detection']
        summaries = [n for n in batch if n['title'] == 'Secret review: items waiting']
        checks.append(ensure(len(items) == 3 and len(summaries) == 1,
                             f'batch of five sends three item notifications and one summary (got {len(items)} and {len(summaries)})'))
        checks.append(ensure(all([a['id'] for a in n['actions']] == ['secret', 'not_secret'] for n in items),
                             'item notifications carry "Secret" and "Not a secret" actions'))
        checks.append(ensure(all('Length: 40 characters' in n['body'] and 'Source: user message.' in n['body'] for n in items),
                             'item notifications show source and length'))
        checks.append(ensure(not any(v in json.dumps(batch) for v in values), 'notifications contain no values'))

        messages_request(gw, [user(f'token {values[5]}')])
        gw.advance(10_000)
        after_budget = gw.notifications()
        checks.append(ensure(len(after_budget) == 5 and sum(n['title'] == 'Secret review: items waiting' for n in after_budget) == 2,
                             'rate limit: a third item inside the same minute becomes a summary'))

        gw.advance(60_000)
        messages_request(gw, [user(f'token {values[6]}')])
        gw.advance(10_000)
        final = gw.notifications()
        checks.append(ensure(len(final) == 6 and final[-1]['title'] == 'Secret review: new detection',
                             'after a minute the rate budget returns and an item notification is sent'))
    return checks


def j_fail_closed(ctx):
    checks = []
    upstream = ctx['upstream']
    secret = ctx['github']
    with gateway(f'http://127.0.0.1:{free_port()}', env=ctx['env']) as gw:
        status, _, body = messages_request(gw, [user(f'token {secret}')])
        checks.append(ensure(status == 502 and secret.encode() not in body,
                             'upstream unreachable: the request fails and no raw value is returned'))
        checks.append(ensure('upstream unreachable' in gw.log(), 'upstream failure is logged without values'))
    with gateway(upstream.url, env={**ctx['env'], 'GATEWAY_SCANNER_BINARY': '/nonexistent/betterleaks'}) as gw:
        upstream.clear()
        status, _, _ = messages_request(gw, [user(f'token {secret}')])
        ensure(status == 200, f'scanner-missing request returned {status}')
        sent = forwarded_text(upstream)
        checks.append(ensure(secret not in sent and TEXT_WITHHELD_MARK in sent,
                             'scanner unavailable: the text is withheld and never sent raw'))
        checks.append(ensure('scanner unavailable' in gw.log(), 'scanner failure is logged'))
    with gateway(upstream.url, env=ctx['env']) as gw:
        upstream.clear()
        status, _, _ = http('POST', f'{gw.url}/v1/messages', body=b'{"messages": [',
                            headers={'Content-Type': 'application/json'})
        checks.append(ensure(status == 400 and len(upstream.received) == 0, 'invalid JSON is refused, not forwarded'))
        status, _, _ = http('POST', f'{gw.url}/v1/messages', body=b'plain text', headers={'Content-Type': 'text/plain'})
        checks.append(ensure(status == 400 and len(upstream.received) == 0,
                             'a non-JSON message request is refused, not forwarded'))
    refused = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, timeout=30, env={
        **os.environ, 'HOST': '0.0.0.0', 'PORT': str(free_port()),
        'GATEWAY_DATA_DIR': tempfile.mkdtemp(prefix='gateway-host-')})
    checks.append(ensure(refused.returncode != 0 and 'loopback' in refused.stdout + refused.stderr,
                         'a non-loopback HOST refuses to start'))
    return checks


def j_adapter_independence(ctx):
    """Story 37: the masking core must not read the Anthropic message format. Only anthropic.ts and gateway.ts may."""
    source = ROOT / 'src'
    core = ['detect.ts', 'hits.ts', 'identity.ts', 'masker.ts', 'store.ts', 'notify.ts', 'review.ts', 'vault.ts']
    markers = ['content_block', 'tool_use', 'input_json_delta', 'tool_result', 'messages', 'media_type']
    offenders = []
    for name in core:
        text = (source / name).read_text()
        for marker in markers:
            if marker in text:
                offenders.append(f'{name}:{marker}')
    return [ensure(not offenders, f'masking core is free of Anthropic message markers (offenders: {offenders or "none"})')]


def j_disk_non_disclosure(ctx):
    """Scans every gateway data directory, log, notification record and the evidence folder for each raw value."""
    needles = set()
    for value in ctx['secrets']:
        needles.add(value)
        needles.add(value[-20:])
    roots = REGISTRY['roots'] + REGISTRY['data_dirs'] + [EVIDENCE]
    scanned, leaks = 0, []
    for root in roots:
        if not Path(root).exists():
            continue
        for path in Path(root).rglob('*'):
            if not path.is_file():
                continue
            scanned += 1
            content = path.read_bytes()
            if any(needle.encode() in content for needle in needles):
                leaks.append(path.name)
    return [ensure(scanned > 0, f'scanned {scanned} files'),
            ensure(not leaks, f'no raw value on disk, in logs, notifications or evidence (hits: {sorted(set(leaks)) or "none"})')]


JOURNEYS = [
    ('streaming', j_streaming),
    ('non-streaming', j_non_streaming),
    ('prompt-note', j_prompt_note),
    ('detection-fixtures', j_detection_fixtures),
    ('canonical-forms', j_canonical_forms),
    ('exemptions-and-formats', j_exemptions_and_formats),
    ('identity-restart', j_identity_restart),
    ('review', j_review),
    ('images', j_images),
    ('notifications', j_notifications),
    ('fail-closed', j_fail_closed),
    ('adapter-independence', j_adapter_independence),
]


def run_journeys():
    text_cases = json.loads((FIXTURES / 'scanner-cases.json').read_text())
    image_cases = json.loads((FIXTURES / 'ocr-cases.json').read_text())
    upstream = FakeUpstream()
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    # Every synthetic value the run uses, so the disk scan can look for each one.
    secrets = {s for c in text_cases if c['kind'] == 'positive' for s in c['secrets']}
    secrets.update(k for c in image_cases for k in c['keys'] if PROVIDER_KEY.match(k))
    ctx = {
        'text': text_cases,
        'images': image_cases,
        'upstream': upstream,
        'secrets': secrets,
        'metrics': {},
        'env': {},
        'github': case(text_cases, 'github-pat-env-assignment')['secrets'][0],
    }
    results = []
    try:
        for name, journey in JOURNEYS:
            started = time.monotonic()
            try:
                checks = journey(ctx)
                results.append({'journey': name, 'status': 'PASS',
                                'checks': [c for c in checks if isinstance(c, str)],
                                'seconds': round(time.monotonic() - started, 1)})
            except Failed as failure:
                results.append({'journey': name, 'status': 'FAIL', 'reason': str(failure),
                                'seconds': round(time.monotonic() - started, 1)})
            except Exception as error:
                results.append({'journey': name, 'status': 'FAIL', 'reason': f'{type(error).__name__}: {error}',
                                'seconds': round(time.monotonic() - started, 1)})
        started = time.monotonic()
        try:
            results.append({'journey': 'disk-non-disclosure', 'status': 'PASS',
                            'checks': [c for c in j_disk_non_disclosure(ctx) if isinstance(c, str)],
                            'seconds': round(time.monotonic() - started, 1)})
        except Failed as failure:
            results.append({'journey': 'disk-non-disclosure', 'status': 'FAIL', 'reason': str(failure),
                            'seconds': round(time.monotonic() - started, 1)})
    finally:
        upstream.shutdown()
        upstream.server_close()
    return results, ctx


def write_evidence(results, ctx):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    report = {
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'status': 'PASS' if all(r['status'] == 'PASS' for r in results) else 'FAIL',
        'journeys': results,
        'metrics': ctx['metrics'],
        'note': 'Synthetic fixtures and fake upstream only. Values are never recorded.',
    }
    path = EVIDENCE / 'journeys.json'
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    return path, report


if __name__ == '__main__':
    journey_results, journey_ctx = run_journeys()
    evidence_path, report = write_evidence(journey_results, journey_ctx)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f'Evidence: {evidence_path}')
    raise SystemExit(0 if report['status'] == 'PASS' else 1)
