import { PrismaClient } from "@intentic-app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Config } from "./config.js";

// One PrismaClient per process, backed by the pg driver adapter (same pattern as the
// reference stack). The connection string and pool cap come from validated config.
export const createPrisma = (config: Config): PrismaClient => {
    const adapter = new PrismaPg({ connectionString: config.database.url, max: config.database.poolMax });
    return new PrismaClient({ adapter });
};
