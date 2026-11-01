# secret-gateway

A local gateway for Claude Code (Anthropic Messages) and Codex (Responses). It masks secrets in the text sent to the model, restores placeholders in tool calls, and lets you review masked values without blocking the agent.

## Codex Masked

On this machine, run `codex-masked` or select **Codex Masked** in T3. The launcher uses the existing Codex login and routes Responses requests through `secret-gateway-codex.service` on `127.0.0.1:8788`. Its review page is `http://127.0.0.1:8788/review`. The Claude listener stays on port 8787.

The installed launcher and unit are maintained in `scripts/codex-masked` and `scripts/secret-gateway-codex.service`. The unit names this machine's worktree; update its paths before installing elsewhere. Start or inspect it with `systemctl --user start secret-gateway-codex.service` and `systemctl --user status secret-gateway-codex.service`.

The Responses adapter scans instructions, messages, tool results, tool arguments, tool descriptions, and metadata. It restores placeholders in function and custom tool calls, including streamed fragments. Protocol identifiers and encrypted reasoning/compaction remain opaque. Data-URL images pass through unmasked, as with Claude. Unsupported input items and compressed requests are refused. The launcher disables request compression and WebSockets so requests use the masking HTTP boundary. Responses and compaction POSTs are supported; other write routes are refused.

This protects model request text. Local Codex session files and tool output are outside the masking boundary. The service currently depends on this worktree remaining present.

Personal use, on one machine. Bun and TypeScript. The gateway listens on loopback only.

## What it does

- Masks provider keys, `NAME=value` assignments for KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL and DATABASE_URL, URL passwords, UUIDs, JWTs, base64 blobs and random-looking tokens of 20 or more characters.
- Leaves identifiers and keys on the exemption lists unmasked. See Exemptions.
- Replaces each secret with a stable placeholder `⟦SECRET_<6 hex>⟧`. The placeholder is an HMAC of the secret under a local key, so the same secret keeps its placeholder across requests and restarts.
- Restores placeholders in tool-use inputs of responses, including streamed responses.
- Links each placeholder in response text to its review page: `[⟦SECRET_<6 hex>⟧](http://127.0.0.1:<port>/review/reveal/<identity>?token=<token>)`. The link carries the review token, so the token appears in the agent's replies and in Claude Code's transcript files on disk. The gateway reduces these links to the bare placeholder in later requests, so the token is not sent upstream again.
- Does not mask screenshots. Images pass through unchanged. See Limits.
- Holds every new detection masked until you answer it on a local review page. Answers are remembered by identity.
- Refuses a request rather than sending it raw when masking or the upstream fails.

## Setup

Requirements: Bun 1.3 or later, Claude Code logged in with your Claude subscription (`claude auth status` should show `loggedIn: true`). No API key is needed.

1. Install the provider scanner into `.tools/bin` (gitignored). The version is Betterleaks 1.9.0 and the archive checksum is `f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7`.

   ```sh
   mkdir -p .tools/bin
   curl -fsSL -o /tmp/betterleaks.tar.gz https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/betterleaks_1.9.0_linux_x64.tar.gz
   echo "f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7  /tmp/betterleaks.tar.gz" | sha256sum -c -
   tar -xzf /tmp/betterleaks.tar.gz -C .tools/bin betterleaks
   .tools/bin/betterleaks version
   ```

2. The gateway has no npm dependencies. Bun runs it directly, so there is no install step.

