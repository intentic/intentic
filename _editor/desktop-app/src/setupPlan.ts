import { parseStep, type RunEvent } from "./desktop";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// Models the run as a full plan drawn up front, with steps that won't happen on this machine left out; the
// script's own `intentic: [phase]` markers move a cursor down it. Weights are seconds, only ever compared to each
// other and to observed pace — never shown — so a wrong one just skews the estimate.

export interface PlanStep {
    /** The phase id the scripts print. */
    readonly phase: string;
    /**
     * The checklist row, what this step is, in the reader's terms rather than the script's. A function, not a string:
     * a plan outlives the language it was drawn in (a run resumed after a restart is planned before the reader's
     * catalog has loaded), so it is translated each time it is drawn, never once when the plan is made.
     */
    readonly label: () => string;
    /** Roughly how long it takes on a normal machine, in seconds. Only ever compared, never shown. */
    readonly weight: number;
}

export interface PlanInput {
    /** Docker is already up, so nothing has to be installed first, the plan's one big conditional step. */
    readonly dockerReady: boolean;
    /** This setup also enrols desktop sync (the setup link carried a folder). */
    readonly syncing: boolean;
    /** `windows` swaps the first two steps and renames them. */
    readonly os: string;
    /**
     * The sandbox image is on this machine already, so the setup starts on it with nothing to download
     * (commands.rs `INTENTIC_REUSE_IMAGE`). Unknown reads as absent: the pull's share then waits on the bar for a download
     * that may never come, which is the honest side to be wrong on.
     */
    readonly imageReady?: boolean;
}

// Steps in the order the flow actually runs them; Windows checks Docker before fetching the installer since that
// check needs the installer binary. Drawing them in real order is this screen's whole contract.
export const setupPlan = (input: PlanInput): readonly PlanStep[] => {
    const windows = input.os === `windows`;
    const fetch: PlanStep = { phase: `fetching-ic`, label: () => t(`desktop.setupPlan.fetchInstaller`), weight: 15 };
    const check: PlanStep = {
        phase: `checking-docker`,
        label: () => windows ? t(`desktop.setupPlan.checkDockerNeeds`) : t(`desktop.setupPlan.checkDocker`),
        weight: windows ? 12 : 5,
    };
    // Can dominate the whole install (download, installer, maybe WSL2); weighted heavily so the bar doesn't stall.
    const install: PlanStep[] = input.dockerReady
        ? []
        : [{ phase: `installing-docker`, label: () => windows ? t(`desktop.setupPlan.setUpDocker`) : t(`desktop.setupPlan.installDocker`), weight: windows ? 600 : 420 }];
    return [
        ...(windows ? [fetch, check, ...install] : [check, ...install, fetch]),
        { phase: `preflight`, label: () => t(`desktop.setupPlan.checkDevice`), weight: 10 },
        { phase: `claiming-code`, label: () => t(`desktop.setupPlan.redeemSetupCode`), weight: 5 },
        // The image is ~2.2 GB compressed in 118 layers, which most connections take well over 4 minutes to fetch, so 240
        // is not how long the pull takes: it is the pull's share of the bar, and the estimate's last resort. The bar is
        // drawn from ic's byte readings (`parseDownload`) or docker's layers (`parseLayer`) whenever there are any, and
        // the estimate from the throughput measured over the last minute; only with neither does the weight time the
        // step, and then the bar creeps on towards its cap rather than stopping at it (`approach`). Kept at 240 because
        // ic's ui.rs, machine_sandbox.rs and the web's agentHouse.ts draw the same plan from the shared
        // setup-progress.fixture.json: a truer weight (~480) is a change to all four at once. An image already here is a
        // docker answer away, and weighted so: at 240 it held half the bar for a step that takes none.
        input.imageReady === true
            ? { phase: `pulling-image`, label: () => t(`desktop.setupPlan.useSandboxImage`), weight: 2 }
            : { phase: `pulling-image`, label: () => t(`desktop.setupPlan.downloadSandboxImage`), weight: 240 },
        { phase: `starting-sandbox`, label: () => t(`desktop.setupPlan.startSandbox`), weight: 25 },
        { phase: `waiting-health`, label: () => t(`desktop.setupPlan.waitToComeUp`), weight: 40 },
        { phase: `verifying`, label: () => t(`desktop.setupPlan.checkAnswers`), weight: 20 },
        ...(input.syncing ? [{ phase: `desktop-sync`, label: () => t(`desktop.setupPlan.setUpFolderSync`), weight: 45 }] : []),
        // Covers a silent ~100 MB agent download; sized against pulling-image so the bar doesn't stall near 99%.
        { phase: `connecting-machine`, label: () => t(`desktop.setupPlan.connectDevice`), weight: 75 },
    ];
};

// Fraction complete per layer state; only Downloading and Extracting actually take time. The same table ic's ui.rs and
// machine_sandbox.rs read docker's pull with, all three held to sandbox-run's setup-progress.fixture.json.
export const LAYER_DONE: Readonly<Record<string, number>> = {
    "Pulling fs layer": 0,
    Waiting: 0,
    Downloading: 0.15,
    "Verifying Checksum": 0.6,
    "Download complete": 0.6,
    Extracting: 0.8,
    "Pull complete": 1,
    "Already exists": 1,
};

