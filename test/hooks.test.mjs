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

test("route injects a fresh high-risk zone once per session, with a notice", () => {
  const cwd = fixture();
  const session_id = session();
  const first = run("route.mjs", { session_id, prompt: BILLING }, { cwd });
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(first.hookSpecificOutput.additionalContext, /^code-map: this prompt enters ZA\. The entries below/);
  assert.match(first.hookSpecificOutput.additionalContext, /\n {2}used by: ZB\n/);
  assert.equal(first.systemMessage, "code-map → ZA (high)");
  assert.deepEqual(JSON.parse(readFileSync(seenFile(session_id), "utf-8")), { zones: { ZA: "full" }, blast: [] });
  assert.equal(run("route.mjs", { session_id, prompt: BILLING }, { cwd }), null);
});

test("route stays silent for one low-risk zone and for unrelated prompts", () => {
  const cwd = fixture();
  assert.equal(run("route.mjs", { session_id: session(), prompt: "Restyle the dashboard widgets charts." }, { cwd }), null);
  assert.equal(run("route.mjs", { session_id: session(), prompt: WEATHER }, { cwd }), null);
});

test("route upgrades a zone seen as one line to its full entry", () => {
  const cwd = fixture();
  const session_id = session();
  writeFileSync(seenFile(session_id), JSON.stringify({ zones: { ZB: "line" }, blast: [] }));
  const out = run("route.mjs", { session_id, prompt: "Rework the dashboard widgets charts and the release scripts." }, { cwd });
  assert.match(out.hookSpecificOutput.additionalContext, /\nZB \(low\): Dashboard widgets and charts\.\n/);
  assert.match(out.hookSpecificOutput.additionalContext, /\nZC \(low\): Release scripts\.\n/);
  assert.equal(out.systemMessage, "code-map → ZB (low), ZC (low)");
  assert.deepEqual(JSON.parse(readFileSync(seenFile(session_id), "utf-8")).zones, { ZB: "full", ZC: "full" });
});

test("route reads a 1.1.0 seen file as empty", () => {
  const cwd = fixture();
  const session_id = session();
  writeFileSync(seenFile(session_id), JSON.stringify(["ZA"]));
  assert.ok(run("route.mjs", { session_id, prompt: BILLING }, { cwd }));
});

const HOOKS = ["route.mjs", "spawn.mjs", "touch.mjs"];

test("hooks exit 0 and print nothing on invalid JSON", () => {
  const cwd = fixture();
  for (const name of HOOKS) assert.equal(run(name, "not json", { cwd }), null, name);
});

test("spawn appends routed zone entries to the subagent prompt and keeps the other fields", () => {
  const cwd = fixture();
  const tool_input = { description: "Scope billing", prompt: BILLING, subagent_type: "general-purpose", run_in_background: false };
  const out = run("spawn.mjs", { session_id: session(), tool_name: "Agent", tool_input }, { cwd });
  const { hookEventName, permissionDecision, updatedInput } = out.hookSpecificOutput;
  assert.equal(hookEventName, "PreToolUse");
  assert.equal(permissionDecision, undefined);
  assert.deepEqual({ ...updatedInput, prompt: "" }, { ...tool_input, prompt: "" });
  assert.ok(updatedInput.prompt.startsWith(`${BILLING}\n\nZone context for this task (code-map, CODEMAP.md; source wins):\nZA (high): `));
  assert.match(updatedInput.prompt, /\n {2}used by: ZB\n/);
  assert.equal(out.systemMessage, "code-map → subagent: ZA (high)");
});

test("spawn points unrouted prompts at the map without a notice, then skips marked prompts", () => {
  const cwd = fixture();
  const out = run("spawn.mjs", { session_id: session(), tool_name: "Agent", tool_input: { prompt: WEATHER } }, { cwd });
  const { prompt } = out.hookSpecificOutput.updatedInput;
  assert.equal(prompt, `${WEATHER}\n\nZone context for this task (code-map): this repo's zone map is CODEMAP.md; source wins.`);
  assert.equal(out.systemMessage, undefined);
  assert.equal(run("spawn.mjs", { session_id: session(), tool_name: "Agent", tool_input: { prompt } }, { cwd }), null);
});

