# Gateway verification

Status: implemented and verified at the HTTP boundary for text. Screenshots are not masked, by decision (no local OCR), so a secret visible in a screenshot reaches the provider. A green run does not prove every issue requirement; coverage gaps are listed below.

Run everything from the repository root with Python 3, Bun and the project-local tools in `.tools/` (see the setup section of [README.md](../../README.md)).

## Full check

```sh
python3 .agents/verification/scripts/check.py
```

Runs the launch smoke check (`scripts/check.py`) and then every journey in `scripts/journeys.py`. Exit 0 means all journeys passed. Evidence:

It also runs `scripts/responses_check.py`: Responses text masking, JSON and fragmented SSE function/custom-tool restoration with and without upstream Content-Type, and refusal of malformed, compressed, and unsupported requests against a fake upstream. A live `codex-masked exec` reply probe passed on 2026-10-31 with the existing ChatGPT login. A live tool restoration probe passed on 2026-10-31 after fixing missing upstream Content-Type: infer JSON/SSE from the Responses request when the header is absent. Codex long-running sessions and compaction remain unverified live.

- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/http-smoke.json` (smoke; overwritten each run)
- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/journeys.json` (journeys; overwritten each run)
- `~/.agents/projects/secret-gateway/goals/issue-1/evidence/auth-probe.json` (approved subscription probe, see below)

Evidence never contains values. Archive milestone copies separately.

## Live Codex restoration probe

```sh
python3 .agents/verification/scripts/responses_live_probe.py
```

Uses the running gateway on port 8788, the existing ChatGPT login, and real model capacity. A temporary verifier accepts only the original synthetic UUID supplied in the prompt. The command prints only a pass/fail report. It is separate from the automated suite. Use `--base-url` to test another Responses listener.

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
| `streaming` | Raw secret absent upstream; tool input restored across 5-character fragments; streamed text blocks link each placeholder to its review page; event sequence unchanged apart from the restored tool input and text links |
| `non-streaming` | Tool input restored for the client; text block links the placeholder to its review page |
| `prompt-note` | Original system prompt kept; note covers placeholder use, no "missing" warnings, masking of all text including accessibility trees, handling credentials through placeholders, verification, unmasked screenshots and text over screenshots, no screenshot while a credential is on screen, no deletion or revocation without approval; note added without a system prompt |
| `detection-fixtures` | Every positive fixture (48) masked at the HTTP boundary; every negative (8) forwarded unchanged; git SHA exempt only in git output |
| `canonical-forms` | Plain, quoted and padded, percent-encoded, and base64 copies share one placeholder |
| `exemptions-and-formats` | UUID, JWT, base64 blob, and unknown random token masked; tool-use and tool-result history masked; gateway placeholders not re-masked; git SHA exempt |
| `tool-references` | Valid tool references pass through; names are scanned; malformed references are withheld |
| `identity-restart` | Placeholder stable across restart; identity key mode 0600 and data directory mode 0700; deleted key gives a new identity and asks again |
| `review` | Pending items stay masked and do not block; listing and page contain no values; token, Origin and Host checks; "Not a secret" unmasks only messages sent after the answer, per conversation, keeps earlier messages masked, and keeps that record across restart; "Secret" stays masked; "Show value" links appear; the reveal page serves the value only with the token, as no-store and no-referrer, with each appearance labelled by its place in the session, the value highlighted in its line, the nearest non-empty line above and below with empty lines kept, and other masked values in that window as placeholders; reveal refuses a missing, wrong or foreign-Host request; answers persist across restart; after restart reveal reports the value is not in memory; review identities match HMAC of the values under the key file; a reply's reveal link is the identity and token of its placeholder; a reply with that link, sent back as history, is reduced to its placeholder, with no token upstream and no new review item |
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

## Gateway-down connect check (approved, live, run once: FAIL)

```sh
python3 .agents/verification/scripts/gateway_down_connect_probe.py
```

Runs the same `claude -p` under `strace -f -e trace=connect`. It records only connect() destinations (address and port), never request or reply content. It passes only when there is no reply, the base URL was tried, and no remote port-443 connect() was attempted. Evidence: `~/.agents/projects/secret-gateway/goals/issue-1/evidence/gateway-down-connect.json`.

Result on 2026-10-30 (plain alias): FAIL. Claude Code tried the closed base URL, then `160.79.104.10:443` (an address `api.anthropic.com` resolves to), and other remote port-443 addresses. No reply, and no model was used. The trace does not show whether a request body was sent.

## Gateway-down proxy variant (approved, live, run once: PASS)

```sh
python3 .agents/verification/scripts/gateway_down_connect_probe.py --proxy
```

Same check, with `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY=1` set as in the README alias. The proxy is a second closed loopback port. Evidence: `evidence/gateway-down-connect-proxy.json`.

