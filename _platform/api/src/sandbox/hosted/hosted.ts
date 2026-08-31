import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";
import { ENV_INGRESS_URL, ENV_SANDBOX_GRANT } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { ingressEnabled, type Reachability } from "../reachability.js";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import {
    createApp,
    createMachine,
    createVolume,
    deleteApp,
    FLY_META_PLATFORM,
    flySandboxRole,
    getMachine,
    isFlyGone,
    listAppNames,
    listMachines,
    listVolumes,
    startMachine,
    updateMachine,
} from "./fly.js";

/* The hosted lane's orchestration, what the routes call, over the fly.ts client. One machine + one volume in
 * one app per sandbox; the app name is derived from the sandbox's 12-hex tunnel id, so the Fly console, the
 * sandbox-<id> hostname the user sees, and the reaper's prefix match all tell the same story.
 *
 * Reachability is the machine's own business: the env carries its signed grant and the address it dials, the
 * daemon opens the tunnel outbound, and the daemon's announce is the only "it's up" signal — the platform
 * never probes or dials a machine, it only flips power. That is the hosted trust trade in one line: power and
 * existence are the platform's, the command path stays browser → daemon. A hosted machine needs no Fly
 * services or IPs for any of it, because nothing ever connects TO it. */

// The lane needs BOTH its own switch and a reachability fabric: a hosted machine is reachable only through the
// grant the platform signs, so Fly credentials without a configured ingress would build machines that boot to
// nothing.
export const hostedEnabled = (config: Config): boolean =>
    config.hosted.flyApiToken !== `` && config.hosted.flyOrg !== `` && ingressEnabled(config);

/* WHICH PLATFORM THIS IS, as the twelve hex characters every machine it creates carries in its Fly metadata
 * (fly.ts), and the thing the orphan sweep checks before it destroys anything.
 *
 * Derived from the API's public URL AND its database, because the copied env file is not a hypothetical here:
 * it is how a laptop came to hold production's Fly token in the first place, and a copy carries API_URL with
 * it. Two deployments that share an address AND a database are the same deployment (two replicas, a redeploy),
 * and everything else is somebody else:
 *   • a laptop with a verbatim copy of production's env still points at its own Postgres, because it cannot
 *     reach production's, so its id differs, which is the case that mattered.
 *   • a staging box restored from a production dump shares the database's NAME but answers on its own URL.
 *   • replicas and redeploys of one deployment share both, and must keep one identity across restarts.
 * Host and database name only, never the credential: this is a label the provider stores in plaintext.
 *
 * `HOSTED_INSTANCE_ID` overrides the derivation, for the two cases where identity has to outlive its inputs:
 * moving the database, and deliberately handing one fleet from one deployment to another. */
const instanceFingerprint = (config: Config): string => {
    const raw = config.database?.url ?? ``;
    try {
        const dsn = new URL(raw);
        return `${config.api.url}|${dsn.host}${dsn.pathname}`;
    } catch {
        // Not a URL we can parse (an empty config in a test, a DSN shape we do not model): the address alone
        // still separates deployments, and a fingerprint that threw would take the whole lane down with it.
        return `${config.api.url}|`;
    }
};

export const hostedInstanceId = (config: Config): string => {
    // `?? ` rather than a bare equality: an id that came back undefined would compare unequal to every stamp
    // ever written, which reads as "none of these machines are mine" — the one wrong answer this must never
    // give quietly.
    const override = config.hosted.instanceId ?? ``;
    return override === `` ? createHash(`sha256`).update(instanceFingerprint(config)).digest(`hex`).slice(0, 12) : override;
};

const hostedAppName = (config: Config, sandboxId: string, connectToken: string): string =>
    `${config.hosted.appPrefix}-${sandboxIdFromToken(connectToken) ?? sandboxId}`;

/* THIS SANDBOX ALREADY HAS A MACHINE, because a second provision for it committed first. Not a failure to
 * show anybody: the reader asked for a machine and there is one, so the route answers with it.
 *
 * It exists because the alternative was measured and expensive. `hostedProvision` reads "does this sandbox
 * have a machine" and then provisions, with no lock between the two, so two calls for one sandbox (a second
 * tab, a retried request, the desktop app open beside the browser) both pass the check. `sandboxId` is unique
 * on HostedMachine, so the loser's row-write is refused — and the claim loop below read that refusal as "this
 * warm machine is bad, try the next one", so it branded, started and stranded EVERY ready machine in the
 * caller's region, one candidate at a time, for a sandbox that already had its own. The region's stock was
 * gone for the next arrival, several machines were running the same connect token until the pool's reconcile
 * collected them, and the reader who lost the race was shown a gateway error while their machine booted. */
