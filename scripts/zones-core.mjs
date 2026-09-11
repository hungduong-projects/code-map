/* Shared parsing for the code-zones map. Dependency-free so hooks and CI can
 * run it before any install step. */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

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
