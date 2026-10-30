// Scanner benchmark: picks the provider-pattern scanner by recall on synthetic fixtures and
// per-request latency. Run from the repository root: bun run bench/scanner.ts
// Scanner-alone recall is the decision metric. Pipeline recall (scanner plus in-process layers)
// is reported alongside it. Latency is checked against 200 ms per request at p95.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findHits } from '../src/hits.ts';
import { ExternalScanner, parseGitleaksJson, parseKingfisherJsonl } from '../src/scanner.ts';

type Case = { id: string; kind: 'positive' | 'negative'; family: string | null; gitContext?: boolean; text: string; secrets: string[] };
type Candidate = { name: string; argv: string[]; parse: (stdout: string) => { secret: string; line: number }[]; okExitCodes: number[] };

const LATENCY_LIMIT_MS = 200;
const cases: Case[] = await Bun.file('.agents/verification/fixtures/scanner-cases.json').json();
const candidates: Candidate[] = [
  { name: 'betterleaks 1.9.0 (all rules)', argv: ['.tools/bin/betterleaks', 'stdin', '-f', 'json', '-r', '-', '--no-banner', '--exit-code', '0'], parse: parseGitleaksJson, okExitCodes: [0] },
  // Generic rules duplicate the in-process name and URL layers and dominate the cost.
  { name: 'betterleaks 1.9.0 (provider rules)', argv: ['.tools/bin/betterleaks', 'stdin', '-f', 'json', '-r', '-', '--no-banner', '--exit-code', '0', '--disable-rule', 'generic-api-key', '--disable-rule', 'generic-credential-uri', '--disable-rule', 'generic-password', '--disable-rule', 'generic-username'], parse: parseGitleaksJson, okExitCodes: [0] },
  { name: 'kingfisher 2.13.0', argv: ['.tools/bin/kingfisher', 'scan', '-', '--no-validate', '--no-update-check', '--format', 'jsonl'], parse: parseKingfisherJsonl, okExitCodes: [0, 200] },
];

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};

async function evaluate(candidate: Candidate) {
  const scanner = new ExternalScanner(candidate);
  const scannerMs: number[] = [];
  const pipelineMs: number[] = [];
  const perFamily = new Map<string, { expected: number; found: number }>();
  let positives = 0;
  let expected = 0;
  let found = 0;
  let pipelineExpected = 0;
  let pipelineFound = 0;
  const negativeFlags: string[] = [];
  const pipelineNegativeFlags: string[] = [];
  const misses: string[] = [];

  for (const testCase of cases) {
    let started = performance.now();
    const findings = await scanner.scan(testCase.text);
    scannerMs.push(performance.now() - started);
    const scannerSecrets = findings.map((finding) => finding.secret);

    started = performance.now();
    const [hits] = await findHits([{ text: testCase.text, gitContext: testCase.gitContext ?? false }], scanner);
    pipelineMs.push(performance.now() - started);
    const pipelineSecrets = hits.map((hit) => hit.secret);

    if (testCase.kind === 'negative') {
      if (scannerSecrets.length > 0) negativeFlags.push(`${testCase.id}: ${scannerSecrets.length} finding(s)`);
      if (pipelineSecrets.length > 0) pipelineNegativeFlags.push(testCase.id);
      continue;
    }
    positives++;
    for (const secret of testCase.secrets) {
      expected++;
      pipelineExpected++;
      const family = perFamily.get(testCase.family!) ?? { expected: 0, found: 0 };
      family.expected++;
      if (scannerSecrets.some((value) => value === secret || value.includes(secret))) {
        found++;
        family.found++;
      } else {
        misses.push(`${testCase.id}`);
      }
      if (pipelineSecrets.some((value) => value === secret)) pipelineFound++;
      perFamily.set(testCase.family!, family);
    }
  }

  return {
    scanner: candidate.name,
    positiveCases: positives,
    expectedSecrets: expected,
    scannerRecall: Math.round((found / expected) * 1000) / 1000,
    pipelineRecall: Math.round((pipelineFound / pipelineExpected) * 1000) / 1000,
    negativeCasesFlagged: negativeFlags,
    pipelineNegativeFlagged: pipelineNegativeFlags,
    scannerMsPerRequest: { p50: percentile(scannerMs, 50), p95: percentile(scannerMs, 95), max: percentile(scannerMs, 100) },
    pipelineMsPerRequest: { p50: percentile(pipelineMs, 50), p95: percentile(pipelineMs, 95), max: percentile(pipelineMs, 100) },
    perFamilyScannerRecall: Object.fromEntries(
      [...perFamily].map(([family, counts]) => [family, `${counts.found}/${counts.expected}`]),
    ),
    scannerMissedCases: misses,
    withinLatencyLimit: percentile(pipelineMs, 95) < LATENCY_LIMIT_MS,
  };
}

const results = [];
for (const candidate of candidates) {
  try {
    results.push(await evaluate(candidate));
  } catch (error) {
    results.push({ scanner: candidate.name, failed: (error as Error).message });
  }
}
// Gitleaks 8.16 (Ubuntu package) is excluded: its stdin mode did not read input on this machine.
const report = {
  checkedAt: new Date().toISOString(),
  fixtures: 'scanner-cases.json (synthetic)',
  latencyLimitMs: LATENCY_LIMIT_MS,
  excluded: { 'gitleaks 8.16.0': 'no stdin command; --pipe did not read stdin in this build' },
  results,
};
const evidenceDir = join(homedir(), '.agents/projects/secret-gateway/goals/issue-1/evidence');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'scanner-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
