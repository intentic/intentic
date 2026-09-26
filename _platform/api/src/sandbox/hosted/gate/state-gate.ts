import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@intentic/prisma";
import { type PlanFailure, PlanFailureSchema, STATE_PLAN_FORMAT } from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, type FlyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { digestOf, parseImageRef } from "../build/hosted-image.js";
import { execMachine, type FlyExecAnswer, type FlyMachineCurrent, getMachineConfig, stopMachine, updateMachine } from "../fly/fly.js";
import { withHostedAppLock } from "../hosted-app-lock.js";
import { startAfterUpdate } from "./start-after-update.js";

/* A HOSTED IMAGE CHANGE ASKS THE TARGET IMAGE FIRST, AND PUTS THE MACHINE BACK WHEN THE NEW ONE WILL NOT START.
 *
 * The self-hosted update runs the target image's own planner (`state-plan.js`, the daemon's conversion engine run
 * without writing) over the sandbox's data before it swaps anything (_sandbox/ic/src/sandbox/preflight.rs). A Fly
 * volume attaches to one machine, so the hosted planner runs on that machine: its config is replaced by a probe (the
 * target image, the same volume, the daemon's entrypoint swapped for a sleep, no front door, no restart), the planner is
 * run in it through Fly's exec, and the machine is stopped again. Then:
 *
 * - `ok: false` puts the previous config back (or, for a caller that asks `keepImage`, the target config on the image
 *   the machine already runs), starts it again when the caller asked for a running machine, and throws HostedImageKept
 *   with the failures in the owner's words. Nothing on the volume was converted.
 * - `ok: true` applies the target config.
 * - no plan at all (an image from before the engine, a probe that would not start, a planner that failed or hung, an
 *   answer in no format this reads) applies the target config too, as every image change did before this gate: a
 *   question an image cannot answer must not cost an update that would have worked. It is logged.
 *
 * Either way, a machine asked to start that does not start on the target is put back on the config it had, pinned to
 * the digest it was running, and started there (HostedImageKept again). An episode the new build opened and never
 * committed is restored by the previous build's own boot (state-journal.ts), so the files go back with the image.
 *
 * A config replacement that keeps the running digest converts nothing, so it skips the probe. A crash between the probe
 * and the final config leaves the probe's marker in the machine's environment, naming the image it ran before: the wake
 * reads it as a config to re-apply (../hosted.ts), and the next gate as the version to go back to.
 *
 * ONE CHANGE AT A TIME. The whole gate, probe to final start, runs under the app's lock (../hosted-app-lock.ts), the one
 * migrate and cleanup take: a second gate on the same machine would replace the first one's probe under its exec, and
 * that exec's failure reads as "no plan", which goes ahead, so a refusal would be lost. A restart and a rebuild wait
 * their turn; a wake does not wait (it is the browser's reflex, repeated on its own) and answers HostedMachineBusy.
 *
 * WHAT THE PROBE CANNOT PROMISE. ic's probe mounts the data `:ro` with `--network none`. Fly has neither a read-only
 * volume mount nor a machine without a network, so here the volume is mounted read-write and the probe can reach the
 * internet. What stands in for both: the one command it runs is the planner, fixed argv with no shell, and the planner
 * has no write mode to select (state-plan.ts learns the version stamp with `write: false` and prints a plan; there is no
 * `--plan` flag because planning is all it does); the probe's environment carries none of the platform's credentials,
 * as ic's carries none; and nothing else boots.
 *
 * WHAT THE ROLLBACK DOES NOT COVER. A start counts as success once Fly reads the machine `starting` or `started`: the
 * daemon's `/health` and its state journal are not waited for, so a version whose machine starts and whose daemon then
 * fails to boot stays on that version: nothing here puts it back. A machine asked to stay stopped
 * (a rebuild applied while it sleeps) is never started, so nothing is judged and nothing is rolled back. A rollback that
 * itself fails is logged at error and recorded on the machine's row, which hosted health reports and mails
 * (../hosted-health.ts) until the machine checks in again. */

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
    | { readonly kind: "unknown"; readonly reason: string };

