/* Hook and helper tests. Run: node --test test/hooks.test.mjs
 * Each hook test builds a throwaway repo with a three-zone map and runs the
 * script the way Claude Code does: one JSON event on stdin. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dependents, formatBlast, formatEntry, formatIndex, formatLine, parseMap } from "../scripts/zones-core.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => join(REPO, "scripts", name);

const ZA = [
  "id: ZA", "risk: high", 'read_first: ["docs/billing.md"]', 'purpose: "Billing ledger and invoice export."',
  'paths: ["a/**"]', 'entrypoints: ["a/index.ts"]', "invariants:", '  - "Ledger rows are append-only."',
  "deps: []", 'verify: "npm test a"',
];
const ZB = [
  "id: ZB", "risk: low", "read_first: []", 'purpose: "Dashboard widgets and charts."',
  'paths: ["b/**"]', 'entrypoints: ["b/index.ts"]', "invariants:", '  - "Charts never mutate data."',
  '  - "Totals come from the ledger."', 'deps: ["ZA"]', 'verify: "npm test b"',
];
const ZC = [
  "id: ZC", "risk: low", "read_first: []", 'purpose: "Release scripts."',
  'paths: ["c/**"]', 'entrypoints: ["c/release.sh"]', "invariants: []", "deps: []", 'verify: "npm test c"',
];
const mapText = (blocks = [ZA, ZB, ZC]) =>
  `# Code zones\n${blocks.map((lines) => `\n\`\`\`yaml\n${lines.join("\n")}\n\`\`\`\n`).join("")}`;

/* Routes to ZA only (ZA ≈ 5.1, ZB ≈ 0.5), and to nothing. */
const BILLING = "Fix the billing ledger invoice export rounding.";
const WEATHER = "Summarize the weather forecast for tomorrow.";
const FILES = ["a/index.ts", "a/x.ts", "b/index.ts", "b/chart.ts", "c/release.sh", "docs/billing.md", "notes/todo.md"];

/* A throwaway repo with the fixture tree, plus CODEMAP.md unless map is null. */
function fixture({ map = mapText() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "code-map-repo-"));
  for (const file of FILES) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), `// ${file}\n`);
  }
  if (map !== null) writeFileSync(join(dir, "CODEMAP.md"), map);
  return dir;
}

/* Seen files land here: the child's os.tmpdir() follows TMPDIR. */
const TMP = mkdtempSync(join(tmpdir(), "code-map-seen-"));
const seenFile = (session_id) => join(TMP, `code-map-${session_id}.json`);
let sessions = 0;
const session = () => `test-${process.pid}-${(sessions += 1)}`;

/* Run a hook script on one event. Returns the parsed output, or null when it printed nothing. */
function run(name, event, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [script(name)], {
    cwd,
    input: typeof event === "string" ? event : JSON.stringify({ cwd, ...event }),
    env: { ...process.env, TMPDIR: TMP, CLAUDE_PLUGIN_DATA: "", ...env },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const zones = parseMap(mapText(), (kind, message) => assert.fail(`fixture map: ${message}`));
const [za, zb, zc] = zones;

test("dependents lists zones whose deps name the id", () => {
  assert.deepEqual(dependents(zones, "ZA").map((zone) => zone.id), ["ZB"]);
  assert.deepEqual(dependents(zones, "ZC"), []);
});

test("formatEntry adds used by only when a zone has dependents", () => {
  assert.equal(formatEntry(za, zones), [
    "ZA (high): Billing ledger and invoice export.",
    "  read_first: docs/billing.md",
    "  entrypoints: a/index.ts",
    "  paths: a/**",
    "  invariant: Ledger rows are append-only.",
    "  deps: none",
    "  used by: ZB",
    "  verify: npm test a",
  ].join("\n"));
  assert.doesNotMatch(formatEntry(zc, zones), /used by/);
});

test("formatLine names the zone, its verify command, and the invariant count", () => {
  assert.equal(formatLine("b/chart.ts", zb, "CODEMAP.md"),
    "code-map: b/chart.ts is in ZB (low), Dashboard widgets and charts. verify: npm test b; 2 invariants in CODEMAP.md.");
  assert.match(formatLine("a/x.ts", za, "CODEMAP.md"), /; 1 invariant in CODEMAP\.md\.$/);
  assert.match(formatLine("c/release.sh", zc, "CODEMAP.md"), /; no invariants in CODEMAP\.md\.$/);
});

test("formatBlast names dependents and their unique verify commands", () => {
  assert.equal(formatBlast("a/index.ts", za, zones), "code-map: a/index.ts is a ZA entrypoint used by ZB. verify: npm test b");
  assert.equal(formatBlast("a/index.ts", za, [za, { ...zb, id: "ZD" }, zb]),
    "code-map: a/index.ts is a ZA entrypoint used by ZD, ZB. verify: npm test b");
  assert.equal(formatBlast("c/release.sh", zc, zones), null);
});

test("formatIndex keeps the 1.1.0 intro and lists every zone", () => {
  const index = formatIndex({ relative: "CODEMAP.md", zones });
  assert.match(index, /^This repo has a code-zones map at CODEMAP\.md\. A prompt that moves into a\n/);
  assert.match(index, /source wins\. Zones:\n- ZA \(high\): Billing ledger and invoice export\.\n/);
  assert.match(index, /\n- ZC \(low\): Release scripts\.$/);
});
