import { randomBytes } from "node:crypto";
import { provisionSandboxTunnel } from "./cloudflare.js";
import type { Config } from "../config.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { encryptSecret } from "../crypto.js";
import { JOB_SANDBOX_POOL, runExclusive } from "../jobs-lock.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

// Keep a handful of sandbox subdomains provisioned ahead of demand so /setup pays no Cloudflare round-trips
// inline: the expensive part of a sandbox (mint a connect token, provision its intentic tunnel + DNS) is done
// here in the background, and sandbox.create just claims a ready one. When the pool is empty create falls back
// to inline provisioning (router.ts), so this is strictly a latency win, never a dependency.

// A claimed reservation, shaped for a verbatim copy into the Sandbox row (token + tunnelToken stay encrypted,
// tokenDigest stays hex — none re-derived).
export type ClaimedReservation = { token: string; tokenDigest: string; tunnelToken: string; tunnelHostname: string };

// Atomically pop the oldest reservation, or undefined when the pool is empty. SKIP LOCKED lets concurrent
// creates take different rows (two sandboxes must never share one tunnel/hostname); the whole DELETE …
// RETURNING is one statement, so the row is gone the moment it's returned. Column identifiers are the quoted
// camelCase PrismaClient maps the model fields to; the table is @@map("reserved_sandbox").
export const claimReserved = async (prisma: PrismaClient): Promise<ClaimedReservation | undefined> => {
    const rows = await prisma.$queryRaw<ClaimedReservation[]>`
        DELETE FROM reserved_sandbox
        WHERE id = (SELECT id FROM reserved_sandbox ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING token, "tokenDigest", "tunnelToken", "tunnelHostname"
    `;
    return rows[0];
};

// Refill the pool up to poolSize, provisioning one spare at a time. No-op unless the intentic-provided path is
// configured and poolSize > 0 (mirrors the reaper's gate in retention.ts). Called at boot, on an interval, and
// right after a claim so a claimed slot is replaced promptly. One top-up runs at a time across the whole
// deployment (jobs-lock.ts): overlapping boot/interval/post-claim runs — same process or another replica —
// skip instead of count-then-provisioning past poolSize.
export const topUp = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const { apiToken, zone, poolSize } = config.intenticCloudflare;
    if (apiToken === `` || zone === `` || poolSize <= 0) {
        return;
    }
    await runExclusive(config, JOB_SANDBOX_POOL, async () => {
        let have = await prisma.reservedSandbox.count();
        while (have < poolSize) {
            const token = randomBytes(16).toString(`base64url`);
            // oxlint-disable-next-line eslint/no-await-in-loop -- provision spares sequentially to stay gentle on Cloudflare; background work, a handful of entries
            const tunnel = await provisionSandboxTunnel({ apiToken, zone, connectToken: token });
            // oxlint-disable-next-line eslint/no-await-in-loop -- see above
            await prisma.reservedSandbox.create({
                data: {
                    token: encryptSecret(config, token),
                    tokenDigest: sha256Hex(token),
                    tunnelToken: encryptSecret(config, tunnel.tunnelToken),
                    tunnelHostname: tunnel.hostname,
                },
            });
            have += 1;
            logger.info({ have, poolSize }, `sandbox pool topped up`);
        }
    });
};

// Backstop cadence — a claim triggers an immediate refill, so the interval only fills on boot and recovers from
// a failed refill or a raised poolSize.
const POOL_INTERVAL_MS = 5 * 60 * 1000;

export const startSandboxPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const { apiToken, zone, poolSize } = config.intenticCloudflare;
    if (apiToken === `` || zone === `` || poolSize <= 0) {
        return;
    }
    const run = async (): Promise<void> => {
        // A failed top-up must not crash the API; the next interval (or the next claim's refill) retries.
        try {
            await topUp(prisma, config, logger);
        } catch (error) {
            logger.error({ err: error }, `sandbox pool top-up failed`);
        }
    };
    void run();
    setInterval(() => void run(), POOL_INTERVAL_MS);
};