// Read loosely, like ic: a refusal that lost a failure to a missing field would stop an update for a reason it cannot show.
const PlanLineSchema = z.object({
    plan: z.unknown().optional(),
    ok: z.unknown().optional(),
    version: z.string().optional(),
    failures: z.array(z.unknown()).optional(),
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

/* The planner's answer as a verdict. Pure, and tolerant where tolerance is safe: only a plan that says `"ok": false`
 * in so many words refuses. The same reading as preflight.rs's `verdict` and `read_plan`. */
export const readPlanAnswer = (answer: FlyExecAnswer): HostedPlanVerdict => {
    if (answer.exitCode !== 0) {
        if (answer.stderr.includes(`Cannot find module`) && answer.stderr.includes(STATE_PLANNER)) {
            return { kind: `unknown`, reason: `the image predates the state-conversion engine` };
        }
        const error = answer.stderr
            .split(`\n`)
            .map((line) => line.trim())
            .findLast((line) => line.includes(`Error`));
        return { kind: `unknown`, reason: `the planner exited with status ${answer.exitCode}${error === undefined ? `` : `: ${clip(error, 200)}`}` };
    }
    const line = lastLine(answer.stdout);
    if (line === undefined) {
        return { kind: `unknown`, reason: `the planner answered nothing` };
    }
    let parsed: z.infer<typeof PlanLineSchema>;
    try {
        parsed = PlanLineSchema.parse(JSON.parse(line));
    } catch {
        return { kind: `unknown`, reason: `the planner's answer is not a plan: ${clip(line, 120)}` };
    }
    if (parsed.plan !== STATE_PLAN_FORMAT) {
        return { kind: `unknown`, reason: `the planner answered plan format ${String(parsed.plan)}, which this platform does not read` };
    }
    const version = parsed.version ?? `the new version`;
    if (parsed.ok === false) {
        return { kind: `refused`, version, failures: failuresOf(parsed.failures) };
    }
    return parsed.ok === true ? { kind: `clear`, version } : { kind: `unknown`, reason: `the planner's plan does not say whether it would succeed` };
};

// The refusal the owner reads: what failed, and that nothing was converted.
const refusalMessage = (version: string, failures: readonly PlanFailure[]): string => {
    const named = failures.map((failure) => (failure.detail === `` ? failure.document : `${failure.document === `` ? `(unnamed document)` : failure.document}: ${failure.detail}`));
    return `intentic ${version} cannot convert this sandbox's stored state, so the update was stopped before it began and the sandbox stays on the version it had${named.length === 0 ? `` : ` (${named.join(`; `)})`}`;
};

// The image a config replacement keeps when it must not change what runs: the config's own image when it names a
// digest, else the digest that tag resolved to when the machine last started, so a re-resolved tag cannot move it.
export const pinnedImage = (image: string, digest: string | undefined): string =>
    image.includes(`@sha256:`) || digest === undefined || digest === `` ? image : `${image.replace(/:[^/:@]+$/, ``)}@${digest}`;

// The target config as a probe: same image and volume, the daemon's entrypoint replaced by a sleep so nothing boots and
// nothing converts, no front door, no restart. Its environment is the marker alone: the platform's credentials (the
// connect token, the tunnel grant) stay out of a machine that has a network and a writable volume, and the planner reads
// none of them, as ic's probe is given none. The marker holds the image the machine ran before, so a gate that died
// mid-probe still knows what to go back to.
export const probeConfig = (target: FlyMachineConfig, previousImage: string): FlyMachineConfig => {
    const { services: _services, checks: _checks, ...rest } = target;
    return {
        ...rest,
        env: { [STATE_PROBE_ENV]: previousImage },
        // The image's CMD, if it has one, lands after `--` as the shell's positional parameters and is never run.
        init: { entrypoint: [`/bin/sh`, `-c`, `sleep ${PROBE_SECONDS}`, `--`] },
        restart: { policy: `no` },
    };
};

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
 * way it can fail is an `unknown` verdict, never a throw: the caller's fail-safe decides what that means. */
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
        return { verdict: { kind: `unknown`, reason: `the probe could not run: ${error instanceof Error ? error.message : String(error)}` }, image: target.image };
    } finally {
        await stopAndSettle(config, machine);
    }
};

interface HostedGateMachine {
    readonly appName: string;
    readonly machineId: string;
}

// Where a machine the gate could not put back is written down: its row, which hosted health reads (../hosted-health.ts).
export interface HostedStrandingRecord {
    readonly prisma: PrismaClient;
    readonly hostedMachineId: string;
}

// The two versions a change moves between, named in every line about it.
interface HostedChange {
    readonly machine: HostedGateMachine;
    readonly previousImage: string;
    readonly targetImage: string;
}