export class HostedAlreadyProvisioned extends Error {}

/* Did this sandbox get its machine from somewhere else while this call was building one?
 *
 * Asked of the DATABASE rather than read off the unique violation's `target`, which Prisma spells differently
 * per database: HostedMachine has TWO unique columns and they mean opposite things here. `sandboxId` is
 * another provision winning the race, which is terminal and answers with the winner's machine; `appName` is a
 * pool app that some other row already adopted, which is one bad candidate and nothing more. Only the first
 * may stop the claim loop, so the question is put to the column that decides it. */
const alreadyProvisioned = async (prisma: PrismaClient, sandboxId: string, error: unknown): Promise<boolean> =>
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === `P2002` &&
    (await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { id: true } })) !== null;

export interface HostedProvisionArgs {
    readonly sandboxId: string;
    // Decrypted by the route (the row stores them encrypted), this module never touches crypto.
    readonly connectToken: string;
    // The sandbox's reachability, signed by the route (reachability.ts): the grant the box presents when it
    // dials, its derived address, and the ingress it dials.
    readonly grant: Reachability;
    readonly ownerEmail: string;
    // Decided by the route from the caller's country (region.ts), because only the request knows it, a
    // European user's machine and volume are both created here, which is what makes the residency promise
    // in the privacy policy true rather than aspirational.
    readonly region: string;
}

/* THE machine config a sandbox runs under, wherever the machine came from. Cold provision creates a machine
 * with it; the warm pool's claim REPLACES a pool machine's config with it, which is both how the sandbox's
 * identity gets in and how the pool's no-op boot override gets erased (updates replace the whole config).
 * One composer, so the two origins cannot drift: a machine claimed from the pool is byte-for-byte the machine
 * that would have been built to order. OWNER_EMAIL is in the env before the daemon ever runs, so the
 * first-bind trust story (only this Google identity may claim ownership) is origin-independent too.
 *
 * The metadata stamp rides on that same "one composer" property: whatever the machine was a second ago, a
 * machine holding this config is somebody's sandbox and says so to Fly, which is the only way to read a
 * pool-born app's true state, since its name will say `pool` forever (fly.ts). The sandbox ID and not the
 * owner's address: metadata is casually visible provider-side, and the ID joins to the platform's own rows. */
const hostedMachineConfig = (config: Config, args: HostedProvisionArgs, machineName: string, volumeId: string) => ({
    ...flyMachineConfig({
        name: machineName,
        image: config.hosted.image,
        baseImage: config.hosted.image,
        guest: { cpus: config.hosted.cpus, memoryMb: config.hosted.memoryMb },
        volumeId,
        env: [
            [`GOOGLE_CLIENT_ID`, config.google.clientId],
            [`CONNECT_TOKEN`, args.connectToken],
            [`OWNER_EMAIL`, args.ownerEmail],
            [`WEB_ORIGIN`, config.webOrigin],
            [`SANDBOX_PUBLIC_URL`, `https://${args.grant.hostname}`],
            [`PLATFORM_URL`, config.api.url],
            // The reachability pair, spelled from the contract every other lane spells it from (the connect
            // one-liner's claim payload, the compose file): the daemon reads exactly these two names.
            [ENV_SANDBOX_GRANT, args.grant.grant],
            [ENV_INGRESS_URL, args.grant.ingressUrl],
            [`IDLE_STOP_MINUTES`, String(config.hosted.idleStopMinutes)],
        ],
    }),
    metadata: flySandboxRole(args.sandboxId, hostedInstanceId(config)),
});

/* Power on a (probably) stopped machine, and the one place "it is coming up" is decided. Idempotent by reading
 * the state on refusal: Fly answers an error for a machine that is already started/starting, and for one it is
 * mid-`replacing` (the state an update passes through), and every one of those answers IS success here — the
 * browser's daemon probe is what decides when the sandbox is actually back. Only a refusal over a machine Fly
 * still reports as stopped/failed is a real refusal. */
