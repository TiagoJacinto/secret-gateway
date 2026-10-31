#!/usr/bin/env python3
"""Live Codex tool-input restoration check using a synthetic UUID and existing login.

This uses the running Responses gateway and real model capacity. It is intentionally
separate from check.py. No prompts, replies, credentials, or UUIDs are printed.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8788')
    parser.add_argument('--model', default='gpt-6.1-sol')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='responses-live-probe-') as directory:
        root = Path(directory)
        value = str(uuid.uuid4())
        (root / 'verify.py').write_text(
            'import sys\n'
            f'assert sys.argv[1] == {value!r}\n'
            'print("GATEWAY_PROBE_VERIFIED")\n'
        )
        command = [
            'codex', 'exec', '--ignore-user-config', '--ephemeral',
            '--skip-git-repo-check', '--json', '-C', directory, '-m', args.model,
            '-c', 'model_provider="probe"',
            '-c', 'model_providers.probe.name="Restoration probe"',
            '-c', 'model_providers.probe.base_url=' + json.dumps(args.base_url),
            '-c', 'model_providers.probe.wire_api="responses"',
            '-c', 'model_providers.probe.requires_openai_auth=true',
            '-c', 'model_providers.probe.supports_websockets=false',
            '-c', 'features.enable_request_compression=false',
            f'Run exactly this shell command: python3 verify.py {value} . '
            'Do not read or edit any files. Then reply PROBE-DONE.',
        ]
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=120)
            # result verification
            passed = result.returncode == 0 and 'GATEWAY_PROBE_VERIFIED' in result.stdout
            report = {'status': 'PASS' if passed else 'FAIL',
                      'codex_exit_code': result.returncode,
                      'tool_received_original_value': passed}
        except (OSError, subprocess.TimeoutExpired) as error:
            passed = False
            report = {'status': 'FAIL', 'error_type': type(error).__name__}
        print(json.dumps(report))
        return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(run())
