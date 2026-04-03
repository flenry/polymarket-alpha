# Board Brief: Drizzle Migration Fix

## Context

**Project:** polymarket-alpha — Phase 1 MVP complete (251 tests, on `main`)  
**Repo:** git@github.com:flenry/polymarket-alpha.git  
**This is an EXISTING project. Brook: work on main directly (no feature branch needed — small fix).**

---

## Problem Statement

`pnpm db:migrate` fails with `Can't find meta/_journal.json`. Root cause: Zoro wrote hand-crafted SQL files (`drizzle/0001_initial_schema.sql`, `drizzle/0002_partition_trades.sql`) but never ran `drizzle-kit generate` to register them, so the `drizzle/meta/` directory was missing entirely.

### Current State (after Robin ran `pnpm db:generate`)

Running `pnpm db:generate` now created:
- `drizzle/meta/_journal.json` — tracks only `0000_misty_thaddeus_ross` (idx 0)
- `drizzle/meta/0000_snapshot.json` — the current schema snapshot
- `drizzle/0000_misty_thaddeus_ross.sql` — drizzle-kit auto-generated DDL (all 8 tables, no partition logic)

But this creates a **new problem**: three migration files exist in `drizzle/`, only one is tracked:

| File | In journal? | Contents |
|---|---|---|
| `0000_misty_thaddeus_ross.sql` | ✅ idx 0 | All 8 tables (drizzle-kit style, no `IF NOT EXISTS`) |
| `0001_initial_schema.sql` | ❌ orphan | All 8 tables (hand-crafted, `IF NOT EXISTS` style) |
| `0002_partition_trades.sql` | ❌ orphan | Partition DDL for `trades` + `order_book_snapshots` |

`pnpm db:migrate` now proceeds past the journal check (fails only on ECONNREFUSED — no DB running), which confirms the journal is the only structural issue.

The `0001` and `0002` files are **duplicate/orphan** files never applied by drizzle-kit. The `0000_*` auto-generated file is semantically equivalent to `0001` (same 8 tables, minor style differences: no `IF NOT EXISTS`).

---

## Goal (success definition)

After the fix:
```bash
pnpm db:generate   # idempotent — no new migration generated
pnpm db:migrate    # applies migrations, exits 0 (given a live DB)
```

The `drizzle/meta/_journal.json` is authoritative and registers exactly the right files in dependency order. No duplicate table-create DDL is applied twice.

---

## Correct Fix Strategy

**Option A (cleanest — adopt drizzle-kit as truth):**  
Delete `0001_initial_schema.sql` (redundant with `0000_*`). Add `0002_partition_trades.sql` to the journal as idx 1. Run `pnpm db:generate` again to verify idempotency (no new migration). Add `db:migrate:partitions` script as a fallback runner if drizzle-kit can't apply raw partition DDL cleanly.

**Option B (preserve hand-crafted 0001):**  
Delete `0000_misty_thaddeus_ross.sql` + `meta/` entirely. Re-do `generate` in a way that starts from `0001`. More complex, fights drizzle-kit naming.

