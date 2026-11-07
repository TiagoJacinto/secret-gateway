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

Uses the running gateway on port 8787 under `/codex` (the default `--base-url`), the existing ChatGPT login, and real model capacity. A temporary verifier accepts only the original synthetic UUID supplied in the prompt. The command prints only a pass/fail report. It is separate from the automated suite. Use `--base-url` to test another Responses listener.

## Live masking sessions

```sh
python3 .agents/verification/scripts/live_session.py --self-test   # no model call
python3 .agents/verification/scripts/live_session.py claude        # one live run through claude-masked
python3 .agents/verification/scripts/live_session.py codex         # one live run through codex-masked
```

Needs the gateway on port 8787 running (`secret-gateway.service`). Codex runs through it under `/codex`. A live run sends one synthetic `ghp_`-shaped value and writes booleans, counts and file paths to `~/.agents/projects/secret-gateway/goals/issue-1/evidence/live-<tool>-session.json`. It never prints or keeps the value or the reply text. It passes when all of these hold: exit 0; a placeholder appears in the reply; the value is absent from the reply, the new log lines and stderr; a route returns 200; the value store holds the value with mode 0600; and no other file in the store, the scratch folder or the CLI's data directory holds the value. Scratch files go to `TMPDIR` and are removed.

For Codex, the stderr rule first removes only the exact `GITHUB_TOKEN=<value>` line, which is the prompt echo (see Codex echo finding below). Any other occurrence of the value fails.

## Launch settings

`check.py` starts `bun run start` with fresh temporary data and an assigned loopback port. The gateway reads:

| Variable | Used for | Default |
| --- | --- | --- |
| `HOST` | Listen address; must be loopback or the gateway refuses to start | `127.0.0.1` |
| `PORT` | Listen port | `8787` |
| `UPSTREAM_BASE_URL` | Anthropic forward target for Claude Code (fake upstream in checks) | `https://api.anthropic.com` |
| `RESPONSES_UPSTREAM_BASE_URL` | Responses forward target for Codex, reached under the `/codex` prefix (fake upstream in checks) | `https://chatgpt.com/backend-api/codex` |
| `GATEWAY_DATA_DIR` | Identity key, review token, answers database, value store, `exemptions.json` and log | `~/.local/share/secret-gateway` |
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
| `text-links` | Placeholder inside link text, a link destination, or a bare URL stays plain; elsewhere it links to its review page; same exact text when placeholders split across 5-character fragments; review row shows the last line with the placeholder and no review link |
| `prompt-note` | Original system prompt kept; note covers placeholder use, no "missing" warnings, masking of all text including accessibility trees, handling credentials through placeholders, verification, unmasked screenshots and text over screenshots, no screenshot while a credential is on screen, no deletion or revocation without approval; note added without a system prompt |
| `detection-fixtures` | Every positive fixture (48) masked at the HTTP boundary; every negative (8) forwarded unchanged; git SHA exempt only in git output |
| `canonical-forms` | Plain, quoted and padded, percent-encoded, and base64 copies share one placeholder |
| `exemptions-and-formats` | UUID, JWT, base64 blob, and unknown random token masked; tool-use and tool-result history masked; gateway placeholders not re-masked; git SHA exempt; T3 thread, run, task and link identifiers exempt in tool results and tool inputs; a UUID under a non-T3 key and a token in a T3 link query stay masked |
| `exemption-file` | A regex pattern added with `bun run exempt` applies to the next request without a restart; it must match a whole identifier (a leading wildcard works, a longer identifier that only starts like it does not); a removed pattern is masked again; the list shows added and seed entries; the file has mode 0600; the CLI refuses a pattern that matches a credential-shaped token, a UUID-wide pattern, a bare `.*`, a quantifier on a group, a lookahead, a backreference, more than 3 quantifiers, an invalid regex, the old `prefix` kind, a credential-named key and an absent entry; an invalid file keeps the previous lists and the log names the problem without a value; an invalid file at startup exempts nothing |
| `tool-references` | Valid tool references pass through; names are scanned; malformed references are withheld |
| `identity-restart` | Placeholder stable across restart; identity key mode 0600 and data directory mode 0700; deleted key gives a new identity and asks again |
| `review` | Pending items stay masked and do not block; listing and page contain no values; token, Origin and Host checks; "Not a secret" unmasks only messages sent after the answer, per conversation, keeps earlier messages masked, and keeps that record across restart; "Secret" stays masked; "Show value" links appear; the reveal page serves the value only with the token, as no-store and no-referrer, with each appearance labelled by its place in the session, the value highlighted in its line, the nearest non-empty line above and below with empty lines kept, and other masked values in that window as placeholders; each row shows the last line with the placeholder and no review link; reveal refuses a missing, wrong or foreign-Host request; answers persist across restart; after restart reveal still shows the value and the table still shows its last line with no value, read from `values.sqlite`; `values.sqlite` and `review.token` are mode 0600; forget needs the token, a valid identity and a same-origin request, deletes the stored value and its lines, keeps the status, and leaves no value or last line on the page; a later request that still sends the value masked stores it again; review identities match HMAC of the values under the key file; a reply's reveal link is the identity and token of its placeholder; a reply with that link, sent back as history, is reduced to its placeholder, with no token upstream and no new review item |
| `images` | Five screenshots forwarded byte for byte (not masked, by decision); text beside a screenshot still masked; an image given by URL is withheld and not forwarded |
| `notifications` | Nothing before the 10 s batch window; batch of five gives three item notifications and one summary; item notifications carry Secret and Not a secret actions; rate limit of three per minute; budget returns after a minute; notifications contain no values |
| `fail-closed` | Upstream unreachable gives 502 without a raw value; scanner missing withholds text; invalid JSON and non-JSON message requests refused; non-loopback HOST refuses to start; an invalid `detections.json` at startup refuses to start |
| `detection-file` | A pattern added with `bun run detect` masks the next request without a restart, with the case rule it was added with (`--case sensitive` matches only the spelled capitalization, `--case insensitive` any capitalization), including base64 copies; the list shows the added entry; the file has mode 0600; the CLI refuses an add without a case rule, a pattern that matches ordinary text, the empty string, a quantifier on a group, a lookahead, an invalid regex, more than 3 quantifiers, the exemption kind and an absent entry; a removed pattern stops masking without a restart; an invalid file keeps the previous list and the log names the problem without a value |
| `adapter-independence` | Masking core modules contain no Anthropic message markers (story 37 assessment) |
| `disk-non-disclosure` | No fixture value, or its last 20 characters, in any gateway file, log, notification record or the evidence folder, except `values.sqlite` with its `-wal` and `-shm` files. The value store must hold the values, and its files must be mode 0600 |

