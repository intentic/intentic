import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, type PrismaConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env. Load the monorepo-root .env (where DATABASE_URL
// lives) before the config is read, using Node's built-in loader. cwd is this package
// dir when the db:* scripts run, so the root file is two levels up.
const rootEnv = resolve(import.meta.dirname, "../../.env");
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
