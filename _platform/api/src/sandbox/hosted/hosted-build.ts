import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { HostedBuildState, HostedBuildStatus } from "@intentic-app/api-contract";
import type { HostedBuild, PrismaClient } from "@intentic-app/prisma";
import { isOfficialSandboxImage, lintOverlay, overlayBase, rewriteOverlayBase } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { flyBuildMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { decryptSecret } from "../../crypto.js";
import { JOB_HOSTED_BUILD, runExclusive } from "../../jobs-lock.js";
import { createMachine, destroyMachine, flyBuildRole, getMachine, getMachineDetail, isFlyGone, listMachines, updateMachine } from "./fly.js";
import { mintAppDeployToken, organizationIdOf, revokeDeployToken } from "./fly-tokens.js";
import { BUILD_ENV, BUILD_PATHS, buildScript, dockerConfigJson, LOG_TAIL_BYTES } from "./hosted-build-script.js";
import { hostedInstanceId, hostedMachineConfig, type HostedProvisionArgs, startAfterUpdate } from "./hosted.js";
import { chargeMinutes, hostedBudgetOf, usageMonth } from "./hosted-usage.js";

/* THE HOSTED LANE'S `ic sandbox rebuild`. On a docker host the owner runs that command on the machine the
 * container lives on: it copies the approved overlay out, refuses it unless it still hashes to what was
 * reviewed, builds it, and recreates the container with the hash stamped. A hosted sandbox is a Fly microVM
 * with no host, so the platform is the executor: it builds the same bytes on a BUILDER machine it creates
 * inside the sandbox's own Fly app, pushes the result to that app's registry path, and replaces the sandbox
 * machine's config with the new image, volume intact, the same replacement a restart is.
 *
 * Every build spends the platform's money on whatever RUN steps an approved recipe carries, and sign-in is
 * Google, so accounts are free. That shapes this module more than anything else:
 *   • ONLY THE OWNER, from a browser session, may start one, and the platform itself on a base image update.
 *     Nothing that holds the connect token can: an agent drafts and waits.
 *   • ONE IN FLIGHT per sandbox, won by a conditional update on the machine row (the pool claim's pattern).
 *   • PER-OWNER limits with PLATFORM-WIDE ceilings behind them (config.hosted.builds*): builds per day per
 *     owner, concurrent builds and builder minutes per day across the platform.
 *   • BUILDER MINUTES ARE AWAKE MINUTES: charged to the owner's month like the sandbox's own running time,
 *     and refused up front when the owner's remaining minutes are under the timeout. A free account cannot
 *     farm builds without spending the hours its sandbox would have run on.
 *   • A TIMEOUT enforced twice, by the script's own `timeout` and by the reconcile below, which force-destroys
 *     a builder that outlives it.
 *   • THE ONLY CREDENTIAL IN THE BUILDER is a deploy token scoped to the sandbox's own app, minted per build
 *     and revoked when the builder reports (fly-tokens.ts). The reconcile also enforces that an app holds one
 *     sandbox machine and at most one builder, destroying anything else, which bounds what a leaked token
 *     could buy to the token's lifetime.
 *
 * The builder reports its own exit, digest and log tail (hosted-build-script.ts) to the report route, which
 * is the primary completion signal and the only source of a log. The reconcile is the fallback for a builder
 * that never reports: it reads the machine's exit event off Fly, fails the row, and cleans up. */

const BUILD_STATES = { building: `building`, built: `built`, failed: `failed` } as const;

// Fly's registry, where the sandbox app's own path lives and where a machine in the org pulls from unaided.
const REGISTRY = `registry.fly.io`;

// One moving tag per sandbox: the machine boots the DIGEST the builder reports, so re-pushing the tag frees
// the previous image from any row and leaves nothing for a later push to hijack.
const overlayImageTag = (appName: string): string => `${REGISTRY}/${appName}:env`;
const overlayCacheTag = (appName: string): string => `${REGISTRY}/${appName}:env-cache`;

// The states Fly reports while a machine still costs something; anything else is a machine that has ended.
const RUNNING_STATES = new Set([`created`, `starting`, `started`, `replacing`]);
const ENDED_STATES = new Set([`stopped`, `failed`, `destroyed`, `suspended`]);

// How long past its timeout a builder gets before the reconcile stops waiting for its report and destroys
// it: the script's own `timeout` fires at the limit, then the report and the exit take seconds, not minutes.
const TIMEOUT_GRACE_MS = 5 * 60 * 1000;
// A builder observed stopped for this long with no report is one whose report is not coming.
const REPORT_GRACE_MS = 2 * 60 * 1000;
const TICK_MS = 60 * 1000;

const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/* WHY A BUILD WAS NOT STARTED, in the words the route answers and the card shows. Every code is a refusal
 * that spent nothing: the checks run in order of cost, and the first that fails ends the request before a
 * token is minted or a machine created. */
export type HostedBuildRefusal = "off" | "no-machine" | "mismatch" | "invalid" | "busy" | "daily" | "ceiling" | "budget";

export class HostedBuildRefused extends Error {
    readonly code: HostedBuildRefusal;

    constructor(code: HostedBuildRefusal, message: string) {
        super(message);
        this.code = code;
    }
}

export const buildStateOf = (row: HostedBuild): HostedBuildState => ({
    state: row.state === BUILD_STATES.built ? `built` : row.state === BUILD_STATES.failed ? `failed` : `building`,
    hash: row.hash,
    startedAt: row.createdAt.toISOString(),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.log === null ? {} : { log: row.log }),
});