**→ Option A is the right call.** Drizzle-kit owns `0000_*` and the journal. We keep that, delete `0001` (it's a semantic duplicate), and manually register `0002` in the journal + snapshot chain.

**Critical sub-question: can `drizzle-kit migrate` apply raw partition DDL?**  
`drizzle-kit migrate` uses `runMigrations()` from `drizzle-orm/migrator` — it executes SQL files verbatim. The `0002` file is valid PostgreSQL DDL. There's no reason it can't run it. The only risk is if drizzle-kit's migrator wraps statements in a transaction that conflicts with `ALTER TABLE ... RENAME` or `CREATE TABLE ... PARTITION OF`. This is a known PostgreSQL constraint: `CREATE TABLE ... PARTITION BY` **can** run inside a transaction. DDL that conflicts with active locks would fail at runtime, not at apply-time. **No custom runner needed** unless DB testing shows otherwise.

---

## Tasks

### Task 1 — Clean up orphan files
- Delete `drizzle/0001_initial_schema.sql` (semantic duplicate of `0000_misty_thaddeus_ross.sql`)
- Files: `drizzle/0001_initial_schema.sql`
- Outcome: Only `0000_*` and `0002_*` remain in `drizzle/`

### Task 2 — Register 0002 in the journal
- Edit `drizzle/meta/_journal.json` — add entry `{ "idx": 1, "version": "7", "when": <timestamp>, "tag": "0002_partition_trades", "breakpoints": true }`
- Files: `drizzle/meta/_journal.json`
- Constraint: `tag` must match the filename without `.sql` extension; `idx` must be sequential
- Outcome: Journal has 2 entries: idx 0 = `0000_misty_thaddeus_ross`, idx 1 = `0002_partition_trades`

### Task 3 — Verify idempotency
- Run `pnpm db:generate` — must produce **no new migration** (schema matches `0000` snapshot, no drift)
- Expected output: `No changes detected` or empty diff
- If it generates something: investigate what column/index drizzle-kit thinks is missing and fix (without modifying `schema.ts`)

### Task 4 — Add `db:migrate:partitions` fallback script (conditional)
- Only needed if Task 3 reveals that drizzle-kit can't apply `0002` cleanly
- If needed: add `"db:migrate:partitions": "psql $DATABASE_URL -f drizzle/0002_partition_trades.sql"` to `package.json`
- Files: `package.json`
- Constraint: no new npm packages; `psql` is available in the docker environment

### Task 5 — Commit and push
- `git add drizzle/ package.json` (if modified)
- Commit: `fix: add drizzle meta journal and register partition migration`
- Push to `main` on origin

---

## Key Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| drizzle-kit generates a new migration on Task 3 (schema drift) | Low | `0000_*` was generated from the exact same `schema.ts` — should be idempotent |
| `drizzle-kit migrate` wraps 0002 DDL in a transaction that fails | Low-Medium | PostgreSQL supports partition DDL in transactions; test with live DB |
| `ALTER TABLE trades RENAME` fails if table doesn't exist yet | None | 0002 runs after 0001 in journal order — trades table exists |

---

## Questions for Vegapunk / Law

**Vegapunk:** Is there a snapshot JSON for idx 1 needed in `meta/`? Drizzle-kit generates `000N_snapshot.json` alongside each migration. For a manually-registered entry, the snapshot after applying `0002` can't be auto-generated (partitioned tables look different to drizzle-kit than the schema.ts describes). Does the absence of `0001_snapshot.json` cause `drizzle-kit migrate` to fail or just skip?

**Law:** The `0002` partition migration does `ALTER TABLE trades RENAME TO trades_legacy` then recreates `trades` as `PARTITION BY RANGE`. This is idempotent only on the first apply. If `db:migrate` is re-run against an already-migrated DB, the journal's `__drizzle_migrations` table will prevent re-application. Confirm drizzle-kit uses a migrations lock table by default — this is the safety net against double-apply.

---

## Out of Scope

- Modifying `src/db/schema.ts` (explicitly prohibited in spec)
- Adding new npm packages
- Changing any application code, tests, or configs other than `package.json` scripts
- Running against a live DB in this fix (verify with DB connection is Brook's/Nami's job if they spin up postgres)

---

## Execution Order

1. Task 1 — delete orphan `0001_initial_schema.sql`
2. Task 2 — update `drizzle/meta/_journal.json`
3. Task 3 — run `pnpm db:generate`, verify idempotency
4. Task 4 — add fallback script only if Task 3 shows issues
5. Task 5 — commit and push to main

---

## TODO

- [ ] Task 1: Delete `drizzle/0001_initial_schema.sql`
- [ ] Task 2: Update `drizzle/meta/_journal.json` — add `0002_partition_trades` as idx 1
- [ ] Task 3: Run `pnpm db:generate` — confirm no new migration
- [ ] Task 4: Add `db:migrate:partitions` to `package.json` if needed (conditional)
- [ ] Task 5: `git add drizzle/ && git commit -m "fix: add drizzle meta journal and register partition migration" && git push origin main`
