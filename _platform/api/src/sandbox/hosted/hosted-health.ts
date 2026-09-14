import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_HEALTH, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { hostedCapacity, type HostedRefusal } from "./hosted-capacity.js";
import { hostedFleet } from "./hosted-fleet.js";
import { hostedEnabled, type OrphanSkip, sortUnknownApps } from "./hosted.js";
import { HOUR_MS } from "../../durations.js";

// Watches the rows-vs-Fly gap other sweeps act on but never report; read-only, fixes nothing. Six shapes:
// - edge: whether the edge in front of the lane is a build that can actually serve it
// - lane: whether the sandboxes that booted could be reached at their own addresses
// - missing: a row whose Fly app is gone (several at once is another deployment's reaper eating this fleet)
// - strangers: apps under our prefix running another deployment's machine; the only orphan shape that mails anybody
// - litter: our-prefix apps with no row, the reaper's ordinary work; reported, never mailed
// - stock: warm machines against the pool target, per region
// Litter must never be counted as a stranger: that conflation is what made this watch stop being read.

// One alert per window per problem shape; the log line still writes every tick.
const ALERT_EVERY_MS = 6 * HOUR_MS;

// How far back check-ins are read for the lane verdict below.
const LANE_WINDOW_MS = 24 * HOUR_MS;
// Below this many failing sandboxes the window says nothing about the lane: one box can be broken on its own.
const LANE_MIN_SAMPLE = 2;

// Long enough for a cross-region round trip to the edge's public address, short enough not to hold a sweep.
const EDGE_TIMEOUT_MS = 10_000;

// What the edge says about itself, which nothing else here asks.
export interface EdgeReading {
    // The build it names; undefined both from an edge too old to carry the field and from an unreleased image,
    // which `stamped` tells apart.
    readonly build: string | undefined;
    // Whether the answer carried a `build` key AT ALL. False is an edge older than the stamp itself.
    readonly stamped: boolean;
    // Whether it replays hosted sandboxes to their Fly apps; undefined from a build with no replay lane at all.
    readonly replay: boolean | undefined;
    // In the operator's words, already a diagnosis rather than a reading; undefined when the edge is fine.
    readonly fault: string | undefined;
}

/* THE COMPONENT WITH NO ROW, NO MIGRATION AND, UNTIL THIS, NOTHING WATCHING IT. */
/* ABSENCE IS THE SIGNAL, and reading it is the whole point. */
/* AND THE SAME ABSENCE ONE FIELD OVER, which is the one this check kept missing. */
const edgeFault = (where: string, replay: boolean | undefined, stamped: boolean): string | undefined => {
    if (replay === undefined) {
        return `${where} is an OLD BUILD: it does not report the hosted replay lane, so it predates it and cannot route a hosted sandbox at all. Its machines were never rolled onto the image CI pushed. Every hosted sandbox answers 502 at its own address until they are.`;
    }
    if (!stamped) {
        return `${where} answers with no build stamp at all, so it is running an image from before the stamp existed: nothing has rolled its machines onto what CI has pushed since. It still replays, so sandboxes are reachable today and nobody is stuck right now — but no edge change has reached production either, and the next one that matters will not land on its own. Rolling it is deploy-ingress.sh's job, which skips silently whenever FLY_API_TOKEN is empty on the branch that deploys.`;
    }
    return replay
        ? undefined
        : `${where} is running with no HOSTED_APP_PREFIX, so it refuses every hosted sandbox's hostname instead of replaying it to that sandbox's Fly app. It must match the api's own prefix.`;
};

// Carrying the key is the age test; its VALUE is empty on an image nobody released, which is a legitimate
// self-built edge and not a fault. Collapsing the two is what hid a stale edge behind a healthy reading.
const buildStamp = (raw: unknown): { stamped: boolean; build: string | undefined } =>
    typeof raw === `string` ? { stamped: true, build: raw === `` ? undefined : raw } : { stamped: false, build: undefined };

