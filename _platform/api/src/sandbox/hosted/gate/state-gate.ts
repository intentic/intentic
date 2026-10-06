import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Prisma } from "@intentic/prisma";
import { type PlanFailure, PlanFailureSchema, STATE_PLAN_FORMAT } from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, type FlyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { digestOf, parseImageRef } from "../build/hosted-image.js";
import { execMachine, type FlyExecAnswer, type FlyMachineCurrent, getMachineConfig, stopMachine, updateMachine } from "../fly/fly.js";
import { withHostedAppLock } from "../hosted-app-lock.js";
import { ENV_PROJECT_DIR } from "../hosted-project.js";
import { awaitDaemon, baselineOf, type DaemonVerdict } from "./daemon-health.js";
import { checkInSince, type HostedGateRecord, type HostedImageFacts, imageColumns, type KeptImage, type KeptVersions, keptVersionsOf, writeKept } from "./gate-row.js";
import { startAfterUpdate } from "./start-after-update.js";

/* A HOSTED IMAGE CHANGE ASKS THE TARGET IMAGE FIRST, WAITS FOR ITS DAEMON AFTER, AND PUTS THE MACHINE BACK WHEN EITHER
 * SAYS NO.
 *
 * The self-hosted update runs the target image's own planner (`state-plan.js`, the daemon's conversion engine run
 * without writing) over the sandbox's data before it swaps anything (_sandbox/ic/src/sandbox/preflight.rs). A Fly
 * volume attaches to one machine, so the hosted planner runs on that machine: its config is replaced by a probe (the
 * target image, the same volume, the daemon's entrypoint swapped for a sleep, no restart), the planner is
 * run in it through Fly's exec, and the machine is stopped again. Then:
 *
 * - `ok: false` puts the previous config back (or, for a caller that asks `keepImage`, the target config on the image
 *   the machine already runs), starts it again when the caller asked for a running machine, and throws HostedImageKept
 *   with the failures in the owner's words. Nothing on the volume was converted.
 * - a planner that ran and failed, or answered something that is not a plan, refuses the same way: a check that
 *   crashed has not said the conversions would work, and a broken planner is a broken image.
 * - `ok: true` applies the target config.
 * - no plan to be had (an image from before the engine, a plan in a format newer than this platform reads, a probe
 *   that would not start, an exec Fly would not run) applies the target config too, as every image change did before
 *   this gate: a question an image cannot answer must not cost an update that would have worked. It is logged.
 *
 * THEN THE DAEMON IS WAITED FOR (daemon-health.ts). Started, the new version has to answer its own `/health` ready with
 * its state journal committed, and check in with the platform, within that module's budget. One that does not start,
 * crashes, never answers, reports its journal failed or never commits it, or never checks in, is put back on the
 * config it had, pinned to the digest it was running, and started there (HostedImageKept again). An episode the new
 * build opened and never committed is restored by the previous build's own boot (state-journal.ts), so the files go
 * back with the image.
 *
 * WHAT THE ROW KEEPS (gate-row.ts). A change that took leaves the image it replaced on the machine's row as the way back,
 * which the owner's rollback returns to (../hosted.ts). A change applied to a machine left stopped (a rebuild applied
 * while it sleeps), or one whose daemon was stopped from outside while it was waited for (an operator, the daemon's own
 * idle-stop), is ON TRIAL: the next start of that image, whoever asks for it, runs the same wait and goes back to the
 * kept image when it fails.
 *
 * A config replacement that keeps the running digest converts nothing, so it skips the probe, and waits for the daemon
 * only when that digest is on trial. A crash between the probe and the final config leaves the probe's marker in the
 * machine's environment, naming the image it ran before: the wake reads it as a config to re-apply (../hosted.ts), and
 * the next gate as the version to go back to.
 *
 * ONE CHANGE AT A TIME. The whole gate, probe to the daemon's verdict, runs under the app's lock (../hosted-app-lock.ts),
 * the one migrate and cleanup take and the meter's stop tries (../hosted-meter.ts): a second gate on the same machine
 * would replace the first one's probe under its exec, and that exec's failure reads as "no plan", which goes ahead, so a
 * refusal would be lost. A restart and a rebuild wait their turn; a wake does not wait (it is the browser's reflex,
 * repeated on its own) and answers HostedMachineBusy.
 *
 * WHAT THE PROBE CANNOT PROMISE. ic's probe mounts the data `:ro` with `--network none`. Fly has neither a read-only
 * volume mount nor a machine without a network, so here the volume is mounted read-write and the probe can reach the
 * internet. What stands in for both: the one command it runs is the planner, fixed argv with no shell, and the planner
 * has no write mode to select (state-plan.ts learns the version stamp with `write: false` and prints a plan; there is no
 * `--plan` flag because planning is all it does); the probe's environment carries none of the platform's credentials,
 * as ic's carries none; and nothing else boots.
 *
 * WHAT THE ROLLBACK DOES NOT COVER. The version put back is started, not waited for: it is the one that ran before. A
 * rollback that itself fails is logged at error and recorded on the machine's row, which hosted health reports and
 * mails (../hosted-health.ts) until the machine checks in again. */