export interface HostedBuildRequest {
    readonly sandboxId: string;
    readonly ownerId: string;
    readonly ownerEmail: string;
    // The approved overlay as the browser read it off the daemon, and the hash the owner approved.
    readonly hash: string;
    readonly content: string;
    // The owner's email, or `platform` for a rebuild the platform decided on (a moved base image).
    readonly requestedBy: string;
}

// The build row with everything the swap needs: the machine, its sandbox's token and its owner.
const withMachine = {
    machine: { include: { sandbox: { include: { owner: { select: { id: true, email: true } } } } } },
} as const;
type BuildRow = HostedBuild & {
    machine: {
        id: string;
        sandboxId: string;
        appName: string;
        machineId: string;
        volumeId: string;
        region: string;
        buildingId: string | null;
        sandbox: { token: string; owner: { id: string; email: string } };
    };
};

/* The checks before anything is spent, cheapest first. The content ones are the same verification `ic` makes
 * on a docker host: only bytes that still hash to what the owner reviewed are built, the base is pinned to
 * the image the platform runs, and the grammar is RUN/ENV under one official FROM. */
const verifiedContent = (config: Config, hash: string, content: string): string => {
    if (sha256Hex(content) !== hash) {
        throw new HostedBuildRefused(`mismatch`, `the overlay changed since it was reviewed: re-read and approve it on the Environment card`);
    }
    const base = overlayBase(content);
    if (base === undefined || !isOfficialSandboxImage(base)) {
        throw new HostedBuildRefused(`invalid`, `the overlay must start with FROM the official sandbox image`);
    }
    const pinned = rewriteOverlayBase(content, config.hosted.image);
    const offending = lintOverlay(pinned);
    if (offending !== undefined) {
        throw new HostedBuildRefused(`invalid`, `the overlay may only carry RUN and ENV steps; refused at: ${offending.trim() || `(empty)`}`);
    }
    return pinned;
};

/* The brakes, read in one pass. Per-owner first (the common refusal), then the platform-wide ceilings, then
 * the owner's own hours. `running` builds are counted at the full timeout against the day's minutes, so the
 * ceiling is never crossed by builds that have not finished yet. */
