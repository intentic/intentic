import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { HostedBuildState, HostedBuildStatus } from "@intentic/api-contract";
import type { HostedBuild, PrismaClient } from "@intentic/prisma";
import { isOfficialSandboxImage, lintOverlay, overlayBase, rewriteOverlayBase } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { flyBuildMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { decryptSecret } from "../../../crypto.js";
import { JOB_HOSTED_BUILD, runExclusive } from "../../../jobs-lock.js";
import {
    createMachine,
    destroyMachine,
    flyBuildRole,
    getMachine,
    getMachineDetail,
    isFlyCapacity,
    isFlyGone,
    listMachines,
    updateMachine,
} from "../fly/fly.js";
import { mintAppDeployToken, organizationIdOf, revokeDeployToken } from "../fly/fly-tokens.js";
import { hostedCapacity, noteProviderAtCapacity } from "../hosted-capacity.js";
import { BUILD_ENV, BUILD_PATHS, buildScript, dockerConfigJson, LOG_TAIL_BYTES } from "./hosted-build-script.js";
import { hostedInstanceId, hostedMachineConfig, type HostedProvisionArgs, startAfterUpdate } from "../hosted.js";
import { chargeMinutes, hostedBudgetOf, usageMonth } from "../hosted-usage.js";

// Executes `ic sandbox rebuild` for hosted sandboxes: builds the approved overlay in a builder machine inside the
// sandbox's own Fly app, then swaps the sandbox machine's config like a restart. Money-relevant rules:
// - only the owner, or the platform on a base image move, may start one; one in flight per sandbox
// - per-owner and platform-wide ceilings (config.hosted.builds*); builder minutes charge like awake time
// - timeout enforced twice (the script's own `timeout`, and the reconcile below)
// - the builder holds only a deploy token scoped to its app, revoked once it reports

const BUILD_STATES = { building: `building`, built: `built`, failed: `failed` } as const;

// Fly's registry; the sandbox app's own path, which any machine in the org can pull from unaided.
const REGISTRY = `registry.fly.io`;

// One moving tag per sandbox: the machine boots the digest the builder reports, so re-pushing frees the previous image
// for later pushes.
const overlayImageTag = (appName: string): string => `${REGISTRY}/${appName}:env`;
const overlayCacheTag = (appName: string): string => `${REGISTRY}/${appName}:env-cache`;

// Fly states that still cost money vs. states for a machine that has ended.
const RUNNING_STATES = new Set([`created`, `starting`, `started`, `replacing`]);
const ENDED_STATES = new Set([`stopped`, `failed`, `destroyed`, `suspended`]);

// Grace after timeout before the reconcile destroys a builder; report and exit take seconds once it fires.
const TIMEOUT_GRACE_MS = 5 * 60 * 1000;
// A builder stopped this long with no report is one whose report isn't coming.
const REPORT_GRACE_MS = 2 * 60 * 1000;
const TICK_MS = 60 * 1000;

const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// Why a build wasn't started, in the words the route/card show. Every code means nothing was spent: checks run
// cheapest-first, and the first failure stops before a token or machine exists.
export type HostedBuildRefusal = "off" | "no-machine" | "mismatch" | "invalid" | "busy" | "daily" | "ceiling" | "budget" | "capacity";

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

// The build row with everything a swap needs: the machine, its sandbox's token, and its owner.
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

// Checks before anything is spent, cheapest first: content still hashes to what was reviewed, the base is pinned to the
// platform's image, and the grammar is RUN/ENV under one official FROM.
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

// Brakes read in one pass: per-owner limit first, then platform-wide ceilings, then the owner's hours. Running builds
// count at the full timeout against the day's minutes.
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
    // A builder is a real machine too; refused, not queued, so the owner's own sandbox is unaffected.
    if ((await hostedCapacity(prisma, config)).headroom === 0) {
        throw new HostedBuildRefused(`capacity`, `we have no room on our provider for a build machine right now; your sandbox is unaffected, try again a little later`);
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

// The config replacement a restart is: a running machine takes it up in place, a stopped one boots it on next wake
// through the normal budget gate. The row records what now runs, for later restarts and base-update comparisons.
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

// Everything a build's end does, whoever declares it: verdict and minutes, owner's month charged, builder destroyed and
// token revoked, guard released, and on success the swap. Best-effort on every side effect but the row.
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
    // The verdict first: everything below may fail and retry, this may not be written twice.
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
            // Built but not booted: a restart still applies the image, so the row stays `built` with the reason
            // attached.
            logger.error({ err, build: build.id }, `hosted build: applying the built image failed`);
            await prisma.hostedBuild.update({
                where: { id: build.id },
                data: { error: `built, but the machine could not be switched to it: ${err instanceof Error ? err.message : String(err)}` },
            });
        }
    }
    logger.info({ build: build.id, ok, minutes, exitCode: outcome.exitCode }, `hosted build: finished`);
};

