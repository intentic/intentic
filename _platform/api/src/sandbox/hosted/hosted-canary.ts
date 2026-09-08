import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { sleep as pause } from "@intentic/base/async";
import { previewUrl, STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { mintSandbox } from "../mint-sandbox.js";
import { JOB_HOSTED_CANARY, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { HostedAtCapacity, hostedCapacity } from "./hosted-capacity.js";
import { destroyHosted, hostedEnabled, provisionHosted } from "./hosted.js";
import { HOUR_MS } from "../../durations.js";

// Runs the real provisioning path on its own sandbox and waits for the daemon's announce: the health sweep catches a
// fleet going missing, not a lane that's intact but stopped working. Off unless HOSTED_CANARY_MINUTES is set; teardown
// always runs, since a leaked machine costs more than the outage this watches for.

const POLL_MS = 15_000;
// Generous: a cold build pulls the image (minutes); past this, a real signup would already have given up.
const DEADLINE_MS = 12 * 60 * 1000;
// How long after check-in the starter site gets to answer at its preview address; past it, the run is red.
const STARTER_DEADLINE_MS = 3 * 60 * 1000;
// The daemon's reserved probe path (preview-proxy.ts PREVIEW_PROBE_PATH); `serving` is the only answer that counts.
const PREVIEW_PROBE_PATH = `/__intentic/preview-probe`;
// One alert per window (same latch shape as the health sweep): a standing fault is a reminder, not a mailbox.
const ALERT_EVERY_MS = 6 * HOUR_MS;

export interface CanaryResult {
    readonly ok: boolean;
    // Time from provision to the daemon's first announce; undefined when it never came.
    readonly announcedInMs: number | undefined;
    // Time to the starter answering at its preview address; undefined if late or the announce never came.
    readonly starterServingInMs: number | undefined;
    // Where the machine came from, so a slow run can be read against its origin's own promise.
    readonly warm: boolean;
    readonly detail: string;
}

const canarySandboxName = `hosted canary`;

// The canary's own account, a real row rather than a null owner: every gate on the path (hour meter, per-user ceiling,
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

// Tears down everything this run made, row then machine, in delete-route order. Deleting the row is itself the
// reachability revocation, so a canary that dies here cannot leak a grant.
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

// Collects anything a previous run left behind (a crash between provision and teardown) before this run starts.
const collectPreviousRuns = async (prisma: PrismaClient, config: Config, logger: Logger, ownerId: string): Promise<void> => {
    const leftovers = await prisma.sandbox.findMany({ where: { ownerId }, select: { id: true } });
    for (const leftover of leftovers) {
        logger.warn({ sandboxId: leftover.id }, `hosted canary: collecting a sandbox a previous run left behind`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, and there is normally none
        await teardown(prisma, config, logger, leftover.id);
    }
};

// Polls the row the daemon's announce writes until it appears or attempts run out. Bounded by a count, not the clock,
// so a stubbed sleep in tests can't spin forever.
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

// The browser's next wait: the starter's preview address through the edge, until its proxy says serving. Bounded by a
// count, like the announce wait.
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
            // Not answering yet is ordinary while the tunnel is still binding.
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(POLL_MS);
    }
    return false;
};

// Nothing proved, nothing failed: the answer for a run that should not happen.
const skipped = (detail: string): CanaryResult => ({ ok: true, announcedInMs: undefined, starterServingInMs: undefined, warm: false, detail });

// The lane being off is ordinary; the lane being full is not: this canary spends a real machine, and on a full fleet
// that's the same machine a signup needs. Capacity has its own alarm (hosted-health.ts); this one just stands down.
const standDown = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<CanaryResult | undefined> => {
    if (!hostedEnabled(config) || config.hosted.canaryEmail === ``) {
        return skipped(`canary off`);
    }
    if ((await hostedCapacity(prisma, config)).full) {
        logger.warn({}, `hosted canary: the lane is full; standing down so the machines that are left go to people`);
        return skipped(`skipped: the lane is at capacity`);
    }
    return undefined;
};

// One run start to finish. Never throws: a canary that can take the process down is a liability, not a check.
export const runHostedCanary = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    sleep: (ms: number) => Promise<void> = pause,
): Promise<CanaryResult> => {
    const email = config.hosted.canaryEmail;
    const standing = await standDown(prisma, config, logger);
    if (standing !== undefined) {
        return standing;
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
            // Default region: proves the lane; per-region proof is hosted-health.ts's job.
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
        // What the person sees next at the address their browser opens: the starter site, or isn't running.
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
            // Operator's words for a full lane, not the reader's; this failure also teaches the platform it's full.
            detail:
                error instanceof HostedAtCapacity
                    ? `the provider has no machines left for this platform, so a new sandbox cannot be created at all`
                    : error instanceof Error
                      ? error.message
                      : `provisioning failed`,
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

// Tests reset this latch; nothing else should touch it.
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

// Boot wiring (main.ts), off by default since every run spends money. First run is not at boot: a deploy restarts every
// replica at once, and the canary has nothing useful to say about a platform still coming up.
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