const assertWithinLimits = async (prisma: PrismaClient, config: Config, ownerId: string, now: Date): Promise<void> => {
    const { buildsPerDay, buildConcurrency, buildMinutesPerDay, buildTimeoutMinutes } = config.hosted;
    const dayStart = utcDayStart(now);
    const [ownerToday, running, finishedToday] = await Promise.all([
        prisma.hostedBuild.count({ where: { createdAt: { gte: dayStart }, machine: { sandbox: { ownerId } } } }),
        prisma.hostedBuild.count({ where: { state: BUILD_STATES.building } }),
        prisma.hostedBuild.aggregate({ _sum: { minutes: true }, where: { finishedAt: { gte: dayStart } } }),
    ]);
    if (ownerToday >= buildsPerDay) {
        throw new HostedBuildRefused(`daily`, `this account has used its ${buildsPerDay} environment builds for today; try again tomorrow`);
    }
    if (running >= buildConcurrency) {
        throw new HostedBuildRefused(`busy`, `the platform is building as many environments as it can right now; try again in a few minutes`);
    }
    const minutesToday = (finishedToday._sum.minutes ?? 0) + running * buildTimeoutMinutes;
    if (buildMinutesPerDay > 0 && minutesToday + buildTimeoutMinutes > buildMinutesPerDay) {
        throw new HostedBuildRefused(`ceiling`, `the platform's environment builds for today are spent; try again tomorrow`);
    }
    const budget = await hostedBudgetOf(prisma, config, ownerId);
    if (budget.metered && budget.remainingMinutes < buildTimeoutMinutes) {
        throw new HostedBuildRefused(
            `budget`,
            `a build can take up to ${buildTimeoutMinutes} minutes of this sandbox's free hours and fewer are left this month; upgrade or self-host`,
        );
    }
};

const provisionArgsOf = (config: Config, row: BuildRow[`machine`]): HostedProvisionArgs => ({
    sandboxId: row.sandboxId,
    connectToken: decryptSecret(config, row.sandbox.token),
    ownerEmail: row.sandbox.owner.email,
    region: row.region,
});

/* BOOT THE MACHINE ONTO A BUILT IMAGE: the config replacement a restart is, with the overlay's digest and
 * hash in it. A running machine takes the new version up in place (Fly restarts it, the volume stays); a
 * stopped one is left stopped, and boots the new image on its next wake through the same budget gate every
 * wake passes, so applying a build is never a way to start a machine without one. The row records what the
 * machine now runs, which is what a later restart preserves and a later base update compares against. */
const applyHostedBuild = async (prisma: PrismaClient, config: Config, logger: Logger, build: BuildRow, digest: string): Promise<void> => {
    const { machine } = build;
    const image = `${REGISTRY}/${machine.appName}@${digest}`;
    const before = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    const running = before !== undefined && RUNNING_STATES.has(before.state);
    await updateMachine(
        config.hosted.flyApiToken,
        machine.appName,
        machine.machineId,
        hostedMachineConfig(config, provisionArgsOf(config, machine), machine.appName, machine.volumeId, { image, environmentHash: build.hash }),
    );
    if (running) {
        await startAfterUpdate(config, machine);
    }
    await prisma.hostedMachine.update({
        where: { id: machine.id },
        data: { image, baseImage: build.baseImage, environmentHash: build.hash },
    });
    logger.info({ app: machine.appName, build: build.id, running }, `hosted build: applied`);
};

/* Everything a build's end does, whoever declares it (the builder's report or the reconcile's verdict): the
 * row's verdict and minutes, the owner's month charged, the builder destroyed, its token revoked, the machine
 * row's guard released, and on success the swap. Best-effort on every side effect but the row, so a Fly bad
 * minute never leaves a build both finished and building. */
