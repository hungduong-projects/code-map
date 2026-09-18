#!/usr/bin/env node
/* SessionStart hook (startup, clear, compact): if the repo has a code-zones
 * map, hand the agent a compact index so routing costs one read instead of a
 * grep sweep, and tell the user the map is live. A broken map gets one line
 * instead of silence. A git repo without a map gets a one-time nudge toward
 * /code-map:init, shown to the user only. Resume and fork keep their history,
 * so they skip this hook. */

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emit, findMap, formatIndex, loadZones, plural, readInput, seenPath } from "./zones-core.mjs";

/* The nearest directory holding .git, or null outside a repo. */
async function gitRoot(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (await access(join(current, ".git")).then(() => true, () => false)) return current;
    if (dirname(current) === current) return null;
  }
}

/* True the first time a repo root is seen, once it is recorded in
 * nudged.json. A root that already has a map, or a failed write, means no
 * nudge, so the nudge can never repeat every session. */
async function firstNudge(dir) {
  const repo = await gitRoot(dir);
  if (!repo || (await findMap(repo))) return false;
  const file = join(process.env.CLAUDE_PLUGIN_DATA, "nudged.json");
  const nudged = await readFile(file, "utf-8").then(JSON.parse).catch(() => []);
  const roots = Array.isArray(nudged) ? nudged : [];
  if (roots.includes(repo)) return false;
  return mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify([...roots, repo])))
    .then(() => true, () => false);
}

const input = await readInput();
const root = input.cwd ?? process.cwd();

/* Startup, clear, and compact all drop earlier zone entries from context. */
await rm(seenPath(input.session_id), { force: true });

const loaded = await loadZones(root).catch(() => null);

if (loaded?.problems.length) {
  const checker = fileURLToPath(new URL("./zones-check.mjs", import.meta.url));
  const line = `code-map: ${loaded.relative} has ${plural(loaded.problems.length, "problem")}, so zone routing is off ` +
    `this session. First: ${loaded.problems[0]}. Details: node "${checker}"`;
  emit("SessionStart", { context: line, notice: line });
} else if (loaded?.zones.length) {
  emit("SessionStart", {
    context: formatIndex(loaded),
    notice: `code-map: ${plural(loaded.zones.length, "zone")} ready (${loaded.relative})`,
  });
} else if (!loaded && input.source === "startup" && process.env.CLAUDE_PLUGIN_DATA && (await firstNudge(root))) {
  /* Only Codex sets PLUGIN_ROOT; its users call a skill with $. */
  const skill = process.env.PLUGIN_ROOT ? "$code-map:init" : "/code-map:init";
  emit("SessionStart", { notice: `code-map: no zone map in this repo. Run ${skill} to draft one.` });
}
