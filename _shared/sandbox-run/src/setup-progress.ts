// A SANDBOX'S SETUP, READ OFF WHAT IT PRINTS: the one reader of `ic sandbox connect`'s output for every TypeScript
// window that shows a setup going, the desktop app's own install (its setupPlan.ts) and the web's press on a connected
// machine (features/setup/progress) alike. Before 2026-10-21 it lived in the desktop app alone, and the web drew the
// same run as a raw log.
//
// The run is a full plan drawn up front, steps that won't happen on this machine left out; ic's own
// `intentic: [phase]` markers move a cursor down it. Weights are seconds, only ever compared to each other and to
// observed pace, never shown, so a wrong one just skews the estimate. No words live here: each window names the steps
// and says the estimate in its own catalog. The phases, weights and pull lines are held to setup-progress.fixture.json,
// with ic's ui.rs and the desktop app's setup_progress.rs.

export interface SetupStep {
    /** The phase id the scripts print. */
    readonly phase: string;
    /** Roughly how long it takes on a normal machine, in seconds. Only ever compared, never shown. */
    readonly weight: number;
}

export interface PlanInput {
    /** Docker is already up, so nothing has to be installed first, the plan's one big conditional step. */
    readonly dockerReady: boolean;
    /** This setup also enrols desktop sync (the setup link carried a folder). */
    readonly syncing: boolean;
    /** `windows` swaps the first two steps. */
    readonly os: string;
    /**
     * The sandbox image is on this machine already, so the setup starts on it with nothing to download
     * (commands.rs `INTENTIC_REUSE_IMAGE`). Unknown reads as absent: the pull's share then waits on the bar for a download
     * that may never come, which is the honest side to be wrong on.
     */
    readonly imageReady?: boolean | undefined;
}

// Steps in the order the flow actually runs them; Windows checks Docker before fetching the installer since that
// check needs the installer binary. Drawing them in real order is the screen's whole contract.
export const setupSteps = (input: PlanInput): readonly SetupStep[] => {
    const windows = input.os === `windows`;
    const fetch: SetupStep = { phase: `fetching-ic`, weight: 15 };
    const check: SetupStep = { phase: `checking-docker`, weight: windows ? 12 : 5 };
    // Can dominate the whole install (download, installer, maybe WSL2); weighted heavily so the bar doesn't stall.
    const install: SetupStep[] = input.dockerReady ? [] : [{ phase: `installing-docker`, weight: windows ? 600 : 420 }];
    return [
        ...(windows ? [fetch, check, ...install] : [check, ...install, fetch]),
        { phase: `preflight`, weight: 10 },
        { phase: `claiming-code`, weight: 5 },
        // The image is ~2.2 GB compressed in 118 layers, which most connections take well over 4 minutes to fetch, so 240
        // is not how long the pull takes: it is the pull's share of the bar, and the estimate's last resort. The bar is
        // drawn from ic's byte readings (`parseDownload`) or docker's layers (`parseLayer`) whenever there are any, and
        // the estimate from the throughput measured over the last minute; only with neither does the weight time the
        // step, and then the bar creeps on towards its cap rather than stopping at it (`approach`). Kept at 240 because
        // ic's ui.rs, setup_progress.rs and the web's agentHouse.ts draw the same plan from the shared
        // setup-progress.fixture.json: a truer weight (~480) is a change to all four at once. An image already here is a
        // docker answer away, and weighted so: at 240 it held half the bar for a step that takes none.
        { phase: `pulling-image`, weight: input.imageReady === true ? 2 : 240 },
        { phase: `starting-sandbox`, weight: 25 },
        { phase: `waiting-health`, weight: 40 },
        // The folder's sync starts as soon as the daemon answers, ahead of the public address's checks, so its first copy
        // runs while they wait on the edge (ic's connect.rs, 2026-10-21). Weights from the step timings the funnel heard
        // (`desktop_install_step`, 10-09 to 10-21): folder sync 46 s, verifying 8 s, connecting the device 13 s at the median.
        ...(input.syncing ? [{ phase: `desktop-sync`, weight: 46 }] : []),
        { phase: `verifying`, weight: 8 },
        // The machine agent's ~100 MB download, when this computer has none, falls in the first of the two agent steps:
        // folder sync when there is one, else this one, sized against pulling-image so the bar doesn't stall near 99%.
        { phase: `connecting-machine`, weight: input.syncing ? 13 : 75 },
    ];
};