Each journey starts its own gateway processes. Ports are assigned per process. Temporary data (value stores, identity keys, logs) is removed after the disk scan, so the scan sees it first.

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

## Results (2026-11-03)

| Check | Result |
| --- | --- |
| `check.py` (smoke, 15 journeys including `review` and `disk-non-disclosure`, Responses check) | PASS at 2026-11-03 13:01 UTC. All 15 journeys pass; `review` has 49 checks. The Responses check passes. An earlier run that day failed `review` after restart, because a group `SIGTERM` could end the gateway before it wrote the last lines. The fix is in the next row |
| Shutdown on group `SIGTERM` (ad hoc, scratch scripts outside the repository, not kept) | Before the fix in `src/main.ts`: 3 of 4 runs lost the last line. `bun run start` and its child both receive the signal, and `process.once` removed the listener, so a second signal could end the process mid-flush. After the fix (listener kept, shutdown runs once): 6 of 6 group runs and 1 wrapper-only run kept the last line |
| Link restoration, ad hoc (scratch script outside the repository, not kept) | 11 text cases across 16 fragment sizes. Streamed text matched plain text on both Anthropic and Responses paths: 0 mismatches |
| `bun build` | Exit 0; bundles 15 modules |
| Typecheck | Not run. The repository has no `tsconfig.json` |

No live probes were run in this check. The live sessions of the same day are in the next section.

## Live sessions (2026-11-03, goal `live-masking-verification`)

| Check | Result |
| --- | --- |
| `live_session.py --self-test` | PASS: six cases, no model call |
| Claude live session, run 1 (14:36 UTC) | FAIL on `placeholder_in_reply` only. Exit 0; both calls 200; no value in reply, log, stderr or other files. This run predates the `reply_chars` field. Evidence: `live-claude-session-run1-fail.json` |
| Codex live session, run 1 (14:37 UTC) | PASS. The echo line is in stderr; no value appears outside it. Evidence: `live-codex-session-run1.json` |
| Codex live session, run 2 (14:58 UTC) | PASS. Exit 0; one route 200 with `masked=121`; the echo line is in stderr and no value appears outside it. It also stored two origin rows (see Origins). Evidence: `live-codex-session.json` |
| Claude live session, run 2 (14:37 UTC) | PASS. Evidence: `live-claude-session.json` |
| Earlier runs (13:21 UTC, before the echo rule) | Claude PASS. Codex FAIL on `value_in_stderr` only. Evidence: `live-claude-session-before-rerun.json`, `live-codex-session-before-echo-fix.json` |
| `check.py` | PASS: smoke, journeys, Responses check. Evidence: `http-smoke.json`, `journeys.json` |

