import { loadConfig } from "./config.js";
import { createPrisma } from "./prisma.js";
import { printHostedFleet, stampHostedOwners } from "./sandbox/hosted/hosted-fleet.js";

/* `pnpm --filter @intentic/api fleet`, the operator's one-shot read of what the platform actually has on Fly, and who has it. */

const config = loadConfig();
const prisma = createPrisma(config);
try {
    process.stdout.write(`${await printHostedFleet(prisma, config)}\n`);
    /* `--stamp` records each taken machine's owner email in Fly metadata. */
    if (process.argv.includes(`--stamp`)) {
        process.stdout.write(`\nstamping owners into Fly metadata\n`);
        const { stamped, failed } = await stampHostedOwners(prisma, config, (line) => process.stdout.write(`  ${line}\n`));
        process.stdout.write(`\n${stamped} stamped, ${failed} failed\n`);
    }
} finally {
    await prisma.$disconnect();
}
