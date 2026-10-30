# Gateway verification

Status: implemented and verified at the HTTP boundary, except OCR exact-read acceptance, which is not met (see Checkpoints). A green run does not prove every issue requirement; coverage gaps are listed below.

Run everything from the repository root with Python 3, Bun and the project-local tools in `.tools/` (see the setup section of [README.md](../../README.md)).

## Full check

```sh
python3 .agents/verification/scripts/check.py
```

Runs the launch smoke check (`scripts/check.py`) and then every journey in `scripts/journeys.py`. Exit 0 means all journeys passed. Evidence:

- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/http-smoke.json` (smoke; overwritten each run)
- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/journeys.json` (journeys; overwritten each run)
- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/auth-probe.json` (approved subscription probe, see below)

Evidence never contains values. Archive milestone copies separately.

## Launch settings

`check.py` starts `bun run start` with fresh temporary data and an assigned loopback port. The gateway reads:

| Variable | Used for | Default |
| --- | --- | --- |
| `HOST` | Listen address; must be loopback or the gateway refuses to start | `127.0.0.1` |
| `PORT` | Listen port | `8787` |
| `UPSTREAM_BASE_URL` | Forward target (fake upstream in checks) | `https://api.anthropic.com` |
| `GATEWAY_DATA_DIR` | Identity key and answers database | `~/.local/share/secret-gateway` |
| `GATEWAY_SCANNER_BINARY` | Provider scanner (Betterleaks) | `.tools/bin/betterleaks` |
| `GATEWAY_COMMAND` | Alternative launch command for the checks | `bun run start` |

Test-only settings, which the journeys use. Do not set them for real use:

- `GATEWAY_CLOCK=manual` with `GATEWAY_TEST_CONTROL=1` gives controlled time. `POST /__test/advance?ms=N` advances it.
- `GATEWAY_NOTIFY_RECORD=<path>` writes each notification as a JSON line instead of calling `notify-send`.

## Journeys

| Journey (`scripts/journeys.py`) | Checks |
| --- | --- |
| `streaming` | Raw secret absent upstream; tool input restored across 5-character fragments; text blocks not restored; event sequence unchanged |
| `non-streaming` | Tool input restored for the client; text block not restored |
| `prompt-note` | Original system prompt kept; note covers placeholder use, no "missing" warnings, Copy-and-paste preference, verification, withheld-screenshot routing; note added without a system prompt |
| `detection-fixtures` | Every positive fixture (48) masked at the HTTP boundary; every negative (8) forwarded unchanged; git SHA exempt only in git output |
| `canonical-forms` | Plain, quoted and padded, percent-encoded, and base64 copies share one placeholder |
| `exemptions-and-formats` | UUID, JWT, base64 blob, and unknown random token masked; tool-use and tool-result history masked; gateway placeholders not re-masked; git SHA exempt |
| `identity-restart` | Placeholder stable across restart; identity key mode 0600 and data directory mode 0700; deleted key gives a new identity and asks again |
| `review` | Pending items stay masked and do not block; listing and page contain no values; token, Origin and Host checks; "Not a secret" unmasks in history; "Secret" stays masked; answers persist across restart; review identities match HMAC of the values under the key file |
| `images` | Five screenshots: each secret key box painted black with a visible label; non-secret text not painted; resent screenshot not OCR-ed again; clean screenshot byte-identical; unreadable screenshots withheld; three failures on one window send one degraded-screen notification; all boxes answered "Not a secret" sends the screenshot unchanged |
| `notifications` | Nothing before the 10 s batch window; batch of five gives three item notifications and one summary; item notifications carry Secret and Not a secret actions; rate limit of three per minute; budget returns after a minute; notifications contain no values |
| `fail-closed` | Upstream unreachable gives 502 without a raw value; scanner missing withholds text; invalid JSON and non-JSON message requests refused; non-loopback HOST refuses to start |
| `adapter-independence` | Masking core modules contain no Anthropic message markers (story 37 assessment) |
| `disk-non-disclosure` | No fixture value, or its last 20 characters, in any gateway data file, log, notification record, or the evidence folder |