const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);
export const wakeHosted = async (config: Config, hosted: { appName: string; machineId: string }): Promise<void> => {
    try {
        await startMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId);
    } catch (error) {
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch(() => undefined);
        if (machine !== undefined && LIVE_STATES.has(machine.state)) {
            return;
        }
        throw error;
    }
};

/* Claim a warm machine for this sandbox, or answer undefined and let the cold path build one. The pool row
 * is won by a guarded update (`ready` → `claimed`), so two simultaneous claims can never brand the same
 * machine; the winner writes the sandbox's real config into it (identity in, no-op boot override out, one
 * `hostedMachineConfig`, so pool-born and built-to-order machines cannot drift), which is also what starts it
 * (the update carries the launch, see fly.ts: a separate start loses a race against Fly's own `replacing`
 * state and refused every claim this pool ever made), and commits the hand-off in one transaction: the
 * HostedMachine row appears and the pool row disappears together, so no crash leaves a machine that is both
 * claimable and somebody's. The start below is the same idempotent confirmation a wake uses: it turns "Fly
 * launched it" into "Fly says it is live", and a machine that is genuinely not coming up still fails here and
 * moves the claim to the next candidate.
 *
 * Region is a hard filter, not a preference: an EEA caller may only ever claim an EEA machine, or the privacy
 * policy's residency promise breaks. `wokeAt` opens the hour meter here, at claim, the pool's own no-op boot
 * was the platform's cost, not this user's.
 *
 * Every failure is caught and answered by trying the NEXT candidate, and only a pool with nothing left in it
 * is answered as a miss: the pool is an accelerator, and a reader who pressed the button is owed a machine,
 * not an explanation of why the fast path stumbled. Giving up on the whole pool at the first stumble is what
 * made one machine Fly had destroyed under its row cost a reader the full cold build while a perfectly warm
 * second machine sat unclaimed beside it, in their own region, for the entire wait. The candidate list is
 * this region's stock (a handful), so the worst case is a handful of cheap refusals before the cold path.
 *
 * A row won and then stranded (update or start failed) stays `claimed` with its app intact for the reconcile
 * job to collect, it must not go back to `ready`, because a half-branded machine already carries this
 * sandbox's tokens. */
const claimPoolMachine = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<{ appName: string; region: string } | undefined> => {
    const candidates = await prisma.hostedPoolMachine.findMany({
        where: { region: args.region, state: `ready`, image: config.hosted.image },
        orderBy: { createdAt: `asc` },
    });
    for (const row of candidates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each iteration races other claimers for one row; parallelism is the bug
        const won = await prisma.hostedPoolMachine.updateMany({ where: { id: row.id, state: `ready` }, data: { state: `claimed` } });
        if (won.count === 0) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await updateMachine(config.hosted.flyApiToken, row.appName, row.machineId, hostedMachineConfig(config, args, row.appName, row.volumeId));
            // oxlint-disable-next-line eslint/no-await-in-loop
            await wakeHosted(config, row);
            // oxlint-disable-next-line eslint/no-await-in-loop
            await prisma.$transaction([
                prisma.hostedMachine.create({
                    data: {
                        sandboxId: args.sandboxId,
                        appName: row.appName,
                        machineId: row.machineId,
                        volumeId: row.volumeId,
                        region: row.region,
                        wokeAt: new Date(),
                    },
                }),
                prisma.hostedPoolMachine.delete({ where: { id: row.id } }),
            ]);
            return { appName: row.appName, region: row.region };
        } catch (error) {
            /* THE ONE FAILURE THAT MUST NOT MOVE TO THE NEXT CANDIDATE: this sandbox already has a machine, so
             * every further candidate would be branded and stranded for nothing (see HostedAlreadyProvisioned).
             * The machine this iteration branded holds no row, so the reconcile collects it, and the pool row it
             * won stays `claimed` for the same pass — one machine spent on the race, never the region's stock. */
            // oxlint-disable-next-line eslint/no-await-in-loop -- the loop is sequential by design; see above
            if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
                logger.warn(
                    { app: row.appName, sandboxId: args.sandboxId },
                    `hosted pool: this sandbox was provisioned concurrently; abandoning the claim rather than branding more stock`,
                );
                throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
            }
            logger.warn({ err: error, app: row.appName }, `hosted pool: claim failed; trying the next warm machine`);
        }
    }
    return undefined;
};

