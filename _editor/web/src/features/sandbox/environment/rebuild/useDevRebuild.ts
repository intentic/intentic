import { type DeviceCommandResult, readDevRebuildLog } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, onScopeDispose, reactive, ref } from "vue";
import { z } from "zod";
import { type DevRebuildLayers, type DevRebuildStage, rebuildFraction, readRebuildProgress, stageStart } from "./devRebuildStages";
import { runDeviceCommand } from "../../devices/useDevices";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { expectRestart, RESTART_PATIENCE_MS, type RestartQuiet } from "../../live/sandboxRestart";
import { removeStoredValue, storedValue, storeValue } from "../../../../lib/browserStorage";
import { beginHubWork, hubWorkKey } from "../../../../workbench/hub/hubWork";
import { t } from "@intentic/ui/i18n";

// FOLLOWING A REBUILD THAT NOTHING ON THIS PAGE OWNS. `dev-rebuild` starts a detached build on the machine holding the
// checkout and returns at once; the build then outlives the button, the card, the daemon and the container, because the
// last thing it does is swap this sandbox onto the image it just built. So the run cannot be a component's ref: it is
// kept per slug at module scope, marked in localStorage, and re-read from the machine's own log — which is the only
// place its progress exists at all. Leaving the tab, reloading, and the restart itself all resume the same run.

export type DevRebuildPhase =
    // Nothing known: no rebuild started here, and the machine's log is old or absent.
    | "idle"
    // The command that starts the build is in flight; seconds, not minutes.
    | "starting"
    | "building"
    // The daemon stopped answering, which mid-build is the swap onto the new image rather than a fault.
    | "restarting"
    | "done"
    | "failed"
    // The log stopped growing and never said how it ended: a machine that slept, or a build someone killed.
    | "lost";

export interface DevRebuildRun {
    phase: DevRebuildPhase;
    // When the build began, by this browser's clock. Undefined for a rebuild found already running on the machine: its
    // log says when it last printed, never when it started, and a clock started at the wrong moment is worse than none.
    startedAt: number | undefined;
    endedAt: number | undefined;
    /** The machine's log tail, replaced whole on each read rather than accumulated. */
    lines: readonly string[];
    exitCode: number | undefined;
    /** Seconds since the log last grew; a build inside a slow docker layer is quiet for minutes at a time. */
    quietFor: number | undefined;
    /** The machine's own sentence when it refused, or why this browser cannot read the log at the moment. */
    trouble: string | undefined;
    // When the log was last READ, which is a fact about this browser's contact with the machine and not about the
    // build: it is what the follow gives up on, since a read that keeps failing leaves `quietFor` frozen at whatever
    // the last good read said. Set when a follow begins as well as on every read, so contact is dated from the moment
    // this browser started asking rather than from a marker that may be an hour old — except in the restart step,
    // whose silence is the sandbox's own and is carried across a reload (see `restartKey`).
    heardAt: number | undefined;
    /** A `lost` run ended by nothing being heard for the silence ceiling, rather than by anything the machine said. */
    unheard: boolean;
    /** Which of the three things a rebuild does it is on. Only ever advances: see devRebuildStages.ts. */
    stage: DevRebuildStage;
    /** When each stage was first seen, so the card can time a step it watched begin. */
    stageAt: Partial<Record<DevRebuildStage, number>>;
    /** The stage's own last word — the package turbo is on, the sentence ic printed. */
    detail: string | undefined;
    /** Docker's step counter, the one real fraction inside the longest stage. */
    layers: DevRebuildLayers | undefined;
    /** How far along, 0–1, never decreasing: a tail that scrolls must not walk the bar backwards. */
    fraction: number;
}

const LIVE: ReadonlySet<DevRebuildPhase> = new Set(["starting", "building", "restarting"]);
export const rebuildRunning = (phase: DevRebuildPhase): boolean => LIVE.has(phase);

// HOW LONG THE RESTART STEP MAY GO UNHEARD-FROM BEFORE THE CARD STOPS PROMISING A RECONNECT. The patience the lane and
// the gate already give a restart this browser asked for (sandboxRestart.ts), so the card does not keep saying
// "reconnects on its own" after every other surface has stopped saying it. A healthy swap is back in about half a
// minute — the confirmation promises ~30s, and a poll every four seconds hears it at once — so two minutes of nothing
// is well past one. It is not a verdict: `ic` itself gives a slow first boot up to eight minutes (health.rs,
// ANSWER_BUDGET), so what ends here is the promise and not the follow. The polls go on, and the first read that lands
// puts the card straight back; only ABANDON_S stops them.
export const OUT_OF_CONTACT_MS = RESTART_PATIENCE_MS;