// Format: `intentic: [<phase>] <sentence>`; unphased output is detail under the running step, not a step itself.
const STEP = /^intentic: \[([a-z-]+)\] (.*)$/;

export interface StepLine {
    /** The phase id, the same vocabulary the platform's setup report uses. */
    readonly phase: string;
    /** What the script said it was doing, for the reader watching one step. */
    readonly message: string;
}

export const parseStep = (line: string): StepLine | undefined => {
    const found = STEP.exec(line);
    return found === null ? undefined : { phase: found[1] ?? ``, message: (found[2] ?? ``).trim() };
};

// Fraction complete per layer state; only Downloading and Extracting actually take time. The same table ic's ui.rs and
// setup_progress.rs read docker's pull with, all three held to setup-progress.fixture.json.
export const LAYER_DONE = {
    "Pulling fs layer": 0,
    Waiting: 0,
    Downloading: 0.15,
    "Verifying Checksum": 0.6,
    "Download complete": 0.6,
    Extracting: 0.8,
    "Pull complete": 1,
    "Already exists": 1,
} as const satisfies Readonly<Record<string, number>>;

type LayerState = keyof typeof LAYER_DONE;
const isLayerState = (text: string): text is LayerState => Object.hasOwn(LAYER_DONE, text);

// One line per layer per state change; counted for real progress, clamped monotonic against growing totals. A layer id
// is hex in either case, as the Rust readers take it.
const LAYER = /^([0-9a-fA-F]{6,}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/;

/** One line of docker's pull: its layer and how far through it is (0..1), or undefined for any other line. */
export const parseLayer = (line: string): { readonly id: string; readonly done: number } | undefined => {
    const found = LAYER.exec(line);
    const state = found?.[2] ?? ``;
    return found === null ? undefined : { id: found[1] ?? ``, done: isLayerState(state) ? LAYER_DONE[state] : 0 };
};

// ic's image cache (its image_cache.rs) finishing a download fetched ahead, or watching one still running, every two
// seconds: `downloading the sandbox image: 812 of 2140 MB (11.2 MB/s)`, indented when piped. Its "MB" is 1024 × 1024
// bytes. The rate in brackets is the average since that run began, so it is not read: the rate here is measured.
const DOWNLOAD = /\bdownloading the sandbox image: (\d+) of (\d+) MB\b/;
const MIB = 1024 * 1024;

/** One of ic's download readings, in bytes, or undefined for any other line (and for a total of nothing). */
export const parseDownload = (line: string): { readonly done: number; readonly total: number } | undefined => {
    const found = DOWNLOAD.exec(line);
    const total = Number(found?.[2] ?? 0) * MIB;
    return found === null || total <= 0 ? undefined : { done: Math.min(Number(found[1]) * MIB, total), total };
};

/** A download reading, kept for the rate. */
export interface Sample {
    readonly at: number;
    readonly done: number;
}

/** The sandbox image's bytes, while ic reports them (only during the pull). */
export interface Download {
    /** Bytes in, never allowed to fall. */
    readonly done: number;
    readonly total: number;
    /**
     * Where the running step's fraction stood when the first reading came, and the bytes in by then: the bytes still to
     * come draw the rest of the step from there, so a reading that arrives after the clock had moved the bar on never
     * holds it still while bytes keep coming.
     */
    readonly base: number;
    readonly from: number;
    /** The readings of the last minute, oldest first: what the rate is measured over. */
    readonly samples: readonly Sample[];
    /** When the last byte came: Docker loading the image is what is left of the step, timed from here. */
    readonly completeAt: number | undefined;
}

/** What the run said: a line of its output, its end, or anything else (an announcement), which moves nothing. */
export type ProgressEvent = { readonly kind: `line`; readonly text: string } | { readonly kind: `exit`; readonly ok: boolean } | { readonly kind: `started` };

export interface Progress<S extends SetupStep = SetupStep> {
    readonly plan: readonly S[];
    /** Which plan step is running: an index, or -1 before the first marker arrives. */
    readonly index: number;
    /** The running step's own sentence, as the script said it, the detail under the row. */
    readonly detail: string;
    /** Layer id → its latest state, for the pull's real fraction. Cleared whenever the step changes. */
    readonly layers: Readonly<Record<string, number>>;
    /** ic's byte readings for the pull, which outrank the layers and the clock. Cleared whenever the step changes. */
    readonly download?: Download | undefined;
    readonly startedAt: number;
    readonly stepStartedAt: number;
    /** Never allowed to fall, since docker's reported totals can grow mid-pull. */
    readonly percent: number;
    /**
     * Where an earlier attempt of the same setup left the bar: this attempt draws the rest of the way from there. A run
     * that stops on a question and is started again re-examines the machine from the top, and a bar that dropped from
     * 10% back to nothing read as the work just done being thrown away.
     */
    readonly floor: number;
    /** Set once the run ends, so the bar stops moving and the estimate disappears. */
    readonly ended: `ok` | `failed` | undefined;
}

export const startProgress = <S extends SetupStep>(plan: readonly S[], now: number, floor = 0): Progress<S> => ({
    plan,
    index: -1,
    detail: ``,
    layers: {},
    startedAt: now,
    stepStartedAt: now,
    percent: floor,
    floor,
    ended: undefined,
});

// How much of THIS attempt's share of the bar (from its floor up) is behind it, 0..1: what pace and estimate measure.
const ownShare = (state: Progress): number => Math.max(0, (state.percent - state.floor) / Math.max(100 - state.floor, 1));

const total = (plan: readonly SetupStep[]): number => plan.reduce((sum, step) => sum + step.weight, 0);

// Where a step with nothing to report but the clock stands, 0..1: elapsed time against its weight, straight up to
// the knee, then ever slower towards the cap without reaching it. A hard stop at the cap froze the bar for as long as
// the step overran its weight (the 2.2 GB pull, 2026-10-12: 53% for nineteen minutes, which the workspace read as the
// app being gone); this keeps it creeping for as long as the step runs, and only the script's own line marks the step
// done. Past the knee the gap left to the cap halves once the step has run on by twice that gap (in weights), drops to
// a third after four times it, and so on: an hour-long overrun still moves the bar.
export const approach = (x: number, knee = 0.6, cap = 0.9): number => {
    if (x <= knee) {
        return Math.max(0, x);
    }
    const gap = cap - knee;
    return cap - gap / (1 + (x - knee) / (2 * gap));
};

// The bytes take the step to DOWNLOAD_CAP; Docker loading the image takes it the rest of the way towards LOADED_CAP, on
// the clock from the last byte, LOAD_SECONDS being roughly what a 2 GB load takes.
const DOWNLOAD_CAP = 0.9;
const LOADED_CAP = 0.98;
const LOAD_SECONDS = 60;
// The rate is measured over the last minute of readings, and only once they span ten seconds.
const RATE_WINDOW_MS = 60_000;
const RATE_MIN_SPAN_MS = 10_000;

const downloadFraction = (download: Download, now: number): number => {
    if (download.completeAt !== undefined) {
        const loading = (now - download.completeAt) / (LOAD_SECONDS * 1000);
        return DOWNLOAD_CAP + (LOADED_CAP - DOWNLOAD_CAP) * approach(loading, 0.5, 1);
    }
    const share = (download.done - download.from) / Math.max(download.total - download.from, 1);
    return download.base + (DOWNLOAD_CAP - download.base) * Math.min(Math.max(share, 0), 1);
};

/** Bytes per second over the last minute of readings; undefined until they span enough time, or while none arrive. */
export const downloadRate = (download: Download | undefined): number | undefined => {
    const first = download?.samples[0];
    const last = download?.samples.at(-1);
    if (first === undefined || last === undefined || last.at - first.at < RATE_MIN_SPAN_MS) {
        return undefined;
    }
    const rate = (last.done - first.done) / ((last.at - first.at) / 1000);
    return rate > 0 ? rate : undefined;
};

/** Fraction (0..1) through the running step: ic's bytes if any, else docker's layers, else the clock (`approach`).
 * Always short of 100%, since only the script's own line marks a step done. */
export const stepFraction = (state: Progress, now: number): number => {
    if (state.download !== undefined) {
        return downloadFraction(state.download, now);
    }
    const layers = Object.values(state.layers);
    if (layers.length > 0) {
        return layers.reduce((sum, done) => sum + done, 0) / layers.length;
    }
    const weight = state.plan[state.index]?.weight ?? 0;
    if (weight <= 0) {
        return 0;
    }
    return approach((now - state.stepStartedAt) / (weight * 1000));
};

// One of ic's readings folded in: the first one bases the bytes where the step already stood; every later one adds a
// sample, and a reading that says less than the last (a restarted fetch) never takes the bar back.
const foldDownload = (state: Progress, reading: { readonly done: number; readonly total: number }, now: number): Download => {
    const before = state.download;
    if (before === undefined || before.total !== reading.total) {
        return {
            done: reading.done,
            total: reading.total,
            base: Math.min(stepFraction(state, now), DOWNLOAD_CAP),
            from: reading.done,
            samples: [{ at: now, done: reading.done }],
            completeAt: reading.done >= reading.total ? now : undefined,
        };
    }
    const done = Math.max(before.done, reading.done);
    return {
        ...before,
        done,
        samples: [...before.samples, { at: now, done }].filter((sample) => sample.at >= now - RATE_WINDOW_MS),
        completeAt: before.completeAt ?? (done >= before.total ? now : undefined),
    };
};

const percentOf = (state: Progress, now: number): number => {
    if (state.index < 0) {
        return state.floor;
    }
    const whole = total(state.plan);
    if (whole <= 0) {
        return state.floor;
    }
    const behind = state.plan.slice(0, state.index).reduce((sum, step) => sum + step.weight, 0);
    const inside = (state.plan[state.index]?.weight ?? 0) * stepFraction(state, now);
    // Capped below 100: only the exit event says a run is actually finished.
    return Math.min(99, state.floor + (100 - state.floor) * ((behind + inside) / whole));
};

/** Fold one event of the run into the progress. Pure given `now`, so the whole model is testable. */
export const advance = <S extends SetupStep>(state: Progress<S>, event: ProgressEvent, now: number): Progress<S> => {
    if (event.kind === `exit`) {
        return { ...state, percent: event.ok ? 100 : state.percent, ended: event.ok ? `ok` : `failed` };
    }
    // A run announcing itself (and where its transcript is going) is not progress through the plan.
    if (event.kind !== `line`) {
        return state;
    }
    const step = parseStep(event.text);
    if (step !== undefined) {
        const at = state.plan.findIndex((planned) => planned.phase === step.phase);
        // An unknown phase is narration, not a step; neither is one already passed — the cursor only moves forward.
        const index = at > state.index ? at : state.index;
        const moved = index !== state.index;
        const next: Progress<S> = {
            ...state,
            index,
            detail: step.message,
            // A step's layers and bytes belong to that step, and the pull is the only step that has any.
            layers: moved ? {} : state.layers,
            download: moved ? undefined : state.download,
            stepStartedAt: moved ? now : state.stepStartedAt,
        };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    const reading = parseDownload(event.text);
    if (reading !== undefined) {
        const next: Progress<S> = { ...state, download: foldDownload(state, reading, now) };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    const layer = parseLayer(event.text);
    if (layer !== undefined) {
        // Docker's own pull after ic's bytes means the download fetched ahead could not be used and the pull took over:
        // its layers are the progress now.
        const next: Progress<S> = { ...state, layers: { ...state.layers, [layer.id]: layer.done }, download: undefined };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    return state;
};

/** The bar between events, so a long silent step still moves on its own clock. */
export const tick = <S extends SetupStep>(state: Progress<S>, now: number): Progress<S> =>
    state.ended === undefined ? { ...state, percent: Math.max(state.percent, percentOf(state, now)) } : state;

/** How one step of the plan stands: behind the run, the one under way, still to come, or never reached by a run that stopped. */
export type StepState = `done` | `running` | `waiting` | `stopped`;

export const stepStateOf = (state: Progress, at: number): StepState => {
    if (state.ended === `ok` || at < state.index) {
        return `done`;
    }
    // Unreached steps after a stopped run are neither done nor pending: marked `stopped`, so a failed install doesn't
    // look like it's still going.
    if (state.ended === `failed`) {
        return `stopped`;
    }
    return at > state.index ? `waiting` : `running`;
};

/** This step's share of the whole plan (0..1), so a bar can be drawn in the plan's own proportions. */
export const stepShare = (state: Progress, at: number): number => (state.plan[at]?.weight ?? 0) / Math.max(total(state.plan), 1);

/** The pull's bytes as a view reports them, while ic reports them. */
export interface DownloadFacts {
    readonly done: number;
    readonly total: number;
    /** Measured over the last minute; undefined until there is a minute's worth to say, or while nothing arrives. */
    readonly bytesPerSecond: number | undefined;
}

/** The pull's bytes while the run is still going and ic reports them. */
export const downloadOf = (state: Progress): DownloadFacts | undefined =>
    state.download === undefined || state.ended !== undefined
        ? undefined
        : { done: state.download.done, total: state.download.total, bytesPerSecond: downloadRate(state.download) };

// Pace is this machine's actual seconds-per-weight-unit so far; the estimate is remaining weight at that pace.
// Clamped near the nominal rate, since the first seconds of a run barely measure anything.
const NOMINAL_MS = 1000;
const paceOf = (state: Progress, now: number): number => {
    const consumed = ownShare(state) * total(state.plan);
    if (consumed <= 0) {
        return NOMINAL_MS;
    }
    const measured = (now - state.startedAt) / consumed;
    return Math.min(Math.max(measured, NOMINAL_MS * 0.4), NOMINAL_MS * 4);
};

// Milliseconds left in a pull whose bytes are coming in: the bytes still to come at the rate measured over the last
// minute, then Docker's load; undefined without a rate, and once the bytes are in (the load is then timed like any step).
const pullLeftMs = (state: Progress): number | undefined => {
    const download = state.download;
    const rate = downloadRate(download);
    if (download === undefined || rate === undefined || download.completeAt !== undefined) {
        return undefined;
    }
    return ((download.total - download.done) / rate) * 1000 + LOAD_SECONDS * 1000;
};

/** Milliseconds left: the pull's own bytes at their measured rate when it has them, and the weight still ahead at this
 * machine's pace so far for everything else. Undefined before anything started or once everything ended. */
export const remainingMsOf = (state: Progress, now: number): number | undefined => {
    // Nothing has started, or everything has: both are states where a countdown would be inventing a number.
    if (state.index < 0 || state.ended !== undefined) {
        return undefined;
    }
    const pull = pullLeftMs(state);
    if (pull === undefined) {
        return total(state.plan) * (1 - ownShare(state)) * paceOf(state, now);
    }
    const after = state.plan.slice(state.index + 1).reduce((sum, step) => sum + step.weight, 0);
    return pull + after * paceOf(state, now);
};