// The planner the target image carries; an image built before the conversion engine has none.
export const STATE_PLANNER = `/opt/sandbox/dist/state-plan.js`;
// The one command a probe runs: the planner over the volume's two roots, no shell to widen it.
const PLAN_COMMAND = [`/usr/local/bin/node`, STATE_PLANNER, `--workspace`, FLY_VOLUME_LAYOUT.workspace, `--history`, FLY_VOLUME_LAYOUT.history] as const;
// Marks a probe config, so a wake that finds one re-applies the real config instead of starting a sleep.
export const STATE_PROBE_ENV = `INTENTIC_STATE_PROBE`;
// A plan reads a few JSON documents: past this it is a hang, and the answer is "no plan".
const PLAN_SECONDS = 60;
// The probe's own ceiling, should nothing come back to stop it; restart `no` leaves it stopped after.
const PROBE_SECONDS = 600;
// How long a probe may take to read `started` (else no plan), and a stopped one `stopped` (else the final config is
// applied anyway).
const SETTLE_ATTEMPTS = 60;
const SETTLE_MS = 500;

/* WHY AN IMAGE CHANGE LEFT THE MACHINE ON THE VERSION IT HAD, in words the owner is shown. `running` says whether the
 * machine was started again there, which is what the caller meters. */
export class HostedImageKept extends Error {
    constructor(
        message: string,
        readonly reason: "refused" | "rolled-back",
        readonly running: boolean,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/* ANOTHER CHANGE HOLDS THIS MACHINE (a restart's gate, a rebuild's swap, a move, a cleanup), and the caller asked not
 * to wait for it. Nothing was touched; asking again once it is done is the whole remedy. */
export class HostedMachineBusy extends Error {}

type HostedPlanVerdict =
    | { readonly kind: "clear"; readonly version: string }
    | { readonly kind: "refused"; readonly version: string; readonly failures: readonly PlanFailure[] }
    // The planner ran and failed, or answered what is not a plan: refused, with the reason in the owner's words.
    | { readonly kind: "broken"; readonly reason: string }
    // No plan to be had: the change goes ahead as it did before the gate.
    | { readonly kind: "unknown"; readonly reason: string };

// Read loosely, like ic: a refusal that lost a failure to a missing field would stop an update for a reason it cannot
// show. A field of the wrong type is a field that is not there.
const PlanLineSchema = z.object({
    plan: z.number().optional().catch(undefined),
    ok: z.boolean().optional().catch(undefined),
    version: z.string().optional().catch(undefined),
    failures: z.array(z.unknown()).optional().catch(undefined),
});

const lastLine = (text: string): string | undefined =>
    text
        .split(`\n`)
        .map((line) => line.trim())
        .findLast((line) => line !== ``);

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

const failuresOf = (raw: readonly unknown[] | undefined): PlanFailure[] =>
    (raw ?? []).flatMap((item) => {
        const failure = PlanFailureSchema.partial().safeParse(item);
        const document = failure.success ? (failure.data.document ?? ``).trim() : ``;
        const detail = failure.success ? (failure.data.detail ?? ``).trim() : ``;
        return document === `` && detail === `` ? [] : [{ document, detail }];
    });

/* The planner's answer as a verdict. Pure. Only a plan that says `"ok": false` in so many words refuses for what it
 * says; a planner that exited on an error, answered nothing, or answered what is not a plan of the format this platform
 * reads refuses as broken. What is not the planner's fault stays "no plan": an image from before the engine (node
 * cannot find the planner at all) and a plan in a format newer than this platform reads. */
export const readPlanAnswer = (answer: FlyExecAnswer): HostedPlanVerdict => {
    if (answer.exitCode !== 0) {
        // The planner's own path, quoted, as node names the module it could not find: a module the planner imports and the
        // image lacks names that module instead (`Cannot find module '…/x.js' imported from …/state-plan.js`), and that
        // image is broken, not old (_sandbox/ic/src/sandbox/preflight.rs predates_engine).
        if (answer.stderr.includes(`Cannot find module '${STATE_PLANNER}'`)) {
            return { kind: `unknown`, reason: `the image predates the state-conversion engine` };
        }
        const error = answer.stderr
            .split(`\n`)
            .map((line) => line.trim())
            .findLast((line) => line.includes(`Error`));
        return { kind: `broken`, reason: `the planner exited with status ${answer.exitCode}${error === undefined ? `` : `: ${clip(error, 200)}`}` };
    }
    const line = lastLine(answer.stdout);
    if (line === undefined) {
        return { kind: `broken`, reason: `the planner answered nothing` };
    }
    let parsed: z.infer<typeof PlanLineSchema>;
    try {
        parsed = PlanLineSchema.parse(JSON.parse(line));
    } catch {
        return { kind: `broken`, reason: `the planner's answer is not a plan: ${clip(line, 120)}` };
    }
    if (parsed.plan === undefined) {
        return { kind: `broken`, reason: `the planner's answer names no plan format` };
    }
    if (parsed.plan !== STATE_PLAN_FORMAT) {
        return { kind: `unknown`, reason: `the planner answered plan format ${parsed.plan}, which this platform does not read` };
    }
    const version = parsed.version ?? `the new version`;
    if (parsed.ok === false) {
        return { kind: `refused`, version, failures: failuresOf(parsed.failures) };
    }
    return parsed.ok === true ? { kind: `clear`, version } : { kind: `broken`, reason: `the planner's plan does not say whether it would succeed` };
};

/* HOW THE OWNER'S MESSAGES NAME A CHANGE: the version it moves to and the move itself. An update by default; the
 * owner's rollback moves to an earlier version, which "the new version" would misname. */
export interface HostedChangeWords {
    readonly target: string;
    readonly change: string;
}
const UPDATE_WORDS: HostedChangeWords = { target: `the new version`, change: `update` };
export const ROLLBACK_WORDS: HostedChangeWords = { target: `the earlier version`, change: `rollback` };

// The refusal the owner reads: what failed, and that nothing was converted.
const refusalMessage = (version: string, failures: readonly PlanFailure[], words: HostedChangeWords): string => {
    const named = failures.map((failure) => (failure.detail === `` ? failure.document : `${failure.document === `` ? `(unnamed document)` : failure.document}: ${failure.detail}`));
    return `intentic ${version} cannot convert this sandbox's stored state, so the ${words.change} was stopped before it began and the sandbox stays on the version it had${named.length === 0 ? `` : ` (${named.join(`; `)})`}`;
};

// A planner that broke: what it did, and that nothing was converted.
const brokenMessage = (reason: string, words: HostedChangeWords): string =>
    `${words.target} could not check this sandbox's stored state (${reason}), so the ${words.change} was stopped before it began and the sandbox stays on the version it had`;

// The image a config replacement keeps when it must not change what runs: the config's own image when it names a
// digest, else the digest that tag resolved to when the machine last started, so a re-resolved tag cannot move it.
export const pinnedImage = (image: string, digest: string | undefined): string =>
    image.includes(`@sha256:`) || digest === undefined || digest === `` ? image : `${image.replace(/:[^/:@]+$/, ``)}@${digest}`;

// The target config as a probe: same image and volume, the daemon's entrypoint replaced by a sleep so nothing boots and
// nothing converts, no restart. Its environment is the marker and the project folder alone: the platform's credentials
// (the connect token, the tunnel grant) stay out of a machine that has a network and a writable volume, and the planner
// reads none of them, as ic's probe is given none. The marker holds the image the machine ran before, so a gate that died
// mid-probe still knows what to go back to; the folder is no credential, and the config that replaces a dead probe
// reads it back off this one (../hosted-project.ts).
export const probeConfig = (target: FlyMachineConfig, previousImage: string): FlyMachineConfig => {
    const env: FlyMachineConfig[`env`] = { [STATE_PROBE_ENV]: previousImage };
    const project = target.env[ENV_PROJECT_DIR];
    if (project !== undefined) {
        env[ENV_PROJECT_DIR] = project;
    }
    return {
        ...target,
        env,
        // The image's CMD, if it has one, lands after `--` as the shell's positional parameters and is never run.
        init: { entrypoint: [`/bin/sh`, `-c`, `sleep ${PROBE_SECONDS}`, `--`] },
        restart: { policy: `no` },
    };
};

interface HostedGateMachine {
    readonly appName: string;
    readonly machineId: string;
}

// Reads the machine until it says `wanted`, bounded. Answers that reading, or the last one when it never did (undefined
// when none answered): the caller decides what a machine that would not settle means.
const settleTo = async (config: Config, machine: HostedGateMachine, wanted: string): Promise<FlyMachineCurrent | undefined> => {
    let last: FlyMachineCurrent | undefined;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
        // allow(silent-catch): an unanswered read is one more attempt; the bound decides, not the refusal
        // oxlint-disable-next-line eslint/no-await-in-loop -- settling is sequential by definition
        const read = await getMachineConfig(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
        last = read ?? last;
        if (read?.state === wanted) {
            return read;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await delay(SETTLE_MS);
    }
    return last;
};

// Stops a machine and waits until it reads stopped, so the next config replacement leaves it stopped rather than
// restarting it. Bounded: a machine that will not say so is replaced anyway.
const stopAndSettle = async (config: Config, machine: HostedGateMachine): Promise<void> => {
    // allow(silent-catch): a refused stop (a probe that already exited) is judged by the state read below, not by the refusal
    await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    await settleTo(config, machine, `stopped`);
};

// What a probe learned: the verdict, and the image it ran, pinned to the digest Fly resolved it to.
interface Probed {
    readonly verdict: HostedPlanVerdict;
    readonly image: string;
}

/* Runs the target image's planner over this machine's volume, and leaves the machine stopped on the probe config. Any
 * way it can fail short of the planner's own answer is an `unknown` verdict, never a throw: the caller's fail-safe
 * decides what that means. */
const preflightHosted = async (config: Config, machine: HostedGateMachine, target: FlyMachineConfig, previousImage: string): Promise<Probed> => {
    const { flyApiToken } = config.hosted;
    try {
        await updateMachine(flyApiToken, machine.appName, machine.machineId, probeConfig(target, previousImage));
        await startAfterUpdate(config, machine);
        // startAfterUpdate counts `starting` as running, which a daemon's start may; Fly runs a command only in a machine
        // that reads `started`, and an exec sent sooner fails as if the planner had.
        const probe = await settleTo(config, machine, `started`);
        if (probe?.state !== `started`) {
            return { verdict: { kind: `unknown`, reason: `the probe never came up (it last read ${probe?.state ?? `nothing`})` }, image: target.image };
        }
        const image = pinnedImage(target.image, probe.imageDigest);
        return { verdict: readPlanAnswer(await execMachine(flyApiToken, machine.appName, machine.machineId, PLAN_COMMAND, PLAN_SECONDS)), image };
    } catch (error) {
        return { verdict: { kind: `unknown`, reason: `the probe could not run: ${errorMessage(error)}` }, image: target.image };
    } finally {
        await stopAndSettle(config, machine);
    }
};

// The two versions a change moves between, named in every line about it.
interface HostedChange {
    readonly machine: HostedGateMachine;
    readonly previousImage: string;
    readonly targetImage: string;
}

// How this machine's config reads around another image and the overlay recipe it carries (null: the stock image): what
// going back to a version Fly no longer holds a config for needs. Without it the config the machine holds is kept
// around the image, which runs the right version with the wrong recipe named.
export type HostedComposer = (image: string, environmentHash: string | null) => FlyMachineConfig;

export interface HostedSwitchOptions {
    // Leave the machine running at the end, on whichever config it ends on.
    readonly start: boolean;
    // On a refusal, apply the target config on the image the machine already runs, rather than its whole previous
    // config: for a change whose config is worth having without its image (a restart's fresh grant, a wake's tunnel).
    readonly keepImage?: boolean;
    // When another change holds this machine: wait for it (the default), or answer HostedMachineBusy at once.
    readonly busy?: "wait" | "refuse";
    // The machine's row (gate-row.ts): what it keeps is read and written, a failed rollback is stamped on it, and the
    // sandbox's check-in is waited for. Without it the gate keeps nothing and waits for no check-in.
    readonly record?: HostedGateRecord | undefined;
    readonly compose?: HostedComposer | undefined;
    // What the row says beside the target image once it holds it; the row's own facts stay when absent.
    readonly facts?: HostedImageFacts | undefined;
    // The platform digest later restarts must not move this machine onto (the owner's rollback, the one it leaves);
    // absent, a change of digest clears the one kept.
    readonly skip?: string | null | undefined;
    readonly words?: HostedChangeWords | undefined;
    readonly logger?: Logger | undefined;
}

// A machine left on neither version, as loudly as this can say it: an error line naming both images, and the row
// stamped so the health sweep reports and mails it until the machine checks in again.
const strand = async (change: HostedChange, error: Error, options: HostedSwitchOptions): Promise<void> => {
    const { machine, previousImage, targetImage } = change;
    options.logger?.error(
        { err: error, app: machine.appName, machineId: machine.machineId, previousImage, targetImage },
        `hosted image gate: putting the previous version back failed; the machine is on neither version and needs a person`,
    );
    const { record } = options;
    if (record === undefined) {
        return;
    }
    try {
        await record.prisma.hostedMachine.update({
            where: { id: record.hostedMachineId },
            data: { strandedAt: new Date(), strandedDetail: `moving ${previousImage} to ${targetImage}, putting the previous version back failed: ${clip(error.message, 400)}` },
        });
    } catch (failure) {
        options.logger?.error({ err: failure, app: machine.appName }, `hosted image gate: recording the stranded machine failed; only the line above says so`);
    }
};

// Puts a config the machine can run back, and starts it when asked. Answers whether it is running there.
const restore = async (config: Config, change: HostedChange, back: FlyMachineConfig, start: boolean, options: HostedSwitchOptions): Promise<boolean> => {
    const { machine } = change;
    try {
        await updateMachine(config.hosted.flyApiToken, machine.appName, machine.machineId, back);
        if (start) {
            await startAfterUpdate(config, machine);
        }
        return start;
    } catch (error) {
        await strand(change, error instanceof Error ? error : new Error(String(error)), options);
        return false;
    }
};

// The image a machine runs, pinned: a dead gate's probe marker names the one it ran before the probe.
const imageBefore = (current: FlyMachineCurrent): string => {
    const marked = current.config.env[STATE_PROBE_ENV];
    return marked !== undefined && marked !== `` ? marked : pinnedImage(current.config.image, current.imageDigest);
};

/* THE IMAGE A MACHINE RUNS, as a digest: what a config replacement passes as its stock image when it must not change
 * the version (a resize, a move, a restore from the trash), so it has no state to convert and nothing to ask. */
export const runningImageOf = async (config: Config, machine: HostedGateMachine): Promise<string> =>
    imageBefore(await getMachineConfig(config.hosted.flyApiToken, machine.appName, machine.machineId));

/* A VERSION TO GO BACK TO: the image, its recipe, and the config to put back around them. `fromRow` when it came off the
 * machine's row because the image the machine holds is on trial, which going back has to write down too. */
interface Version extends KeptImage {
    readonly config: FlyMachineConfig;
    readonly fromRow: boolean;
}

// What the machine holds now, as the version a change leaves. A probe left by a gate that died is never the config to go
// back to: the target's config is put around the image its marker names.
const heldOf = (current: FlyMachineCurrent, target: FlyMachineConfig, kept: KeptVersions): Version => {
    const image = imageBefore(current);
    const config = current.config.env[STATE_PROBE_ENV] === undefined ? { ...current.config, image } : { ...target, image };
    return { image, environmentHash: kept.image === image ? kept.environmentHash : null, config, fromRow: false };
};

// What a change goes back to when its target fails: the version the machine holds, unless that is on trial and the row
// keeps the one before it, which is then composed around the machine's config.
const lastGoodOf = (held: Version, kept: KeptVersions, compose: HostedComposer | undefined): Version => {
    const { previous } = kept;
    if (kept.unprovenImage !== held.image || previous === undefined) {
        return held;
    }
    return { ...previous, config: compose?.(previous.image, previous.environmentHash) ?? { ...held.config, image: previous.image }, fromRow: true };
};

// The versions one change works with, read before it touches anything.
interface Versions {
    readonly held: Version;
    readonly lastGood: Version;
}

/* THE ROW ONCE THE MACHINE HOLDS `target`, running and seen healthy, or ON TRIAL. The way back is the last version seen
 * good, unless the target is that very version (the owner going back while the image held was on trial), when it is
 * the one left. A way back that is not pinned is no way back: a tag would re-resolve to whatever it names by then. */
const noteChange = async (target: string, versions: Versions, change: { readonly onTrial: boolean; readonly moved: boolean }, options: HostedSwitchOptions): Promise<void> => {
    const way = versions.lastGood.image === target ? versions.held : versions.lastGood;
    const previousImage = way.image.includes(`@sha256:`) ? way.image : null;
    const data: Prisma.HostedMachineUpdateInput = {
        previousImage,
        previousEnvironmentHash: previousImage === null ? null : way.environmentHash,
        unprovenImage: change.onTrial && previousImage !== null ? target : null,
    };
    if (options.skip !== undefined) {
        data.skippedDigest = options.skip;
    } else if (change.moved) {
        data.skippedDigest = null;
    }
    if (options.facts !== undefined) {
        Object.assign(data, imageColumns(target, options.facts));
    }
    await writeKept(options.record, data, options.logger);
};

// Back on the version kept before an image on trial: the row names it again, and keeps nothing before it.
const noteBack = async (lastGood: Version, options: HostedSwitchOptions): Promise<void> => {
    await writeKept(
        options.record,
        {
            previousImage: null,
            previousEnvironmentHash: null,
            unprovenImage: null,
            ...imageColumns(lastGood.image, { environmentHash: lastGood.environmentHash, baseImage: null, baseDigest: null }),
        },
        options.logger,
    );
};

// The version moved to did not come up: back onto the last good one, running, and the owner told which of the two it is on.
const rollBack = async (config: Config, change: HostedChange, lastGood: Version, headline: string, failure: Error, options: HostedSwitchOptions): Promise<never> => {
    options.logger?.error(
        { err: failure, app: change.machine.appName, previousImage: lastGood.image, targetImage: change.targetImage },
        `hosted image gate: ${headline}; putting the previous one back`,
    );
    const back = await restore(config, change, lastGood.config, true, options);
    if (back && lastGood.fromRow) {
        await noteBack(lastGood, options);
    }
    throw new HostedImageKept(
        back
            ? `${headline}, so the sandbox was put back on the version it had: ${failure.message}`
            : `${headline}, and putting the previous version back failed too: ${failure.message}`,
        `rolled-back`,
        back,
        { cause: failure },
    );
};

// Starts the machine on the config it holds and waits for its daemon. A start Fly will not make throws, as
// startAfterUpdate does; everything after the start is the verdict.
const startAndWait = async (config: Config, machine: HostedGateMachine, options: HostedSwitchOptions): Promise<DaemonVerdict> => {
    const baseline = await baselineOf(config, machine);
    const checkedIn = options.record === undefined ? undefined : await checkInSince(options.record, options.logger);
    await startAfterUpdate(config, machine);
    return awaitDaemon(config, machine, baseline, checkedIn);
};

// The version a target that did not come up goes back to: the last good one, unless that is the target itself (the
// owner going back to the version before an image on trial), when it is the image the machine held. Putting the
// version that just failed back would leave the machine on it, and the row would forget the one it came from.
const wayBackFrom = (versions: Versions, targetImage: string): Version => (versions.lastGood.image === targetImage ? versions.held : versions.lastGood);

/* THE MACHINE HOLDS `target` AND IS TO RUN IT: started, its daemon waited for, the row told what came of it. A version
 * that does not come up goes back to the last good one (wayBackFrom); a wait someone stopped leaves it on trial. */
const runAndJudge = async (config: Config, change: HostedChange, versions: Versions, moved: boolean, options: HostedSwitchOptions): Promise<void> => {
    const words = options.words ?? UPDATE_WORDS;
    const { targetImage } = change;
    const back = wayBackFrom(versions, targetImage);
    let verdict: DaemonVerdict;
    try {
        verdict = await startAndWait(config, change.machine, options);
    } catch (error) {
        return rollBack(config, change, back, `${words.target} did not start`, error instanceof Error ? error : new Error(String(error)), options);
    }
    if (verdict.kind === `down`) {
        return rollBack(config, change, back, `${words.target} did not come up`, new Error(verdict.reason), options);
    }
    if (verdict.kind === `interrupted`) {
        options.logger?.warn(
            { app: change.machine.appName, image: targetImage, reason: verdict.reason },
            `hosted image gate: the machine was stopped before its daemon could be judged; the version stays on trial for its next start`,
        );
    } else if (verdict.slow) {
        options.logger?.warn({ app: change.machine.appName, image: targetImage }, `hosted image gate: the daemon is still booting after its budget; kept as a slow boot`);
    }
    return noteChange(targetImage, versions, { onTrial: verdict.kind === `interrupted`, moved }, options);
};

// Puts the version the machine held back after a refusal, and starts it when asked: judged, when it is itself on trial.
const keepHeld = async (config: Config, change: HostedChange, back: FlyMachineConfig, versions: Versions, options: HostedSwitchOptions): Promise<boolean> => {
    if (!options.start || !versions.lastGood.fromRow) {
        return restore(config, change, back, options.start, options);
    }
    if (!(await restore(config, change, back, false, options))) {
        return false;
    }
    await runAndJudge(config, { ...change, targetImage: versions.held.image }, versions, false, options);
    return true;
};

// Throws HostedImageKept for a plan that refuses or a planner that broke, after putting the machine back; logs "no plan".
const refuseUnlessClear = async (
    config: Config,
    change: HostedChange,
    probed: Probed,
    target: FlyMachineConfig,
    versions: Versions,
    options: HostedSwitchOptions,
): Promise<void> => {
    const { verdict } = probed;
    const { logger } = options;
    if (verdict.kind === `clear`) {
        return;
    }
    if (verdict.kind === `unknown`) {
        logger?.warn({ app: change.machine.appName, image: target.image, reason: verdict.reason }, `hosted image gate: no state plan; switching as before the gate`);
        return;
    }
    logger?.warn(
        { app: change.machine.appName, image: target.image, ...(verdict.kind === `refused` ? { failures: verdict.failures } : { reason: verdict.reason }) },
        `hosted image gate: the target cannot convert this sandbox's state, or could not say; the machine keeps its version`,
    );
    const back = options.keepImage === true ? { ...target, image: versions.held.image } : versions.held.config;
    const running = await keepHeld(config, change, back, versions, options);
    const words = options.words ?? UPDATE_WORDS;
    throw new HostedImageKept(
        verdict.kind === `refused` ? refusalMessage(verdict.version, verdict.failures, words) : brokenMessage(verdict.reason, words),
        `refused`,
        running,
    );
};

// A target named by a tag, pinned to the digest the registry holds for it now, so the probe and the switch after it
// run the same image. A registry that will not say leaves the tag, and the digest the probe ran pins it instead.
const pinTarget = async (target: FlyMachineConfig, logger: Logger | undefined): Promise<FlyMachineConfig> => {
    const ref = parseImageRef(target.image);
    if (target.image.includes(`@sha256:`) || ref === undefined) {
        return target;
    }
    // allow(silent-catch): an unreachable registry is the same answer as no digest, logged below
    const digest = await digestOf(ref).catch(() => undefined);
    if (digest === undefined) {
        logger?.warn({ image: target.image }, `hosted image gate: the target's tag did not resolve to a digest; the probe's own digest will pin it`);
        return target;
    }
    return { ...target, image: `${ref.registry}/${ref.repository}@${digest}` };
};

// The same digest converts nothing: a plain replacement, as before the gate, whose start is judged only when that
// digest is on trial.
const switchInPlace = async (config: Config, machine: HostedGateMachine, pinned: FlyMachineConfig, versions: Versions, options: HostedSwitchOptions): Promise<void> => {
    await updateMachine(config.hosted.flyApiToken, machine.appName, machine.machineId, pinned);
    if (options.facts !== undefined) {
        await writeKept(options.record, imageColumns(pinned.image, options.facts), options.logger);
    }
    if (!options.start) {
        return;
    }
    if (!versions.lastGood.fromRow) {
        await startAfterUpdate(config, machine);
        return;
    }
    await runAndJudge(config, { machine, previousImage: versions.lastGood.image, targetImage: pinned.image }, versions, false, options);
};

const gateAndSwitch = async (config: Config, machine: HostedGateMachine, requested: FlyMachineConfig, options: HostedSwitchOptions): Promise<void> => {
    const { flyApiToken } = config.hosted;
    const [current, kept] = await Promise.all([getMachineConfig(flyApiToken, machine.appName, machine.machineId), keptVersionsOf(options.record)]);
    const held = heldOf(current, requested, kept);
    const versions: Versions = { held, lastGood: lastGoodOf(held, kept, options.compose) };
    const pinned = await pinTarget(requested, options.logger);
    if (pinned.image === held.image && pinned.image.includes(`@sha256:`)) {
        await switchInPlace(config, machine, pinned, versions, options);
        return;
    }
    const probed = await preflightHosted(config, machine, pinned, held.image);
    const target = { ...pinned, image: probed.image };
    const change: HostedChange = { machine, previousImage: versions.lastGood.image, targetImage: target.image };
    await refuseUnlessClear(config, change, probed, target, versions, options);
    await updateMachine(flyApiToken, machine.appName, machine.machineId, target);
    if (!options.start) {
        await noteChange(target.image, versions, { onTrial: true, moved: true }, options);
        return;
    }
    await runAndJudge(config, change, versions, true, options);
};

/* REPLACES A MACHINE'S CONFIG WITH `target` UNDER THE STATE GATE (see the header), holding the app's lock throughout.
 * Throws HostedImageKept when the machine stays on the version it had, and HostedMachineBusy when asked not to wait. */
export const switchHostedImage = async (config: Config, machine: HostedGateMachine, target: FlyMachineConfig, options: HostedSwitchOptions): Promise<void> => {
    const done = await withHostedAppLock(config, machine.appName, options.busy !== `refuse`, async () => {
        await gateAndSwitch(config, machine, target, options);
        return true;
    });
    if (done === undefined) {
        throw new HostedMachineBusy(`this sandbox is being changed right now (a restart, a rebuild or a move); try again in a moment`);
    }
};

/* STARTS A MACHINE WHOSE IMAGE IS ON TRIAL, and judges it: the wake of a machine a rebuild was applied to while it slept.
 * The same wait and the same way back as a change's own start. Under the app's lock without waiting, like the wake's
 * heal: HostedMachineBusy when another change holds the machine. One no longer on trial once the lock is held (another
 * start judged it meanwhile) is simply started. */
export const startOnTrial = async (
    config: Config,
    machine: HostedGateMachine,
    options: Omit<HostedSwitchOptions, "start" | "busy" | "facts" | "skip" | "keepImage">,
): Promise<void> => {
    const done = await withHostedAppLock(config, machine.appName, false, async () => {
        const [current, kept] = await Promise.all([getMachineConfig(config.hosted.flyApiToken, machine.appName, machine.machineId), keptVersionsOf(options.record)]);
        const held = heldOf(current, current.config, kept);
        const versions: Versions = { held, lastGood: lastGoodOf(held, kept, options.compose) };
        if (!versions.lastGood.fromRow) {
            await startAfterUpdate(config, machine);
            return true;
        }
        await runAndJudge(config, { machine, previousImage: versions.lastGood.image, targetImage: held.image }, versions, false, { ...options, start: true });
        return true;
    });
    if (done === undefined) {
        throw new HostedMachineBusy(`this sandbox is being changed right now (a restart, a rebuild or a move); try again in a moment`);
    }
};

export { type HostedGateRecord, type HostedImageFacts, STOCK_FACTS } from "./gate-row.js";
