import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_HEALTH, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { hostedCapacity } from "./hosted-capacity.js";
import { hostedFleet } from "./hosted-fleet.js";
import { hostedEnabled, type OrphanSkip, sortUnknownApps } from "./hosted.js";
import { HOUR_MS } from "../../durations.js";

// Watches the rows-vs-Fly gap other sweeps act on but never report; read-only, fixes nothing. Five shapes:
// - edge: whether the edge in front of the lane is a build that can actually serve it
// - missing: a row whose Fly app is gone (several at once is another deployment's reaper eating this fleet)
// - strangers: apps under our prefix running another deployment's machine; the only orphan shape that mails anybody
// - litter: our-prefix apps with no row, the reaper's ordinary work; reported, never mailed
// - stock: warm machines against the pool target, per region
// Litter must never be counted as a stranger: that conflation is what made this watch stop being read.

// One alert per window per problem shape; the log line still writes every tick.
const ALERT_EVERY_MS = 6 * HOUR_MS;

// Long enough for a cross-region round trip to the edge's public address, short enough not to hold a sweep.
const EDGE_TIMEOUT_MS = 10_000;

// What the edge says about itself, which nothing else here asks.
export interface EdgeReading {
    // The build it reports; undefined from one older than that field, which is itself the fault below.
    readonly build: string | undefined;
    // Whether it replays hosted sandboxes to their Fly apps; undefined from a build with no replay lane at all.
    readonly replay: boolean | undefined;
    // In the operator's words, already a diagnosis rather than a reading; undefined when the edge is fine.
    readonly fault: string | undefined;
}

/* THE COMPONENT WITH NO ROW, NO MIGRATION AND, UNTIL THIS, NOTHING WATCHING IT. Everything else in this sweep
 * compares the platform's own database against Fly. The edge is in neither: it is a process on Fly holding
 * live connections, and the hosted lane is exactly as reachable as whatever build happens to be running on it.
 *
 * That gap is not hypothetical. CI pushed `ingress:latest` on every platform push and nothing ever rolled the
 * machines (now deploy-ingress.sh), so production served a ten-day-old edge while the sandbox image moved onto
 * `fly-replay`. The old build had no replay in it, so every hosted sandbox answered 502 at its own public name,
 * probed itself for five minutes and told its owner to start it over. Every check this platform had stayed
 * green: the rows were right, the machines were up, the api was healthy, and the one process between a person
 * and their sandbox was never asked anything.
 *
 * Asked over the PUBLIC address on purpose — that is the path a browser takes, and a private probe would have
 * passed for all ten days. */
/* ABSENCE IS THE SIGNAL, and reading it is the whole point. An edge that does not report `replay` is not an
 * edge with the lane switched off — it is a build from before the lane existed, which will never route a
 * hosted sandbox no matter how long anyone waits or how many times they press start it over. Told apart from
 * `replay: false` because the remedies differ: one is a deploy, the other is one missing variable. */
const edgeFault = (where: string, replay: boolean | undefined): string | undefined => {
    if (replay === undefined) {
        return `${where} is an OLD BUILD: it does not report the hosted replay lane, so it predates it and cannot route a hosted sandbox at all. Its machines were never rolled onto the image CI pushed. Every hosted sandbox answers 502 at its own address until they are.`;
    }
    return replay
        ? undefined
        : `${where} is running with no HOSTED_APP_PREFIX, so it refuses every hosted sandbox's hostname instead of replaying it to that sandbox's Fly app. It must match the api's own prefix.`;
};

const edgeReading = async (config: Config): Promise<EdgeReading | undefined> => {
    if (config.ingress.url === ``) {
        return undefined;
    }
    const where = `the edge at ${config.ingress.url}`;
    let body: { replay?: unknown; build?: unknown } | undefined;
    try {
        const response = await fetch(`${config.ingress.url}/health`, { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) });
        if (!response.ok) {
            return { build: undefined, replay: undefined, fault: `${where} answered ${response.status} on its own /health.` };
        }
        body = (await response.json()) as { replay?: unknown; build?: unknown };
    } catch {
        return {
            build: undefined,
            replay: undefined,
            fault: `${where} could not be reached at all, so no sandbox is reachable on any lane — tunnel or hosted.`,
        };
    }
    const build = typeof body?.build === `string` && body.build !== `` ? body.build : undefined;
    const replay = typeof body?.replay === `boolean` ? body.replay : undefined;
    return { build, replay, fault: edgeFault(where, replay) };
};

export interface HostedHealth {
    // The edge in front of the lane; undefined when this platform has no ingress configured to ask.
    readonly edge: EdgeReading | undefined;
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
    const [fleet, capacity, edge] = await Promise.all([hostedFleet(prisma, config), hostedCapacity(prisma, config), edgeReading(config)]);
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
        edge,
        capacity: { used: capacity.used, cap: capacity.cap, full: capacity.full, reason: capacity.reason },
        missing,
        strangers,
        litter,
        stock,
        // An edge that cannot serve the lane outranks every row-level reading: the fleet can be perfect and
        // still reach nobody.
        healthy:
            edge?.fault === undefined &&
            !capacity.full &&
            missing.length === 0 &&
            strangers.length === 0 &&
            stock.every((r) => r.warm >= r.target),
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

// Subject line: a broken edge leads, then a full fleet — both are happening to people right now rather than
// to bookkeeping, and the edge is the one that makes every other reading here beside the point.
const alertSubject = (health: HostedHealth): string => {
    const said = [
        health.edge?.fault === undefined ? `` : `the edge cannot serve hosted sandboxes`,
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
        heading:
            health.edge?.fault !== undefined
                ? `Hosted sandboxes cannot be reached at their addresses`
                : health.capacity.full
                  ? `The hosted lane has run out of machines`
                  : `The hosted fleet and the database disagree`,
        body: [
            // First, and in its own words: it is already a diagnosis, and it makes the rest moot while it stands.
            health.edge?.fault ?? ``,
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

// What the log line leads with, in the same order the mail does: the edge first, because while it stands
// every other reading here is beside the point.
const faultLine = (health: HostedHealth): string => {
    if (health.edge?.fault !== undefined) {
        return `hosted health: ${health.edge.fault}`;
    }
    return health.capacity.full
        ? `hosted health: the lane is full; nobody can be given a new machine until the provider's allowance is raised`
        : `hosted health: the fleet and the database disagree`;
};

// Short stock is ordinary weather and isn't mailed; a full fleet is, since no tick fixes it. An edge that
// cannot serve the lane always is: no tick fixes that either, and while it stands nobody reaches anything.
const worthMailing = (health: HostedHealth): boolean =>
    health.edge?.fault !== undefined || health.capacity.full || health.missing.length > 0 || health.strangers.length > 0;

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
        logger.info(
            { stock: health.stock, litter: health.litter, capacity: health.capacity, edge: health.edge?.build ?? `(not asked)` },
            `hosted health: fleet and database agree, and the edge serves the lane`,
        );
        return health;
    }
    logger.error(
        {
            edge: health.edge,
            capacity: health.capacity,
            missing: health.missing,
            strangers: health.strangers,
            litter: health.litter,
            stock: health.stock,
        },
        faultLine(health),
    );
    const admins = adminsOf(config);
    if (admins.length === 0 || !worthMailing(health) || now() - lastAlertAt < ALERT_EVERY_MS) {
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
