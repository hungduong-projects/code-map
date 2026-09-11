# code-map

Coding agents spend turns re-discovering your repo and still miss what they
must not break. code-map keeps one checked-in map of the repo's zones, and its
hooks hand each agent the right zone before it edits: the files to read first,
the invariants, and the command that verifies the change.

On a 698-file repo, Sonnet scoped 5 tasks with 40% fewer tokens and 7 fewer tool calls
than without code-map (4 runs per task).

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
- **Session start** — a mapped repo opens with the zone index in context,
  about 400 tokens for a 15-zone map. A map with problems gets one line naming
  the first. A git repo without a map shows a one-time hint to run
  `/code-map:init`.
- **Prompts** — when a prompt moves into a high-risk zone or spans zones the
  session has not seen, those zones' entries go in, including which zones
  depend on them. Same-zone follow-ups and single low-risk edits stay silent.
- **Subagents** — an `Agent` call gets its task's zone entries appended to the
  subagent's prompt, or a one-line pointer to the map. Subagents start without
  your session's context.
- **File touches** — the first Read, Edit or Write in a zone the agent has not
  seen adds that zone: the full entry for high risk, one line otherwise.
  Editing a zone's entrypoint names the zones that depend on it and their
  verify commands.
- **Unowned edits** — an edit landing in a file no zone owns gets flagged:
  update the map or say the file is deliberately unmapped.
- **Notices** — you see a short `code-map → …` line when zone context goes in.
  It costs the model no tokens.
- `node scripts/zones-check.mjs` — CI-grade validation: unique path ownership,
  live globs, existing entrypoints and `read_first` files, declared deps. It
  also prints the index and map token cost, and warns past 2,500 tokens, or
  when a code name in a zone's purpose or invariants (`PROTOCOL_VERSION`,
  `fetchLedger`) appears in none of that zone's or its deps' files.
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

## Develop

`node --test test/hooks.test.mjs` runs the hook tests. No install step.
