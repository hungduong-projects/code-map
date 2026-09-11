/* Shared parsing for the code-zones map. Dependency-free so hooks and CI can
 * run it before any install step. */

import { access, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/* Where a repo may keep its map, first hit wins. */
export const MAP_LOCATIONS = [
  "docs/reference/code-zones.md",
  "docs/code-zones.md",
  "CODEMAP.md",
];

export const REQUIRED = [
  "id",
  "risk",
  "read_first",
  "purpose",
  "paths",
  "entrypoints",
  "invariants",
  "deps",
  "verify",
];
export const LISTS = new Set(["read_first", "paths", "entrypoints", "invariants", "deps"]);

const unquote = (value) => value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");

export async function findMap(root) {
  for (const candidate of MAP_LOCATIONS) {
    const path = join(root, candidate);
    const found = await access(path).then(() => true, () => false);
    if (found) return { path, relative: candidate };
  }
  return null;
}

/* The map's yaml blocks use only scalars, flow lists, and indented string
 * lists. Parsing that small vocabulary here keeps malformed content a clear
 * failure without a YAML dependency. */
export function parseZone(block, number, fail) {
  const zone = { source: `zone ${number}` };
  let list = null;

  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      zone[list].push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) {
      fail("parse", `${zone.source}: cannot parse \`${line}\``);
      continue;
    }
    const [, key, value] = pair;
    if (!REQUIRED.includes(key)) fail("parse", `${zone.source}: unknown key \`${key}\``);
    if (value === "") {
      if (!LISTS.has(key)) fail("parse", `${zone.source}: \`${key}\` must be a scalar`);
      zone[key] = [];
      list = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      zone[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
      list = null;
    } else {
      zone[key] = unquote(value);
      list = null;
    }
  }

  for (const key of REQUIRED) {
    if (!(key in zone)) fail("parse", `${zone.source}: missing \`${key}\``);
    else if (LISTS.has(key) !== Array.isArray(zone[key])) {
      fail("parse", `${zone.source}: \`${key}\` must be ${LISTS.has(key) ? "a list" : "a scalar"}`);
    }
  }
  return zone;
}

export function parseMap(text, fail) {
  const blocks = [...text.matchAll(/^```yaml\s*\n([\s\S]*?)^```\s*$/gm)].map((match) => match[1]);
  if (!blocks.length) fail("parse", "no ```yaml zone blocks found");
  return blocks.map((block, index) => parseZone(block, index + 1, fail));
}

/* `[` and `]` are literal — Next.js route directories like app/[locale] make
 * character classes a footgun. `**` crosses directories, `*` stays within a
 * segment. */
export function globRegex(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else {
      pattern += /[\\^$+?.()|{}\[\]]/.test(glob[index]) ? `\\${glob[index]}` : glob[index];
    }
  }
  return new RegExp(`${pattern}$`);
}

export function owningZone(zones, path) {
  for (const zone of zones) {
    for (const glob of Array.isArray(zone.paths) ? zone.paths : []) {
      if (globRegex(glob).test(path)) return zone;
    }
  }
  return null;
}

const STOP = new Set(("the and for with that this from into what where which when how does should would could " +
  "about have make need want change fix add update file files code test tests use using not all any " +
  "read write edit only first scope under over new just also must keep still same other some more please " +
  "tsx jsx mjs json yaml").split(" "));
