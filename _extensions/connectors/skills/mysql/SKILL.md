---
name: mysql
description: Query the connected MySQL/MariaDB database with the mysql client. Use when the user asks about their database — tables, rows, schema, or to run SQL against MySQL.
---

# MySQL (connected)

The connection is in the env (`$MYSQL_HOST`, `$MYSQL_PORT`, `$MYSQL_USER`, `$MYSQL_PASSWORD`, `$MYSQL_DATABASE`).
Pass the password via `MYSQL_PWD` and the rest as flags. The client is preinstalled once the sandbox has been
rebuilt for this capability (Environment card).

- List tables: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SHOW TABLES;"`
- Describe a table: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "DESCRIBE <table>;"`
- Run a query: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT * FROM <table> LIMIT 20;"`
- Scriptable output (tab-separated, no header): add `-N -B`, e.g. `MYSQL_PWD="$MYSQL_PASSWORD" mysql -N -B -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT count(*) FROM <table>;"`
- List databases: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" -e "SHOW DATABASES;"`

Notes: this is a read-write connection — the connected user's grants bound what you can do. Prefer a `WHERE`
on every `UPDATE`/`DELETE`.
