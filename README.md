# IIQ_3rd_helper

A JavaScript utility for distributing user IDs evenly across database partitions. It automatically detects data skew, subdivides large categories, and generates SQL `WHERE` clauses for each partition.

## What it does

Given a list of user IDs and a target partition count, `normalizePartitionsAutoSplit()` returns one SQL filter per partition — ready to use in a `WHERE` clause or partition definition.

**Example output:**
```json
[
  {
    "partition_name": "PARTITION_1",
    "estimated_rows": 1402,
    "query": "(\n    USER_ID LIKE 'A1%'\n    OR USER_ID LIKE 'A2%'\n)"
  },
  {
    "partition_name": "PARTITION_CATCH_ALL",
    "estimated_rows": 38,
    "query": "(\n    USER_ID NOT LIKE '0%' AND\n    ...\n    AND USER_ID != '' AND USER_ID IS NOT NULL\n)"
  }
]
```

## Usage

Copy `ShinNormalizer_V3_DidEverything.js` into your project and call the function directly — there are no dependencies to install.

```js
const result = normalizePartitionsAutoSplit(
  userIds,        // string[] — raw user ID list (nulls/empty strings allowed)
  36,             // numPartitions — target number of partitions
  ['0','1','2','3','4','5','6','7','8','9','C'], // majorCategories — top-level prefixes
  true            // includeNotAll — include a catch-all partition for unmatched IDs
);
```

Each element in the returned array has:

| Field | Type | Description |
|---|---|---|
| `partition_name` | string | e.g. `PARTITION_1`, `PARTITION_CATCH_ALL`, `PARTITION_EXCEPTION` |
| `estimated_rows` | number | Number of input IDs assigned to this partition |
| `query` | string | SQL condition block ready for use in a `WHERE` clause |

## How it works

1. **Filter** — removes null/empty entries; computes per-partition target capacity
2. **Classify** — groups each ID by the first matching `majorCategory` prefix; unmatched IDs go to `CatchAll`
3. **Auto-split** — any group exceeding 115% of target capacity is subdivided by appending the next character as a new prefix; repeats until no group is oversized (max depth: 10 characters)
4. **Bin-pack** — sorts groups largest-first and assigns each to the partition with the current lowest count (greedy)
5. **Generate SQL** — emits `USER_ID LIKE 'prefix%'` or `USER_ID = 'exact'` per group
6. **Append special partitions** — `PARTITION_CATCH_ALL` for unclassified IDs, `PARTITION_EXCEPTION` for nulls/empty strings

## Special partitions

| Partition | Condition |
|---|---|
| `PARTITION_CATCH_ALL` | IDs that don't start with any `majorCategory` prefix (only if `includeNotAll = true` and count > 0) |
| `PARTITION_EXCEPTION` | Null or empty-string entries from the original input |

## Quick test

```bash
node -e "
$(cat ShinNormalizer_V3_DidEverything.js)
const ids = ['A100','A200','B001','C999','','null_user'];
console.log(JSON.stringify(normalizePartitionsAutoSplit(ids, 3, ['A','B','C']), null, 2));
"
```