/**
 * Whether this run lost contact in its restart step: in the swap, which takes down the daemon every read rides, with
 * no read landing for OUT_OF_CONTACT_MS. On 2026-10-06 the new daemon crash-looped and the card said "Restarting onto
 * it" for eighteen minutes while the machine's log already held the answer. A run the silence ceiling then ended still
 * counts, so `lost` can say it was this rather than a log that went quiet.
 */
export const outOfContact = (run: DevRebuildRun, now: number): boolean => {
    if (run.stage !== `swap` || run.heardAt === undefined) {
        return false;
    }
    return rebuildRunning(run.phase) ? now - run.heardAt >= OUT_OF_CONTACT_MS : run.phase === `lost` && run.unheard;
};

/** Seconds a settled run took; undefined for one adopted mid-flight, whose start nothing here ever saw. */
export const rebuildSeconds = (run: DevRebuildRun): number | undefined =>
    run.startedAt === undefined ? undefined : Math.max(0, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));

// Slow enough not to tax a laptop over its own tunnel, fast enough that the pane moves while you watch it.
const POLL_MS = 4_000;
// A clock of its own, so elapsed time keeps counting between polls.
const TICK_MS = 1_000;
// The ceiling on silence, in both of the ways a rebuild can go silent: a log nobody has written to for this long with
// no exit mark is not a slow build any more, and a machine this browser has not heard from for this long is not a
// rebuild it is still following.
const ABANDON_S = 15 * 60;
// A log that isn't there yet is a redirect that hasn't landed; past this it is a log that never will.
const GRACE_MS = 20_000;
// How recently the log must have grown for a rebuild nobody here started to be worth adopting on sight.
const ADOPT_WITHIN_S = 120;
// Past this, a marker left by a tab closed mid-build describes a rebuild nobody is waiting for.
const MARKER_GOOD_FOR_MS = 60 * 60_000;
const PROBE_AGAIN_MS = 30_000;

const markerKey = (slug: string): string => `intentic.devRebuild.${slug}`;

// THE RESTART STEP'S SILENCE, KEPT ACROSS A RELOAD. Anywhere else a reload re-dates contact from the moment this browser
// starts asking again, since a tab closed mid-build says nothing about the build. The restart is the exception: there
// the silence IS the sandbox, the daemon these reads ride being the thing replaced, so a reload twenty minutes into a
// swap that never came back must not paint a fresh "Restarting onto it" and hand it another fifteen. A key beside the
// marker rather than a new shape for it, so a page from either side of the swap still reads the marker as a number.
const restartKey = (slug: string): string => `${markerKey(slug)}.restart`;

interface RestartRecord {
    readonly heardAt: number;
    readonly stageAt: Partial<Record<DevRebuildStage, number>>;
}

// What a stored record must hold to be read at all: storage outlives every version of this page, so it is parsed
// rather than trusted. `image` is absent for a swap the log reached without docker ever printing in its tail.
const RestartRecordSchema = z.object({
    heardAt: z.number(),
    stageAt: z.object({ image: z.number().optional(), swap: z.number() }),
});

const keepRestart = (run: DevRebuildRun, slug: string): void => {
    if (run.stage !== `swap` || run.heardAt === undefined || !rebuildRunning(run.phase)) {
        return;
    }
    const record: RestartRecord = { heardAt: run.heardAt, stageAt: run.stageAt };
    storeValue(restartKey(slug), JSON.stringify(record));
};

// A record older than the run it sits beside belongs to a rebuild before it, and is no record of this one.
const restartOf = (slug: string, startedAt: number): RestartRecord | undefined => {
    const text = storedValue(restartKey(slug));
    if (text === undefined) {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        // allow(silent-catch): a half-written or hand-edited record is no record at all; the reload dates contact afresh.
        return undefined;
    }
    const record = RestartRecordSchema.safeParse(value).data;
    if (record === undefined || record.heardAt < startedAt || record.stageAt.swap < startedAt) {
        return undefined;
    }
    const { image, swap } = record.stageAt;
    // An image step dated before the run began is the same stale record's, and draws no number rather than a wrong one.
    const stageAt = image !== undefined && image >= startedAt ? { compile: startedAt, image, swap } : { compile: startedAt, swap };
    return { heardAt: record.heardAt, stageAt };
};