// A machine left on neither version, as loudly as this can say it: an error line naming both images, and the row
// stamped so the health sweep reports and mails it until the machine checks in again.
const strand = async (change: HostedChange, error: Error, options: HostedSwitchOptions): Promise<void> => {
    const { machine, previousImage, targetImage } = change;
    options.logger?.error(
        { err: error, app: machine.appName, machineId: machine.machineId, previousImage, targetImage },
        `hosted image gate: putting the previous version back failed; the machine is on neither version and needs a person`,
    );
    const { stranding } = options;
    if (stranding === undefined) {
        return;
    }
    try {
        await stranding.prisma.hostedMachine.update({
            where: { id: stranding.hostedMachineId },
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

// What the machine ran before this change, and the config to go back to. A probe left by a gate that died is never
// that config: the target's config is put around the image its marker names.
interface PreviousMachine {
    readonly image: string;
    readonly config: FlyMachineConfig;
}
const previousOf = (current: FlyMachineCurrent, target: FlyMachineConfig): PreviousMachine => {
    const image = imageBefore(current);
    return { image, config: current.config.env[STATE_PROBE_ENV] === undefined ? { ...current.config, image } : { ...target, image } };
};

interface HostedSwitchOptions {
    // Leave the machine running at the end, on whichever config it ends on.
    readonly start: boolean;
    // On a refusal, apply the target config on the image the machine already runs, rather than its whole previous
    // config: for a change whose config is worth having without its image (a restart's fresh grant, a wake's tunnel).
    readonly keepImage?: boolean;
    // When another change holds this machine: wait for it (the default), or answer HostedMachineBusy at once.
    readonly busy?: "wait" | "refuse";
    // The row a failed rollback is recorded on; without it the error line is all there is.
    readonly stranding?: HostedStrandingRecord | undefined;
    readonly logger?: Logger | undefined;
}

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

// The new version did not start: back onto the one it had, running, and the owner told which of the two it is on.
const rollBack = async (config: Config, change: HostedChange, previous: FlyMachineConfig, error: Error, options: HostedSwitchOptions): Promise<never> => {
    options.logger?.error(
        { err: error, app: change.machine.appName, previousImage: change.previousImage, targetImage: change.targetImage },
        `hosted image gate: the new version did not start; putting the previous one back`,
    );
    const back = await restore(config, change, previous, true, options);
    throw new HostedImageKept(
        back
            ? `the new version did not start, so the sandbox was put back on the version it had: ${error.message}`
            : `the new version did not start, and putting the previous version back failed too: ${error.message}`,
        `rolled-back`,
        back,
        { cause: error },
    );
};

const gateAndSwitch = async (config: Config, machine: HostedGateMachine, requested: FlyMachineConfig, options: HostedSwitchOptions): Promise<void> => {
    const { flyApiToken } = config.hosted;
    const { start, logger } = options;
    const previous = previousOf(await getMachineConfig(flyApiToken, machine.appName, machine.machineId), requested);
    const pinned = await pinTarget(requested, logger);
    // The same digest converts nothing: a plain replacement, as before the gate.
    if (pinned.image === previous.image && pinned.image.includes(`@sha256:`)) {
        await updateMachine(flyApiToken, machine.appName, machine.machineId, pinned);
        if (start) {
            await startAfterUpdate(config, machine);
        }
        return;
    }
    const probed = await preflightHosted(config, machine, pinned, previous.image);
    const target = { ...pinned, image: probed.image };
    const { verdict } = probed;
    const change: HostedChange = { machine, previousImage: previous.image, targetImage: target.image };
    if (verdict.kind === `refused`) {
        logger?.warn(
            { app: machine.appName, image: target.image, failures: verdict.failures },
            `hosted image gate: the target cannot convert this sandbox's state; the machine keeps its version`,
        );
        const back = await restore(config, change, options.keepImage === true ? { ...target, image: previous.image } : previous.config, start, options);
        throw new HostedImageKept(refusalMessage(verdict.version, verdict.failures), `refused`, back);
    }
    if (verdict.kind === `unknown`) {
        logger?.warn({ app: machine.appName, image: target.image, reason: verdict.reason }, `hosted image gate: no state plan; switching as before the gate`);
    }
    await updateMachine(flyApiToken, machine.appName, machine.machineId, target);
    if (!start) {
        return;
    }
    try {
        await startAfterUpdate(config, machine);
    } catch (error) {
        await rollBack(config, change, previous.config, error instanceof Error ? error : new Error(String(error)), options);
    }
};