Each journey starts its own gateway processes. Ports are assigned per process, and temporary data is kept until the disk scan.

## Benchmarks (separate scripts)

```sh
bun run bench/scanner.ts   # scanner recall, pipeline recall, latency per request (200 ms p95 limit)
bun run bench/ocr.ts       # OCR exact key reads, latency per screenshot, masking coverage
```

Both write evidence under the goals folder. The scanner benchmark selects Betterleaks with provider rules. The OCR benchmark also runs RapidOCR through `bench/rapidocr_exact.py` in `.tools/rapidocr-venv`.

Fixtures are synthetic. Regenerate with `python3 .agents/verification/scripts/make_fixtures.py`. Values come from a fixed seed. Keys are random and fake.

## Authentication probe (approved, live)

```sh
python3 .agents/verification/scripts/auth_probe.py
```

Runs `claude -p` (Haiku 5.5, medium effort, synthetic prompt) through a loopback forwarder with the local subscription login. Records only paths, statuses and whether auth header names were present. This is the only live authenticated call approved for this goal. Do not run it again without approval.

## Results (2026-10-30)

| Check | Result |
| --- | --- |
| `check.py` (smoke and 13 journeys) | PASS |
| Subscription authentication probe | PASS (base URL honoured; Bearer forwarded; 200; PROBE-OK on claude-haiku-5-5) |
| Scanner benchmark | Betterleaks provider rules: pipeline recall 47/48; scanner-alone recall 0.521; p95 86 ms (pass). All-rules Betterleaks p95 319 ms (fails). Kingfisher p95 718 ms (fails) |
| OCR benchmark, exact key reads | **Not met.** Tesseract 2/7 (266 ms median); RapidOCR 4/7 (776 ms median, line boxes only) |
| OCR masking coverage | 6/6 secret key boxes covered by the screenshot engine |

## Coverage gaps and limits

- **Exact OCR reads (acceptance) are not met.** Misreads are mostly O/0 and l/I/1 in random mixed-case keys. Masking still covers the misread boxes, but a placeholder whose key was misread restores the wrong value. This needs a user decision (see Checkpoints).
- Scanner-alone recall for Cloudflare, Neon, Google and AWS formats is low. Coverage for those comes from the name and entropy layers in the pipeline. The Google `ya29.` prefix is outside the token charset, so only its random tail is masked.
- Desktop notification buttons do not appear on this machine. AppArmor profile `/etc/apparmor.d/notify-send` blocks `GetCapabilities`. Notifications are sent as plain notifications, and the recording notifier verifies the action list only. The review page is the working answer path.
- Gateway-down behaviour: Claude Code uses the base URL and has no direct fallback in the alias configuration. Not verified live.
- Thinking blocks are not scanned or changed, since the model only saw placeholders. Tool definitions are not scanned.
- Unsupported content blocks (documents, URL images, other types) are withheld, not scanned.
- OCR and screenshot identity: an image's values are recovered by OCR again only when the model uses one of its placeholders. OCR results are cached as identities and boxes, not values.
- Benchmarks and journeys do not measure the desktop UI, Claude Code itself beyond the probe, or the Codex adapter (out of scope).

## Checkpoints for the user

1. OCR exact-read acceptance. Options: (a) keep Tesseract, accept masking coverage as the security acceptance and report exact reads as informational; (b) switch to RapidOCR (4/7 exact, Python sidecar, line boxes); (c) change fixture text size or font to measure a different case (not done, this would be tuning to the test). Recommendation: (a) now, and (b) if restore accuracy matters more than latency.
2. Action buttons on desktop notifications. Requires changing the system AppArmor profile for `notify-send` (system configuration; not changed).
3. Gateway-down test (story 2) needs a live Claude Code run against a closed port. It needs your approval because a fallback to the API would send the subscription token. Not run.
4. Whether to keep the all-rules Betterleaks configuration (higher scanner-alone recall, p95 319 ms) for an interactive setup where latency is less important.

## Cleanup

Normal and failed runs terminate only the gateway process group they started and remove temporary data. Evidence is kept. After a forced kill of `check.py`, inspect the process list for `bun run start` processes started from this repository before stopping any.
