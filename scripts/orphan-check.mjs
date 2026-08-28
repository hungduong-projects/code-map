#!/usr/bin/env node
/* PostToolUse hook on Write|Edit: when an edit lands in a file no zone owns,
 * say so — that is either a stale map or a new surface, and both deserve a
 * sentence before the session moves on. Silent when the map is absent, the
 * file is owned, or the file is the map itself. */

import { relative } from "node:path";

import { loadZones, owningZone } from "./zones-core.mjs";

const input = JSON.parse(await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data || "{}"));
}));

const filePath = input.tool_input?.file_path;
const root = input.cwd ?? process.cwd();
if (!filePath) process.exit(0);

const loaded = await loadZones(root).catch(() => null);
if (!loaded || loaded.problems.length) process.exit(0);

const path = relative(root, filePath);
if (path.startsWith("..") || path === loaded.relative) process.exit(0);
if (/\.test\.[^/]+$/.test(path) || (!path.includes("/") && path.startsWith("."))) process.exit(0);
if (owningZone(loaded.zones, path)) process.exit(0);

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `\`${path}\` belongs to no zone in ${loaded.relative}. Either this edit opened a new surface — add it to the owning zone's paths (or a new zone) — or it is deliberately unmapped; say which before finishing.`,
  },
}));