test("spawn is silent without a map or a prompt", () => {
  assert.equal(run("spawn.mjs", { tool_name: "Agent", tool_input: { prompt: BILLING } }, { cwd: fixture({ map: null }) }), null);
  assert.equal(run("spawn.mjs", { tool_name: "Agent", tool_input: {} }, { cwd: fixture() }), null);
});

const hookScripts = (event) => JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf-8")).hooks[event]
  .map((group) => [group.matcher, group.hooks.map((hook) => hook.command.match(/scripts\/([\w-]+\.mjs)/)[1])]);

test("hooks.json wires each script to its event and matcher", () => {
  assert.deepEqual(hookScripts("PreToolUse"), [["Agent", ["spawn.mjs"]]]);
  assert.deepEqual(hookScripts("PostToolUse"), [["Write|Edit", ["orphan-check.mjs"]], ["Read|Edit|Write", ["touch.mjs"]]]);
});

const touch = (cwd, session_id, tool_name, file, extra = {}) =>
  run("touch.mjs", { session_id, tool_name, tool_input: { file_path: join(cwd, file) }, ...extra }, { cwd });

test("touch gives a high-risk zone its full entry once per thread", () => {
  const cwd = fixture();
  const session_id = session();
  const out = touch(cwd, session_id, "Read", "a/x.ts");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith("code-map: a/x.ts is in ZA (high). Its entry:\nZA (high): "));
  assert.equal(out.systemMessage, "code-map → ZA (high) via a/x.ts");
  assert.equal(touch(cwd, session_id, "Read", "a/x.ts"), null);
  assert.ok(touch(cwd, session_id, "Read", "a/x.ts", { agent_id: "s1" }), "a subagent keeps its own seen set");
});

test("touch gives a low-risk zone one line and no notice", () => {
  const out = touch(fixture(), session(), "Read", "b/chart.ts");
  assert.equal(out.hookSpecificOutput.additionalContext,
    "code-map: b/chart.ts is in ZB (low), Dashboard widgets and charts. verify: npm test b; 2 invariants in CODEMAP.md.");
  assert.equal(out.systemMessage, undefined);
});

test("touch reports blast radius on the first entrypoint edit", () => {
  const cwd = fixture();
  const session_id = session();
  const out = touch(cwd, session_id, "Edit", "a/index.ts");
  assert.match(out.hookSpecificOutput.additionalContext, /Its entry:\nZA \(high\): /);
  assert.match(out.hookSpecificOutput.additionalContext, /\ncode-map: a\/index\.ts is a ZA entrypoint used by ZB\. verify: npm test b$/);
  assert.equal(out.systemMessage, "code-map → ZA (high) via a/index.ts · code-map → a/index.ts is a ZA entrypoint used by 1 zone");
  assert.equal(touch(cwd, session_id, "Edit", "a/index.ts"), null);
});

test("touch reports blast radius for a zone the thread already holds", () => {
  const cwd = fixture();
  const session_id = session();
  touch(cwd, session_id, "Read", "a/index.ts");
  const out = touch(cwd, session_id, "Write", "a/index.ts");
  assert.equal(out.hookSpecificOutput.additionalContext, "code-map: a/index.ts is a ZA entrypoint used by ZB. verify: npm test b");
  assert.equal(out.systemMessage, "code-map → a/index.ts is a ZA entrypoint used by 1 zone");
});

test("touch ignores unowned files, the map, outside paths, missing paths, and unmapped repos", () => {
  const cwd = fixture();
  const session_id = session();
  assert.equal(touch(cwd, session_id, "Read", "notes/todo.md"), null);
  assert.equal(touch(cwd, session_id, "Read", "CODEMAP.md"), null);
  assert.equal(run("touch.mjs", { session_id, tool_name: "Read", tool_input: { file_path: "/elsewhere/a/x.ts" } }, { cwd }), null);
  assert.equal(run("touch.mjs", { session_id, tool_name: "Read", tool_input: {} }, { cwd }), null);
  assert.equal(touch(fixture({ map: null }), session(), "Read", "a/x.ts"), null);
});