// The spending half of starting a build, once every refusal has passed and the row's guard is won: mints a scoped
// token, creates the builder, writes the row. Anything that fails here must leave nothing running or reserved.
const startBuilder = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: { id: string; sandboxId: string; appName: string; region: string },
    request: HostedBuildRequest,
    pinned: string,
    id: string,
): Promise<HostedBuildState> => {
    const { flyApiToken, flyOrg, buildTimeoutMinutes } = config.hosted;
    let builderMachineId: string | undefined;
    try {
        const secret = randomBytes(32).toString(`base64url`);
        const organizationId = await organizationIdOf(flyApiToken, flyOrg);
        const deploy = await mintAppDeployToken(flyApiToken, organizationId, {
            app: machine.appName,
            name: `intentic overlay build ${id}`,
            expiryMinutes: buildTimeoutMinutes + 15,
        });
        const image = overlayImageTag(machine.appName);
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
                    [BUILD_ENV.cache, overlayCacheTag(machine.appName)],
                    [BUILD_ENV.timeoutSeconds, String(buildTimeoutMinutes * 60)],
                    [BUILD_ENV.reportUrl, `${config.api.url}/sandbox/hosted-build-report/${id}`],
                    [BUILD_ENV.secret, secret],
                ],
            }),
            metadata: flyBuildRole(machine.sandboxId, hostedInstanceId(config)),
        };
        const created = await createMachine(flyApiToken, machine.appName, {
            name: `${machine.appName}-build-${id.slice(0, 8)}`,
            region: machine.region,
            config: machineConfig,
        });
        builderMachineId = created.machineId;
        const row = await prisma.hostedBuild.create({
            data: {
                id,
                hostedMachineId: machine.id,
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
        logger.info({ app: machine.appName, build: id, requestedBy: request.requestedBy }, `hosted build: builder created`);
        return buildStateOf(row);
    } catch (error) {
        // Nothing was recorded: destroy the builder if it was made, and reopen the row's guard.
        if (builderMachineId !== undefined) {
            await destroyMachine(flyApiToken, machine.appName, builderMachineId, { force: true }).catch((err: unknown) =>
                logger.warn(
                    { err, app: machine.appName },
                    `hosted build: cleanup of a builder after a failed start failed; the reconcile collects it`,
                ),
            );
        }
        await prisma.hostedMachine.updateMany({ where: { id: machine.id, buildingId: id }, data: { buildingId: null } });
        // Same brake arriving one call later (the org filled up meanwhile): surfaced as capacity, not a gateway error.
        if (isFlyCapacity(error)) {
            noteProviderAtCapacity(machine.region);
            logger.error({ err: error, app: machine.appName }, `hosted build: the provider has no machine left for a builder`);
            throw new HostedBuildRefused(
                `capacity`,
                `we have no room on our provider for a build machine right now; your sandbox is unaffected, try again a little later`,
            );
        }
        throw error;
    }
};

// Verify, brake, win the row, then spend, in that order, so every refusal costs nothing and every failure after the
// guard releases it. Answers the build's state as started; the card polls from there.
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
    // Same recipe, same base, already built and still there: a swap, not a build.
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
    return startBuilder(prisma, config, logger, hosted, request, pinned, id);
};

// The builder's own report, authenticated by the secret only it and the row (hashed) hold. Can only end a build, never
// start or change one: unknown id, wrong secret, or an already-finished build are all answered untouched.
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

// The platform's image moved past this machine's overlay base: rebuilds the same approved recipe on the new base, under
// the owner's limits. A restart keeps the current overlay; a refusal here is logged, not surfaced as a restart failure.
export const rebuildOnMovedBase = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    hosted: { id: string; sandboxId: string; image: string | null; baseImage: string | null; environmentHash: string | null },
    owner: { id: string; email: string },
): Promise<void> => {
    // Falsy, not `=== null`: a row missing these columns has no overlay to rebuild either.
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

// The build in flight or last finished, and what the platform last booted the machine with.
export const hostedBuildStatus = async (prisma: PrismaClient, hostedMachineId: string): Promise<HostedBuildStatus> => {
    const [latest, machine] = await Promise.all([
        prisma.hostedBuild.findFirst({ where: { hostedMachineId }, orderBy: { createdAt: `desc` } }),
        prisma.hostedMachine.findUnique({ where: { id: hostedMachineId }, select: { environmentHash: true } }),
    ]);
    return { build: latest === null ? null : buildStateOf(latest), applied: machine?.environmentHash ?? null };
};

// The fleet invariant while a build's token is alive: the app holds only its sandbox machine and this build's builder.
// Anything else is what a leaked token would have made; destroyed and logged.
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

// One reconcile pass over every build in flight: the fallback for a builder that never reports, the timeout nobody else
// enforces, and the app-shape invariant. Sequential and per-row guarded.
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
            // Fly couldn't be asked: not a verdict, retried next tick.
            continue;
        }
        if (detail === `gone`) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await finishHostedBuild(prisma, config, logger, build, { error: `the builder disappeared before it reported` });
            continue;
        }
        if (ENDED_STATES.has(detail.state)) {
            // A builder stopped this long and still `building` has no report coming; its exit event is next best.
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
    // A guard whose build is no longer building (a crash between verdict and release) opens again.
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

// Boot wiring (main.ts): one replica at a time, every minute. Runs even with builds off, so an in-flight build still
// ends and its builder is collected.
export const startHostedBuilds = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_BUILD, () =>
            reconcileHostedBuilds(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted build reconcile failed`)),
        ).catch((error: unknown) => logger.error({ err: error }, `hosted build lock failed`));
    };
    tick();
    setInterval(tick, TICK_MS);
};

// Daily sweep (retention.ts): keeps only the newest built row per machine, which restarts and rebuilds read.
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