const finishHostedBuild = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    build: BuildRow,
    outcome: { exitCode?: number; digest?: string; log?: string; error?: string },
): Promise<void> => {
    const now = new Date();
    const ceilingMs = (config.hosted.buildTimeoutMinutes + 1) * 60_000;
    const minutes = Math.max(1, Math.ceil(Math.min(now.getTime() - build.createdAt.getTime(), ceilingMs) / 60_000));
    const ok = outcome.error === undefined && outcome.exitCode === 0 && outcome.digest !== undefined && outcome.digest !== ``;
    const log = outcome.log === undefined ? undefined : Buffer.from(outcome.log, `utf8`).subarray(-LOG_TAIL_BYTES).toString(`utf8`);
    const error = ok
        ? undefined
        : (outcome.error ??
          (outcome.exitCode === undefined
              ? `the build ended without a result`
              : outcome.digest === undefined || outcome.digest === ``
                ? `the build exited ${outcome.exitCode} without pushing an image`
                : `the build exited ${outcome.exitCode}`));
    const { flyApiToken } = config.hosted;
    // The verdict first: everything below may fail and be retried, this may not be written twice.
    const updated = await prisma.hostedBuild.updateMany({
        where: { id: build.id, state: BUILD_STATES.building },
        data: {
            state: ok ? BUILD_STATES.built : BUILD_STATES.failed,
            ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
            ...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
            ...(log === undefined ? {} : { log }),
            ...(error === undefined ? {} : { error }),
            minutes,
            finishedAt: now,
        },
    });
    if (updated.count === 0) {
        return;
    }
    await chargeMinutes(prisma, build.machine.sandbox.owner.id, usageMonth(now), minutes);
    await destroyMachine(flyApiToken, build.machine.appName, build.builderMachineId, { force: true }).catch((err: unknown) =>
        logger.warn({ err, build: build.id }, `hosted build: destroying the builder failed; the reconcile retries`),
    );
    if (build.tokenId !== null) {
        await revokeDeployToken(flyApiToken, build.tokenId)
            .then(() => prisma.hostedBuild.update({ where: { id: build.id }, data: { tokenId: null } }))
            .catch((err: unknown) => logger.warn({ err, build: build.id }, `hosted build: revoking the deploy token failed; it expires on its own`));
    }
    await prisma.hostedMachine.updateMany({ where: { id: build.hostedMachineId, buildingId: build.id }, data: { buildingId: null } });
    if (ok && outcome.digest !== undefined) {
        try {
            await applyHostedBuild(prisma, config, logger, build, outcome.digest);
        } catch (err) {
            // Built but not booted: the image is there and a restart applies it (refreshHosted keeps the row's
            // overlay), so the row stays `built` with the reason on it rather than lying about a failure.
            logger.error({ err, build: build.id }, `hosted build: applying the built image failed`);
            await prisma.hostedBuild.update({
                where: { id: build.id },
                data: { error: `built, but the machine could not be switched to it: ${err instanceof Error ? err.message : String(err)}` },
            });
        }
    }
    logger.info({ build: build.id, ok, minutes, exitCode: outcome.exitCode }, `hosted build: finished`);
};

/* START A BUILD: verify, brake, win the row, then spend, in that order, so every refusal costs nothing and
 * every failure after the guard releases it. Answers the build's state as started, which is what the card
 * polls from then on. */
