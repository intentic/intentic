---
name: postgres
description: Query the connected PostgreSQL database with psql. Use when the user asks about their database, tables, rows, schema, or to run SQL against Postgres.
---

# PostgreSQL (connected)

The connection string is in `$POSTGRES_URL`: pass it to `psql` as the first argument. `psql` is preinstalled
once the sandbox has been rebuilt for this capability (Environment card).

- List tables: `psql "$POSTGRES_URL" -c "\dt"`
- Describe a table: `psql "$POSTGRES_URL" -c "\d <table>"`
- Run a query: `psql "$POSTGRES_URL" -c "SELECT * FROM <table> LIMIT 20"`
- Scriptable output (no headers/formatting, one value): `psql "$POSTGRES_URL" -tAc "SELECT count(*) FROM <table>"`
- List databases / schemas: `psql "$POSTGRES_URL" -c "\l"` / `psql "$POSTGRES_URL" -c "\dn"`

Notes: this is a read-write connection, the connected role's grants bound what you can do. Wrap risky writes
in `BEGIN; … COMMIT;` and prefer a `WHERE` on every `UPDATE`/`DELETE`.
