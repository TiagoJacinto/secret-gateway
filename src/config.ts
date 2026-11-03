import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
  host: string;
  port: number;
  // Anthropic Messages upstream, used by Claude Code.
  upstreamBaseUrl: string;
  // Responses upstream, used by Codex. Codex reaches it through the /codex path prefix.
  responsesUpstreamBaseUrl: string;
  dataDir: string;
  testControl: boolean;
  manualClock: boolean;
  notifyRecordPath?: string;
  scannerBinary: string;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  // The review surface and the answers store are for one user on this machine. Refuse other interfaces.
  if (!LOOPBACK.has(host)) throw new Error(`HOST must be loopback (got ${host}); the gateway is local-only`);
  const port = Number(env.PORT ?? 8787);
  return {
    host,
    port,
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
    responsesUpstreamBaseUrl: (env.RESPONSES_UPSTREAM_BASE_URL ?? 'https://chatgpt.com/backend-api/codex').replace(/\/$/, ''),
    dataDir: env.GATEWAY_DATA_DIR ?? join(homedir(), '.local', 'share', 'secret-gateway'),
    testControl: env.GATEWAY_TEST_CONTROL === '1',
    manualClock: env.GATEWAY_CLOCK === 'manual',
    notifyRecordPath: env.GATEWAY_NOTIFY_RECORD,
    scannerBinary: env.GATEWAY_SCANNER_BINARY ?? join(import.meta.dir, '..', '.tools', 'bin', 'betterleaks'),
  };
}