export const requestHostedBuild = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    request: HostedBuildRequest,
): Promise<HostedBuildState> => {
    if (config.hosted.buildsPerDay === 0) {
        throw new HostedBuildRefused(`off`, `environment builds are not enabled on this platform`);
    }
    const hosted = await prisma.hostedMachine.findUnique({
        where: { sandboxId: request.sandboxId },
        include: { sandbox: { include: { owner: { select: { id: true, email: true } } } } },
    });
    if (hosted === null) {
        throw new HostedBuildRefused(`no-machine`, `this sandbox has no machine we run`);
    }
    const pinned = verifiedContent(config, request.hash, request.content);
    const now = new Date();
    // Nothing to build: the machine already runs this overlay on the platform's current base.
    if (hosted.environmentHash === request.hash && hosted.baseImage === config.hosted.image) {
        const last = await prisma.hostedBuild.findFirst({
            where: { hostedMachineId: hosted.id, hash: request.hash },
            orderBy: { createdAt: `desc` },
        });
        if (last !== null) {
            return buildStateOf(last);
        }
    }
    if (hosted.buildingId !== null) {
        throw new HostedBuildRefused(`busy`, `this sandbox's environment is already being built`);
    }
    // The same recipe on the same base, built before and still there: a swap, not a build.
    const reusable = await prisma.hostedBuild.findFirst({
        where: { hostedMachineId: hosted.id, hash: request.hash, baseImage: config.hosted.image, state: BUILD_STATES.built, digest: { not: null } },
        orderBy: { createdAt: `desc` },
        include: withMachine,
    });
    if (reusable !== null && reusable.digest !== null) {
        await applyHostedBuild(prisma, config, logger, reusable, reusable.digest);
        return buildStateOf(reusable);
    }
    await assertWithinLimits(prisma, config, hosted.sandbox.owner.id, now);
    const id = randomUUID();
    const won = await prisma.hostedMachine.updateMany({ where: { id: hosted.id, buildingId: null }, data: { buildingId: id } });
    if (won.count === 0) {
        throw new HostedBuildRefused(`busy`, `this sandbox's environment is already being built`);
    }
    const { flyApiToken, flyOrg, buildTimeoutMinutes } = config.hosted;
    let builderMachineId: string | undefined;
    try {
        const secret = randomBytes(32).toString(`base64url`);
        const organizationId = await organizationIdOf(flyApiToken, flyOrg);
        const deploy = await mintAppDeployToken(flyApiToken, organizationId, {
            app: hosted.appName,
            name: `intentic overlay build ${id}`,
            expiryMinutes: buildTimeoutMinutes + 15,
        });
        const image = overlayImageTag(hosted.appName);
        const machineConfig = {
            ...flyBuildMachineConfig({
                image: config.hosted.builderImage,
                guest: { cpuKind: config.hosted.builderCpuKind, cpus: config.hosted.builderCpus, memoryMb: config.hosted.builderMemoryMb },
                files: [
                    { path: BUILD_PATHS.dockerfile, content: pinned },
                    { path: BUILD_PATHS.script, content: buildScript() },
                    { path: BUILD_PATHS.dockerConfig, content: dockerConfigJson(REGISTRY, deploy.token) },
                ],
                entrypoint: [`/bin/sh`, BUILD_PATHS.script],
                env: [
                    [BUILD_ENV.image, image],
                    [BUILD_ENV.cache, overlayCacheTag(hosted.appName)],
                    [BUILD_ENV.timeoutSeconds, String(buildTimeoutMinutes * 60)],
                    [BUILD_ENV.reportUrl, `${config.api.url}/sandbox/hosted-build-report/${id}`],
                    [BUILD_ENV.secret, secret],
                ],
            }),
            metadata: flyBuildRole(hosted.sandboxId, hostedInstanceId(config)),
        };
        const created = await createMachine(flyApiToken, hosted.appName, {
            name: `${hosted.appName}-build-${id.slice(0, 8)}`,
            region: hosted.region,
            config: machineConfig,
        });
        builderMachineId = created.machineId;
        const row = await prisma.hostedBuild.create({
            data: {
                id,
                hostedMachineId: hosted.id,
                hash: request.hash,
                baseImage: config.hosted.image,
                content: request.content,
                state: BUILD_STATES.building,
                image,
                builderMachineId: created.machineId,
                builderInstanceId: created.instanceId,
                secretHash: sha256Hex(secret),
                tokenId: deploy.id,
                requestedBy: request.requestedBy,
            },
        });
        logger.info({ app: hosted.appName, build: id, requestedBy: request.requestedBy }, `hosted build: builder created`);
        return buildStateOf(row);
    } catch (error) {
        // Nothing was recorded, so nothing may be left running or reserved: the builder (if it got made) goes,
        // and the row's guard opens again for the next request.
        if (builderMachineId !== undefined) {
            await destroyMachine(flyApiToken, hosted.appName, builderMachineId, { force: true }).catch((err: unknown) =>
                logger.warn(
                    { err, app: hosted.appName },
                    `hosted build: cleanup of a builder after a failed start failed; the reconcile collects it`,
                ),
            );
        }
        await prisma.hostedMachine.updateMany({ where: { id: hosted.id, buildingId: id }, data: { buildingId: null } });
        throw error;
    }
};

/* THE BUILDER'S OWN REPORT, authenticated by the secret only it and the row (hashed) hold. A report can only
 * ever END a build, never start or change one: an unknown id, a wrong secret and a build already finished
 * are each answered without touching anything. */
export type HostedBuildReportAnswer = "unknown" | "forbidden" | "stale" | "done";

