#!/usr/bin/env node
/* Validate a repo's code-zones map. Run from the repo root, or pass the map
 * path as the first argument. Dependency-free so CI can run it before any
 * install step. Exit 1 on structural rot; unowned files are a warning. */

import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { findMap, formatIndex, globRegex, namedIdentifiers, parseMap } from "./zones-core.mjs";

const ROOT = process.cwd();
const problems = [];
const fail = (kind, message) => problems.push(`[${kind}] ${message}`);

const exists = (path) => access(join(ROOT, path)).then(() => true, () => false);
const gitFiles = async () => {
  const { stdout } = await promisify(execFile)("git", ["ls-files"], { cwd: ROOT });
  return stdout.split("\n").filter(Boolean);
};

function isExcludedOrphan(path) {
  return /\.test\.[^/]+$/.test(path) || /\.d\.ts$/.test(path) ||
    /(^|\/)(LICENSE|README)[^/]*$/.test(path) || (!path.includes("/") && path.startsWith("."));
}

async function validate(zones, files) {
  const ids = new Map();
  for (const zone of zones) {
    if (zone.id && ids.has(zone.id)) fail("duplicate zone id", `\`${zone.id}\` is also ${ids.get(zone.id).source}`);
    else if (zone.id) ids.set(zone.id, zone);
  }

  const owners = new Map();
  for (const zone of zones) {
    for (const glob of Array.isArray(zone.paths) ? zone.paths : []) {
      const matched = files.filter((path) => globRegex(glob).test(path));
      if (!matched.length) fail("unmatched path glob", `\`${zone.id}\`: \`${glob}\``);
      for (const path of matched) {
        const prior = owners.get(path);
        if (prior && prior !== zone.id) fail("overlapping ownership", `\`${path}\` matches \`${prior}\` and \`${zone.id}\``);
        else owners.set(path, zone.id);
      }
    }
    const entrypoints = Array.isArray(zone.entrypoints) ? zone.entrypoints : [];
    const readFirst = Array.isArray(zone.read_first) ? zone.read_first : [];
    for (const path of [...entrypoints, ...readFirst]) {
      if (!(await exists(path))) fail("missing named path", `\`${zone.id}\`: \`${path}\``);
    }
    for (const dep of Array.isArray(zone.deps) ? zone.deps : []) {
      if (!ids.has(dep)) fail("unknown dependency", `\`${zone.id}\` depends on undeclared zone \`${dep}\``);
    }
  }
  return files.filter((path) => !owners.has(path) && !isExcludedOrphan(path));
}

/* Names a zone's prose asserts that neither its own files nor its deps' files
 * contain: the likely stale facts. The map holds every name, so it is never
 * searched. Runs on a valid map, so paths and deps are sound. */
async function ungrounded(zones, files, mapFile) {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const owned = (zone) => files.filter((path) => path !== mapFile && zone.paths.some((glob) => globRegex(glob).test(path)));
  const report = [];
  for (const zone of zones) {
    const names = namedIdentifiers(zone);
    if (!names.length) continue;
    const scope = [zone, ...zone.deps.map((id) => byId.get(id))].flatMap(owned);
    const text = (await Promise.all(scope.map((path) => readFile(join(ROOT, path), "utf-8").catch(() => "")))).join("\n");
    const missing = names.filter((name) => !text.includes(name));
    if (missing.length) report.push({ id: zone.id, missing });
  }
  return report;
}

const mapPath = process.argv[2] ?? (await findMap(ROOT))?.path;
if (!mapPath) {
  console.log("code zones: no map found — run /code-map:init to create one");
  process.exit(0);
}

let text;
try {
  text = await readFile(mapPath, "utf-8");
} catch {
  fail("map", `cannot read \`${mapPath}\``);
}
const zones = text ? parseMap(text, fail) : [];
const files = await gitFiles();
const orphans = await validate(zones, files);

if (problems.length) {
  console.error(`\ncode zones: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`code zones: ${zones.length} zones, no problems`);
/* chars / 4 is a rough token count, close enough to catch a map that has
 * outgrown what every session pays for it. */
const indexTokens = Math.ceil(formatIndex({ relative: relative(ROOT, mapPath), zones }).length / 4);
const mapTokens = Math.ceil(text.length / 4);
console.log(`code zones: session-start index ≈ ${indexTokens} tokens, map ≈ ${mapTokens} tokens`);
if (mapTokens > 2500) console.warn(`code zones: warning, map ≈ ${mapTokens} tokens is over the 2,500-token budget`);
if (orphans.length) {
  console.warn(`code zones: warning — ${orphans.length} tracked file${orphans.length === 1 ? "" : "s"} have no zone`);
  for (const path of orphans.slice(0, 20)) console.warn(`  ${path}`);
  if (orphans.length > 20) console.warn(`  ... and ${orphans.length - 20} more`);
}
const stale = await ungrounded(zones, files, relative(ROOT, mapPath));
if (stale.length) {
  const count = stale.reduce((total, { missing }) => total + missing.length, 0);
  console.warn(`code zones: warning — ${count} named identifier${count === 1 ? "" : "s"} not found in their zone's files`);
  for (const { id, missing } of stale) console.warn(`  ${id}: ${missing.join(", ")}`);
}
