#!/usr/bin/env node
/* SessionStart hook: if the repo has a code-zones map, hand the agent a
 * compact index so routing costs one read instead of a grep sweep. Silent in
 * repos without a map. */

import { loadZones } from "./zones-core.mjs";

const loaded = await loadZones(process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length || !loaded.zones.length) process.exit(0);

const lines = loaded.zones
  .filter((zone) => zone.id && zone.purpose)
  .map((zone) => `- ${zone.id} (${zone.risk ?? "low"}): ${zone.purpose}`);

const context = [
  `This repo has a code-zones map at ${loaded.relative}. Before scoping any change,`,
  `match the files you expect to edit to one zone and read only that zone's entry —`,
  `its read_first files, entrypoints, and verify command. The map is a routing`,
  `hint; source wins. Zones:`,
  ...lines,
].join("\n");

console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
