import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import type { MachineSandbox } from "@intentic/sandbox-contract";
import { readPrepareUpdates } from "./config.js";
import { fleet, icInFlight, runIc } from "./tools/sandboxes.js";

/* KEEPING THE NEXT SANDBOX UPDATE DOWNLOADED, so taking one is a half-minute restart instead of minutes of
 * watching a pull. The update card can only quote the short number once `ic sandbox prepare` has run, and
 * until this tick existed nobody ran it unless the owner found the Download button first — which made the
 * common case the expensive one on every machine whose owner never did.
 *
 * The tick is deliberately dumb: every few hours, for each sandbox container on this machine, run
 * `ic sandbox prepare <slug> --auto` and let `ic` decide everything. It already declines on low disk, skips
 * pinned and locally-built images, no-ops cheaply when the channel tag hasn't moved (one registry manifest
 * check), and clears a stale staged record when the sandbox caught up by another route. Teaching this file a
 * second copy of any of those rules is how the timer and the command would drift apart.
 *
 * WHY THE MACHINE AGENT AND NOT THE SANDBOX: the download's costs — disk, bandwidth, a Docker daemon — are
 * this machine's, so the switch lives here (`intentic-machine computer updates`, cached in computer.json)
 * with the machine's owner, not on a surface an agent can reach. Nothing in any sandbox can start, steer or
 * observe this tick; a sandbox only ever learns what `ic` tells it the way it always has, through the staged
 * marker on its own /history volume.
 *
 * Failures stay in this log. A failed background download leaves the world exactly as it was — the update
 * card still offers the ordinary paths — so nothing here is worth a user-facing error; a slug that keeps
 * failing is retried on a doubling backoff so a broken one costs a line every day or two, not every tick. */

// The first look, well after boot: docker, the containers and their tunnels are themselves still coming up in
// the minutes after login, and a pull racing that start-up would bill its noise to the wrong culprit.
const FIRST_TICK_MS = 5 * 60_000;
// A release is not urgent (the daemon's own version check says the same); what matters is that the download
// predates the click by hours, not that it lands within minutes of the tag moving.
const TICK_MS = 6 * 60 * 60_000;
// Spread across a fleet: a release day must not have every machine of an org pull in the same minute.
const JITTER_MS = 30 * 60_000;
// The backoff ceiling, in ticks: a slug that fails forever is retried every ~2 days, cheap enough to keep
// trying and loud enough (one log line per try) to be findable when someone goes looking.
const MAX_SKIP_TICKS = 8;

// Which of this machine's sandboxes an unattended prepare may even consider: running ones (`prepare` reads
// the approved overlay out of the container, and a stopped sandbox gets its download on the tick after it
// starts), and never runners — a runner's image is its PARENT's decision, reconciled from the parent sandbox
// (runner-hub.ts), and staging an update under one would fight that reconciler. Pinned and dev images are
// deliberately NOT filtered here: `ic` classifies those from the container's own stamps, where the knowledge
// lives.
export const prepareTargets = (boxes: readonly MachineSandbox[]): string[] =>
    boxes.filter((box) => box.running && !box.slug.startsWith("runner-")).map((box) => box.slug);

// How many ticks a slug sits out after its n-th consecutive failure: 1, 2, 4, then MAX_SKIP_TICKS.
export const ticksToSkip = (failures: number): number => (failures <= 0 ? 0 : Math.min(2 ** (failures - 1), MAX_SKIP_TICKS));

// The exact command line, beside its `--auto` contract: ic treats the flag as "nobody is watching", so a
// spelling that dropped it would run the attended flow's judgement calls unattended (recreate.rs names them).
export const autoPrepareArgs = (slug: string): string[] => ["sandbox", "prepare", slug, "--auto"];

// Consecutive failures and remaining sit-out ticks, per slug. A slug that succeeds — or disappears from the
// fleet — takes its entries with it.
export interface AutoPrepareState {
    readonly failures: Map<string, number>;
    readonly waits: Map<string, number>;
}

export const newState = (): AutoPrepareState => ({ failures: new Map(), waits: new Map() });