Runs used in this goal: 2 of 2 Claude, 2 of 2 Codex.

The Claude criterion is unstable. With the same script, one run had no placeholder in its reply and the next had one. The cause is not known. The reply text is not kept, by design. `reply_chars` now records the reply length, so a repeat can show whether the reply was empty.

Values forgotten: one synthetic value (length 40) in each store, from the 13:20–13:22 UTC window. Still pending in that window and not confirmed synthetic: four Claude items (lengths 46, 29, 39, 117) and one Codex item (length 132).

Forgotten after the 14:55 UTC restart: the three synthetic values (length 40) from the 14:36–14:37 runs, two Claude and one Codex, each confirmed by its window and length. The review API returned `deleted: true` for each, and `values.sqlite` holds no row for them. Their `items` rows stay `pending` with no value. Five other Claude items and twelve other Codex items come from the CLI's own context and are not confirmed synthetic. All of them are left pending.

### Codex echo finding

`codex exec` prints its prompt to stderr as a `user` block, before it calls the provider. So the prompt's `GITHUB_TOKEN=` line appears in stderr. A marker run confirmed the format: the line is `GITHUB_TOKEN=<marker>` with no prefix or trailing text. That run used a closed provider port, so no model was called, and it ended at the 90 s timeout. This is Codex CLI behaviour, not a gateway leak. The stderr rule removes only that line for Codex. Changing the CLI is a follow-up.

### Classification of the 138 masked items: blocked

Status: the 138 masked items stay unclassified. They predate the origins change below, so their rule and location are not stored, and they cannot be classified from stored data. New items can be classified: both gateways were restarted at 14:55 UTC on the origins code, and the Codex run at 14:58 UTC produced live origin rows (see Origins below).

The 138 count is from `POST /responses 400 masked=138` at 13:17:26 UTC. That request used a rejected model. The log shows 35 new pending items in the 13:17:00–13:17:27 window: 15 `message text` and 20 `request metadata`. The other masked items were not logged as new. Grouping by source label alone (option a) was not chosen. See Decisions item 7.

### Origins of new items (approved src change, 2026-11-03)

The user chose option (b) of the classification question. When the gateway first sees an item, it writes one row to the `origins` table of `answers.sqlite`:

- `rule`: the Betterleaks rule ID, such as `github-pat`, or an in-process layer name: `in-process:name`, `in-process:url-password`, `in-process:uuid`, `in-process:jwt` or `in-process:entropy`.
- `location`: the slot location in the request, such as `tool result from Bash, message 3`. It is a position label, not a file path. Tool inputs are not stored.

The row holds no value. It records the first sighting only. The table is created on open, with no migration. Items stored before this change have no row.

Verification, 2026-11-03. The scratch scripts are not committed. They printed only rule names, counts and booleans:
- A check with the real Betterleaks binary on a synthetic GitHub token, an `API_KEY=` value and a UUID. The token got `github-pat`, the value got `in-process:name`, and the UUID got `in-process:uuid`.
- A store check: a second write of the same item adds no row, and an item stored before the change gets no row.
- An end-to-end check: one masked request to a fresh gateway stored `github-pat` at `tool result from Bash, message 3`.
- `check.py`: PASS.
- Deployed on 2026-11-03. The user approved a restart. Restart alone would not load the change, because both units run from `t3-c0af0a97`, which was at `df05576`. So that worktree was moved, detached, to `f751ac6`, and both units were restarted at 14:55 UTC. Both processes run from `t3-c0af0a97`. Both listen on 8787 and 8788, and both review pages return 200. Both `answers.sqlite` files have the `origins` table, with no rows yet. The restart ended the gateway's open desktop notifications, and no gateway notification process remains. Their pending items remain on the review page.
- Verified live, 14:58 UTC: the Codex test run (run 2) stored `github-pat` at `message text, item 7` and `in-process:entropy` at `message text, item 6`, both in the Codex store, both `pending`. The read-only query above returns these two rows.
- Forgotten after run 2: the synthetic `github-pat` value (length 40). Its `values.sqlite` rows are gone. The `in-process:entropy` item from the same run (length 29) is not confirmed synthetic and stays pending.
- Rollback: `git -C /home/tiago/.t3/worktrees/secret-gateway/t3-c0af0a97 checkout --detach df05576`, then `systemctl --user restart secret-gateway.service secret-gateway-codex.service`.

