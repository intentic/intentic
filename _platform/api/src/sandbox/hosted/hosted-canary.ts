import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret, encryptSecret } from "../../crypto.js";
import { JOB_HOSTED_CANARY, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { ensureZrokAccount } from "../zrok-provision.js";
import { deleteSandboxAccount } from "../zrok.js";
import { destroyHosted, hostedEnabled, provisionHosted } from "./hosted.js";

/* DOES SIGNING UP STILL GET YOU A WORKING MACHINE? Asked by doing it, on a timer, rather than by waiting for
 * somebody to report that it doesn't.
 *
 * The health sweep beside this one compares rows against Fly, which catches a fleet going missing but cannot
 * catch a lane that quietly stopped WORKING: an image that no longer boots, a tunnel grant the hub refuses, a
 * region out of capacity, an env key that stopped being passed. Every one of those looks perfect from the
 * platform's side, the row exists, the machine is `started`, and the only symptom is that the daemon never
 * checks in, which is indistinguishable from "a user opened the page and wandered off" unless something is
 * deliberately watching. Production had six such sandboxes in a row and nothing said a word.
 *
 * So this runs the REAL path, the same `provisionHosted` a signup runs, on a sandbox of its own, and waits for
 * the same announce a person waits for. It proves the whole chain in one assertion: Fly built (or the pool
 * handed over) a machine, the image booted, the daemon came up, the tunnel bound, and the platform accepted
 * the check-in. Then it destroys everything it made.
 *
 * It costs a machine's few minutes each run, which is why it is OFF unless `HOSTED_CANARY_MINUTES` says
 * otherwise, and why the teardown runs in a `finally` even when the wait fails: a canary that leaks machines
 * would cost more than the outage it watches for. */

const POLL_MS = 15_000;
// Generous on purpose: a cold build pulls the image (minutes), and a canary that cries at four is a canary
// nobody reads. Past this, a real signup would have given up long ago.
const DEADLINE_MS = 12 * 60 * 1000;
// One alert per this window, the same latch shape as the health sweep: a standing fault should be a reminder,
// not a mailbox.
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

export interface CanaryResult {
    readonly ok: boolean;
    // How long from "provision" to the daemon's first announce. Undefined when it never came.
    readonly announcedInMs: number | undefined;
    // Where the machine came from, so a slow run can be read against the promise its origin makes.
    readonly warm: boolean;
    readonly detail: string;
}

const canarySandboxName = `hosted canary`;

// The account the canary's sandbox belongs to. Deliberately a real row rather than a null owner: the whole
// point is to walk the path a person walks, and every gate on it (the hour meter, the per-user ceiling,
// membership) reads an owner.
const ensureCanaryUser = async (prisma: PrismaClient, email: string): Promise<string> => {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing !== null) {
        return existing.id;
    }
    const created = await prisma.user.create({
        data: { id: `canary-${randomBytes(8).toString(`hex`)}`, email, name: `Hosted canary`, emailVerified: true },
        select: { id: true },
    });
    return created.id;
};

/* Everything this run made, taken back down in the order the delete route uses: the hub grant first (zrok has
 * no way to list accounts, so a grant whose row is gone can never be found again), then the row, then the
 * machine. Best-effort throughout: a teardown that throws would strand the machine it was cleaning up. */
const teardown = async (prisma: PrismaClient, config: Config, logger: Logger, sandboxId: string): Promise<void> => {
    const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } }).catch(() => null);
    const hosted = await prisma.hostedMachine.findUnique({ where: { sandboxId } }).catch(() => null);
    if (sandbox?.zrokToken != null) {
        const tunnelId = sandboxIdFromToken(decryptSecret(config, sandbox.token)) ?? sandboxId;
        await deleteSandboxAccount(config.zrok, tunnelId).catch((error: unknown) =>
            logger.warn({ err: error, sandboxId }, `hosted canary: releasing the tunnel grant failed`),
        );
    }
    await prisma.sandbox.delete({ where: { id: sandboxId } }).catch((error: unknown) =>
        logger.warn({ err: error, sandboxId }, `hosted canary: deleting the canary sandbox failed`),
    );
    if (hosted !== null) {
        await destroyHosted(config, hosted.appName).catch((error: unknown) =>
            logger.warn({ err: error, app: hosted.appName }, `hosted canary: destroying the canary machine failed; left for the reaper`),
        );
    }
};

// Anything a previous run left behind (a crash between provision and teardown), collected before this one
// starts, so the canary can never accumulate machines.
const collectPreviousRuns = async (prisma: PrismaClient, config: Config, logger: Logger, ownerId: string): Promise<void> => {
    const leftovers = await prisma.sandbox.findMany({ where: { ownerId }, select: { id: true } });
    for (const leftover of leftovers) {
        logger.warn({ sandboxId: leftover.id }, `hosted canary: collecting a sandbox a previous run left behind`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, and there is normally none
        await teardown(prisma, config, logger, leftover.id);
    }
};

/* The wait a person makes, made by a machine: poll the row the daemon's announce writes until it appears or
 * the attempts run out. Bounded by a COUNT rather than by the clock, so the loop terminates on its own terms
 * whatever the clock is doing, which is what keeps a stubbed sleep (tests) from spinning until the process
 * dies and a suspended event loop from silently extending the deadline. */
const waitForAnnounce = async (prisma: PrismaClient, sandboxId: string, deadlineMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> => {
    for (let attempt = 0; attempt < Math.ceil(deadlineMs / POLL_MS); attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
        const row = await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { lastSeenAt: true } });
        if (row?.lastSeenAt != null) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(POLL_MS);
    }
    return false;
};

