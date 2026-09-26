import { setTimeout as delay } from "node:timers/promises";
import { type PlanFailure, PlanFailureSchema, STATE_PLAN_FORMAT } from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, type FlyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { execMachine, type FlyExecAnswer, type FlyMachineCurrent, getMachine, getMachineConfig, stopMachine, updateMachine } from "../fly/fly.js";
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
 * reads it as a config to re-apply (../hosted.ts), and the next gate as the version to go back to. */

// The planner the target image carries; an image built before the conversion engine has none.
export const STATE_PLANNER = `/opt/sandbox/dist/state-plan.js`;
// Marks a probe config, so a wake that finds one re-applies the real config instead of starting a sleep.
export const STATE_PROBE_ENV = `INTENTIC_STATE_PROBE`;
// A plan reads a few JSON documents: past this it is a hang, and the answer is "no plan".
const PLAN_SECONDS = 60;
// The probe's own ceiling, should nothing come back to stop it; restart `no` leaves it stopped after.
const PROBE_SECONDS = 600;
// How long a stopped probe may take to read `stopped` before the final config is applied anyway.
const STOP_ATTEMPTS = 60;
const STOP_MS = 500;

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

export type HostedPlanVerdict =
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
export const refusalMessage = (version: string, failures: readonly PlanFailure[]): string => {
    const named = failures.map((failure) => (failure.detail === `` ? failure.document : `${failure.document === `` ? `(unnamed document)` : failure.document}: ${failure.detail}`));
    return `intentic ${version} cannot convert this sandbox's stored state, so the update was stopped before it began and the sandbox stays on the version it had${named.length === 0 ? `` : ` (${named.join(`; `)})`}`;
};

// The image a config replacement keeps when it must not change what runs: the config's own image when it names a
// digest, else the digest that tag resolved to when the machine last started, so a re-resolved tag cannot move it.
export const pinnedImage = (image: string, digest: string | undefined): string =>
    image.includes(`@sha256:`) || digest === undefined || digest === `` ? image : `${image.replace(/:[^/:@]+$/, ``)}@${digest}`;

// The target config as a probe: same image, volume and environment, the daemon's entrypoint replaced by a sleep so
// nothing boots and nothing converts, no front door, no restart. The marker holds the image the machine ran before, so a
// gate that died mid-probe still knows what to go back to.
export const probeConfig = (target: FlyMachineConfig, previousImage: string): FlyMachineConfig => {
    const { services: _services, checks: _checks, ...rest } = target;
    return {
        ...rest,
        env: { ...target.env, [STATE_PROBE_ENV]: previousImage },
        // The image's CMD, if it has one, lands after `--` as the shell's positional parameters and is never run.
        init: { entrypoint: [`/bin/sh`, `-c`, `sleep ${PROBE_SECONDS}`, `--`] },
        restart: { policy: `no` },
    };
};

// Stops a machine and waits until it reads stopped, so the next config replacement leaves it stopped rather than
// restarting it. Bounded: a machine that will not say so is replaced anyway.
const stopAndSettle = async (config: Config, machine: HostedGateMachine): Promise<void> => {
    // allow(silent-catch): a refused stop (a probe that already exited) is judged by the state read below, not by the refusal
    await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
        // allow(silent-catch): an unanswered read is one more attempt; the bound below applies the final config regardless
        // oxlint-disable-next-line eslint/no-await-in-loop -- settling is sequential by definition
        const read = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
        if (read?.state === `stopped`) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await delay(STOP_MS);
    }
};

/* Runs the target image's planner over this machine's volume, and leaves the machine stopped on the probe config. Any
 * way it can fail is an `unknown` verdict, never a throw: the caller's fail-safe decides what that means. */
export const preflightHosted = async (
    config: Config,
    machine: HostedGateMachine,
    target: FlyMachineConfig,
    previousImage: string,
): Promise<HostedPlanVerdict> => {
    const { flyApiToken } = config.hosted;
    try {
        await updateMachine(flyApiToken, machine.appName, machine.machineId, probeConfig(target, previousImage));
        await startAfterUpdate(config, machine);
        const answer = await execMachine(
            flyApiToken,
            machine.appName,
            machine.machineId,
            [`/usr/local/bin/node`, STATE_PLANNER, `--workspace`, FLY_VOLUME_LAYOUT.workspace, `--history`, FLY_VOLUME_LAYOUT.history],
            PLAN_SECONDS,
        );
        return readPlanAnswer(answer);
    } catch (error) {
        return { kind: `unknown`, reason: `the probe could not run: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
        await stopAndSettle(config, machine);
    }
};

export interface HostedGateMachine {
    readonly appName: string;
    readonly machineId: string;
}

// Puts a config the machine can run back, and starts it when asked. Answers whether it is running there.
const restore = async (config: Config, machine: HostedGateMachine, previous: FlyMachineConfig, start: boolean, logger: Logger | undefined): Promise<boolean> => {
    try {
        await updateMachine(config.hosted.flyApiToken, machine.appName, machine.machineId, previous);
        if (start) {
            await startAfterUpdate(config, machine);
        }
        return start;
    } catch (error) {
        logger?.error({ err: error, app: machine.appName }, `hosted image gate: putting the previous config back failed; the machine needs a person`);
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

export interface HostedSwitchOptions {
    // Leave the machine running at the end, on whichever config it ends on.
    readonly start: boolean;
    // On a refusal, apply the target config on the image the machine already runs, rather than its whole previous
    // config: for a change whose config is worth having without its image (a restart's fresh grant, a wake's tunnel).
    readonly keepImage?: boolean;
    readonly logger?: Logger | undefined;
}

/* REPLACES A MACHINE'S CONFIG WITH `target` UNDER THE STATE GATE (see the header). Throws HostedImageKept when the
 * machine stays on the version it had. */
export const switchHostedImage = async (config: Config, machine: HostedGateMachine, target: FlyMachineConfig, options: HostedSwitchOptions): Promise<void> => {
    const { flyApiToken } = config.hosted;
    const { start, logger } = options;
    const previous = previousOf(await getMachineConfig(flyApiToken, machine.appName, machine.machineId), target);
    // The same digest converts nothing: a plain replacement, as before the gate.
    if (target.image === previous.image && target.image.includes(`@sha256:`)) {
        await updateMachine(flyApiToken, machine.appName, machine.machineId, target);
        if (start) {
            await startAfterUpdate(config, machine);
        }
        return;
    }
    const verdict = await preflightHosted(config, machine, target, previous.image);
    if (verdict.kind === `refused`) {
        logger?.warn(
            { app: machine.appName, image: target.image, failures: verdict.failures },
            `hosted image gate: the target cannot convert this sandbox's state; the machine keeps its version`,
        );
        const back = await restore(config, machine, options.keepImage === true ? { ...target, image: previous.image } : previous.config, start, logger);
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
        logger?.error({ err: error, app: machine.appName, image: target.image }, `hosted image gate: the new version did not start; putting the previous one back`);
        const back = await restore(config, machine, previous.config, true, logger);
        const cause = error instanceof Error ? error.message : String(error);
        throw new HostedImageKept(
            back
                ? `the new version did not start, so the sandbox was put back on the version it had: ${cause}`
                : `the new version did not start, and putting the previous version back failed too: ${cause}`,
            `rolled-back`,
            back,
            { cause: error },
        );
    }
};
