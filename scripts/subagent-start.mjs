#!/usr/bin/env node
/* SubagentStart hook, for Codex: a spawn_agent message arrives encrypted, so
 * spawn.mjs cannot route the child's task. A child that inherits none of the
 * parent thread gets the last 3 zones the parent loaded in full, or a pointer
 * to the map, and starts with those zones marked seen so its own touches do
 * not repeat them. Silent for a child that inherits the thread, and in Claude
 * Code, where spawn.mjs already put the zones in the prompt and no fork file
 * exists. */

import { emit, formatTaskBlock, loadFork, loadSeen, loadZones, readInput, saveSeen } from "./zones-core.mjs";

const input = await readInput();
const fork = await loadFork(input.session_id);
if (!fork || fork === "all") process.exit(0);

const loaded = await loadZones(input.cwd ?? process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const parent = await loadSeen(input.session_id);
const picked = Object.keys(parent.zones)
  .filter((id) => parent.zones[id] === "full")
  .map((id) => loaded.zones.find((zone) => zone.id === id))
  .filter(Boolean)
  .slice(-3);

if (picked.length) {
  const child = await loadSeen(input.session_id, input.agent_id);
  for (const zone of picked) child.zones[zone.id] = "full";
  await saveSeen(input.session_id, input.agent_id, child);
}

emit("SubagentStart", {
  context: formatTaskBlock(loaded, picked),
  notice: picked.length ? `code-map → subagent: ${picked.map((zone) => `${zone.id} (${zone.risk})`).join(", ")}` : "",
});