// One line per layer per state change; counted for real progress, clamped monotonic against growing totals. A layer id
// is hex in either case, as the Rust readers take it.
const LAYER = /^([0-9a-fA-F]{6,}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/;

/** One line of docker's pull: its layer and how far through it is (0..1), or undefined for any other line. */
export const parseLayer = (line: string): { readonly id: string; readonly done: number } | undefined => {
    const found = LAYER.exec(line);
    return found === null ? undefined : { id: found[1] ?? ``, done: LAYER_DONE[found[2] ?? ``] ?? 0 };
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

export interface Progress {
    readonly plan: readonly PlanStep[];
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

export const startProgress = (plan: readonly PlanStep[], now: number, floor = 0): Progress => ({
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

const total = (plan: readonly PlanStep[]): number => plan.reduce((sum, step) => sum + step.weight, 0);

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

// Fraction (0..1) through the running step: ic's bytes if any, else docker's layers, else the clock (`approach`).
// Always short of 100%, since only the script's own line marks a step done.
const stepFraction = (state: Progress, now: number): number => {
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

/** Fold one line of the run into the progress. Pure given `now`, so the whole model is testable. */
export const advance = (state: Progress, event: RunEvent, now: number): Progress => {
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
        const next: Progress = {
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
        const next: Progress = { ...state, download: foldDownload(state, reading, now) };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    const layer = parseLayer(event.text);
    if (layer !== undefined) {
        // Docker's own pull after ic's bytes means the download fetched ahead could not be used and the pull took over:
        // its layers are the progress now.
        const next: Progress = { ...state, layers: { ...state.layers, [layer.id]: layer.done }, download: undefined };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    return state;
};

/** The bar between events, so a long silent step still moves on its own clock. */
export const tick = (state: Progress, now: number): Progress =>
    state.ended === undefined ? { ...state, percent: Math.max(state.percent, percentOf(state, now)) } : state;

export interface StepView {
    readonly phase: string;
    readonly label: string;
    readonly state: `done` | `running` | `waiting` | `stopped`;
    /** Only on the running row: what the script is saying about it right now. */
    readonly detail: string | undefined;
    /** This step's share of the whole plan (0..1), so the bar can be drawn in the plan's own proportions. */
    readonly share: number;
}

/** The pull's bytes as the view reports them, while ic reports them. */
export interface DownloadView {
    readonly done: number;
    readonly total: number;
    /** Measured over the last minute; undefined until there is a minute's worth to say, or while nothing arrives. */
    readonly bytesPerSecond: number | undefined;
}

export interface ProgressView {
    readonly steps: readonly StepView[];
    readonly percent: number;
    /** "Step 4 of 9", the position, for the reader who wants the count rather than the bar. */
    readonly position: string | undefined;
    /** "about 3 min left", or undefined when there is nothing honest to say yet. */
    readonly remaining: string | undefined;
    /** The same estimate in milliseconds, for a page that words it in its own language (the web's local/projectWords.ts). */
    readonly remainingMs: number | undefined;
    /** How far through the running step (0..1): ic's bytes or docker's layers during the pull, the clock else. */
    readonly stepProgress: number;
    /** The pull's bytes, while the running step is the pull and ic reports them. */
    readonly download: DownloadView | undefined;
}

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

// Milliseconds left: the pull's own bytes at their measured rate when it has them, and the weight still ahead at this
// machine's pace so far for everything else.
const remainingMsOf = (state: Progress, now: number): number | undefined => {
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

const remainingOf = (state: Progress, now: number): string | undefined => {
    const left = remainingMsOf(state, now);
    if (left === undefined) {
        return undefined;
    }
    if (left < 60_000) {
        return t(`desktop.setupPlan.lessThanMinute`);
    }
    const minutes = Math.round(left / 60_000);
    return t(`desktop.setupPlan.aboutMinutes`, { count: minutes }, minutes);
};

// The running row's line: the script's own sentence, except while ic counts the pull's bytes, which say more.
const runningDetail = (state: Progress): string => {
    const download = state.download;
    if (download === undefined) {
        return state.detail;
    }
    return download.completeAt === undefined
        ? t(`desktop.setupPlan.downloadedOf`, { done: formatBytes(download.done), total: formatBytes(download.total) })
        : t(`desktop.setupPlan.loadingImage`);
};

export const progressView = (state: Progress, now: number): ProgressView => ({
    steps: state.plan.map((step, at) => ({
        phase: step.phase,
        label: step.label(),
        state:
            state.ended === `ok` || at < state.index
                ? `done`
                : at > state.index
                  ? // Unreached steps after a stopped run are neither done nor pending.
                    // Marked `stopped`, not `waiting`, so a failed install doesn't look like it's still going.
                    state.ended === `failed`
                      ? `stopped`
                      : `waiting`
                  : state.ended === `failed`
                    ? `stopped`
                    : `running`,
        detail: at === state.index && state.ended === undefined ? runningDetail(state) : undefined,
        share: step.weight / Math.max(total(state.plan), 1),
    })),
    percent: Math.round(state.percent),
    position: state.index < 0 || state.ended !== undefined ? undefined : t(`desktop.setupPlan.stepOf`, { index: state.index + 1, total: state.plan.length }),
    remaining: remainingOf(state, now),
    remainingMs: remainingMsOf(state, now),
    stepProgress: state.index < 0 ? 0 : state.ended === `ok` ? 1 : stepFraction(state, now),
    download:
        state.download === undefined || state.ended !== undefined
            ? undefined
            : { done: state.download.done, total: state.download.total, bytesPerSecond: downloadRate(state.download) },
});
