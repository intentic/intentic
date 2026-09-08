import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import type { DeviceSandbox } from "@intentic/sandbox-contract";
import { readPrepareUpdates } from "./config.js";
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
// Backoff ceiling in ticks: a permanently failing slug retries every ~2 days, still loud enough to notice.
const MAX_SKIP_TICKS = 8;

// Only running sandboxes (a stopped one downloads on its next start) and never runners, whose image is the parent's
// decision to reconcile. Pinned/dev images aren't filtered here; ic classifies those from the container's own stamps.
export const prepareTargets = (boxes: readonly DeviceSandbox[]): string[] =>
    boxes.filter((box) => box.running && !box.slug.startsWith("runner-")).map((box) => box.slug);

// How many ticks a slug sits out after its n-th consecutive failure: 1, 2, 4, up to MAX_SKIP_TICKS.
export const ticksToSkip = (failures: number): number => (failures <= 0 ? 0 : Math.min(2 ** (failures - 1), MAX_SKIP_TICKS));

// `--auto` tells ic nobody is watching; dropping it would run the attended flow's judgement calls unattended.
export const autoPrepareArgs = (slug: string): string[] => ["sandbox", "prepare", slug, "--auto"];

// Consecutive failures and remaining sit-out ticks, per slug; a slug that succeeds or leaves the fleet takes its
// entries with it.
export interface AutoPrepareState {
    readonly failures: Map<string, number>;
    readonly waits: Map<string, number>;
}

export const newState = (): AutoPrepareState => ({ failures: new Map(), waits: new Map() });

// ic's last output line names the outcome (staged, current, skipped) or, on failure, what broke.
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
        // runIc throws when this machine has no ic at all; backoff keeps that from repeating every tick.
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

// Serialised: two pulls at once doubles the disk's worst moment for no benefit. Split from the scheduler so a test can
// hand it a fake prepare and assert the decisions without timers or docker.
export const runTick = async (
    state: AutoPrepareState,
    boxes: readonly DeviceSandbox[],
    prepare: (slug: string) => Promise<{ code: number; output: string }>,
    log: Log,
    busy: ReadonlySet<string> = icInFlight,
): Promise<void> => {
    const targets = prepareTargets(boxes);
    // Drops entries for slugs no longer on this machine, so history can't leak onto a reused name.
    for (const slug of [...state.failures.keys(), ...state.waits.keys()]) {
        if (!targets.includes(slug)) {
            state.failures.delete(slug);
            state.waits.delete(slug);
        }
    }
    for (const slug of targets) {
        // A person's flow is already running on this slug; leave it alone until next tick.
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

// First look minutes after start, then every few hours with jitter; the switch is re-read every tick so a toggle wins
// even without a restart.
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
            // fleet throws when docker is missing or wedged; this loop just needs to still be there when it's back.
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
