#!/usr/bin/env node
/* SessionStart hook: if the repo has a code-zones map, hand the agent a
 * compact index so routing costs one read instead of a grep sweep. Silent in
 * repos without a map. */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadZones } from "./zones-core.mjs";

const input = JSON.parse(await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data || "{}"));
}));

const loaded = await loadZones(process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length || !loaded.zones.length) process.exit(0);

/* Startup, clear, and compact all drop earlier route entries from context. */
await rm(join(tmpdir(), `code-map-${input.session_id}.json`), { force: true });

const lines = loaded.zones
  .filter((zone) => zone.id && zone.purpose)
  .map((zone) => `- ${zone.id} (${zone.risk ?? "low"}): ${zone.purpose}`);

const context = [
  `This repo has a code-zones map at ${loaded.relative}. A prompt that moves into a`,
  `high-risk zone or spans zones arrives with those zones' entries attached — start`,
  `from their read_first files, entrypoints, and verify command. When no entry`,
  `arrives, match the edit to a zone below and read only that zone's section if`,
  `you need it. The map is a routing hint; source wins. Zones:`,
  ...lines,
].join("\n");

console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