const words = (text) => (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((word) => !STOP.has(word));
/* A zone's own purpose and paths speak for it; words that only appear in its
 * read_first names or invariants count half, so one incidental word there
 * cannot pull a zone into the route. */
const FIELDS = [["purpose", 1], ["paths", 1], ["entrypoints", 1], ["read_first", 0.5], ["invariants", 0.5]];
const matchWeight = (vocab, word) => {
  let weight = 0;
  for (const [known, value] of vocab) {
    const match = known === word ||
      (Math.min(word.length, known.length) >= 3 && Math.abs(word.length - known.length) <= 3 &&
        (known.startsWith(word) || word.startsWith(known)));
    if (match) weight = Math.max(weight, value);
  }
  return weight;
};

/* Lexical routing: score each zone by the prompt words its text shares,
 * weighted by how few zones share them, plus a strong bonus when the prompt
 * names a path the zone owns. Sorted best first. */
export function scoreZones(zones, prompt) {
  const vocabs = zones.map((zone) => {
    const vocab = new Map();
    for (const [field, weight] of FIELDS) {
      for (const word of words([zone[field]].flat().join(" "))) vocab.set(word, Math.max(vocab.get(word) ?? 0, weight));
    }
    return vocab;
  });
  const asked = new Set(words(prompt));
  const named = prompt.match(/[\w.[\]-]*\/[\w./[\]-]+|[\w-]+\.[a-z]{1,4}\b/g) ?? [];

  return zones.map((zone, index) => {
    let score = 0;
    for (const word of asked) {
      const shared = vocabs.filter((vocab) => matchWeight(vocab, word)).length;
      if (shared) score += matchWeight(vocabs[index], word) * Math.log(1 + zones.length / shared);
    }
    if (named.some((path) => owningZone([zone], path))) score += 10;
    return { zone, score };
  }).sort((a, b) => b.score - a.score);
}

/* The zones a prompt touches: the best match plus any within half its score,
 * or nothing when no zone clears more than one distinctive word. */
export function routeZones(zones, prompt, limit = 3) {
  const scored = scoreZones(zones, prompt);
  const best = scored[0]?.score ?? 0;
  if (best < 3) return [];
  return scored.filter(({ score }) => score >= best / 2).slice(0, limit).map(({ zone }) => zone);
}

export async function loadZones(root) {
  const map = await findMap(root);
  if (!map) return null;
  const problems = [];
  const fail = (kind, message) => problems.push(`[${kind}] ${message}`);
  const zones = parseMap(await readFile(map.path, "utf-8"), fail);
  return { ...map, zones, problems };
}

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (values) => (values.length ? values.join(", ") : "none");

/* Zones that list `id` in their deps, in map order: the ones an edit to its
 * public surface can break. */
export function dependents(zones, id) {
  return zones.filter((zone) => Array.isArray(zone.deps) && zone.deps.includes(id));
}

/* A zone's full record as hooks inject it. `used by` comes from the other
 * zones' deps, so the map schema stays the same. */
export function formatEntry(zone, zones) {
  const users = dependents(zones, zone.id).map((user) => user.id);
  return [
    `${zone.id} (${zone.risk}): ${zone.purpose}`,
    `  read_first: ${list(zone.read_first)}`,
    `  entrypoints: ${list(zone.entrypoints)}`,
    `  paths: ${list(zone.paths)}`,
    ...zone.invariants.map((invariant) => `  invariant: ${invariant}`),
    `  deps: ${list(zone.deps)}`,
    ...(users.length ? [`  used by: ${users.join(", ")}`] : []),
    `  verify: ${zone.verify}`,
  ].join("\n");
}

/* One line for a touch in a low-risk zone: enough to place the file and find
 * the rest in the map. */
export function formatLine(path, zone, relative) {
  const invariants = zone.invariants.length ? plural(zone.invariants.length, "invariant") : "no invariants";
  return `code-map: ${path} is in ${zone.id} (${zone.risk}), ${zone.purpose.replace(/\.$/, "")}. ` +
    `verify: ${zone.verify}; ${invariants} in ${relative}.`;
}

/* Who depends on an edited entrypoint and how to check them, or null when no
 * zone does. */
export function formatBlast(path, zone, zones) {
  const users = dependents(zones, zone.id);
  if (!users.length) return null;
  const verify = [...new Set(users.map((user) => user.verify))].join("; ");
  return `code-map: ${path} is a ${zone.id} entrypoint used by ${users.map((user) => user.id).join(", ")}. verify: ${verify}`;
}

/* The code-shaped names a zone's prose asserts: SCREAMING_SNAKE, camelCase,
 * and snake_case words in purpose and invariants, once each. Plain words and
 * commands like `npm run core:build` don't match, and map keys like read_first
 * are schema, not code. zones-check looks for each name in the zone's files. */
const NAME = /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g;
export function namedIdentifiers(zone) {
  const names = [zone.purpose, ...zone.invariants].join("\n").match(NAME) ?? [];
  return [...new Set(names)].filter((name) => !REQUIRED.includes(name));
}

/* The session-start index. zones-check measures this same text for its
 * budget line. */
export function formatIndex({ relative, zones }) {
  return [
    `This repo has a code-zones map at ${relative}. A prompt that moves into a`,
    `high-risk zone or spans zones arrives with those zones' entries attached — start`,
    `from their read_first files, entrypoints, and verify command. When no entry`,
    `arrives, match the edit to a zone below and read only that zone's section if`,
    `you need it. The map is a routing hint; source wins. Zones:`,
    ...zones
      .filter((zone) => zone.id && zone.purpose)
      .map((zone) => `- ${zone.id} (${zone.risk ?? "low"}): ${zone.purpose}`),
  ].join("\n");
}

/* The files one tool call touched, relative to root and inside it, as
 * { path, edit }. Claude names one file_path; a Codex apply_patch names the
 * files it adds, updates or moves to (a deleted file has nothing to route);
 * a shell command counts when a segment is a plain cat, head, tail, sed or nl
 * of existing files. Substitutions, redirects and a cd make shell paths
 * uncertain, so those read as nothing. */
const READERS = new Set(["cat", "head", "tail", "sed", "nl"]);

export async function touchedFiles({ tool_name: tool, tool_input: args = {} }, root) {
  const files = [];
  if (["Read", "Edit", "Write"].includes(tool) && typeof args.file_path === "string") {
    files.push({ path: args.file_path, edit: tool !== "Read" });
  } else if (tool === "apply_patch" && typeof args.command === "string") {
    for (const [, path] of args.command.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) {
      files.push({ path: path.trim(), edit: true });
    }
  } else if (tool === "Bash" && typeof args.command === "string" && !/\$\(|`|>|<</.test(args.command)) {
    for (const segment of args.command.split(/&&|\|\||[|;\n]/)) {
      const [first, ...rest] = (segment.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) ?? [])
        .map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
      if (first === "cd") break;
      if (!READERS.has(first)) continue;
      for (const word of rest.filter((word) => !word.startsWith("-"))) {
        if (await stat(resolve(root, word)).then((info) => info.isFile(), () => false)) files.push({ path: word, edit: false });
      }
    }
  }
  const unique = new Map();
  for (const { path, edit } of files) {
    const inside = relative(root, resolve(root, path));
    if (inside && !inside.startsWith("..") && !unique.has(inside)) unique.set(inside, { path: inside, edit });
  }
  return [...unique.values()];
}

/* Hook input arrives as one JSON object on stdin. Anything else is no event
 * to act on, so the hook ends quietly. */
export async function readInput() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    const input = JSON.parse(data);
    if (input && typeof input === "object") return input;
  } catch {}
  process.exit(0);
}

/* One JSON line for Claude Code: context for the model, a notice the user
 * sees at no token cost, and event fields such as updatedInput. Callers emit
 * last and let the process end, so piped stdout flushes. */
export function emit(event, { context = "", notice = "", extra = {} } = {}) {
  const specific = { ...(context ? { additionalContext: context } : {}), ...extra };
  console.log(JSON.stringify({
    ...(Object.keys(specific).length ? { hookSpecificOutput: { hookEventName: event, ...specific } } : {}),
    ...(notice ? { systemMessage: notice } : {}),
  }));
}

/* What a thread already holds: zones map to "full" once their entry went in
 * and "line" after a one-line touch; blast lists zones whose entrypoint edit
 * was already reported. A subagent keeps its own file, since it starts
 * without the main thread's context. Any other shape, including the 1.1.0
 * array, reads as empty. */
const safe = (value) => String(value ?? "").replace(/[^\w-]/g, "");
export const seenPath = (session, agent) =>
  join(tmpdir(), `code-map-${safe(session)}${agent ? `-${safe(agent)}` : ""}.json`);

export async function loadSeen(session, agent) {
  const seen = await readFile(seenPath(session, agent), "utf-8").then(JSON.parse).catch(() => null);
  const valid = seen?.zones && typeof seen.zones === "object" && !Array.isArray(seen.zones) && Array.isArray(seen.blast);
  return valid ? seen : { zones: {}, blast: [] };
}

export async function saveSeen(session, agent, seen) {
  await writeFile(seenPath(session, agent), JSON.stringify(seen)).catch(() => {});
}

/* How much of the parent thread the next Codex subagent inherits: its spawn
 * call's fork_turns, "all" when unset. Only a Codex spawn writes this, so a
 * Claude session never has one. */
const forkPath = (session) => seenPath(session, "fork");

export async function saveFork(session, fork) {
  await writeFile(forkPath(session), JSON.stringify(String(fork ?? "all"))).catch(() => {});
}

export async function loadFork(session) {
  return readFile(forkPath(session), "utf-8").then(JSON.parse).catch(() => null);
}
