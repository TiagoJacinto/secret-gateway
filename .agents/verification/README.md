# Gateway verification

Status: implemented and verified at the HTTP boundary for text. Screenshots are not masked, by decision (no local OCR), so a secret visible in a screenshot reaches the provider. A green run does not prove every issue requirement; coverage gaps are listed below.

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
| `prompt-note` | Original system prompt kept; note covers placeholder use, no "missing" warnings, Copy-and-paste preference, verification, text over screenshots, no deletion or revocation without approval; note added without a system prompt |
| `detection-fixtures` | Every positive fixture (48) masked at the HTTP boundary; every negative (8) forwarded unchanged; git SHA exempt only in git output |
| `canonical-forms` | Plain, quoted and padded, percent-encoded, and base64 copies share one placeholder |
| `exemptions-and-formats` | UUID, JWT, base64 blob, and unknown random token masked; tool-use and tool-result history masked; gateway placeholders not re-masked; git SHA exempt |
| `identity-restart` | Placeholder stable across restart; identity key mode 0600 and data directory mode 0700; deleted key gives a new identity and asks again |
| `review` | Pending items stay masked and do not block; listing and page contain no values; token, Origin and Host checks; "Not a secret" unmasks in history; "Secret" stays masked; answers persist across restart; review identities match HMAC of the values under the key file |
| `images` | Five screenshots forwarded byte for byte (not masked, by decision); text beside a screenshot still masked; an image given by URL is withheld and not forwarded |
| `notifications` | Nothing before the 10 s batch window; batch of five gives three item notifications and one summary; item notifications carry Secret and Not a secret actions; rate limit of three per minute; budget returns after a minute; notifications contain no values |
| `fail-closed` | Upstream unreachable gives 502 without a raw value; scanner missing withholds text; invalid JSON and non-JSON message requests refused; non-loopback HOST refuses to start |
| `adapter-independence` | Masking core modules contain no Anthropic message markers (story 37 assessment) |
| `disk-non-disclosure` | No fixture value, or its last 20 characters, in any gateway data file, log, notification record, or the evidence folder |

Each journey starts its own gateway processes. Ports are assigned per process, and temporary data is kept until the disk scan.

## Benchmarks

```sh
bun run bench/scanner.ts   # scanner recall, pipeline recall, latency per request (200 ms p95 limit)
```

Writes evidence under the goals folder. The scanner benchmark selects Betterleaks with provider rules.

Fixtures are synthetic. Regenerate with `python3 .agents/verification/scripts/make_fixtures.py`. Values come from a fixed seed. Keys are random and fake. The screenshot fixtures check pass-through and text masking beside images only.

## Authentication probe (approved, live)

```sh
python3 .agents/verification/scripts/auth_probe.py
```

Runs `claude -p` (Haiku 5.5, medium effort, synthetic prompt) through a loopback forwarder with the local subscription login. Records only paths, statuses and whether auth header names were present. Do not run it again without approval.

## Gateway-down check (approved, live, run once)

```sh
python3 .agents/verification/scripts/gateway_down_probe.py
```

Runs `claude -p` (Haiku 5.5, medium effort, synthetic prompt) with `ANTHROPIC_BASE_URL` set to a loopback port where nothing listens. It passes when Claude Code gives no reply and the marker is absent. It records the exit code, error flags and whether the marker appeared. It does not record the request path, reply text or stderr, so a direct connection attempt would not show. Evidence: `~/.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-down.json`. Approved 2026-10-30 as one run. Do not run it again without approval.

## Results (2026-10-30)

| Check | Result |
| --- | --- |
| `check.py` (smoke and 13 journeys) | PASS |
| Subscription authentication probe | PASS (base URL honoured; Bearer forwarded; 200; PROBE-OK on claude-haiku-5-5) |
| Gateway-down check (closed port, one run) | PASS as defined: exit 1, no reply, no model used. Does not show the request path |
| Scanner benchmark | Betterleaks provider rules: pipeline recall 47/48; scanner-alone recall 0.521; p95 86 ms (pass). All-rules Betterleaks p95 319 ms (fails). Kingfisher p95 718 ms (fails) |
| Local OCR (removed) | Not used. Last results kept as history in `evidence/ocr-benchmark.json`: Tesseract 2/7 exact keys, RapidOCR 4/7 |

## Coverage gaps and limits

- **Screenshots are not masked (decision, 2026-10-30).** A secret visible in a screenshot reaches the provider. The image also stays in the conversation history. Expected from the Messages API, later requests resend it; this is not verified live.
- Scanner-alone recall for Cloudflare, Neon, Google and AWS formats is low. Coverage for those comes from the name and entropy layers in the pipeline. The Google `ya29.` prefix is outside the token charset, so only its random tail is masked.
- Desktop notification buttons do not appear on this machine. AppArmor profile `/etc/apparmor.d/notify-send` blocks `GetCapabilities`. Notifications are sent as plain notifications, and the recording notifier verifies the action list only. The review page is the working answer path.
- Gateway-down behaviour: one live run with a closed port gave no reply (see the gateway-down check). That run does not show the request path, so a direct connection attempt would not be seen.
- Thinking blocks are not scanned or changed, since the model only saw placeholders. Tool definitions are not scanned.
- Unsupported content blocks (documents, URL images, other types) are withheld, not scanned.
- Benchmarks and journeys do not measure the desktop UI, Claude Code itself beyond the probe, or the Codex adapter (out of scope).

## Decisions and checkpoints

Decided by the user (2026-10-30):

1. Screenshots pass through unmasked. Local OCR was removed from the code. Reverse this by restoring the OCR path from commit `7b37f2c`.

2. Notification buttons: plain notifications with the review link. The AppArmor profile for `notify-send` is unchanged, so buttons do not appear. Story 27 is not met.
3. Gateway-down test (story 2): approved and run once. See the gateway-down check above. Result: no reply; the request path is not shown.
4. Scanner: provider rules (pipeline p95 86 ms, within the 200 ms limit). All rules (p95 303 ms) is not used.

Open for the user:

5. Optional cleanup: run `rm -rf .tools/rapidocr-venv` and `rm -rf ~/.cache/kingfisher` from the repository root, or decline.
6. Restore policy for placeholders is moot for screenshots now, since no screenshot values are masked.

## Cleanup

Normal and failed runs terminate only the gateway process group they started and remove temporary data. Evidence is kept. After a forced kill of `check.py`, inspect the process list for `bun run start` processes started from this repository before stopping any.
