import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import { sleep as pause } from "@intentic/base/async";
import { previewUrl, STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { mintSandbox } from "../mint-sandbox.js";
import { JOB_HOSTED_CANARY, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
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
/* How long after the check-in the STARTER SITE gets to answer at its preview address. The check-in proves the
 * machine and the tunnel; this proves what the person was brought here to see, through the same edge a
 * browser uses, and it is the number Phase 1 of the onboarding work is measured by (a prewarmed volume should
 * make this seconds). Past it the run is red even though the daemon is up: a sandbox whose first screen says
 * "isn't running" is the failure this canary exists to catch, however healthy the platform's rows look. */
const STARTER_DEADLINE_MS = 3 * 60 * 1000;
// The daemon's reserved probe path (its panels/preview-proxy.ts PREVIEW_PROBE_PATH), answered with CORS open and
// a JSON body naming what the hostname serves; `serving` is the only answer that counts.
const PREVIEW_PROBE_PATH = `/__intentic/preview-probe`;
// One alert per this window, the same latch shape as the health sweep: a standing fault should be a reminder,
// not a mailbox.
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

export interface CanaryResult {
    readonly ok: boolean;
    // How long from "provision" to the daemon's first announce. Undefined when it never came.
    readonly announcedInMs: number | undefined;
    // How long from "provision" until the starter site answered at its preview address. Undefined when it did
    // not within its deadline, or when the announce never came.
    readonly starterServingInMs: number | undefined;
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

/* Everything this run made, taken back down in the order the delete route uses: the row, then the machine.
 * Releasing reachability is not a step any more — deleting the row IS the revocation (reachability.ts), so the
 * canary cannot leak a grant even if it dies here. Best-effort throughout: a teardown that throws would strand
 * the machine it was cleaning up. */
const teardown = async (prisma: PrismaClient, config: Config, logger: Logger, sandboxId: string): Promise<void> => {
    const hosted = await prisma.hostedMachine.findUnique({ where: { sandboxId } }).catch(() => null);
    await prisma.sandbox
        .delete({ where: { id: sandboxId } })
        .catch((error: unknown) => logger.warn({ err: error, sandboxId }, `hosted canary: deleting the canary sandbox failed`));
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
const waitForAnnounce = async (
    prisma: PrismaClient,
    sandboxId: string,
    deadlineMs: number,
    sleep: (ms: number) => Promise<void>,
): Promise<boolean> => {
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

/* The wait a person's BROWSER makes next: the starter's preview address, through the edge, until its proxy says
 * it is serving. Bounded by a count like the announce wait, for the same reasons. */
const waitForStarter = async (url: string, deadlineMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> => {
    for (let attempt = 0; attempt < Math.ceil(deadlineMs / POLL_MS); attempt += 1) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
            const response = await fetch(`${url}${PREVIEW_PROBE_PATH}`, { signal: AbortSignal.timeout(10_000) });
            if (response.ok) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                const body = (await response.json().catch(() => undefined)) as { proxy?: unknown; state?: unknown } | undefined;
                if (body?.proxy === `intentic-preview` && body.state === `serving`) {
                    return true;
                }
            }
        } catch {
            // Not answering yet is the ordinary state of a name whose tunnel is still binding.
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
    sleep: (ms: number) => Promise<void> = pause,
): Promise<CanaryResult> => {
    const email = config.hosted.canaryEmail;
    if (!hostedEnabled(config) || email === ``) {
        return { ok: true, announcedInMs: undefined, starterServingInMs: undefined, warm: false, detail: `canary off` };
    }
    const ownerId = await ensureCanaryUser(prisma, email);
    await collectPreviousRuns(prisma, config, logger, ownerId);
    const { token, sandbox } = await mintSandbox(prisma, config, { name: canarySandboxName, ownerId });
    const startedAt = Date.now();
    try {
        const { warm } = await provisionHosted(prisma, config, logger, {
            sandboxId: sandbox.id,
            connectToken: token,
            ownerEmail: email,
            // The default region: the canary proves the lane, and a per-region proof is what the pool's own
            // stock check (hosted-health.ts) is for.
            region: config.hosted.region,
        });
        const announced = await waitForAnnounce(prisma, sandbox.id, DEADLINE_MS, sleep);
        const announcedInMs = Date.now() - startedAt;
        if (!announced) {
            return {
                ok: false,
                announcedInMs: undefined,
                starterServingInMs: undefined,
                warm,
                detail: `a ${warm ? `warm` : `cold`} machine was provisioned but never checked in within ${DEADLINE_MS / 60_000} minutes`,
            };
        }
        // What the person sees next, at the address their browser opens: the starter site, or "isn't running".
        const starterUrl = previewUrl(`${STARTER_REPO}--${STARTER_APP}`, config.ingress.zone, sandboxIdFromToken(token));
        const serving = starterUrl === undefined ? false : await waitForStarter(starterUrl, STARTER_DEADLINE_MS, sleep);
        const starterServingInMs = Date.now() - startedAt;
        return serving
            ? {
                  ok: true,
                  announcedInMs,
                  starterServingInMs,
                  warm,
                  detail: `provisioned, checked in, starter serving after ${Math.round(starterServingInMs / 1000)}s`,
              }
            : {
                  ok: false,
                  announcedInMs,
                  starterServingInMs: undefined,
                  warm,
                  detail: `a ${warm ? `warm` : `cold`} machine checked in after ${Math.round(announcedInMs / 1000)}s but its starter site never served within ${STARTER_DEADLINE_MS / 60_000} more minutes`,
              };
    } catch (error) {
        return {
            ok: false,
            announcedInMs: undefined,
            starterServingInMs: undefined,
            warm: false,
            detail: error instanceof Error ? error.message : `provisioning failed`,
        };
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