Result on 2026-10-30: PASS. Claude Code tried the proxy, made no remote connection, and gave no reply; no model was used. One run only. The gateway-running case is the next section. Do not run it again without approval.

## Gateway-up alias check (approved, live, run once: PASS)

```sh
python3 .agents/verification/scripts/gateway_up_alias_probe.py
```

Starts the real gateway with a recording forwarder as its upstream. Runs `claude -p` under strace with the README alias environment. The prompt holds a synthetic fake key. The forwarder records booleans and statuses only, and refuses to forward a request that still holds the fake key. Evidence: `evidence/gateway-up-alias.json`.

Result on 2026-10-30: PASS. The reply carried the marker. One Messages request reached the upstream with a placeholder and without the fake key, and returned 200. Claude Code made no remote connect(). One request went to the closed proxy port and failed; the reply still worked. One run only. Do not run it again without approval.

## Results (2026-10-30)

| Check | Result |
| --- | --- |
| `check.py` (smoke and 13 journeys) | PASS |
| Subscription authentication probe | PASS (base URL honoured; Bearer forwarded; 200; PROBE-OK on claude-haiku-5-5) |
| Gateway-down check, no trace (one run) | No reply, no model used. Shows no connects, so it is not a pass for story 2 |
| Gateway-down connect check, strace, plain alias (one run) | FAIL: connect() to the API host's address with the gateway down. Request body not shown |
| Gateway-down connect check, strace, proxy variant (one run) | PASS: proxy tried, no remote connect, no reply |
| Gateway-up alias check, strace, proxy variant (one run) | PASS: masked Messages request reached the upstream with a placeholder and returned 200; reply with marker; no remote connect |
| Scanner benchmark | Betterleaks provider rules: pipeline recall 47/48; scanner-alone recall 0.521; p95 86 ms (pass). All-rules Betterleaks p95 319 ms (fails). Kingfisher p95 718 ms (fails) |
| Local OCR (removed) | Not used. Last results kept as history in `evidence/ocr-benchmark.json`: Tesseract 2/7 exact keys, RapidOCR 4/7 |

## Coverage gaps and limits

- **Screenshots are not masked (decision, 2026-10-30).** A secret visible in a screenshot reaches the provider. The image also stays in the conversation history. Expected from the Messages API, later requests resend it; this is not verified live.
- Scanner-alone recall for Cloudflare, Neon, Google and AWS formats is low. Coverage for those comes from the name and entropy layers in the pipeline. The Google `ya29.` prefix is outside the token charset, so only its random tail is masked.
- Desktop notification buttons do not appear on this machine. AppArmor profile `/etc/apparmor.d/notify-send` blocks `GetCapabilities`. Notifications are sent as plain notifications, and the recording notifier verifies the action list only. The review page is the working answer path.
- **Gateway down, plain alias: Claude Code attempts a direct connection to the API host** (strace check, 2026-10-30). It is not known whether a request body was sent. The README alias adds proxy settings. With them, one gateway-down run made no remote connection, and one gateway-running run gave a masked reply. Each is one run. Other HTTPS traffic from Claude Code goes to the closed proxy and fails. Not tested: features that need other HTTPS hosts.
- Thinking blocks are not scanned or changed, since the model only saw placeholders. Tool definitions are not scanned.
- Unsupported content blocks (documents, URL images, other types) are withheld, not scanned. Tool references in tool results are supported when they contain only a type and a string tool name; their names are scanned.
- Benchmarks and journeys do not measure the desktop UI or long-running Claude/Codex sessions.

## Decisions and checkpoints

Decided by the user (2026-10-30):

1. Screenshots pass through unmasked. Local OCR was removed from the code. Reverse this by restoring the OCR path from commit `7b37f2c`.

2. Notification buttons: plain notifications with the review link. The AppArmor profile for `notify-send` is unchanged, so buttons do not appear. Story 27 is not met; the user accepted this on 2026-10-30.
3. Gateway-down test (story 2): approved. The plain alias failed the strace check. The proxy variant passed the gateway-down check, and the gateway-running alias check passed. The README alias uses the variant. Story 2 is recorded as met by the variant, one run each; the limits are in the gaps list.
4. Scanner: provider rules (pipeline p95 86 ms, within the 200 ms limit). All rules (p95 303 ms) is not used.

Open for the user:

5. Optional cleanup: run `rm -rf .tools/rapidocr-venv` and `rm -rf ~/.cache/kingfisher` from the repository root, or decline.
6. Restore policy for placeholders is moot for screenshots now, since no screenshot values are masked.

## Cleanup

Normal and failed runs terminate only the gateway process group they started and remove temporary data. Evidence is kept. After a forced kill of `check.py`, inspect the process list for `bun run start` processes started from this repository before stopping any.
