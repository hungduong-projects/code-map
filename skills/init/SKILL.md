---
name: init
description: Draft this repo's code-zones map — scan the tree, partition it into 8-15 owned zones, validate, and wire the pointers. Use when the user asks to initialize, create, or rebuild a code map, zone map, or codebase map for a repo.
---

# /code-map:init — draft the zone map

Create the checked-in routing map agents read before scoping any change. One
file, 8-15 zones, every tracked path owned by exactly one zone.

## Ground rules

- The map is a **routing hint**: it answers "where does this change live and
  what must I read first", never "what is in every file". Source always wins.
- **No file inventories.** A zone owns globs; it names at most 5 entrypoints.
- **Invariants earn their place** only if they change what an agent does before
  its first edit AND no auto-loading rule file (`.claude/rules/`, AGENTS.md)
  already carries them. Reference the rule file in `read_first` instead of
  repeating it.
- Target ≤2,500 tokens for the whole body. One screen per zone.

## Procedure

1. **Census.** `git ls-files`, group by top-level directory. Identify vendored
   or generated directories to leave unmapped. In a large repo, dispatch an
   Explore subagent to verify what each directory actually is — do not guess
   from names.
2. **Partition** into 8-15 zones along runtime boundaries and package seams
   (routing, auth, API surface, core pipeline, data access, shared models, UI,
   native/other-language packages, schema/platform, repo tooling). Merge
   nothing across a package or verification boundary.
3. **Write the map** to `docs/reference/code-zones.md` if the repo has a
   `docs/` convention, else `CODEMAP.md` at the root. One `## Zx — name`
   section per zone, each holding one yaml block with exactly these keys:

   ```yaml
   id: Z1
   risk: high            # high = read read_first before the first edit
   read_first: [".claude/rules/routing.md"]
   purpose: "One sentence."
   paths: ["proxy.ts", "i18n/**"]        # globs; [ ] are literal; unique ownership
   entrypoints: ["i18n/routing.ts"]      # 2-5 files other zones may import
   invariants:
     - "Only what no rule file already says."
   deps: ["Z2"]          # zones this one may import from
   verify: "npx vitest run i18n"
   ```

   Open the file with a short header: routing hint, source wins, how to use it
   in three bullets (match edit to zone, read `read_first` on high risk, follow
   `deps` instead of expanding scope).
4. **Validate.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/zones-check.mjs"`
   from the repo root. Fix every problem — overlapping ownership means a glob
   is too broad, not that the check is wrong. Read the orphan warning list:
   deliberately unmapped files (unwired modules, scratch) stay orphans and get
   one warning line in the map header; everything else joins a zone.
5. **Wire the pointers.** If AGENTS.md exists, add one line telling agents to
   read the map before scoping (this is the bridge to harnesses without
   hooks). If the repo validates docs frontmatter or keeps an llms.txt, comply
   with those conventions. Offer to add `zones-check` to CI mirroring how the
   repo runs its cheapest checks.
6. **Commit** following the repo's convention, then report: zone count, orphan
   count, and the one-line usage rule.

## Rebuilding

Re-running on a repo with an existing map means reconciling, not overwriting:
keep zone ids stable, fold in new directories, and let the validator's orphan
list drive what changed.
