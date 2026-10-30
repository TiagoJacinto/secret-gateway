"""RapidOCR candidate for bench/ocr.ts. Runs in the project-local venv at .tools/rapidocr-venv.

Prints one JSON line per fixture with the recognized line texts and per-image latency (warm model).
Usage: .tools/rapidocr-venv/bin/python bench/rapidocr_exact.py <ocr-cases.json>
"""
import json
import sys
import time
from pathlib import Path

from rapidocr import RapidOCR

cases = json.loads(Path(sys.argv[1]).read_text())
engine = RapidOCR()
engine(str(Path(sys.argv[1]).parent / cases[0]['file']))  # warm-up, not measured
for case in cases:
    path = str(Path(sys.argv[1]).parent / case['file'])
    timings = []
    result = None
    for _ in range(3):
        started = time.perf_counter()
        result = engine(path)
        timings.append((time.perf_counter() - started) * 1000)
    lines = list(result.txts or [])
    print(json.dumps({'id': case['id'], 'msMedian': round(sorted(timings)[1]), 'lines': lines}))
