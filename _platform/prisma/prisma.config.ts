import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { env, type PrismaConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env. Load the monorepo-root .env (where DATABASE_URL lives) before the config
// is read, using Node's built-in loader. The root is found by walking up to the workspace marker, so neither
// this file's depth nor the cwd the db:* scripts happen to run from is part of the answer.
const rootEnv = join(repoRoot(import.meta.url), ".env");
if (existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
}

export default {
    schema: "./schema.prisma",
    datasource: {
        url: env(`DATABASE_URL`),
    },
    // Explicit so `prisma migrate deploy --config ./node_modules/@intentic-app/prisma/prisma.config.ts`
    // resolves migrations relative to this file (next to the bundled schema) regardless of cwd.
    migrations: {
        path: "./migrations",
    },
} satisfies PrismaConfig;
