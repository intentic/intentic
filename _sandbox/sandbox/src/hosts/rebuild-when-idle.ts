import type { DeviceFlowLine, DeviceSandboxFlow, EnvironmentRebuildWait } from "@intentic/sandbox-contract";
import { askedRestart, type RestartResume } from "../system/restart-resume.js";
import type { Services } from "../composition.js";

// "REBUILD WHEN THEY'RE IDLE". A rebuild restarts the container every turn here runs in, and the owner pressing Rebuild
// now while four agents were mid-turn cut all four. This holds the rebuild until nothing a restart would cut is in
// flight (a turn, a land, a running subagent, a workflow's step: bootstrap/working-now.ts), then hands it to
// the connected device exactly as the button would. The wait lives in the sandbox, not in the page that asked: that
// page may be a phone that locks, or a tab closed long before the last agent finishes, and a wait kept there would be
// lost with it. It is kept in memory only, since the sandbox restarting for any other reason is itself the interruption
// this was waiting to avoid; the card then offers the rebuild again. A turn that starts while the device builds (it
// builds for minutes before its restart) is cut at the restart, so the rebuild asks the next boot to resume what it cuts
// (restart-resume.ts).

// How often an idle sandbox is looked for: turns end at their own pace, and nothing is lost by a few seconds more.
const POLL_MS = 5_000;
// How long this process may outlive a device stream that stopped without a word before that stop is not the cutover.
const CUTOVER_GRACE_MS = 2 * 60_000;
const LOST = "Lost contact with that device before this sandbox restarted. It may still finish; if nothing happens, rebuild again.";

export interface RebuildWhenIdleDeps {
    // What a restart would cut now, by the name the board or the run shows it under (workingNames, "restart").
    readonly working: () => readonly string[];
    // The swap relayed to the device, as the Rebuild button relays it (device-reports.ts manageDeviceSandbox).
    readonly relay: (host: string, flow: DeviceSandboxFlow) => AsyncIterable<DeviceFlowLine>;
    readonly restartResume: RestartResume;
    // This sandbox's own name on its device; undefined for one no device runs by name.
    readonly slug: () => string | undefined;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
    readonly pollMs?: number;
    readonly cutoverGraceMs?: number;
    readonly now?: () => number;
}

export interface RebuildWhenIdle {
    // What the card shows, waiting-on names read fresh; undefined when nothing is asked.
    readonly state: () => EnvironmentRebuildWait | undefined;
    // Asks for the rebuild of `hash` on `host`, started at once when nothing is in flight now. "unnamed": this sandbox
    // has no name a device could rebuild it by.
    readonly ask: (request: { readonly host: string; readonly hash: string }) => Promise<"unnamed" | undefined>;
    // Withdraws a waiting ask, or dismisses a failed one; one already with the device is the device's to finish.
    readonly cancel: () => "started" | undefined;
    // Stops the wait's timer, for shutdown and tests.
    readonly stop: () => void;
}

type Held = Omit<EnvironmentRebuildWait, "waitingOn">;

export const createRebuildWhenIdle = (deps: RebuildWhenIdleDeps): RebuildWhenIdle => {
    const now = deps.now ?? Date.now;
    let held: Held | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const stopPolling = (): void => {
        clearInterval(timer);
        timer = undefined;
    };

    // Handed to the device, the next boot asked to resume what the restart cuts (askedRestart). The device answering in
    // words (a refusal, or nothing to do) ends it here, the ask withdrawn; a stream that just stops is the cutover,
    // unless this process is still here to say otherwise a while later.
    const start = async (request: Held, slug: string): Promise<void> => {
        stopPolling();
        held = { ...request, phase: "rebuilding" };
        deps.logger.info({ host: request.host, hash: request.hash }, "rebuild when idle: nothing is in flight, the device rebuilds this sandbox now");
        const current = (): boolean => held?.phase === "rebuilding" && held.requestedAt === request.requestedAt;
        let answered = false;
        let failure: string | undefined;
        try {
            for await (const line of askedRestart(deps.restartResume, now(), deps.relay(request.host, { op: "rebuild", slug, hash: request.hash }))) {
                answered ||= line.kind !== "line";
                failure = line.kind === "error" ? line.message : failure;
            }
        } catch (error) {
            answered = true;
            failure = error instanceof Error ? error.message : String(error);
        }
        if (!answered) {
            grace = setTimeout(() => {
                if (current()) {
                    held = { ...request, phase: "failed", message: LOST };
                }
            }, deps.cutoverGraceMs ?? CUTOVER_GRACE_MS);
            grace.unref?.();
            return;
        }
        if (!current()) {
            return;
        }
        if (failure === undefined) {
            held = undefined;
            return;
        }
        deps.logger.warn({ host: request.host, failure }, "rebuild when idle: the device did not rebuild this sandbox");
        held = { ...request, phase: "failed", message: failure };
    };

    const check = (): void => {
        const slug = deps.slug();
        if (held?.phase !== "waiting" || slug === undefined || deps.working().length > 0) {
            return;
        }
        void start(held, slug);
    };

    return {
        state: () => (held === undefined ? undefined : { ...held, waitingOn: held.phase === "waiting" ? [...deps.working()] : [] }),
        ask: async ({ host, hash }) => {
            if (deps.slug() === undefined) {
                return "unnamed";
            }
            // A second ask replaces the first (a newer approved overlay, or another device): one rebuild, of what was
            // asked last. One already with the device finishes; its restart is what this asked for anyway.
            if (held?.phase === "rebuilding") {
                return undefined;
            }
            held = { host, hash, requestedAt: now(), phase: "waiting" };
            stopPolling();
            timer = setInterval(check, deps.pollMs ?? POLL_MS);
            timer.unref?.();
            check();
            return undefined;
        },
        cancel: () => {
            if (held?.phase === "rebuilding") {
                return "started";
            }
            held = undefined;
            stopPolling();
            return undefined;
        },
        stop: () => {
            stopPolling();
            clearTimeout(grace);
        },
    };
};
