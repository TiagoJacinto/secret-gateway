// External provider-pattern scanner, run as a binary in stdin mode. The command comes from configuration,
// so the rule set stays whatever version is installed. Output is parsed into secret strings and line numbers.
import type { ScanFinding, Scanner } from './hits.ts';

// okExitCodes: codes that mean the scan ran. Other codes are failures and withhold the request.
export type ScannerCommand = { argv: string[]; parse: (stdout: string) => ScanFinding[]; okExitCodes: number[] };

// gitleaks-compatible JSON: an array of findings with Secret and StartLine.
export function parseGitleaksJson(stdout: string): ScanFinding[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  const findings = JSON.parse(trimmed) as { Secret?: string; Match?: string; StartLine?: number }[];
  return (findings ?? []).map((finding) => ({
    secret: finding.Secret || finding.Match || '',
    line: finding.StartLine ?? 1,
  }));
}

// Kingfisher JSON Lines: one line per finding with the matched value in finding.snippet.
export function parseKingfisherJsonl(stdout: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as { finding?: { snippet?: string; line?: number } };
    if (record.finding?.snippet) findings.push({ secret: record.finding.snippet, line: record.finding.line ?? 1 });
  }
  return findings;
}

// Chosen by bench/scanner.ts: Betterleaks with its provider rules. The four generic rules are disabled
// because the in-process name and URL layers cover them, and they cost about 220 ms per request.
export const GENERIC_RULES = ['generic-api-key', 'generic-credential-uri', 'generic-password', 'generic-username'];

export function providerScanner(binary: string): ScannerCommand {
  const disabled = GENERIC_RULES.flatMap((rule) => ['--disable-rule', rule]);
  return {
    argv: [binary, 'stdin', '-f', 'json', '-r', '-', '--no-banner', '--exit-code', '0', ...disabled],
    parse: parseGitleaksJson,
    okExitCodes: [0],
  };
}

export class ExternalScanner implements Scanner {
  readonly #command: ScannerCommand;

  constructor(command: ScannerCommand) {
    this.#command = command;
  }

  async scan(text: string): Promise<ScanFinding[]> {
    const process = Bun.spawn(this.#command.argv, { stdin: new TextEncoder().encode(text), stdout: 'pipe', stderr: 'ignore' });
    const stdout = await new Response(process.stdout).text();
    const exitCode = await process.exited;
    if (!this.#command.okExitCodes.includes(exitCode)) throw new Error(`scanner exited with ${exitCode}`);
    return this.#command.parse(stdout);
  }
}
