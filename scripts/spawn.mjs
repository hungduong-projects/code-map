#!/usr/bin/env node
/* PreToolUse hook on Agent: a subagent starts without the session's zone
 * context, so append the entries its task routes to, or a one-line pointer to
 * the map, to the prompt it receives. The block reads as part of the task,
 * because subagents treat a detached "fact" as outside their brief. Adds to
 * the input only: never approves or blocks the call. */

import { emit, formatEntry, loadZones, readInput, routeZones } from "./zones-core.mjs";

const MARKER = "Zone context for this task (code-map";

const input = await readInput();
const task = input.tool_input;
if (typeof task?.prompt !== "string" || task.prompt.includes(MARKER)) process.exit(0);

const loaded = await loadZones(input.cwd ?? process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const routed = routeZones(loaded.zones, task.prompt);
const block = routed.length
  ? [`${MARKER}, ${loaded.relative}; source wins):`, ...routed.map((zone) => formatEntry(zone, loaded.zones))].join("\n")
  : `${MARKER}): this repo's zone map is ${loaded.relative}; source wins.`;

emit("PreToolUse", {
  notice: routed.length ? `code-map → subagent: ${routed.map((zone) => `${zone.id} (${zone.risk})`).join(", ")}` : "",
  extra: { updatedInput: { ...task, prompt: `${task.prompt}\n\n${block}` } },
});
