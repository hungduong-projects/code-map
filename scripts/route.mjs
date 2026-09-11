#!/usr/bin/env node
/* UserPromptSubmit hook: when a prompt moves into a zone this session has not
 * seen yet, inject that zone's entry so the agent scopes from read_first and
 * entrypoints instead of the whole map. Only scope shifts earn an entry: a
 * high-risk zone, or a prompt spanning zones. Same-zone follow-ups and single
 * low-risk edits stay silent, as do repos without a map. */

import { emit, formatEntry, loadSeen, loadZones, readInput, routeZones, saveSeen } from "./zones-core.mjs";

const input = await readInput();
/* A background agent's result re-enters as a <task-notification> prompt: the
 * agent's own report, not a new task, so it earns no entries. */
if (typeof input.prompt !== "string" || !input.prompt || input.prompt.trimStart().startsWith("<task-notification>")) {
  process.exit(0);
}
const loaded = await loadZones(input.cwd ?? process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const routed = routeZones(loaded.zones, input.prompt);
const seen = await loadSeen(input.session_id, input.agent_id);
const fresh = routed.filter((zone) => seen.zones[zone.id] !== "full");
if (!fresh.length || (routed.length < 2 && fresh[0].risk !== "high")) process.exit(0);
for (const zone of fresh) seen.zones[zone.id] = "full";
await saveSeen(input.session_id, input.agent_id, seen);

emit("UserPromptSubmit", {
  context: [
    `code-map: this prompt enters ${routed.map((zone) => zone.id).join(" + ")}. The entries below are the map's`,
    `full record for the zones not already in context, so skip ${loaded.relative} unless`,
    `the route looks wrong. Open only the files the task needs; source wins.`,
    ...fresh.map((zone) => formatEntry(zone, loaded.zones)),
  ].join("\n"),
  notice: `code-map → ${routed.map((zone) => `${zone.id} (${zone.risk})`).join(", ")}`,
});