/* Create the machine, from the warm pool when one is waiting (seconds: the image is already on its host),
 * built to order otherwise (minutes: app → volume → machine, image pulled on first boot). Either way the row
 * is stamped last and the env is the same contract vocabulary every connect flow sets, composed here rather
 * than claimed by a script, because there is no script: the machine's first boot IS the sandbox, and the
 * daemon's announce narrates it exactly like a pasted run's.
 *
 * A cold-path failure after the app exists deletes the app again (best-effort) so a retry starts clean, and
 * anything this cleanup misses is an app with no HostedMachine row, which is precisely what the reaper
 * deletes. A pool claim that fails falls through to the cold path: the reader asked for a machine, not for a
 * pool hit. */
export const provisionHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<{ appName: string; region: string }> => {
    const { flyApiToken, flyOrg, volumeGb } = config.hosted;
    const { region } = args;
    const claimed = await claimPoolMachine(prisma, config, logger, args);
    if (claimed !== undefined) {
        return claimed;
    }
    const appName = hostedAppName(config, args.sandboxId, args.connectToken);
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        const { machineId } = await createMachine(flyApiToken, appName, {
            name: appName,
            region,
            config: hostedMachineConfig(config, args, appName, volumeId),
        });
        // `wokeAt` opens the hour meter's first stretch: a machine is RUNNING from the moment it is created,
        // so the free lane's clock starts here rather than at the first wake, which is the only version that
        // does not hand out an uncounted first session to everyone who ever provisions one.
        await prisma.hostedMachine.create({ data: { sandboxId: args.sandboxId, appName, machineId, volumeId, region, wokeAt: new Date() } });
        return { appName, region };
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, appName }, `hosted: cleanup after failed provision failed; orphaned for the reaper`),
        );
        /* The claim loop's race, one step later: the row-write lost to a concurrent provision for this sandbox.
         * The app this call built is unambiguously its own (a cold path that collided on the name would have
         * failed at `createApp`, before this block) and has just been taken back down, so the winner's machine
         * is the answer and there is nothing to report as a failure. */
        if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
            throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
        }
        throw error;
    }
};

/* An explicit "start it over" is also the hosted lane's repair/update boundary. A plain stop/start keeps the
 * rootfs Fly resolved when the Machine was first created, so a corrected image behind the configured tag can
 * never repair a boot-crashing machine: every click simply runs the same broken bytes again. Replace the full
 * config while the machine is stopped, preserving its volume id and identity, then take the ordinary wake
 * path, which the replacement has already started: still exactly one metered transition, with the wake as its
 * confirmation. */
export const refreshHosted = async (
    config: Config,
    args: HostedProvisionArgs,
    hosted: { appName: string; machineId: string; volumeId: string },
): Promise<void> => {
    await updateMachine(
        config.hosted.flyApiToken,
        hosted.appName,
        hosted.machineId,
        hostedMachineConfig(config, args, hosted.appName, hosted.volumeId),
    );
    await wakeHosted(config, hosted);
};

// Tear the whole app down (machines + volume ride with it). 404-tolerant by fly.ts's contract.
export const destroyHosted = async (config: Config, appName: string): Promise<void> => deleteApp(config.hosted.flyApiToken, appName);

/* HOW LONG AN APP IS TOO YOUNG TO JUDGE. A cold provision is app → volume → machine → row, so between the
 * first call and the last there are minutes in which a perfectly healthy signup owns Fly resources that no row
 * vouches for yet. Anything inside this window is somebody arriving, never a leftover. */
const REAP_GRACE_MS = 30 * 60 * 1000;

/* THE MOST THIS SWEEP MAY DESTROY IN ONE PASS, in apps and as a share of our-prefix stock. A reaper's whole
 * input is "the database did not mention it", so every way the database can be wrong (a replica pointed at
 * the wrong DSN, a restore in progress, a migration that has not run) reads as "destroy everything", and the
 * sweep is at its most confident exactly when it is most wrong. A sweep that wants more than this stops and
 * says so instead: an operator reading one loud line beats a fleet nobody can get back. */