export const reportHostedBuild = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    buildId: string,
    secret: string,
    report: { exitCode: number | undefined; digest: string | undefined; log: string },
): Promise<HostedBuildReportAnswer> => {
    const build = await prisma.hostedBuild.findUnique({ where: { id: buildId }, include: withMachine });
    if (build === null) {
        return `unknown`;
    }
    const given = Buffer.from(sha256Hex(secret), `hex`);
    const expected = Buffer.from(build.secretHash, `hex`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return `forbidden`;
    }
    if (build.state !== BUILD_STATES.building) {
        return `stale`;
    }
    await finishHostedBuild(prisma, config, logger, build, {
        ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
        ...(report.digest === undefined || report.digest === `` ? {} : { digest: report.digest }),
        log: report.log,
    });
    return `done`;
};

/* THE BASE IMAGE MOVED UNDER AN OVERLAY: the platform's image is newer than the one this machine's overlay
 * was built on. A restart keeps the overlay it has (the tools must not vanish), and this puts the same
 * approved recipe through a build on the new base, the platform asking on the owner's behalf, under the
 * owner's limits. Nothing to do for a stock machine or one already on the current base; a refusal (a limit,
 * a build in flight) is logged and left for the owner's next visit, never surfaced as a restart failure. */
export const rebuildOnMovedBase = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    hosted: { id: string; sandboxId: string; image: string | null; baseImage: string | null; environmentHash: string | null },
    owner: { id: string; email: string },
): Promise<void> => {
    // Falsy rather than `=== null`: a row read without these columns (an older caller's select, a fixture)
    // has no overlay to rebuild either, and reading it as one would ask for a build of nothing.
    if (!hosted.image || !hosted.environmentHash || hosted.baseImage === config.hosted.image) {
        return;
    }
    const last = await prisma.hostedBuild.findFirst({
        where: { hostedMachineId: hosted.id, hash: hosted.environmentHash, state: BUILD_STATES.built },
        orderBy: { createdAt: `desc` },
        select: { hash: true, content: true },
    });
    if (last === null) {
        return;
    }
    try {
        await requestHostedBuild(prisma, config, logger, {
            sandboxId: hosted.sandboxId,
            ownerId: owner.id,
            ownerEmail: owner.email,
            hash: last.hash,
            content: last.content,
            requestedBy: `platform`,
        });
    } catch (error) {
        logger.warn(
            { err: error, sandboxId: hosted.sandboxId },
            `hosted build: rebuilding the overlay on the new base was refused; the owner can ask again`,
        );
    }
};

// The build in flight or the last one finished, and what the platform last booted the machine with.
export const hostedBuildStatus = async (prisma: PrismaClient, hostedMachineId: string): Promise<HostedBuildStatus> => {
    const [latest, machine] = await Promise.all([
        prisma.hostedBuild.findFirst({ where: { hostedMachineId }, orderBy: { createdAt: `desc` } }),
        prisma.hostedMachine.findUnique({ where: { id: hostedMachineId }, select: { environmentHash: true } }),
    ]);
    return { build: latest === null ? null : buildStateOf(latest), applied: machine?.environmentHash ?? null };
};

/* THE FLEET INVARIANT, checked while a build's token is alive: a sandbox's app holds its machine and at most
 * this build's builder. Anything else is what a leaked deploy token would have made, and it is destroyed
 * and said out loud. One list call per active build, which is normally none. */