/* One run, start to finish, answering what it proved. Never throws: a canary that can take the process down
 * with it is a liability rather than a check. */
export const runHostedCanary = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CanaryResult> => {
    const email = config.hosted.canaryEmail;
    if (!hostedEnabled(config) || email === ``) {
        return { ok: true, announcedInMs: undefined, warm: false, detail: `canary off` };
    }
    const ownerId = await ensureCanaryUser(prisma, email);
    await collectPreviousRuns(prisma, config, logger, ownerId);
    const token = randomBytes(16).toString(`base64url`);
    const sandbox = await prisma.sandbox.create({
        data: { name: canarySandboxName, ownerId, token: encryptSecret(config, token), tokenDigest: sha256Hex(token) },
    });
    const startedAt = Date.now();
    try {
        const grant = await ensureZrokAccount(prisma, config, sandbox);
        const { appName } = await provisionHosted(prisma, config, logger, {
            sandboxId: sandbox.id,
            connectToken: token,
            grant,
            ownerEmail: email,
            // The default region: the canary proves the lane, and a per-region proof is what the pool's own
            // stock check (hosted-health.ts) is for.
            region: config.hosted.region,
        });
        // A pool claim keeps its pool app name for life, which is also how the wizard knows what to promise.
        const warm = appName.startsWith(`${config.hosted.appPrefix}-pool-`);
        const announced = await waitForAnnounce(prisma, sandbox.id, DEADLINE_MS, sleep);
        const announcedInMs = Date.now() - startedAt;
        return announced
            ? { ok: true, announcedInMs, warm, detail: `provisioned and checked in` }
            : {
                  ok: false,
                  announcedInMs: undefined,
                  warm,
                  detail: `a ${warm ? `warm` : `cold`} machine was provisioned but never checked in within ${DEADLINE_MS / 60_000} minutes`,
              };
    } catch (error) {
        return { ok: false, announcedInMs: undefined, warm: false, detail: error instanceof Error ? error.message : `provisioning failed` };
    } finally {
        await teardown(prisma, config, logger, sandbox.id);
    }
};

const failureMail = (config: Config, result: CanaryResult) => ({
    subject: `intentic hosted: the provisioning canary failed`,
    html: linkEmail({
        heading: `A hosted machine could not be provisioned`,
        body: `The canary ran the same path a new signup runs and it did not finish: ${result.detail}. Until this passes again, assume anyone choosing "start instantly" is meeting the same thing.`,
        action: `Open the admin panel`,
        link: config.webOrigin,
    }),
    link: config.webOrigin,
});

let lastAlertAt = 0;

// Tests reset the latch; nothing else has any business touching it.
export const forgetHostedCanaryAlert = (): void => {
    lastAlertAt = 0;
};

export const sweepHostedCanary = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: () => number = Date.now,
): Promise<CanaryResult> => {
    const result = await runHostedCanary(prisma, config, logger);
    if (result.ok) {
        logger.info({ announcedInMs: result.announcedInMs, warm: result.warm }, `hosted canary: a new sandbox came up`);
        return result;
    }
    logger.error({ detail: result.detail, warm: result.warm }, `hosted canary: a new sandbox did NOT come up`);
    const admins = config.admin.emails
        .split(`,`)
        .map((address) => address.trim())
        .filter((address) => address !== ``);
    if (admins.length === 0 || now() - lastAlertAt < ALERT_EVERY_MS) {
        return result;
    }
    lastAlertAt = now();
    await sendMail(config, logger, { to: admins.join(`, `), ...failureMail(config, result) }).catch((error: unknown) =>
        logger.error({ err: error }, `hosted canary: alerting failed`),
    );
    return result;
};

/* Boot wiring (main.ts). OFF by default: this one spends real money on every run, so a self-hoster gets it
 * only by asking, and the first run is deliberately not at boot, a deploy restarts every replica at once and
 * the canary has nothing useful to say about a platform that is still coming up. */
export const startHostedCanary = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config) || config.hosted.canaryMinutes === 0 || config.hosted.canaryEmail === ``) {
        return;
    }
    const everyMs = config.hosted.canaryMinutes * 60 * 1000;
    setInterval(() => {
        void runExclusive(config, JOB_HOSTED_CANARY, async () => {
            await sweepHostedCanary(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted canary failed`));
        }).catch((error: unknown) => logger.error({ err: error }, `hosted canary lock failed`));
    }, everyMs);
};
