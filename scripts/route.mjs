#!/usr/bin/env node
/* UserPromptSubmit hook: when a prompt moves into a zone this session has not
 * seen yet, inject that zone's entry so the agent scopes from read_first and
 * entrypoints instead of the whole map. Only scope shifts earn an entry: a
 * high-risk zone, or a prompt spanning zones. Same-zone follow-ups and single
 * low-risk edits stay silent, as do repos without a map. */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadZones, routeZones } from "./zones-core.mjs";

const input = JSON.parse(await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data || "{}"));
}));

const loaded = await loadZones(input.cwd ?? process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length || !input.prompt) process.exit(0);

const routed = routeZones(loaded.zones, input.prompt);
const seenPath = join(tmpdir(), `code-map-${input.session_id}.json`);
const seen = new Set(JSON.parse(await readFile(seenPath, "utf-8").catch(() => "[]")));
const fresh = routed.filter((zone) => !seen.has(zone.id));
if (!fresh.length || (routed.length < 2 && fresh[0].risk !== "high")) process.exit(0);
await writeFile(seenPath, JSON.stringify([...seen, ...fresh.map((zone) => zone.id)]));

const list = (values) => (values.length ? values.join(", ") : "none");
const entries = fresh.map((zone) => [
  `${zone.id} (${zone.risk}): ${zone.purpose}`,
  `  read_first: ${list(zone.read_first)}`,
  `  entrypoints: ${list(zone.entrypoints)}`,
  `  paths: ${list(zone.paths)}`,
  ...zone.invariants.map((invariant) => `  invariant: ${invariant}`),
  `  deps: ${list(zone.deps)}`,
  `  verify: ${zone.verify}`,
].join("\n"));

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: [
      `code-map: this prompt enters ${routed.map((zone) => zone.id).join(" + ")}. The entries below are the map's`,
      `full record for the zones not already in context, so skip ${loaded.relative} unless`,
      `the route looks wrong. Open only the files the task needs; source wins.`,
      ...entries,
    ].join("\n"),
  },
}));
