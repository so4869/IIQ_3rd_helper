# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Single-script tool for analyzing the `spt_provisioning_transaction` table in a **SailPoint IdentityIQ 8.4p2** SQL Server database. Produces two sets of aggregated reports:
- SQL-level counts by application / source
- XML-parsed counts by application / month / source / planResult and by AttributeRequest `op`

## Running the script

```bash
pip install pyodbc

# Date string form
python analyze_provisioning_transactions.py --start 2024-01-01 --end 2024-12-31

# Datetime form
python analyze_provisioning_transactions.py --start "2024-01-01 00:00:00" --end "2024-12-31 23:59:59"

# Unix millisecond timestamp form
python analyze_provisioning_transactions.py --start 1704034800000 --end 1735570799999
```

## DB configuration

Hardcoded constants at the top of `analyze_provisioning_transactions.py` (lines 34–38):

```python
SERVER   = "localhost"
PORT     = 1433
DATABASE = "identityiq"
USERNAME = "sa"
PASSWORD = "yourpassword"   # change before running
```

The script auto-selects the best available ODBC driver from `DRIVER_CANDIDATES` (lines 40–45).

## Architecture

The script runs three sequential phases:

1. **DB connection** — detects the available ODBC driver via `find_driver()`, connects with `Encrypt=no`.
2. **SQL aggregation** (`SUMMARY_SQL`) — a single GROUP BY query counts rows by `integration` / `source`; no XML touched.
3. **XML parsing** (`DETAIL_SQL`) — fetches all rows in chunks of 500 (`FETCH_CHUNK_SIZE`), then `parse_attributes()` extracts three sub-elements from the `attributes` NVARCHAR(MAX) column:
   - `request` — the requested `ProvisioningPlan`
   - `filtered` — the filtered `ProvisioningPlan`
   - `planResult` — the `ProvisioningResult` status

`get_entitlements_by_op()` counts `AttributeRequest` values per `op` (Add/Remove/Set/…), handling three SailPoint XML serialization forms: inline `value` attribute, single `<Value>` element, and multi-value `<Value><List><String>…` list.

Aggregation keys: `(application, month, source, planResult_status)` for transactions; `(application, month, source, op)` for entitlements.