const REAP_MAX_APPS = 3;
const REAP_MAX_SHARE = 0.25;

/* WHOSE APP THIS IS, answered from the provider rather than inferred from a name. Three answers, and the two
 * that are not "mine" both mean LEAVE IT:
 *   • `mine`     every machine in it carries this platform's stamp: the sweep may judge it by our rows.
 *   • `theirs`   at least one machine names a different platform: another deployment sharing this org and
 *                credential is running it, and its rows are not ours to read. Destroying it is the outage.
 *   • `unknown`  machines minted before the stamp existed, so there is nothing to go on. Unprovable is not the
 *                same as unwanted; the health sweep reports these for a human.
 *
 * An app with NO machines has no stamp to read either, and it answers `unknown` here — but the sweep does not
 * leave it standing, because emptiness is itself the evidence (see `orphanVerdict`). */
export type AppOwner = "mine" | "theirs" | "unknown";

const appOwner = (machines: { metadata: Record<string, string> }[], instance: string): AppOwner => {
    const stamps = machines.map((machine) => machine.metadata[FLY_META_PLATFORM]).filter((stamp) => stamp !== undefined);
    if (stamps.length === 0) {
        return `unknown`;
    }
    return stamps.every((stamp) => stamp === instance) ? `mine` : `theirs`;
};

/* Everything about an unknown app the sweep needs, or `undefined` when Fly stopped answering about it (a
 * concurrent teardown, a bad minute), which is read as "not now" rather than as a verdict. The age is the
 * OLDEST resource in the app: a machine replaced a minute ago inside an app from last week is not new. */
const appEvidence = async (
    config: Config,
    app: string,
): Promise<{ owner: AppOwner; oldestAt: Date | undefined; machines: number } | undefined> => {
    try {
        const machines = await listMachines(config.hosted.flyApiToken, app);
        const volumes = machines.length > 0 ? [] : await listVolumes(config.hosted.flyApiToken, app);
        const stamps = [...machines.map((machine) => machine.createdAt), ...volumes.map((volume) => volume.createdAt)].filter(
            (at): at is Date => at !== undefined,
        );
        return {
            owner: appOwner(machines, hostedInstanceId(config)),
            oldestAt: stamps.length === 0 ? undefined : new Date(Math.min(...stamps.map((at) => at.getTime()))),
            machines: machines.length,
        };
    } catch (error) {
        return isFlyGone(error) ? { owner: `mine`, oldestAt: undefined, machines: 0 } : undefined;
    }
};

/* WHY AN APP IS BEING LEFT STANDING, or `undefined` for one this platform may collect. The order is the
 * argument:
 *
 *   1. `unreadable`  Fly would not answer about it. Not a verdict, and never spent as one.
 *   2. `theirs`      a machine names another deployment. Checked before the clock, because this is the fact an
 *                    operator most needs told (a second deployment on this org and credential is the CAUSE of
 *                    the fleet-loss outage), and a young stranger is still a stranger.
 *   3. `young`       inside the grace window: a cold provision is app → volume → machine → row, so for minutes
 *                    a perfectly healthy signup owns Fly resources no row vouches for yet.
 *   4. no machines   COLLECTABLE, and the case this ordering exists to add. An app with nothing in it has no
 *                    stamp to read, so it used to answer `unknown` and be left standing FOREVER: nothing could
 *                    ever prove it ours, the daily sweep logged it as unprovable every night, and the health
 *                    watch counted it as a stranger every fifteen minutes, which mailed the admins about a
 *                    fleet-loss that had not happened and could never be cleared. Emptiness is its own
 *                    evidence: a machine is the only thing that runs in an app, so an app without one is
 *                    running nothing and can lose nobody their sandbox. Past the grace window with no row
 *                    behind it, the only things that produce this shape are a failed provision of ours and a
 *                    failed provision of somebody else's — litter either way.
 *   5. `unknown`     it HAS machines, but none carries a stamp: minted before the stamp existed. Left standing
 *                    on purpose, because these are the ones that could still be somebody's sandbox. */
export type OrphanSkip = "theirs" | "unknown" | "young" | "unreadable";

