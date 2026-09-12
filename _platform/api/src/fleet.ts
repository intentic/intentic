import { loadConfig } from "./config.js";
import { createPrisma } from "./prisma.js";
import { printHostedFleet, stampHostedOwners } from "./sandbox/hosted/hosted-fleet.js";

/* `pnpm --filter @intentic/api fleet`, the operator's one-shot read of what the platform actually has on
 * Fly, and who has it. Same shape as main.ts (config, then a client) minus everything that runs: no server,
 * no jobs, no writes anywhere. It answers the question the Fly console structurally cannot, because a warm
 * machine's app name is minted before anyone claims it and Fly never lets a name change, see hosted-fleet.ts
 * for why the platform's own rows are the only honest source. */

const config = loadConfig();
const prisma = createPrisma(config);
try {
    process.stdout.write(`${await printHostedFleet(prisma, config)}\n`);
    /* `--stamp` writes each taken machine's owner email into its Fly metadata (FLY_META_OWNER), which is the
     * one-off half of that stamp: machines created or re-configured from now on carry it already, and this is
     * for the ones that were built before it existed and might otherwise sit stopped for months without ever
     * being re-configured. A metadata write restarts nothing, so it is safe to run against a live fleet, and
     * it is idempotent, so it is safe to run twice. Opt-in rather than automatic because it is the only thing
     * this read-only tool can write. */
    if (process.argv.includes(`--stamp`)) {
        process.stdout.write(`\nstamping owners into Fly metadata\n`);
        const { stamped, failed } = await stampHostedOwners(prisma, config, (line) => process.stdout.write(`  ${line}\n`));
        process.stdout.write(`\n${stamped} stamped, ${failed} failed\n`);
    }
} finally {
    await prisma.$disconnect();
}
