import type { Log } from "@intentic/local-agent";
import type { DeviceSandbox } from "@intentic/sandbox-contract";
import { readMachineConfig } from "../environments/machine.js";
import { type IcRun, lastLine, newRoundState, type RoundState, type Rounds, runRound, startRounds, ticksToSkip } from "./ic-rounds.js";
import { fleet, icInFlight, runIc } from "./tools/sandboxes.js";

// Keeps the next sandbox update downloaded by running `ic sandbox prepare <slug> --auto` on a timer, letting `ic`
// decide everything (disk checks, pinned/dev images, no-ops). Lives on the machine, not the sandbox, since the
// download's disk/bandwidth/docker cost is the machine's; failures just log with backoff, never surface to the user.

// Well after boot: docker and its containers are still starting up, so an early pull would blame the wrong thing.
const FIRST_TICK_MS = 5 * 60_000;
// A release isn't urgent; what matters is the download predates the click by hours, not minutes.
const TICK_MS = 6 * 60 * 60_000;
// Spread across a fleet, so a release day doesn't have every machine pull in the same minute.
const JITTER_MS = 30 * 60_000;

export { ticksToSkip };

// Only running sandboxes (a stopped one downloads on its next start) and never runners, whose image is the parent's
// decision to reconcile. Pinned/dev images aren't filtered here; ic classifies those from the container's own stamps.
export const prepareTargets = (boxes: readonly DeviceSandbox[]): string[] =>
    boxes.filter((box) => box.running && !box.slug.startsWith("runner-")).map((box) => box.slug);

// `--auto` tells ic nobody is watching; dropping it would run the attended flow's judgement calls unattended.
export const autoPrepareArgs = (slug: string): string[] => ["sandbox", "prepare", slug, "--auto"];

export type AutoPrepareState = RoundState;

export const newState = (): AutoPrepareState => newRoundState();

// Split from the scheduler so a test can hand it a fake prepare and assert the decisions without timers or docker.
export const runTick = async (
    state: AutoPrepareState,
    boxes: readonly DeviceSandbox[],
    prepare: (slug: string) => Promise<IcRun>,
    log: Log,
    busy: ReadonlySet<string> = icInFlight,
): Promise<void> =>
    await runRound(
        state,
        prepareTargets(boxes),
        // ic's last line names the outcome (staged, current, skipped).
        { name: "auto-prepare", run: prepare, said: (slug, run) => `auto-prepare ${slug}: ${lastLine(run.output) ?? "done"}` },
        log,
        busy,
    );

// First look minutes after start (jittered, so a PC's sides never pull at once), then every few hours; the switch
// (`intentic-machine updates --sandboxes`) is re-read every tick.
export const startAutoPrepare = (log: Log): Rounds => {
    const state = newState();
    return startRounds(
        "auto-prepare",
        log,
        FIRST_TICK_MS + Math.floor(Math.random() * JITTER_MS),
        () => TICK_MS + Math.floor(Math.random() * JITTER_MS),
        async () => {
            // A config that does not read skips the round (it throws), since it may be the one holding the switch off.
            if ((await readMachineConfig()).sandboxUpdates !== false) {
                await runTick(state, await fleet(), async (slug) => await runIc(autoPrepareArgs(slug), () => undefined), log);
            }
        },
    );
};
