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

export async function loadZones(root) {
  const map = await findMap(root);
  if (!map) return null;
  const problems = [];
  const fail = (kind, message) => problems.push(`[${kind}] ${message}`);
  const zones = parseMap(await readFile(map.path, "utf-8"), fail);
  return { ...map, zones, problems };
}
