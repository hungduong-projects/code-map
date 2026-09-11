#!/usr/bin/env node
/* PreToolUse hook on Agent (and Codex spawn_agent): a subagent starts without
 * the session's zone context, so append the entries its task routes to, or a
 * one-line pointer to the map, to the prompt it receives. Adds to the input
 * only: never approves or blocks the call. */

import { TASK_MARKER, emit, formatTaskBlock, loadZones, readInput, routeZones, saveFork } from "./zones-core.mjs";

const input = await readInput();
const task = input.tool_input;
/* A Codex spawn_agent message arrives encrypted, so there is no task to
 * route. Record how much of this thread the child inherits instead;
 * subagent-start hands it zones when it inherits none. */
if (typeof task?.prompt !== "string" && String(input.tool_name).endsWith("spawn_agent")) {
  await saveFork(input.session_id, task?.fork_turns);
  process.exit(0);
}
if (typeof task?.prompt !== "string" || task.prompt.includes(TASK_MARKER)) process.exit(0);

const loaded = await loadZones(input.cwd ?? process.cwd()).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const routed = routeZones(loaded.zones, task.prompt);
emit("PreToolUse", {
  notice: routed.length ? `code-map → subagent: ${routed.map((zone) => `${zone.id} (${zone.risk})`).join(", ")}` : "",
  extra: { updatedInput: { ...task, prompt: `${task.prompt}\n\n${formatTaskBlock(loaded, routed)}` } },
});
