#!/bin/sh
# Apply pending Prisma migrations, then exec the Bun daemon as PID 1. migrate deploy is idempotent (only
# unapplied migrations run) and safe to race across replicas — Prisma takes an advisory lock. The CLI is the
# tree's own prisma (a prod dep — run through bun, the image ships no node); its --config resolves the schema
# + migrations dir relative to the prisma package, and DATABASE_URL comes from the environment.
set -e

echo "[api] applying database migrations…"
bun /app/node_modules/prisma/build/index.js migrate deploy --config /app/node_modules/@intentic-app/prisma/prisma.config.ts

echo "[api] starting intentic platform api…"
cd /app
exec bun src/main.ts
