import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";
import { poolEnabled } from "./pool-membership.js";

/* THE DEMO SERVICE — a complete, working premium service the platform itself hosts, so the catalog is never
 * an empty promise and the whole metered path (spend → signed forward → answer → credits header; refund on
 * failure) is demonstrable end to end without recruiting a provider. Its upstream is the platform's own
 * /pool/demo/upstream, which verifies the forwarded signature exactly as a real provider would — making it
 * doubly useful as living documentation of what a provider implements.
 *
 * Seeded at boot behind POOL_DEMO_SERVICE, the trial's off-by-default posture: on, the row is (re)activated
 * with a per-platform random secret minted once and stored encrypted like any service secret; off, the row
 * is delisted rather than deleted, so its run history stays on the ledger. */

export const DEMO_SLUG = `demo-research`;

export const seedDemoService = async (prisma: PrismaClient, config: Config): Promise<void> => {
    if (!poolEnabled(config)) {
        return;
    }
    const existing = await prisma.service.findUnique({ where: { slug: DEMO_SLUG } });
    if (!config.pool.demoService) {
        if (existing !== null && existing.active) {
            await prisma.service.update({ where: { slug: DEMO_SLUG }, data: { active: false } });
        }
        return;
    }
    const state = {
        publisher: `intentic`,
        name: `Demo Research`,
        description: `A demonstration research run — answers a canned summary for any query, so you can watch the metered flow end to end.`,
        upstreamUrl: new URL(`/pool/demo/upstream`, config.api.url).toString(),
        creditsPerRun: 5,
        active: true,
    };
    if (existing === null) {
        await prisma.service.create({ data: { slug: DEMO_SLUG, secret: encryptSecret(config, randomBytes(24).toString(`hex`)), ...state } });
        return;
    }
    // Keep the minted secret; refresh everything else, so a flag flip or a copy change never rotates what a
    // running platform signs with mid-flight.
    await prisma.service.update({ where: { slug: DEMO_SLUG }, data: state });
};

// The canned answer the demo upstream serves — deliberately shaped like a real research result, so an agent
// quoting it in chat reads plausibly, and deliberately labelled, so nobody mistakes it for one.
export const demoAnswer = (query: string): object => ({
    demo: true,
    query,
    summary: `Demo summary for "${query}": this canned answer proves the metered path end to end — your credits were spent, the call was signature-verified, and a real provider would answer here.`,
    sources: [{ title: `The creator pool, documented`, url: `https://intentic.dev/api/earn/` }],
});