const edgeReading = async (config: Config): Promise<EdgeReading | undefined> => {
    if (config.ingress.url === ``) {
        return undefined;
    }
    const where = `the edge at ${config.ingress.url}`;
    let body: { replay?: unknown; build?: unknown } | undefined;
    try {
        const response = await fetch(`${config.ingress.url}/health`, { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) });
        if (!response.ok) {
            return { build: undefined, stamped: false, replay: undefined, fault: `${where} answered ${response.status} on its own /health.` };
        }
        body = (await response.json()) as { replay?: unknown; build?: unknown };
    } catch {
        return {
            build: undefined,
            stamped: false,
            replay: undefined,
            fault: `${where} could not be reached at all, so no sandbox is reachable on any lane — tunnel or hosted.`,
        };
    }
    const { stamped, build } = buildStamp(body?.build);
    const replay = typeof body?.replay === `boolean` ? body.replay : undefined;
    return { build, stamped, replay, fault: edgeFault(where, replay, stamped) };
};

/* Lane health reads reachability reported by sandboxes, not platform configuration alone. */
export interface LaneReading {
    // Hosted sandboxes that checked in within the window and last said their address answered with their own id.
    readonly reachable: number;
    // ... and said it did not.
    readonly unreachable: number;
    // In the operator's words; undefined while any sandbox at all is getting through.
    readonly fault: string | undefined;
}

// Several sandboxes failing with none succeeding is the lane; a mix is per-sandbox trouble the admin panel lists.
const laneFault = (reachable: number, unreachable: number): string | undefined =>
    reachable > 0 || unreachable < LANE_MIN_SAMPLE
        ? undefined
        : `${unreachable} hosted sandboxes checked in over the last day and EVERY ONE of them reported that its own public address answers something other than itself, while none reported getting through. The machines are fine and their daemons are running: what is between a browser and them is not delivering. Each sandbox app sits on its own Fly private network, so the first thing to check is that the org still allows cross-network replays (\`fly orgs cross-network-replays status\`), then that the edge's HOSTED_APP_PREFIX still names these apps.`;

const laneReading = async (prisma: PrismaClient, now: () => number): Promise<LaneReading> => {
    const since = new Date(now() - LANE_WINDOW_MS);
    // Hosted rows only: a sandbox on somebody's own machine is reached down a tunnel and says nothing about this lane.
    const checkedIn = (reach: string) => ({ hosted: { isNot: null }, lastSeenAt: { gt: since }, bootReport: { path: [`reach`], equals: reach } });
    const [reachable, unreachable] = await Promise.all([
        prisma.sandbox.count({ where: checkedIn(`reachable`) }),
        prisma.sandbox.count({ where: checkedIn(`unreachable`) }),
    ]);
    return { reachable, unreachable, fault: laneFault(reachable, unreachable) };
};