3. Enable the pre-commit secret check. Install [lefthook](https://lefthook.dev) and [gitleaks](https://github.com/gitleaks/gitleaks) on your PATH, then run `lefthook install` in the repository root once. A commit with a staged secret is then blocked.

## Run

Start the gateway in its own terminal. It keeps running until you stop it.

```sh
cd /path/to/secret-gateway
bun run start
```

It logs `secret-gateway listening on http://127.0.0.1:8787` and the review page address. The same lines go to `gateway.log` in the data directory (mode 0600), When the file passes 10 MB, the gateway moves it to `gateway.log.1` (replacing the previous `.1`) and starts a new one. Each proxied request has one line, for example `POST /v1/messages 200 412ms masked=1 session=3f9a1c2e`. Each new detection (`pending <identity prefix> from <source> (length N)`) and each review answer (`review answer <identity prefix> <status>`) has one line too. Lines hold counts and 8-character identity or session prefixes, never values or message text. Defaults: `HOST=127.0.0.1`, `PORT=8787`, `UPSTREAM_BASE_URL=https://api.anthropic.com`, data in `~/.local/share/secret-gateway` (`identity.key` with mode 0600, `answers.sqlite`). Change them with environment variables, and see the verification README for the full list.

## Use Claude Code through the gateway

Add this alias to your own shell configuration. This repository does not install it:

```sh
alias claude-masked='ANTHROPIC_BASE_URL=http://127.0.0.1:8787 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=1 claude'
```

Then start a session with `claude-masked`. The base URL sends requests to the gateway. The proxy settings send any other connection to port 9, where nothing should listen, so a direct connection to the API fails. Port 9 must have nothing listening on this machine. In one live check on 2026-10-30, this alias gave a masked reply with the gateway running. With the gateway down, it made no remote connection. The alias without the proxy settings did connect to the API host (see Limits).

## Exemptions

Some values match the masking rules but are routing data, such as the T3 Code thread and task IDs an agent passes back to T3 tools. `exemptions.json` in the data directory lists what stays unmasked:

- A **prefix** exempts a value inside an identifier that starts with it, such as `mcp:launch:`. An identifier ends at any character outside letters, digits and `: % / . _ ~ -`, so a link's query text after `?` stays scanned.
- A **key** exempts the value after that name, such as `"threadId":`.

The gateway creates the file on first start with the T3 Code entries, then the file is the source of truth. The gateway re-reads it on the next request after it changes, so no restart is needed. If the file is invalid, the gateway keeps the previous lists (none at startup) and logs the reason. The file holds no secret values. For one value, use **Not a secret** on the review page.

```sh
bun run exempt list
bun run exempt add prefix acme-ref: --note "vendor ticket IDs"
bun run exempt add key ticketId
bun run exempt remove prefix acme-ref:
```

The command refuses a prefix under 6 characters and a key named like a credential (KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL, DATABASE_URL), because their values would be unmasked. Set `GATEWAY_DATA_DIR` to edit another data directory.

## Review detections

Open http://127.0.0.1:8787/review while the gateway runs. Each row shows an identity prefix, status, source (for example `tool result from Bash`) and length. The page itself never shows a value.

- **Show value** opens a new page that lists each appearance of the value in the session, labelled with its place (for example `user message text, message 3`). Each appearance shows its line with the value highlighted, the nearest non-empty line above and below it, and the empty lines between. Other masked values in those lines show as placeholders. The page needs the review token, which the review page includes, so only a page from this gateway can open it. The line and value are held in memory only. They are never written to disk, and a restart removes them. Rows from before a restart show "value not in memory".

- **Secret** keeps the value masked.
- **Not a secret** unmasks the value only in messages that each conversation sends after your answer. Messages sent before it keep their placeholders, so their prompt cache is not rewritten. A conversation is the Claude Code session header plus the system prompt, so a side request with its own system prompt has its own record. The record is kept in the answers database, so a restart does not change it. A conversation that starts after your answer has no earlier messages, so the value is unmasked from its first message.

The page only answers requests from the page itself. Desktop notifications are sent with a link to this page. On this machine, their buttons do not appear (see Limits).

## Verify

```sh
python3 .agents/verification/scripts/check.py
bun run bench/scanner.ts
```

These run the HTTP-boundary journeys and the scanner benchmark. The commands and results are in [.agents/verification/README.md](.agents/verification/README.md).

## Limits

- **Without the proxy settings, Claude Code connects to the API host when the gateway is down.** In one live check on 2026-10-30, the alias without proxy settings made a connection attempt to the API host with the gateway down. The trace does not show whether a request body was sent. The alias in Setup adds the proxy settings. Its gateway-down run made no remote connection. Its gateway-running run gave a masked reply. Each is one run. Claude Code's other HTTPS traffic (for example web fetch or MCP servers) goes to the closed proxy and fails. Not tested: those features. Keep the gateway running whenever you use the alias.
- **Screenshots are not masked.** Images pass through to Anthropic unchanged, so a secret visible in a screenshot reaches the provider. The image also stays in the conversation history. Expected from the Messages API, later requests resend it; this was not checked live. Prefer text sources. Rotate any key that appeared in a screenshot.
- Desktop notification buttons need an AppArmor change to `notify-send` on this machine. Not changed. Notifications are plain, and the review page answers. Story 27 (buttons) is not met; you accepted this on 2026-10-30.
- Scanner-alone recall is low for Cloudflare, Neon, Google and AWS formats. The name and entropy layers cover them in the full pipeline.
- Thinking blocks are not changed. Tool definitions are not scanned. Document blocks and URL images are withheld, not scanned.
- Not covered: other agents, hosted use, and multiple users. Codex has HTTP-boundary checks and a live reply probe; long-running Codex sessions and compaction have not been verified live.
- Claude Code's own transcripts keep real values, as they did before.
