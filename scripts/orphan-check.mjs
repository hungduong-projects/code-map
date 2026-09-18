#!/usr/bin/env node
/* PostToolUse hook on Write|Edit (Codex apply_patch matches too): when an
 * edit lands in a file no zone owns, say so — that is either a stale map or a
 * new surface, and both deserve a sentence before the session moves on.
 * Silent when the map is absent, the file is owned, or the file is the map
 * itself. */

import { loadZones, owningZone, readInput, touchedFiles } from "./zones-core.mjs";

const input = await readInput();

const root = input.cwd ?? process.cwd();
const edited = (await touchedFiles(input, root)).filter((file) => file.edit).map((file) => file.path);
if (!edited.length) process.exit(0);

const loaded = await loadZones(root).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const orphans = edited.filter((path) => path !== loaded.relative &&
  !/\.test\.[^/]+$/.test(path) && !(!path.includes("/") && path.startsWith(".")) &&
  !owningZone(loaded.zones, path));
if (!orphans.length) process.exit(0);

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: orphans.map((path) =>
      `\`${path}\` belongs to no zone in ${loaded.relative}. Either this edit opened a new surface — add it to the owning zone's paths (or a new zone) — or it is deliberately unmapped; say which before finishing.`).join("\n"),
  },
}));