export interface HostedHealth {
    // The edge in front of the lane; undefined when this platform has no ingress configured to ask.
    readonly edge: EdgeReading | undefined;
    // What the daemons that booted said about being reachable at their own addresses.
    readonly lane: LaneReading;
    // The fleet is at its provider ceiling with no warm stock left; the only fault where rows and Fly fully agree.
    readonly capacity: {
        // Undefined when nothing needed counting: no ceiling configured and no refusal to explain.
        readonly used: number | undefined;
        readonly cap: number;
        readonly full: boolean;
        readonly reason: "cap" | "provider" | undefined;
        // Which regions the provider is refusing, in its own words; empty when the ceiling is this platform's own.
        readonly refusals: readonly HostedRefusal[];
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

// The regions this platform places machines in; one knob names both, and a single-region setup dedupes to one.
const configuredRegions = (config: Config): string[] => [...new Set([config.hosted.region, config.hosted.regionEu].filter((region) => region !== ``))];

export const hostedHealth = async (prisma: PrismaClient, config: Config, now: () => number = Date.now): Promise<HostedHealth> => {
    const [fleet, capacity, edge, lane] = await Promise.all([
        hostedFleet(prisma, config),
        hostedCapacity(prisma, config),
        edgeReading(config),
        laneReading(prisma, now),
    ]);
    const missing = fleet.filter((entry) => entry.missing).map((entry) => entry.appName);
    // `orphan` says an app has no row, not whose; the reaper's classifier answers that, skipped when nothing to ask.
    const orphans = fleet.filter((entry) => entry.role === `orphan`).map((entry) => entry.appName);
    const sorted: { doomed: string[]; skipped: { app: string; why: OrphanSkip }[] } =
        orphans.length === 0 ? { doomed: [], skipped: [] } : await sortUnknownApps(config, orphans);
    const strangers = sorted.skipped.filter((entry) => entry.why === `theirs`).map((entry) => entry.app);
    const litter = [...sorted.doomed, ...sorted.skipped.filter((entry) => entry.why !== `theirs`).map((entry) => entry.app)];
    const stock = configuredRegions(config).map((region) => ({
        region,
        warm: fleet.filter((entry) => entry.role === `warm` && !entry.missing && entry.region === region).length,
        target: config.hosted.poolSize,
    }));
    return {
        edge,
        lane,
        capacity: { used: capacity.used, cap: capacity.cap, full: capacity.full, reason: capacity.reason, refusals: capacity.refusals },
        missing,
        strangers,
        litter,
        stock,
        // An edge that cannot serve the lane, or a lane no sandbox got through, outranks every row-level
        // reading: the fleet can be perfect and still reach nobody.
        healthy:
            edge?.fault === undefined &&
            lane.fault === undefined &&
            !capacity.full &&
            missing.length === 0 &&
            strangers.length === 0 &&
            stock.every((r) => r.warm >= r.target),
    };
};

const andList = (parts: readonly string[]): string =>
    parts.length <= 1 ? (parts[0] ?? ``) : `${parts.slice(0, -1).join(`, `)} and ${parts.at(-1) ?? ``}`;

/* THE TWO THINGS THIS ALERT USED TO WITHHOLD, both of which decide what the reader does next.
 *
 * WHICH REGION. The refusal is latched per region and both user-facing paths scope it to the caller's own
 * (hosted.ts's provision, the hosted offer), so a region out of hardware refuses EEA sign-ups while everyone
 * else is served normally. Saying "nobody can be given a new sandbox" of that sends the reader to look for an
 * outage that is not happening.
 *
 * AND WHAT FLY SAID. The alert offered "its allowance for this org, or a region's hardware" and left the
 * reader to guess, which are opposite fixes: one is a quota raised with Fly, the other is placing machines
 * somewhere else. The count cannot tell them apart — a fleet that held ten machines at the refusal held twelve
 * an hour later, so it was never an org ceiling — and the log line that carried the wording lives in a
 * container that restarts. Quoted here, the mail is the diagnosis rather than the start of one. */
const capacityLine = (capacity: HostedHealth[`capacity`], regions: readonly string[]): string => {
    const held = `${capacity.used ?? `all`}${capacity.cap === 0 ? `` : ` of ${capacity.cap}`} machines`;
    const nobody = `no sign-up anywhere can be given a machine; they are being told plainly that we are out of machines and pointed at running one on their own computer`;
    if (capacity.reason === `cap`) {
        return `This platform is at the ceiling it was configured with (${held}), and there is no warm stock left either, so ${nobody}. Raise HOSTED_MAX_MACHINES, and the provider's own allowance with it, and the lane opens again by itself.`;
    }
    const refusing = capacity.refusals.map((refusal) => refusal.region);
    const quoted = capacity.refusals.map((refusal) => `${refusal.region} — "${refusal.detail}"`).join(`; `);
    const who =
        refusing.length > 0 && refusing.length < regions.length
            ? `Only sign-ups placed in ${andList(refusing)} are refused; the other regions are serving normally`
            : `There is no warm stock left either, so ${nobody}`;
    return `Fly refused to create a machine for capacity in the last few minutes, with ${held} in the fleet. What it actually said: ${quoted}. That wording is the diagnosis — an allowance for this org is raised with Fly, while a region out of hardware is placed somewhere else instead, and the size of the fleet says nothing about which of the two this is. ${who}.`;
};

// Subject line: a broken edge leads, then a full fleet — both are happening to people right now rather than
// to bookkeeping, and the edge is the one that makes every other reading here beside the point.
const alertSubject = (health: HostedHealth): string => {
    const said = [
        health.edge?.fault === undefined ? `` : `the edge cannot serve hosted sandboxes`,
        health.lane.fault === undefined ? `` : `no sandbox can be reached at its address`,
        health.capacity.full
            ? `the fleet is full (${health.capacity.used ?? `all`}${health.capacity.cap === 0 ? `` : ` of ${health.capacity.cap}`} machines)`
            : ``,
        health.missing.length > 0 ? `${health.missing.length} machine(s) gone` : ``,
        health.strangers.length > 0 ? `${health.strangers.length} app(s) another deployment is running` : ``,
    ].filter((part) => part !== ``);
    return `intentic hosted: ${said.join(`, `)}`;
};

// Reachability leads whichever reading established it: to the reader both mean their sandbox does not answer.
const alertHeading = (health: HostedHealth): string => {
    if (health.edge?.fault !== undefined || health.lane.fault !== undefined) {
        return `Hosted sandboxes cannot be reached at their addresses`;
    }
    if (!health.capacity.full) {
        return `The hosted fleet and the database disagree`;
    }
    // Naming the region in the heading, since a reader who is not in it should not be reading an outage.
    const refusing = health.capacity.refusals.map((refusal) => refusal.region);
    return refusing.length === 0 ? `The hosted lane has run out of machines` : `The hosted lane has run out of machines in ${andList(refusing)}`;
};

const alertMail = (config: Config, health: HostedHealth) => ({
    subject: alertSubject(health),
    html: linkEmail({
        heading: alertHeading(health),
        body: [
            // First, and in its own words: it is already a diagnosis, and it makes the rest moot while it stands.
            health.edge?.fault ?? ``,
            // Second: the sandboxes' own verdict, which stands whether or not the edge could explain it.
            health.lane.fault ?? ``,
            health.capacity.full ? capacityLine(health.capacity, configuredRegions(config)) : ``,
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
    if (health.lane.fault !== undefined) {
        return `hosted health: ${health.lane.fault}`;
    }
    if (!health.capacity.full) {
        return `hosted health: the fleet and the database disagree`;
    }
    // The structured `capacity` field beside this carries the refusals verbatim; the message names where, not why.
    const refusing = health.capacity.refusals.map((refusal) => refusal.region);
    return refusing.length === 0
        ? `hosted health: the lane is full; nobody can be given a new machine`
        : `hosted health: the provider is refusing machines in ${andList(refusing)}; nobody placed there can be given one`;
};

// What the healthy line says about the edge; an unstamped one never reaches it, since that is now a fault.
// `(not asked)` used to stand for that case too, so the one reading that meant something — a deploy that never
// landed — read on every tick as a check nobody had run.
const edgeLine = (edge: EdgeReading | undefined): string => edge?.build ?? (edge === undefined ? `(not asked)` : `(unreleased build)`);

// Short stock is ordinary weather and isn't mailed; a full fleet is, since no tick fixes it. An edge that
// cannot serve the lane always is: no tick fixes that either, and while it stands nobody reaches anything.
const worthMailing = (health: HostedHealth): boolean =>
    health.edge?.fault !== undefined ||
    health.lane.fault !== undefined ||
    health.capacity.full ||
    health.missing.length > 0 ||
    health.strangers.length > 0;

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
    const health = await hostedHealth(prisma, config, now);
    // Litter rides on both branches: it doesn't affect health, and would otherwise be invisible on a healthy day.
    if (health.healthy) {
        logger.info(
            {
                stock: health.stock,
                litter: health.litter,
                capacity: health.capacity,
                edge: edgeLine(health.edge),
                lane: health.lane,
            },
            `hosted health: fleet and database agree, and the edge serves the lane`,
        );
        return health;
    }
    logger.error(
        {
            edge: health.edge,
            lane: health.lane,
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
