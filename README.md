# code-map

A checked-in zone map coding agents read before they touch a repo. One markdown
file partitions the tree into 8-15 owned zones — purpose, path globs,
entrypoints, `read_first` files, allowed dependencies, verify command, risk
tier. An agent matches its edit to one zone and loads ~1.5k tokens of routing
instead of re-deriving the repo by grep (measured on a 533-file repo: 53 tool
calls and 182k tokens per session without a map).

The map routes, source decides, and the validator keeps the map honest.

## Install

```
/plugin marketplace add hungduong-projects/code-map
/plugin install code-map@code-map
```

Requires Node 18+ on PATH (the hooks and validator are dependency-free node
scripts). MIT licensed.

## Use

- `/code-map:init` — scan the current repo and draft its map
  (`docs/reference/code-zones.md`, or `CODEMAP.md` at the root).
- **SessionStart hook** — injects the zone index whenever a mapped repo opens.
  Repos without a map: silent no-op.
- **PostToolUse hook** — an edit landing in a file no zone owns gets flagged:
  update the map or say the file is deliberately unmapped.
- `node scripts/zones-check.mjs` — CI-grade validation: unique path ownership,
  live globs, existing entrypoints and `read_first` files, declared deps.
  Vendor it into a repo's CI to make map rot a build failure.

## Map shape

One `## Zx — name` section per zone, one yaml block each:

```yaml
id: Z1
risk: high
read_first: [".claude/rules/routing.md"]
purpose: "Locale routing and session refresh."
paths: ["proxy.ts", "i18n/**"]
entrypoints: ["i18n/routing.ts"]
invariants:
  - "Only what no auto-loading rule file already says."
deps: ["Z2"]
verify: "npx vitest run i18n"
```

Rules that keep it useful: every tracked path belongs to exactly one zone, no
file inventories, invariants only where no rule file already covers them, the
whole body under ~2,500 tokens. Deliberately unmapped files stay on the
validator's orphan warning — that list is the honest census of unwired code.
