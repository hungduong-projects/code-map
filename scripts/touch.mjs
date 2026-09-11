#!/usr/bin/env node
/* PostToolUse hook on Read|Edit|Write|Bash: the prompt router sees words, not
 * files. The first touch of a file in a zone this thread has not seen attaches
 * that zone: the full entry for high risk, one line otherwise. An edit to a
 * zone's entrypoint also names the zones that depend on it, once. Codex
 * patches and plain shell reads count as touches too. Silent for unowned
 * files (orphan-check covers edits there), the map itself, and repos without
 * a map. */

import {
  dependents, emit, formatBlast, formatEntry, formatLine, loadSeen, loadZones, owningZone, plural, readInput, saveSeen,
  touchedFiles,
} from "./zones-core.mjs";

const input = await readInput();
const root = input.cwd ?? process.cwd();
const files = await touchedFiles(input, root);
if (!files.length) process.exit(0);

const loaded = await loadZones(root).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const seen = await loadSeen(input.session_id, input.agent_id);
const context = [];
const notices = [];

for (const { path, edit } of files) {
  const zone = path !== loaded.relative && owningZone(loaded.zones, path);
  if (!zone) continue;

  if (!seen.zones[zone.id]) {
    if (zone.risk === "high") {
      context.push(`code-map: ${path} is in ${zone.id} (high). Its entry:`, formatEntry(zone, loaded.zones));
      notices.push(`code-map → ${zone.id} (high) via ${path}`);
      seen.zones[zone.id] = "full";
    } else {
      context.push(formatLine(path, zone, loaded.relative));
      seen.zones[zone.id] = "line";
    }
  }

  const blast = edit && zone.entrypoints.includes(path) && !seen.blast.includes(zone.id) &&
    formatBlast(path, zone, loaded.zones);
  if (blast) {
    context.push(blast);
    notices.push(`code-map → ${path} is a ${zone.id} entrypoint used by ${plural(dependents(loaded.zones, zone.id).length, "zone")}`);
    seen.blast.push(zone.id);
  }
}

if (!context.length) process.exit(0);
await saveSeen(input.session_id, input.agent_id, seen);
emit("PostToolUse", { context: context.join("\n"), notice: notices.join(" · ") });
