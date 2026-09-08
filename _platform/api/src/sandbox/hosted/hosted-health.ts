import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_HEALTH, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { hostedCapacity } from "./hosted-capacity.js";
import { hostedFleet } from "./hosted-fleet.js";
import { hostedEnabled, type OrphanSkip, sortUnknownApps } from "./hosted.js";
import { HOUR_MS } from "../../durations.js";

// Watches the rows-vs-Fly gap other sweeps act on but never report; read-only, fixes nothing. Four shapes:
// - missing: a row whose Fly app is gone (several at once is another deployment's reaper eating this fleet)
// - strangers: apps under our prefix running another deployment's machine; the only orphan shape that mails anybody
// - litter: our-prefix apps with no row, the reaper's ordinary work; reported, never mailed
// - stock: warm machines against the pool target, per region
// Litter must never be counted as a stranger: that conflation is what made this watch stop being read.

// One alert per window per problem shape; the log line still writes every tick.
const ALERT_EVERY_MS = 6 * HOUR_MS;

export interface HostedHealth {
    // The fleet is at its provider ceiling with no warm stock left; the only fault where rows and Fly fully agree.
    readonly capacity: {
        // Undefined when nothing needed counting: no ceiling configured and no refusal to explain.
        readonly used: number | undefined;
        readonly cap: number;
        readonly full: boolean;
        readonly reason: "cap" | "provider" | undefined;
    };
    // Rows whose Fly app is gone; the shape that leaves people pressing start it over.
    readonly missing: string[];
    // Apps running another deployment's machine; the cause signal, and the only orphan shape that mails anybody.
    readonly strangers: string[];
    // Our-prefix apps with no row: the reaper's ordinary work. Never mailed, never counted against healthy.
    readonly litter: string[];
    // Warm stock per region against the configured target.
    readonly stock: { region: string; warm: number; target: number }[];
    readonly healthy: boolean;
}

export const hostedHealth = async (prisma: PrismaClient, config: Config): Promise<HostedHealth> => {
    const [fleet, capacity] = await Promise.all([hostedFleet(prisma, config), hostedCapacity(prisma, config)]);
    const missing = fleet.filter((entry) => entry.missing).map((entry) => entry.appName);
    // `orphan` says an app has no row, not whose; the reaper's classifier answers that, skipped when nothing to ask.
    const orphans = fleet.filter((entry) => entry.role === `orphan`).map((entry) => entry.appName);
    const sorted: { doomed: string[]; skipped: { app: string; why: OrphanSkip }[] } =
        orphans.length === 0 ? { doomed: [], skipped: [] } : await sortUnknownApps(config, orphans);
    const strangers = sorted.skipped.filter((entry) => entry.why === `theirs`).map((entry) => entry.app);
    const litter = [...sorted.doomed, ...sorted.skipped.filter((entry) => entry.why !== `theirs`).map((entry) => entry.app)];
    const regions = [...new Set([config.hosted.region, config.hosted.regionEu].filter((region) => region !== ``))];
    const stock = regions.map((region) => ({
        region,
        warm: fleet.filter((entry) => entry.role === `warm` && !entry.missing && entry.region === region).length,
        target: config.hosted.poolSize,
    }));
    return {
        capacity: { used: capacity.used, cap: capacity.cap, full: capacity.full, reason: capacity.reason },
        missing,
        strangers,
        litter,
        stock,
        healthy: !capacity.full && missing.length === 0 && strangers.length === 0 && stock.every((r) => r.warm >= r.target),
    };
};

// Own ceiling vs. provider refusal have different remedies (a config number vs. a quota only Fly can move), but both
// end the same way: nobody new gets a sandbox.
const capacityLine = (capacity: HostedHealth[`capacity`]): string => {
    const held = `${capacity.used ?? `all`}${capacity.cap === 0 ? `` : ` of ${capacity.cap}`} machines`;
    const cause =
        capacity.reason === `cap`
            ? `This platform is at the ceiling it was configured with (${held}): raise HOSTED_MAX_MACHINES, and the provider's own allowance with it.`
            : `Fly refused to create a machine for capacity in the last few minutes, with ${held} in the fleet: its allowance for this org, or a region's hardware, is the limit rather than anything here.`;
    return `${cause} There is no warm stock left either, so nobody can be given a new sandbox: new sign-ups are being told plainly that we are out of machines and pointed at running one on their own computer. Free machines or raise the limit and the lane opens again by itself.`;
};