const enforceAppShape = async (config: Config, logger: Logger, build: BuildRow): Promise<void> => {
    const machines = await listMachines(config.hosted.flyApiToken, build.machine.appName).catch(() => undefined);
    if (machines === undefined) {
        return;
    }
    for (const machine of machines) {
        if (machine.id === build.machine.machineId || machine.id === build.builderMachineId) {
            continue;
        }
        logger.error(
            { app: build.machine.appName, machine: machine.id, build: build.id },
            `hosted build: a machine nobody made is in a sandbox's app; destroying it`,
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, and there is normally none
        await destroyMachine(config.hosted.flyApiToken, build.machine.appName, machine.id, { force: true }).catch((err: unknown) =>
            logger.error({ err, app: build.machine.appName, machine: machine.id }, `hosted build: destroying a stray machine failed`),
        );
    }
};

/* One reconcile pass over every build in flight: the fallback for a builder that never reports, the timeout
 * nobody else enforces, and the app-shape invariant. Sequential and per-row guarded, the pool's stance. */
export const reconcileHostedBuilds = async (prisma: PrismaClient, config: Config, logger: Logger, now: () => number = Date.now): Promise<void> => {
    const building = await prisma.hostedBuild.findMany({ where: { state: BUILD_STATES.building }, include: withMachine });
    const { flyApiToken, buildTimeoutMinutes } = config.hosted;
    for (const build of building) {
        const age = now() - build.createdAt.getTime();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per build in flight
        await enforceAppShape(config, logger, build);
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        const detail = await getMachineDetail(flyApiToken, build.machine.appName, build.builderMachineId).catch((error: unknown) =>
            isFlyGone(error) ? (`gone` as const) : undefined,
        );
        if (detail === undefined) {
            // Fly could not be asked: not a verdict, asked again next tick.
            continue;
        }
        if (detail === `gone`) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await finishHostedBuild(prisma, config, logger, build, { error: `the builder disappeared before it reported` });
            continue;
        }
        if (ENDED_STATES.has(detail.state)) {
            // The report arrives before the builder exits, so a builder that has been stopped for a while and
            // is still `building` here is one whose report is not coming. Its exit event is the next best word.
            if (age < REPORT_GRACE_MS) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            await finishHostedBuild(prisma, config, logger, build, {
                ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
                error: detail.oomKilled
                    ? `the builder ran out of memory`
                    : detail.exitCode === 0
                      ? `the builder exited without reporting an image`
                      : `the builder exited ${detail.exitCode ?? `without a code`} and never reported`,
            });
            continue;
        }
        if (age > buildTimeoutMinutes * 60_000 + TIMEOUT_GRACE_MS) {
            logger.warn({ build: build.id, app: build.machine.appName }, `hosted build: builder past its timeout; destroying it`);
            // oxlint-disable-next-line eslint/no-await-in-loop
            await finishHostedBuild(prisma, config, logger, build, { error: `the build ran past ${buildTimeoutMinutes} minutes and was stopped` });
        }
    }
    // A guard whose build is no longer building (a crash between the verdict and the release) opens again.
    const guarded = await prisma.hostedMachine.findMany({ where: { buildingId: { not: null } }, select: { id: true, buildingId: true } });
    for (const row of guarded) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const inFlight = await prisma.hostedBuild.findFirst({
            where: { id: row.buildingId ?? ``, state: BUILD_STATES.building },
            select: { id: true },
        });
        if (inFlight === null) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await prisma.hostedMachine.updateMany({ where: { id: row.id, buildingId: row.buildingId }, data: { buildingId: null } });
        }
    }
};

// Boot wiring (main.ts): every minute, one replica at a time. Started even when builds are off, so a build
// that was in flight when the feature was switched off still ends and its builder is still collected.
export const startHostedBuilds = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_BUILD, () =>
            reconcileHostedBuilds(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted build reconcile failed`)),
        ).catch((error: unknown) => logger.error({ err: error }, `hosted build lock failed`));
    };
    tick();
    setInterval(tick, TICK_MS);
};

/* THE DAILY SWEEP (retention.ts): build rows are disposable. Everything older than the window goes except the
 * newest built one per machine, which is what a restart re-applies and a base update rebuilds from. */
const BUILD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const sweepHostedBuilds = async (prisma: PrismaClient, now: () => number = Date.now): Promise<number> => {
    const cutoff = new Date(now() - BUILD_RETENTION_MS);
    const keep = await prisma.hostedBuild.findMany({
        where: { state: BUILD_STATES.built },
        orderBy: { createdAt: `desc` },
        distinct: [`hostedMachineId`],
        select: { id: true },
    });
    const gone = await prisma.hostedBuild.deleteMany({
        where: { createdAt: { lt: cutoff }, state: { not: BUILD_STATES.building }, id: { notIn: keep.map((row) => row.id) } },
    });
    return gone.count;
};
