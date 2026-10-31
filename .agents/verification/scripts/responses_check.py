#!/usr/bin/env python3
"""Responses HTTP-boundary regression: real gateway, synthetic upstream and values."""
import json
import threading
from http.server import ThreadingHTTPServer
from journeys import UpstreamHandler, gateway, http, ensure, PLACEHOLDER, FIXTURES, case


class Handler(UpstreamHandler):
    received = []
    omit_content_type = False

    def _send(self, status, content_type, payload):
        if not self.omit_content_type:
            return super()._send(status, content_type, payload)
        self.send_response(status)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.received.append(body)
        placeholder = PLACEHOLDER.findall(json.dumps(body, ensure_ascii=False))[0]
        arguments = json.dumps({'value': placeholder}, ensure_ascii=False)
        output = [{'type': 'function_call', 'id': 'fc_1', 'name': 'use_value', 'arguments': arguments},
                  {'type': 'custom_tool_call', 'id': 'ct_1', 'name': 'apply_patch', 'input': placeholder}]
        if body.get('stream'):
            events = []
            def emit(kind, **fields):
                events.append('data: ' + json.dumps({'type': kind, **fields}, ensure_ascii=False) + '\n\n')
            for i in range(0, len(arguments), 3):
                emit('response.function_call_arguments.delta', item_id='fc_1', delta=arguments[i:i+3])
            emit('response.function_call_arguments.done', item_id='fc_1', arguments=arguments)
            for i in range(0, len(placeholder), 3):
                emit('response.custom_tool_call_input.delta', item_id='ct_1', delta=placeholder[i:i+3])
            emit('response.custom_tool_call_input.done', item_id='ct_1', input=placeholder)
            emit('response.completed', response={'output': output})
            self._send(200, 'text/event-stream', ''.join(events).encode())
        else:
            self._send(200, 'application/json', json.dumps({'output': output}).encode())


def run():
    cases = json.loads((FIXTURES / 'scanner-cases.json').read_text())
    secret = case(cases, 'github-pat-env-assignment')['secrets'][0]
    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        with gateway(f'http://127.0.0.1:{upstream.server_port}', env={'GATEWAY_PROTOCOL': 'responses'}) as gw:
            # result verification
            for omit_type, stream, path in [
                (omit_type, stream, path)
                for omit_type in (False, True)
                for stream, path in [(False, '/responses'), (True, '/responses'), (False, '/responses/compact')]
            ]:
                Handler.omit_content_type = omit_type
                body = {'instructions': 'Handle values safely.', 'stream': stream,
                        'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': 'token=' + secret}]},
                                  {'type': 'function_call_output', 'call_id': 'call_1', 'output': secret},
                                  {'type': 'additional_tools', 'id': 'toolset-1234567890abcdef1234567890abcdef',
                                   'tools': [{'type': 'function', 'name': 'use_value', 'description': secret}]}]}
                status, headers, raw = http('POST', gw.url + path, body)
                ensure(status == 200, 'Responses request succeeds')
                ensure(secret not in json.dumps(Handler.received[-1]), 'secret absent upstream')
                ensure('Secret masking is active' in Handler.received[-1]['instructions'], 'masking note added')
                ensure(Handler.received[-1]['input'][2]['id'] == body['input'][2]['id'], 'protocol ID preserved')
                if not stream:
                    output = json.loads(raw)['output']
                    ensure(json.loads(output[0]['arguments'])['value'] == secret, 'function argument restored')
                    ensure(output[1]['input'] == secret, 'custom input restored')
                else:
                    events = [json.loads(line[6:]) for line in raw.decode().splitlines() if line.startswith('data: ')]
                    args = ''.join(e['delta'] for e in events if e['type'] == 'response.function_call_arguments.delta')
                    custom = ''.join(e['delta'] for e in events if e['type'] == 'response.custom_tool_call_input.delta')
                    ensure(json.loads(args)['value'] == secret, 'fragmented function arguments restored')
                    ensure(custom == secret, 'fragmented custom input restored')
                    ensure(json.loads(events[-1]['response']['output'][0]['arguments'])['value'] == secret,
                           'completed response restored')
                expected_type = 'text/event-stream' if stream else 'application/json'
                ensure(expected_type in headers.get('content-type', ''), 'response media type set')
            count = len(Handler.received)
            for path, body, headers in [('/unsupported', {'input': secret}, {}),
                                        ('/responses', b'not json', {'Content-Type': 'application/json'}),
                                        ('/responses', {'input': secret}, {'Content-Encoding': 'zstd'}),
                                        ('/responses', {'input': [{'type': 'unknown', 'value': secret}]}, {})]:
                status, _, _ = http('POST', gw.url + path, body, headers)
                ensure(status >= 400, 'unsupported request refused')
            ensure(len(Handler.received) == count, 'refused requests never reach upstream')
    finally:
        upstream.shutdown()
        upstream.server_close()
    print('PASS: Responses masking, tool restoration (JSON and fragmented SSE), fail-closed routes')


if __name__ == '__main__':
    run()
