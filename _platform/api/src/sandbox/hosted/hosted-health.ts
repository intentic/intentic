import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_HEALTH, runExclusive } from "../../jobs-lock.js";
import { linkEmail, sendMail } from "../../mail.js";
import { hostedFleet } from "./hosted-fleet.js";
import { hostedEnabled, type OrphanSkip, sortUnknownApps } from "./hosted.js";

/* IS THE HOSTED LANE ACTUALLY WORKING, asked on a timer instead of by a person who happened to look.
 *
 * Everything the platform believes about its machines lives in two places that can disagree: its own rows and
 * Fly. Every sweep in this directory acts on that disagreement (the reaper destroys apps with no row, the idle
 * collector destroys rows that have gone quiet), and NOTHING watched the disagreement itself. So the lane
 * failed the way it did: every production machine was destroyed out from under its row by another deployment
 * sharing the Fly org, the rows survived pointing at machines that no longer existed, and the platform's only
 * report of it was a `warn` line per machine per day, in a container log, saying the meter could not read a
 * state. The first person to notice was a user pressing a button that could not work.
 *
 * This is the watch that was missing, and it is deliberately dumber than the sweeps it guards: it destroys
 * nothing, fixes nothing, and only ever says what it sees.
 *
 *   • MISSING, a row whose Fly app is gone. One is a provider hiccup or a hand-deleted machine; several at
 *     once is somebody else's reaper eating this platform's fleet, which is the outage, and the number is what
 *     tells them apart.
 *   • STRANGERS, apps a machine of ANOTHER deployment's is running under our prefix. Nonzero means a second
 *     deployment is sharing this org and credential, which is the CAUSE rather than the symptom, and it shows
 *     up here BEFORE anyone's machine is lost.
 *   • LITTER, our-prefix apps with no row that are simply waiting for the daily reaper, plus the few it cannot
 *     prove are ours. Reported, never mailed, and never counted against `healthy`.
 *   • STOCK, warm machines against the pool target, per region. A pool that never fills is a cold first boot
 *     for everybody who signs up, which nothing else on the platform would ever say out loud.
 *
 * STRANGERS AND LITTER USED TO BE ONE NUMBER, and that is what made this watch stop working. Every app with no
 * row counted as a stranger, so an ordinary failed provision mailed the admins "another deployment is probably
 * sharing this Fly org" — a sentence that was not true, about a fault nobody could act on — and an app the
 * reaper could not prove was ours did it every six hours forever. An alarm that cries for something no action
 * clears is an alarm people learn to close, which is the one thing this file cannot afford: it is the only
 * warning before the outage it was built for. So the question "whose app is this" is now put to the provider,
 * by the same code the reaper judges with (hosted.ts's sortUnknownApps), and only a foreign STAMP mails
 * anybody. It costs one small read per orphan app, which is normally none at all. */

// One alert per this window per problem shape, so a standing fault is a daily reminder rather than a mailbox
// full of the same sentence. The log line is written every tick regardless: the mail is for a human, the log
// is for the record.
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

export interface HostedHealth {
    // Rows whose app Fly no longer has: the shape that leaves people pressing "start it over".
    readonly missing: string[];
    // Apps running a machine that names ANOTHER deployment. The cause signal, and the only orphan shape that
    // mails anybody.
    readonly strangers: string[];
    // Our-prefix apps with no row: the reaper's ordinary work, plus the few it cannot prove are ours. Said out
    // loud, never mailed, never counted against `healthy`.
    readonly litter: string[];
    // Warm stock per region against the configured target.
    readonly stock: { region: string; warm: number; target: number }[];
    readonly healthy: boolean;
}

export const hostedHealth = async (prisma: PrismaClient, config: Config): Promise<HostedHealth> => {
    const fleet = await hostedFleet(prisma, config);
    const missing = fleet.filter((entry) => entry.missing).map((entry) => entry.appName);
    // `orphan` is the fleet's word for an app with no row behind it, which says nothing yet about WHOSE it is.
    // The reaper's own classifier answers that from the provider; skipped entirely when there is nothing to
    // ask about, which is the normal case and keeps this watch free.
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
        missing,
        strangers,
        litter,
        stock,
        healthy: missing.length === 0 && strangers.length === 0 && stock.every((r) => r.warm >= r.target),
    };
};

const alertMail = (config: Config, health: HostedHealth) => ({
    subject: `intentic hosted: ${health.missing.length} machine(s) gone, ${health.strangers.length} app(s) another deployment is running`,
    html: linkEmail({
        heading: `The hosted fleet and the database disagree`,
        body: [
            health.missing.length > 0 ? `${health.missing.length} sandbox row(s) point at Fly apps that no longer exist: ${health.missing.join(`, `)}.` : ``,
            health.strangers.length > 0
                ? `${health.strangers.length} app(s) under this platform's prefix are running machines stamped by a DIFFERENT deployment: ${health.strangers.join(`, `)}. Another deployment is sharing this Fly org and credential, which is how a fleet gets destroyed out from under its rows.`
                : ``,
            ...health.stock.filter((entry) => entry.warm < entry.target).map((entry) => `The ${entry.region} warm pool is at ${entry.warm} of ${entry.target}.`),
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

/* One pass: read, say, and (at most every ALERT_EVERY_MS) mail. Errors are the caller's to swallow, a health
 * check that takes the process down with it would be worse than the fault it watches for. */
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
    // Litter rides on BOTH lines, because it does not make the lane unhealthy and would otherwise be invisible
    // on exactly the days there is nothing else to say: the apps the reaper cannot prove are ours are a small
    // manual job, and a log nobody can grep is the same as not knowing.
    if (health.healthy) {
        logger.info({ stock: health.stock, litter: health.litter }, `hosted health: fleet and database agree`);
        return health;
    }
    logger.error(
        { missing: health.missing, strangers: health.strangers, litter: health.litter, stock: health.stock },
        `hosted health: the fleet and the database disagree`,
    );
    const admins = adminsOf(config);
    // The pool being short is ordinary weather (a claim just emptied a slot, a build is in flight), so it is
    // logged but never mailed; a machine that has vanished under its row never is.
    const worthMailing = health.missing.length > 0 || health.strangers.length > 0;
    if (admins.length === 0 || !worthMailing || now() - lastAlertAt < ALERT_EVERY_MS) {
        return health;
    }
    lastAlertAt = now();
    await sendMail(config, logger, { to: admins.join(`, `), ...alertMail(config, health) }).catch((error: unknown) =>
        logger.error({ err: error }, `hosted health: alerting failed`),
    );
    return health;
};

// Tests reset the latch; nothing else has any business touching it.
export const forgetHostedHealthAlert = (): void => {
    lastAlertAt = 0;
};

/* Boot wiring (main.ts): every `healthMinutes`, one replica at a time. Reads only, so the lock is about not
 * paying for the same Fly calls on every replica rather than about safety. */
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