Read-only query, once the gateways run this code. Run it on `~/.local/share/secret-gateway-codex/answers.sqlite` and `~/.local/share/secret-gateway/answers.sqlite`:

```sql
SELECT o.rule, o.location, i.status, count(*) AS items
FROM origins o JOIN items i ON i.id = o.id
GROUP BY o.rule, o.location, i.status;
```

### One gateway process (committed as 2ab4327, deployed 2026-11-03)

Approved by the user on 2026-11-03. One process now serves both clients on port 8787:
- Requests under `/codex` (Codex) use the Responses adapter and `RESPONSES_UPSTREAM_BASE_URL`. The prefix is removed before the upstream sees the path, so `/codex/responses` reaches `<upstream>/responses`.
- All other requests (Claude Code) use the Anthropic adapter and `UPSTREAM_BASE_URL`, as before.
- The review page is `http://127.0.0.1:8787/review` for both.
- The launcher `scripts/codex-masked` points at `http://127.0.0.1:8787/codex`. The unit `scripts/secret-gateway-codex.service` is removed from the branch.
- `responses_check.py` checks the routing: a `GET /codex/models` reaches the Responses upstream as `/models`, and a `GET /models` reaches the Anthropic upstream.
- `check.py`: PASS. `tsc` on `src/`: no errors. One error in `bench/scanner.ts` (`Candidate` lacks `rule`), left as it was. It comes from the `rule` field added in `f751ac6`.

Deployed on 2026-11-03 at 15:17 UTC. The user chose option 1 of the store plan: merge both stores into one, keep the Claude identity key, keep every old ID.
1. Stopped `secret-gateway.service` and `secret-gateway-codex.service`. No client session was running.
2. Backed up both data directories to `~/.local/share/secret-gateway-premerge-2026-11-03` (owner-only). The backup holds stored values. Delete it once the merge is accepted.
3. Merged the Codex stores into `~/.local/share/secret-gateway`. Every ID was kept. Counts: 4013 items, 3 origins, 71 conversations, 62 unmask points, 243 value entries, 544 appearances. Every row from both backups is in the merged store, and the appearance order per identity is kept. The check compared the stores in place and printed PASS/FAIL only.
4. Set `t3-c0af0a97` to `2ab4327` (detached). Disabled the Codex unit and moved it into the backup directory.
5. Started `secret-gateway.service`, which listens on 8787. `/review` returns 200, port 8788 is closed, and `GET /codex/models` is logged as `/codex/models 401` from the Responses upstream. The probe sent no credentials.

Not verified: a live Claude or Codex session after the merge. Both live caps are used (2 of 2 each). The old Codex data directory `~/.local/share/secret-gateway-codex` is untouched and no longer read.

## Coverage gaps and limits

- **Screenshots are not masked (decision, 2026-10-30).** A secret visible in a screenshot reaches the provider. The image also stays in the conversation history. Expected from the Messages API, later requests resend it; this is not verified live.
- No journey or `responses_check.py` case covers a placeholder inside a link or URL on the Responses path. The ad hoc check in the 2026-11-03 results covers it, and it is not repeatable from the suite.
- Scanner-alone recall for Cloudflare, Neon, Google and AWS formats is low. Coverage for those comes from the name and entropy layers in the pipeline. The Google `ya29.` prefix is outside the token charset, so only its random tail is masked.
- Desktop notification buttons do not appear on this machine. AppArmor profile `/etc/apparmor.d/notify-send` blocks `GetCapabilities`. Notifications are sent as plain notifications, and the recording notifier verifies the action list only. The review page is the working answer path.
- **Gateway down, plain alias: Claude Code attempts a direct connection to the API host** (strace check, 2026-10-30). It is not known whether a request body was sent. The README alias adds proxy settings. With them, one gateway-down run made no remote connection, and one gateway-running run gave a masked reply. Each is one run. Other HTTPS traffic from Claude Code goes to the closed proxy and fails. Not tested: features that need other HTTPS hosts.
- Thinking blocks are not scanned or changed, since the model only saw placeholders. Tool definitions are not scanned on the Messages path. The Responses path scans string fields under `tools`, `metadata` and `prompt`, labelled `request metadata`. Its effect on false positives is not measured.
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
Decided by the user (2026-11-03):

7. Classification: option (b), store the Betterleaks rule ID and source location per item. Implemented; see Origins of new items. Option (a) and option (c) were not chosen. The 138 items cannot be classified, since they predate the change.

## Cleanup

Normal and failed runs terminate only the gateway process group they started and remove temporary data. Evidence is kept. After a forced kill of `check.py`, inspect the process list for `bun run start` processes started from this repository before stopping any.
