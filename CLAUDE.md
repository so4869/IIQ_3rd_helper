# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**IIQ_3rd_helper** is a collection of SailPoint IdentityIQ / ISC helper utilities. There is no shared build system or package manager — each subdirectory is an independent tool.

## Repository Structure

| Directory | Language | Purpose |
|---|---|---|
| `ShinNormalizer/` | Node.js | Distribute USER_IDs across DB partitions; generate SQL WHERE clauses |
| `Summary-SPT_PROVISIONING_TRANSACTION/` | Python | Analyze `spt_provisioning_transaction` table in IdentityIQ 8.4p2 SQL Server DB |

Each subdirectory has its own `CLAUDE.md` and `README.md` with full details.

## Language Note

Korean comments are used throughout all source files. Preserve this style when editing.