const idle = (): DevRebuildRun => ({
    phase: "idle",
    startedAt: undefined,
    endedAt: undefined,
    lines: [],
    exitCode: undefined,
    quietFor: undefined,
    trouble: undefined,
    heardAt: undefined,
    unheard: false,
    stage: "compile",
    stageAt: {},
    detail: undefined,
    layers: undefined,
    fraction: 0,
});

const runs = new Map<string, DevRebuildRun>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const probedAt = new Map<string, number>();

// WHAT IS LEFT ON SCREEN OF A BUILD THE READER WALKED AWAY FROM, held for as long as this browser is following one.
// Both are kept here rather than by the card for the same reason the run is: the reader leaves the section precisely
// because the build doesn't need them. The hub row carries it while they are still in the hub; the restart
// expectation carries it everywhere else, and through the swap that ends it — which is the part that reaches them
// wherever they are, as a workspace that stops answering.
const ENVIRONMENT_ROW = hubWorkKey(`sandbox`, `environment`);
// A function, so the label is said in the language active when the build is marked.
const what = (): string => t(`sandbox.useDevRebuild.rebuildingFromCheckout`);
// The card's own `restarting` line, said to a reader who is no longer on the card. Hedged on WHEN, not on what: a
// poll four seconds stale can't tell the swap from a machine the build has buried, and both are this rebuild's doing.
const quiet = (): RestartQuiet => ({
    title: t(`sandbox.useDevRebuild.restartingOntoImageBuilt`),
    detail: t(`sandbox.useDevRebuild.rebuildSwapsSandboxOnto`),
});
const marks = new Map<string, () => void>();

const mark = (slug: string): void => {
    if (marks.has(slug)) {
        return;
    }
    // No sandbox selected means nothing is reading the ledger either: the hub row still marks, and the expectation
    // would have no surface to appear on.
    const sandbox = useSandbox().activeSandboxId.value;
    const ends = [
        beginHubWork(ENVIRONMENT_ROW, what()),
        ...(sandbox === undefined ? [] : [expectRestart({ sandbox, id: `dev-rebuild`, what: what(), quiet: quiet() })]),
    ];
    marks.set(slug, () => {
        for (const end of ends) {
            end();
        }
    });
};

const unmark = (slug: string): void => {
    marks.get(slug)?.();
    marks.delete(slug);
};

const runFor = (slug: string): DevRebuildRun => {
    const existing = runs.get(slug);
    if (existing !== undefined) {
        return existing;
    }
    const fresh = reactive(idle());
    runs.set(slug, fresh);
    return fresh;
};

const stop = (slug: string): void => {
    const timer = timers.get(slug);
    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(slug);
    }
};

const STAGE_ORDER: readonly DevRebuildStage[] = ["compile", "image", "swap"];

// WHERE THE STAGE IS KEPT MONOTONIC, and the reason it is kept on the run rather than computed by the card: the read is
// a bounded tail, so evidence of a stage scrolls away while that stage is still running.
const reach = (run: DevRebuildRun, stage: DevRebuildStage): boolean => {
    if (STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(run.stage)) {
        return false;
    }
    if (stage !== run.stage) {
        run.stage = stage;
        run.detail = undefined;
        run.layers = undefined;
    }
    run.stageAt[stage] ??= Date.now();
    return true;
};

// The bar only ever fills: a tail whose newest layer line belongs to an earlier docker stage would otherwise rewind it.
const fill = (run: DevRebuildRun, to: number): void => {
    run.fraction = Math.max(run.fraction, to);
};

// One read's worth of stage movement, applied only where it is forward.
const noteProgress = (run: DevRebuildRun, lines: readonly string[]): void => {
    const progress = readRebuildProgress(lines);
    if (progress === undefined || !reach(run, progress.stage)) {
        return;
    }
    run.detail = progress.detail ?? run.detail;
    run.layers = progress.layers ?? run.layers;
    fill(run, rebuildFraction(progress));
};

// A terminal phase ends the follow and drops the marker: what stays on screen from here is an outcome, not a wait.
const settle = (run: DevRebuildRun, slug: string, phase: DevRebuildPhase, trouble?: string): void => {
    run.phase = phase;
    run.endedAt = Date.now();
    run.trouble = trouble;
    if (phase === "done") {
        reach(run, "swap");
        fill(run, 1);
    }
    removeStoredValue(markerKey(slug));
    removeStoredValue(restartKey(slug));
    stop(slug);
    unmark(slug);
};