// Subject line: a full fleet leads, since it's happening to people right now rather than to bookkeeping.
const alertSubject = (health: HostedHealth): string => {
    const said = [
        health.capacity.full
            ? `the fleet is full (${health.capacity.used ?? `all`}${health.capacity.cap === 0 ? `` : ` of ${health.capacity.cap}`} machines)`
            : ``,
        health.missing.length > 0 ? `${health.missing.length} machine(s) gone` : ``,
        health.strangers.length > 0 ? `${health.strangers.length} app(s) another deployment is running` : ``,
    ].filter((part) => part !== ``);
    return `intentic hosted: ${said.join(`, `)}`;
};

const alertMail = (config: Config, health: HostedHealth) => ({
    subject: alertSubject(health),
    html: linkEmail({
        heading: health.capacity.full ? `The hosted lane has run out of machines` : `The hosted fleet and the database disagree`,
        body: [
            health.capacity.full ? capacityLine(health.capacity) : ``,
            health.missing.length > 0
                ? `${health.missing.length} sandbox row(s) point at Fly apps that no longer exist: ${health.missing.join(`, `)}.`
                : ``,
            health.strangers.length > 0
                ? `${health.strangers.length} app(s) under this platform's prefix are running machines stamped by a DIFFERENT deployment: ${health.strangers.join(`, `)}. Another deployment is sharing this Fly org and credential, which is how a fleet gets destroyed out from under its rows.`
                : ``,
            ...health.stock
                .filter((entry) => entry.warm < entry.target)
                .map((entry) => `The ${entry.region} warm pool is at ${entry.warm} of ${entry.target}.`),
        ]
            .filter((line) => line !== ``)
            .join(` `),
        action: `Open the admin panel`,
        link: config.webOrigin,
    }),
    link: config.webOrigin,
});

const adminsOf = (config: Config): string[] =>
    config.admin.emails
        .split(`,`)
        .map((email) => email.trim())
        .filter((email) => email !== ``);

let lastAlertAt = 0;

// One pass: read, log, and mail at most every ALERT_EVERY_MS. Errors are the caller's to swallow; a health check that
// takes the process down would be worse than the fault it watches for.
export const sweepHostedHealth = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: () => number = Date.now,
): Promise<HostedHealth | undefined> => {
    if (!hostedEnabled(config)) {
        return undefined;
    }
    const health = await hostedHealth(prisma, config);
    // Litter rides on both branches: it doesn't affect health, and would otherwise be invisible on a healthy day.
    if (health.healthy) {
        logger.info({ stock: health.stock, litter: health.litter, capacity: health.capacity }, `hosted health: fleet and database agree`);
        return health;
    }
    logger.error(
        { capacity: health.capacity, missing: health.missing, strangers: health.strangers, litter: health.litter, stock: health.stock },
        health.capacity.full
            ? `hosted health: the lane is full; nobody can be given a new machine until the provider's allowance is raised`
            : `hosted health: the fleet and the database disagree`,
    );
    const admins = adminsOf(config);
    // Short stock is ordinary weather and isn't mailed; a full fleet is, since no tick fixes it.
    const worthMailing = health.capacity.full || health.missing.length > 0 || health.strangers.length > 0;
    if (admins.length === 0 || !worthMailing || now() - lastAlertAt < ALERT_EVERY_MS) {
        return health;
    }
    lastAlertAt = now();
    await sendMail(config, logger, { to: admins.join(`, `), ...alertMail(config, health) }).catch((error: unknown) =>
        logger.error({ err: error }, `hosted health: alerting failed`),
    );
    return health;
};

// Tests reset this latch; nothing else should touch it.
export const forgetHostedHealthAlert = (): void => {
    lastAlertAt = 0;
};

// Boot wiring (main.ts): every `healthMinutes`, one replica at a time. Read-only; the lock is about not repeating Fly
// calls, not about safety.
export const startHostedHealth = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config) || config.hosted.healthMinutes === 0) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_HEALTH, async () => {
            await sweepHostedHealth(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted health sweep failed`));
        }).catch((error: unknown) => logger.error({ err: error }, `hosted health lock failed`));
    };
    tick();
    setInterval(tick, config.hosted.healthMinutes * 60 * 1000);
};