const orphanVerdict = (evidence: Awaited<ReturnType<typeof appEvidence>>, now: number): OrphanSkip | undefined => {
    if (evidence === undefined) {
        return `unreadable`;
    }
    if (evidence.owner === `theirs`) {
        return `theirs`;
    }
    if (evidence.oldestAt !== undefined && now - evidence.oldestAt.getTime() < REAP_GRACE_MS) {
        return `young`;
    }
    if (evidence.machines === 0) {
        return undefined;
    }
    return evidence.owner === `mine` ? undefined : `unknown`;
};

/* Every our-prefix app the database cannot explain, sorted into the ones this platform may collect and the
 * ones it must leave alone with the reason why. Sequential: this runs over a handful of apps (normally none at
 * all), and the Fly API is happier for it.
 *
 * Exported because the health watch asks the same question and must get the same answer: it reports what the
 * reaper leaves standing, and two definitions of "whose app is this" would eventually disagree about the one
 * thing they exist to agree on. */
export const sortUnknownApps = async (
    config: Config,
    unknown: string[],
): Promise<{ doomed: string[]; skipped: { app: string; why: OrphanSkip }[] }> => {
    const now = Date.now();
    const doomed: string[] = [];
    const skipped: { app: string; why: OrphanSkip }[] = [];
    for (const app of unknown) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per unknown app, once a day
        const why = orphanVerdict(await appEvidence(config, app), now);
        if (why === undefined) {
            doomed.push(app);
        } else {
            skipped.push({ app, why });
        }
    }
    return { doomed, skipped };
};

/* The daily reconcile (retention.ts): every OUR-prefix app in the org that THIS platform made and no longer
 * has a row for gets destroyed. Failed-provision leftovers, delete-flow teardowns that lost their race,
 * anything half-made. The DB row is the source of "this app should still exist", rows are created only after
 * the machine is and deleted only when the machine's story ends, so one of ours without a row is never a
 * machine somebody is working in.
 *
 * "That this platform made" is the load-bearing clause and the reason this is not a set difference any more.
 * A Fly org is shared by everything holding its credential, and an app name carries no owner, so a sweep that
 * destroys every app its own database cannot explain will happily destroy another deployment's entire fleet,
 * leaving that deployment's rows pointing at machines Fly no longer has. That is precisely what happened here:
 * production's sandboxes were destroyed by a second instance, and every affected user was left pressing a
 * "start it over" button that 404s forever. So ownership is read off machine metadata (fly.ts), a young app is
 * left alone (a signup in flight owns resources before its row exists), and a pass that wants to destroy an
 * implausible amount refuses outright. Apps outside the prefix are still never even looked at. */
export const reapHostedOrphans = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    if (!hostedEnabled(config)) {
        return;
    }
    const prefix = `${config.hosted.appPrefix}-`;
    const names = (await listAppNames(config.hosted.flyApiToken, config.hosted.flyOrg)).filter((name) => name.startsWith(prefix));
    if (names.length === 0) {
        return;
    }
    const [machines, pooled] = await Promise.all([
        prisma.hostedMachine.findMany({ select: { appName: true } }),
        prisma.hostedPoolMachine.findMany({ select: { appName: true } }),
    ]);
    const known = new Set([...machines, ...pooled].map((row) => row.appName));
    const { doomed, skipped } = await sortUnknownApps(
        config,
        names.filter((candidate) => !known.has(candidate)),
    );
    if (skipped.length > 0) {
        // One line an operator can act on: an app this sweep will never collect is either somebody else's
        // (fine, and worth knowing) or ours from before the stamp (a manual cleanup, once).
        logger.warn({ skipped }, `hosted reaper: apps left standing because this platform cannot prove they are its own`);
    }
    const ceiling = Math.max(REAP_MAX_APPS, Math.floor(names.length * REAP_MAX_SHARE));
    if (doomed.length > ceiling) {
        logger.error(
            { doomed: doomed.length, ceiling, ourApps: names.length, apps: doomed },
            `hosted reaper: refusing to destroy this many apps at once; the database, not the fleet, is the likely fault`,
        );
        return;
    }
    for (const name of doomed) {
        logger.warn({ app: name }, `hosted reaper: destroying orphaned app`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API; a handful at most
        await deleteApp(config.hosted.flyApiToken, name).catch((error: unknown) =>
            logger.error({ err: error, app: name }, `hosted reaper: destroying orphaned app failed; retried tomorrow`),
        );
    }
};