// What one read of the machine's log means for a run believed to be in flight. The exit mark is the only thing that
// ends a rebuild; everything else is a build still going, however quiet.
const absorb = (run: DevRebuildRun, slug: string, text: string): void => {
    const log = readDevRebuildLog(text);
    run.quietFor = log.quietFor;
    if (!log.missing) {
        run.lines = log.lines;
    }
    if (log.exitCode !== undefined) {
        run.exitCode = log.exitCode;
        settle(run, slug, log.exitCode === 0 ? "done" : "failed");
        return;
    }
    const vanished = log.missing && Date.now() - (run.startedAt ?? 0) > GRACE_MS;
    if (vanished || (log.quietFor ?? 0) > ABANDON_S) {
        settle(run, slug, "lost");
        return;
    }
    noteProgress(run, log.lines);
    run.phase = "building";
    run.trouble = undefined;
};

// A daemon that does not know this command will not learn it by being asked again: the page is newer than the container
// serving it, which is a dogfooding state and not a fact about the build. Anything else it answers — the device asleep,
// the tunnel sulking — is worth another try in four seconds.
const DRIFTED: ReadonlySet<number> = new Set([400, 404]);

// A read that never arrived. The daemon going quiet mid-build IS the swap onto the new image — it is this container
// being replaced — whereas an answer that says the device is away leaves the build itself unjudged.
const unread = (run: DevRebuildRun, slug: string, error: unknown): void => {
    if (error instanceof SandboxHttpError) {
        if (DRIFTED.has(error.status)) {
            settle(run, slug, "lost", error.message);
            return;
        }
        run.trouble = error.message;
        return;
    }
    run.phase = "restarting";
    run.trouble = undefined;
    // The daemon dying IS the swap, so it dates the last stage even when the log never got to say so.
    reach(run, "swap");
    fill(run, stageStart("swap"));
};

const poll = async (slug: string, hostId: string): Promise<void> => {
    const run = runFor(slug);
    try {
        const result = await runDeviceCommand(hostId, `dev-rebuild-log`);
        if (result.ok) {
            // `message`, never `output`: the latter is the raw `run_command` answer, exit line and stream fences and all.
            run.heardAt = Date.now();
            absorb(run, slug, result.message);
        } else if (result.refused) {
            // The device turned the read away — a switch of its own, a path out of its reach. The build is still out
            // there and this browser has lost its only window on it, which is exactly what `lost` says.
            settle(run, slug, "lost", result.message);
        } else {
            // A READ THAT DIDN'T LAND IS NOT A BUILD THAT FAILED. The device took the command and killed it at its
            // deadline, which on a machine loaded by the very build being read about is a thing that happens: the
            // build is detached out there regardless. Say so on the card and ask again in four seconds.
            run.trouble = result.message;
        }
    } catch (error) {
        unread(run, slug, error);
    }
    if (!rebuildRunning(run.phase)) {
        return;
    }
    // Nothing heard from the machine at all for this long — reads killed at their deadline, a device reported away, a
    // daemon that never came back from the swap — is no longer a build being followed, whatever the last read said.
    if (Date.now() - (run.heardAt ?? Date.now()) > ABANDON_S * 1_000) {
        run.unheard = true;
        settle(run, slug, "lost", run.trouble);
        return;
    }
    keepRestart(run, slug);
    // No wall-clock ceiling on the follow: a log still growing after two hours is a slow build, not a lost one, and
    // this repo's own rebuild has taken that long on a laptop. What ends a follow is the exit mark arriving, or one of
    // the two silences above — never how long a reader has been waiting.
    timers.set(
        slug,
        setTimeout(() => void poll(slug, hostId), POLL_MS),
    );
};

const follow = (slug: string, hostId: string): void => {
    stop(slug);
    void poll(slug, hostId);
};

