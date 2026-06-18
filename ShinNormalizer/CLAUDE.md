# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Code

Place a newline-separated list of user IDs in `input.txt`, then:

```bash
node main_shin.js
```

Output is printed to console and written to `output.txt` as a tab-separated file with columns: `Partition Name`, `Estimated Accounts`, `Estimated Rows`, `Query`.

No build system, package manager, or test framework. Node.js only.

## Architecture

Two files:

- **`main_shin.js`** — entry point. Reads `input.txt`, configures options, calls `normalizePartitions()`, and writes results.
- **`ShinNormalizer_V10_DualBalance.js`** — exports `normalizePartitions()`, the full algorithm.

## Core Function: `normalizePartitions(userIds, numPartitions, majorCategories, options)`

**Options:**
| Option | Default | Description |
|---|---|---|
| `includeNotAll` | `true` | Emit a `PARTITION_CATCH_ALL` for unmatched IDs |
| `maxDepth` | `10` | Max prefix drilling depth |
| `allowMixing` | `false` | Allow different major categories to share a partition |
| `granularity` | `0.05` | Controls drill-down threshold: `max(ceil(targetCap × granularity), 10)` |
| `balanceTarget` | `'row'` | `'row'` balances by total row count; `'user'` balances by unique user count, ignoring heavy users |

**8-phase algorithm:**
1. **Preprocessing** — deduplicate into `userStats` Map (id → row count); track `emptyOrNullRowCount`
2. **Initial grouping** — classify each unique ID into first matching `majorCategory` prefix, else `CatchAll`
3. **Drill-down** (`drillAndSort`) — BFS queue subdivides any prefix whose weight exceeds `splitThreshold`; IDs whose length equals the current prefix get an `EXACT_` marker and are not further split; stops at `maxDepth`
4. **Sequential packing** (`packSequentially`) — assigns sorted chunks to partitions using a dynamic rolling target (`remainingWeight / remainingParts`); fills empty partitions at the end if needed
5. **Mode-based allocation** — `allowMixing=false`: each `majorCategory` gets its own set of partitions sized proportionally to its weight; `allowMixing=true`: all categories are packed together
6. **Query compression** — for each prefix, walks backward to find the shortest prefix that has no conflicts with any other partition's prefixes/exacts
7. **Gap catcher** — per `majorCategory`, if the category was split into multiple prefixes/exacts, appends a compound NOT clause to the last partition of that category to catch any IDs that fall through the cracks
8. **Result formatting** — emits `{ partition_name, estimated_users, estimated_rows, query }`; appends `PARTITION_CATCH_ALL` and `PARTITION_EXCEPTION` (nulls/empties) as needed

## Key Invariants

- `EXACT_` prefix on a `categoryGroups` key signals an exact-match group; strip the marker before emitting SQL (`USER_ID = 'val'` instead of `USER_ID LIKE 'val%'`).
- `CatchAll` is never drilled down and collects all IDs not matching any `majorCategory`.
- `balanceTarget: 'user'` makes `getWeight()` return `idsArray.length` (unique user count) rather than summing row counts — this affects both drill-down thresholds and partition size targets.

## Language Note

Comments throughout the source are in Korean. Preserve this style when editing.
