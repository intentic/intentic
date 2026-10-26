import type { DeviceCommandResult } from "@intentic/sandbox-contract/schemas/devices";
import { readDevRebuildLog } from "@intentic/sandbox-contract/schemas/devices";
import type { EnvironmentDevSwapWait } from "@intentic/sandbox-contract/schemas/environment";
import { errorMessage } from "@intentic/base/errors";
import type { RestartResume } from "../../system/restart-resume.js";
import type { Services } from "../../composition.js";

// "RESTART ONCE NOBODY IS MID-TURN", for a rebuild from the checkout. The build runs for minutes on the machine that
// holds the checkout and ends by swapping this container onto what it built; asked to, it holds at its swap gate with
// every image built and the container untouched (the hold file, dev-rebuild-log.ts in the contract). This sandbox is
// the one that knows who is mid-turn, so it lets the gate through itself: holds it, then, while nothing a restart
// would cut is in flight (bootstrap/working-now.ts), reads the build's log, and the moment the gate is holding, removes
// the hold. Kept here rather than in the page that asked, for the reason rebuild-when-idle.ts gives: a page closed or
// a phone locked meanwhile must not lose it. In memory only: this sandbox restarting for anything else is the
// interruption the wait was sparing, and the hold file it left keeps the restart waiting for the owner instead.

// How often an idle sandbox is looked for, and the gate read when one is: turns end at their own pace.
const POLL_MS = 5_000;

export type DevSwapCommand = "dev-rebuild-hold" | "dev-rebuild-release" | "dev-rebuild-log";

export interface DevSwapWhenIdleDeps {
    // What a restart would cut now, by the name the board or the run shows it under (workingNames, "restart").
    readonly working: () => readonly string[];
    // A device command run on that host, as the card runs it (device-commands.ts runDeviceCommand). Throws only when
    // the device cannot be reached; an answer in words comes back as `ok: false`.
    readonly run: (host: string, command: DevSwapCommand) => Promise<DeviceCommandResult>;
    readonly restartResume: RestartResume;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
    readonly pollMs?: number;
    readonly now?: () => number;
}

export interface DevSwapWhenIdle {
    // What the card shows, waiting-on names read fresh; undefined when nothing is asked.
    readonly state: () => EnvironmentDevSwapWait | undefined;
    // Holds the rebuild on `host` at its gate and lets it through once nobody is mid-turn. A second ask replaces the
    // first. Resolves once the hold is placed (or refused, which the state then says).
    readonly ask: (request: { readonly host: string }) => Promise<void>;
    // Stops waiting, leaving the hold file as it is: the owner's next choice (let it through now, or hold it for
    // them) is the page's to send, and dropping the hold here would restart the sandbox on a choice nobody made.
    readonly cancel: () => void;
    // Stops the timer, for shutdown and tests.
    readonly stop: () => void;
}

type Held = Omit<EnvironmentDevSwapWait, "waitingOn">;
type GateLog = ReturnType<typeof readDevRebuildLog>;

// What the build's log says now: the log, the device's refusal in its words, or undefined when this read did not land,
// which is a reason to ask again rather than to stop.
const readGate = async (deps: DevSwapWhenIdleDeps, host: string): Promise<GateLog | { readonly refused: string } | undefined> => {
    try {
        const result = await deps.run(host, "dev-rebuild-log");
        if (result.refused) {
            return { refused: result.message };
        }
        return result.ok ? readDevRebuildLog(result.message) : undefined;
    } catch {
        // allow(silent-catch): a device asleep or a read killed at its deadline; the build carries on, and so does the wait
        return undefined;
    }
};

// Lets the gate through, the next boot asked first to resume whatever a turn started in the gap the restart cuts.
// Answers the device's words when it could not be told, and the ask is withdrawn with them.
const releaseGate = async (deps: DevSwapWhenIdleDeps, host: string, at: number): Promise<string | undefined> => {
    deps.logger.info({ host }, "dev swap when idle: nobody is mid-turn, letting the checkout rebuild restart this sandbox");
    deps.restartResume.announce?.({ by: "daemon", host, action: "rebuild", reason: "checkout rebuild the owner asked to restart once nothing was in flight" });
    await deps.restartResume.ask(at);
    let failure: string | undefined;
    try {
        const result = await deps.run(host, "dev-rebuild-release");
        failure = result.ok ? undefined : result.message;
    } catch (error) {
        failure = errorMessage(error);
    }
    if (failure !== undefined) {
        await deps.restartResume.withdraw();
    }
    return failure;
};