// One read, no follow: only a log that grew in the last couple of minutes is a rebuild worth putting on screen
// unasked. An unreachable device says nothing here — this browser asked unprompted, and there is no run for it to
// be about.
const probe = async (slug: string, hostId: string): Promise<void> => {
    const run = runFor(slug);
    let result: DeviceCommandResult;
    try {
        result = await runDeviceCommand(hostId, `dev-rebuild-log`);
    } catch {
        // Nothing to report, and nobody asked; only the read is forgiven, not what is made of its answer.
        return;
    }
    if (!result.ok) {
        return;
    }
    const log = readDevRebuildLog(result.message);
    if (log.missing || log.exitCode !== undefined || log.quietFor === undefined || log.quietFor > ADOPT_WITHIN_S) {
        return;
    }
    // No `startedAt`: the log's age says when this build last printed, not when it began, and the card would rather
    // show no clock than one counting from the wrong moment.
    Object.assign(run, idle(), { phase: "building", lines: log.lines, quietFor: log.quietFor, heardAt: Date.now() });
    noteProgress(run, log.lines);
    mark(slug);
    follow(slug, hostId);
};

export interface DevRebuildFollower {
    run: DevRebuildRun;
    /** Seconds this run has been going, ticking while it is live; undefined before one starts. */
    elapsed: ComputedRef<number | undefined>;
    /** Fires the rebuild and follows it. Resolves once it is under way, not once it is built. */
    start: (hostId: string) => Promise<void>;
    /** Picks up a rebuild already running out there: one this tab never started, or one it started before a reload. */
    adopt: (hostId: string) => void;
    /** Clears a settled run off the card. A live one is left alone — a build doesn't stop because the reader looked away. */
    dismiss: () => void;
}

export function useDevRebuild(slug: string): DevRebuildFollower {
    const run = runFor(slug);

    // The RUN is module state because the build outlives this component; the CLOCK that draws it is not, because a
    // second only needs counting while somebody is reading it. Idle cards write nothing and re-render nothing.
    const now = ref(Date.now());
    const ticking = setInterval(() => {
        if (rebuildRunning(run.phase)) {
            now.value = Date.now();
        }
    }, TICK_MS);
    onScopeDispose(() => clearInterval(ticking), true);

    const start = async (hostId: string): Promise<void> => {
        stop(slug);
        // A build this browser started has a first stage it watched begin, which is the one thing an adopted run lacks.
        Object.assign(run, idle(), { phase: "starting", startedAt: Date.now(), heardAt: Date.now(), stageAt: { compile: Date.now() } });
        mark(slug);
        storeValue(markerKey(slug), String(run.startedAt));
        removeStoredValue(restartKey(slug));
        now.value = Date.now();
        try {
            const result = await runDeviceCommand(hostId, `dev-rebuild`);
            if (!result.ok) {
                settle(run, slug, "failed", result.message);
                return;
            }
            run.phase = "building";
            follow(slug, hostId);
        } catch (error) {
            settle(run, slug, "failed", error instanceof Error ? error.message : t(`sandbox.useDevRebuild.couldntReachDevice`));
        }
    };

    // Two ways a run exists that this component never started: a marker from before a reload or the swap, and a log
    // still growing because someone ran the rebuild in a terminal. One read of the machine settles both.
    const adopt = (hostId: string): void => {
        if (rebuildRunning(run.phase) || timers.has(slug)) {
            return;
        }
        const marker = Number(storedValue(markerKey(slug)) ?? Number.NaN);
        if (Number.isFinite(marker) && Date.now() - marker < MARKER_GOOD_FOR_MS) {
            // A reload in the restart step resumes that step on the clock it already had: the same silence, still
            // counting, rather than a fresh one.
            const restart = restartOf(slug, marker);
            Object.assign(run, idle(), {
                phase: "building",
                startedAt: marker,
                heardAt: restart?.heardAt ?? Date.now(),
                stageAt: restart?.stageAt ?? { compile: marker },
            });
            if (restart !== undefined) {
                reach(run, "swap");
                fill(run, stageStart("swap"));
            }
            mark(slug);
            follow(slug, hostId);
            return;
        }
        const last = probedAt.get(slug);
        if (run.phase !== `idle` || (last !== undefined && Date.now() - last < PROBE_AGAIN_MS)) {
            return;
        }
        probedAt.set(slug, Date.now());
        void probe(slug, hostId);
    };

    const elapsed = computed(() => {
        const from = run.startedAt;
        return from === undefined ? undefined : Math.max(0, Math.round(((run.endedAt ?? now.value) - from) / 1000));
    });

    return {
        run,
        elapsed,
        start,
        adopt,
        dismiss: () => {
            if (!rebuildRunning(run.phase)) {
                Object.assign(run, idle());
            }
        },
    };
}
