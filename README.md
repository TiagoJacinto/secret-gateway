# secret-gateway

A local gateway between Claude Code and the Anthropic Messages API. It masks secrets in the text sent to the model, restores placeholders in tool calls, and lets you review masked values without blocking the agent.

Personal use, on one machine. Bun and TypeScript. The gateway listens on loopback only.

## What it does

- Masks provider keys, `NAME=value` assignments for KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL and DATABASE_URL, URL passwords, UUIDs, JWTs, base64 blobs and random-looking tokens of 20 or more characters.
- Replaces each secret with a stable placeholder `⟦SECRET_<6 hex>⟧`. The placeholder is an HMAC of the secret under a local key, so the same secret keeps its placeholder across requests and restarts.
- Restores placeholders in tool-use inputs of responses, including streamed responses.
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

## Run

Start the gateway in its own terminal. It keeps running until you stop it.

```sh
cd /path/to/secret-gateway
bun run start
```

It logs `secret-gateway listening on http://127.0.0.1:8787` and the review page address. Defaults: `HOST=127.0.0.1`, `PORT=8787`, `UPSTREAM_BASE_URL=https://api.anthropic.com`, data in `~/.local/share/secret-gateway` (`identity.key` with mode 0600, `answers.sqlite`). Change them with environment variables, and see the verification README for the full list.

## Use Claude Code through the gateway

Add this alias to your own shell configuration. This repository does not install it:

```sh
alias claude-masked='ANTHROPIC_BASE_URL=http://127.0.0.1:8787 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=1 claude'
```

Then start a session with `claude-masked`. The base URL sends requests to the gateway. The proxy settings send any other connection to port 9, where nothing should listen, so a direct connection to the API fails. Port 9 must have nothing listening on this machine. In one live check on 2026-10-30, this alias gave a masked reply with the gateway running. With the gateway down, it made no remote connection. The alias without the proxy settings did connect to the API host (see Limits).

## Review detections

Open http://127.0.0.1:8787/review while the gateway runs. Each row shows an identity prefix, status, source (for example `tool result from Bash`) and length. It never shows a value.

- **Secret** keeps the value masked.
- **Not a secret** unmasks the value from the next request onward, across the whole history. Expect a cost spike in prompt caching when you do this.

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
- Not covered: Codex or other agents, hosted use, multiple users, and live validation with providers.
- Claude Code's own transcripts keep real values, as they did before.
