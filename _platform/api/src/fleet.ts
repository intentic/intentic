import { loadConfig } from "./config.js";
import { createPrisma } from "./prisma.js";
import { printHostedFleet } from "./sandbox/hosted/hosted-fleet.js";

/* `pnpm --filter @intentic-app/api fleet`, the operator's one-shot read of what the platform actually has on
 * Fly, and who has it. Same shape as main.ts (config, then a client) minus everything that runs: no server,
 * no jobs, no writes anywhere. It answers the question the Fly console structurally cannot, because a warm
 * machine's app name is minted before anyone claims it and Fly never lets a name change, see hosted-fleet.ts
 * for why the platform's own rows are the only honest source. */

const config = loadConfig();
const prisma = createPrisma(config);
try {
    process.stdout.write(`${await printHostedFleet(prisma, config)}\n`);
} finally {
    await prisma.$disconnect();
}