// ic's own last sentence is the one worth a long-lived log: it says which outcome this was (staged, already
// current, skipped) or, on a failure, what broke.
const lastLine = (output: string): string | undefined => output.split(/\r?\n/).findLast((line) => line.trim() !== "");

const prepareOne = async (
    state: AutoPrepareState,
    slug: string,
    prepare: (slug: string) => Promise<{ code: number; output: string }>,
    log: Log,
): Promise<void> => {
    icInFlight.add(slug);
    let run: { code: number; output: string };
    try {
        run = await prepare(slug);
    } catch (error) {
        // runIc throws when this machine has no `ic` at all — the one failure shared by every slug, and
        // still just a failure here: backoff keeps it from repeating every tick for every sandbox.
        run = { code: 1, output: errorMessage(error) };
    } finally {
        icInFlight.delete(slug);
    }
    if (run.code === 0) {
        state.failures.delete(slug);
        state.waits.delete(slug);
        log(`auto-prepare ${slug}: ${lastLine(run.output) ?? "done"}`);
        return;
    }
    const failures = (state.failures.get(slug) ?? 0) + 1;
    state.failures.set(slug, failures);
    state.waits.set(slug, ticksToSkip(failures));
    log(
        `auto-prepare ${slug}: failed (attempt ${failures}, retrying after ${ticksToSkip(failures)} tick(s)) — ${lastLine(run.output) ?? "no output"}`,
    );
};

/* One pass over the fleet, serialised: two pulls at once double the disk's worst moment for zero wall-clock
 * anyone is waiting on. Split from the scheduler so a test can hand it a fleet and a fake `prepare` and
 * assert the decisions — which slug ran, which sat out, what a failure did to the next tick — without timers
 * or docker. */
export const runTick = async (
    state: AutoPrepareState,
    boxes: readonly MachineSandbox[],
    prepare: (slug: string) => Promise<{ code: number; output: string }>,
    log: Log,
    busy: ReadonlySet<string> = icInFlight,
): Promise<void> => {
    const targets = prepareTargets(boxes);
    // Bookkeeping for sandboxes that left this machine, so a removed slug's failure history cannot leak onto
    // a future sandbox that happens to reuse its name.
    for (const slug of [...state.failures.keys(), ...state.waits.keys()]) {
        if (!targets.includes(slug)) {
            state.failures.delete(slug);
            state.waits.delete(slug);
        }
    }
    for (const slug of targets) {
        // A person's flow is running on this slug right now — stay out of its way; next tick is hours off.
        if (busy.has(slug)) {
            continue;
        }
        const wait = state.waits.get(slug) ?? 0;
        if (wait > 0) {
            state.waits.set(slug, wait - 1);
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one pull at a time is the point (see above)
        await prepareOne(state, slug, prepare, log);
    }
};

/* The scheduler: first look a few minutes after the loop starts, then every few hours with jitter. The
 * switch is re-read every tick — it is one small file, and a toggle must win even if the loop restart that
 * normally follows it never happened. Timers are cleared by `stop`, which the resident loop calls from the
 * same two places it stops everything else, so a tick never outlives the process's reason to exist. */
export const startAutoPrepare = (log: Log): { stop: () => void } => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const state = newState();
    const schedule = (delay: number): void => {
        timer = setTimeout(() => void tick(), delay);
    };
    const tick = async (): Promise<void> => {
        try {
            if (await readPrepareUpdates()) {
                await runTick(state, await fleet(), async (slug) => await runIc(autoPrepareArgs(slug), () => undefined), log);
            }
        } catch (error) {
            // `fleet` throws where docker itself is missing or wedged; the machine has bigger problems than a
            // background download, and this loop's job is to still be there when docker is back.
            log(`auto-prepare: skipped this round — ${errorMessage(error)}`);
        }
        if (!stopped) {
            schedule(TICK_MS + Math.floor(Math.random() * JITTER_MS));
        }
    };
    schedule(FIRST_TICK_MS);
    return {
        stop: (): void => {
            stopped = true;
            clearTimeout(timer);
        },
    };
};