// Places the hold; the device's words when it could not.
const placeHold = async (deps: DevSwapWhenIdleDeps, host: string): Promise<string | undefined> => {
    try {
        const result = await deps.run(host, "dev-rebuild-hold");
        return result.ok ? undefined : result.message;
    } catch (error) {
        return errorMessage(error);
    }
};

// Where one look at the log leaves a wait: nothing left to let through, let through already, ready to let through, or
// nothing to do yet.
const verdict = (request: Held, log: GateLog, idle: boolean): "clear" | "released" | "release" | "wait" => {
    // The build ended (built and swapped, failed, cancelled), or never was.
    if (log.missing || log.exitCode !== undefined) {
        return "clear";
    }
    if (request.phase !== "waiting") {
        return "wait";
    }
    // Let through already, by this wait or by the owner's own button: the restart is under way.
    if (log.swapping) {
        return "released";
    }
    return log.waiting && idle ? "release" : "wait";
};

export const createDevSwapWhenIdle = (deps: DevSwapWhenIdleDeps): DevSwapWhenIdle => {
    const now = deps.now ?? Date.now;
    let held: Held | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    // A read of the log can take most of a minute on a machine the build is loading; one at a time.
    let checking = false;
    const idle = (): boolean => deps.working().length === 0;

    const stopPolling = (): void => {
        clearInterval(timer);
        timer = undefined;
    };
    // Whether `request` is still the wait asked for: an answer that arrives after a newer ask, or a cancel, is dropped.
    const still = (request: Held): boolean => held !== undefined && held.requestedAt === request.requestedAt && held.host === request.host;
    const settle = (request: Held, next: Held | undefined): void => {
        if (!still(request)) {
            return;
        }
        held = next;
        if (next === undefined || next.phase === "failed") {
            stopPolling();
        }
        if (next?.phase === "failed") {
            deps.logger.warn({ host: request.host, message: next.message }, "dev swap when idle: the device could not be told");
        }
    };

    const look = async (request: Held): Promise<void> => {
        const log = await readGate(deps, request.host);
        if (log === undefined || !still(request)) {
            return;
        }
        if ("refused" in log) {
            settle(request, { ...request, phase: "failed", message: log.refused });
            return;
        }
        // Still nobody mid-turn after a read that may have taken a while.
        const next = verdict(request, log, idle());
        if (next === "clear") {
            settle(request, undefined);
        } else if (next === "released") {
            settle(request, { ...request, phase: "released" });
        } else if (next === "release") {
            const failure = await releaseGate(deps, request.host, now());
            settle(request, failure === undefined ? { ...request, phase: "released" } : { ...request, phase: "failed", message: failure });
        }
    };

    const check = async (): Promise<void> => {
        const request = held;
        // Holding costs nobody anything; the log is read only when letting it through would cut nobody.
        if (request === undefined || request.phase === "failed" || checking || (request.phase === "waiting" && !idle())) {
            return;
        }
        checking = true;
        try {
            await look(request);
        } finally {
            checking = false;
        }
    };

    return {
        state: () => (held === undefined ? undefined : { ...held, waitingOn: held.phase === "waiting" ? [...deps.working()] : [] }),
        ask: async ({ host }) => {
            const request: Held = { host, requestedAt: now(), phase: "waiting" };
            held = request;
            stopPolling();
            const failure = await placeHold(deps, host);
            if (failure !== undefined) {
                settle(request, { ...request, phase: "failed", message: failure });
                return;
            }
            if (still(request)) {
                timer = setInterval(() => void check(), deps.pollMs ?? POLL_MS);
                timer.unref?.();
                void check();
            }
        },
        cancel: () => {
            held = undefined;
            stopPolling();
        },
        stop: stopPolling,
    };
};
