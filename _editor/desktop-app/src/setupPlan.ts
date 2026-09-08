import { parseStep, type RunEvent } from "./desktop";

// Models the run as a full plan drawn up front, with steps that won't happen on this machine left out; the
// script's own `intentic: [phase]` markers move a cursor down it. Weights are seconds, only ever compared to each
// other and to observed pace — never shown — so a wrong one just skews the estimate.

export interface PlanStep {
    /** The phase id the scripts print. */
    readonly phase: string;
    /** The checklist row, what this step is, in the reader's terms rather than the script's. */
    readonly label: string;
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
}

// Steps in the order the flow actually runs them; Windows checks Docker before fetching the installer since that
// check needs the installer binary. Drawing them in real order is this screen's whole contract.
export const setupPlan = (input: PlanInput): readonly PlanStep[] => {
    const windows = input.os === `windows`;
    const fetch: PlanStep = { phase: `fetching-ic`, label: `Fetch the installer`, weight: 15 };
    const check: PlanStep = {
        phase: `checking-docker`,
        label: windows ? `Check what Docker needs` : `Check Docker`,
        weight: windows ? 12 : 5,
    };
    // Can dominate the whole install (download, installer, maybe WSL2); weighted heavily so the bar doesn't stall.
    const install: PlanStep[] = input.dockerReady
        ? []
        : [{ phase: `installing-docker`, label: windows ? `Set up Docker` : `Install Docker`, weight: windows ? 600 : 420 }];
    return [
        ...(windows ? [fetch, check, ...install] : [check, ...install, fetch]),
        { phase: `preflight`, label: `Check this device`, weight: 10 },
        { phase: `claiming-code`, label: `Redeem your setup code`, weight: 5 },
        // Reports real progress via docker's layer names, so this weight only needs to be right about its share.
        { phase: `pulling-image`, label: `Download the sandbox image`, weight: 240 },
        { phase: `starting-sandbox`, label: `Start your sandbox`, weight: 25 },
        { phase: `waiting-health`, label: `Wait for it to come up`, weight: 40 },
        { phase: `verifying`, label: `Check it answers`, weight: 20 },
        ...(input.syncing ? [{ phase: `desktop-sync`, label: `Set up folder sync`, weight: 45 }] : []),
        // Covers a silent ~100 MB agent download; sized against pulling-image so the bar doesn't stall near 99%.
        { phase: `connecting-machine`, label: `Connect this device`, weight: 75 },
    ];
};

// One line per layer per state change; counted for real progress, clamped monotonic against growing totals.
const LAYER = /^([0-9a-f]{6,}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/;

// Fraction complete per layer state; only Downloading and Extracting actually take time.
const LAYER_DONE: Record<string, number> = {
    "Pulling fs layer": 0,
    Waiting: 0,
    Downloading: 0.15,
    "Verifying Checksum": 0.6,
    "Download complete": 0.6,
    Extracting: 0.8,
    "Pull complete": 1,
    "Already exists": 1,
};

export interface Progress {
    readonly plan: readonly PlanStep[];
    /** Which plan step is running: an index, or -1 before the first marker arrives. */
    readonly index: number;
    /** The running step's own sentence, as the script said it, the detail under the row. */
    readonly detail: string;
    /** Layer id → its latest state, for the pull's real fraction. Cleared whenever the step changes. */
    readonly layers: Readonly<Record<string, number>>;
    readonly startedAt: number;
    readonly stepStartedAt: number;
    /** Never allowed to fall, since docker's reported totals can grow mid-pull. */
    readonly percent: number;
    /** Set once the run ends, so the bar stops moving and the estimate disappears. */
    readonly ended: `ok` | `failed` | undefined;
}

export const startProgress = (plan: readonly PlanStep[], now: number): Progress => ({
    plan,
    index: -1,
    detail: ``,
    layers: {},
    startedAt: now,
    stepStartedAt: now,
    percent: 0,
    ended: undefined,
});

const total = (plan: readonly PlanStep[]): number => plan.reduce((sum, step) => sum + step.weight, 0);

// Fraction (0..1) through the running step: docker's layers if any, else elapsed time against the step's weight,
// capped short of 100% since only the script's own line marks a step done.
const stepFraction = (state: Progress, now: number): number => {
    const layers = Object.values(state.layers);
    if (layers.length > 0) {
        return layers.reduce((sum, done) => sum + done, 0) / layers.length;
    }
    const weight = state.plan[state.index]?.weight ?? 0;
    if (weight <= 0) {
        return 0;
    }
    return Math.min(0.9, (now - state.stepStartedAt) / (weight * 1000));
};

const percentOf = (state: Progress, now: number): number => {
    if (state.index < 0) {
        return 0;
    }
    const whole = total(state.plan);
    if (whole <= 0) {
        return 0;
    }
    const behind = state.plan.slice(0, state.index).reduce((sum, step) => sum + step.weight, 0);
    const inside = (state.plan[state.index]?.weight ?? 0) * stepFraction(state, now);
    // Capped below 100: only the exit event says a run is actually finished.
    return Math.min(99, ((behind + inside) / whole) * 100);
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
            // A step's layers belong to that step, and the pull is the only step that has any.
            layers: moved ? {} : state.layers,
            stepStartedAt: moved ? now : state.stepStartedAt,
        };
        return { ...next, percent: Math.max(state.percent, percentOf(next, now)) };
    }
    const layer = LAYER.exec(event.text);
    if (layer !== null) {
        const [, id, status] = layer;
        const done = LAYER_DONE[status ?? ``] ?? 0;
        const next: Progress = { ...state, layers: { ...state.layers, [id ?? ``]: done } };
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
}

export interface ProgressView {
    readonly steps: readonly StepView[];
    readonly percent: number;
    /** "Step 4 of 9", the position, for the reader who wants the count rather than the bar. */
    readonly position: string | undefined;
    /** "about 3 min left", or undefined when there is nothing honest to say yet. */
    readonly remaining: string | undefined;
}

// Pace is this machine's actual seconds-per-weight-unit so far; the estimate is remaining weight at that pace.
// Clamped near the nominal rate, since the first seconds of a run barely measure anything.
const NOMINAL_MS = 1000;
const paceOf = (state: Progress, now: number): number => {
    const consumed = (state.percent / 100) * total(state.plan);
    if (consumed <= 0) {
        return NOMINAL_MS;
    }
    const measured = (now - state.startedAt) / consumed;
    return Math.min(Math.max(measured, NOMINAL_MS * 0.4), NOMINAL_MS * 4);
};

const remainingOf = (state: Progress, now: number): string | undefined => {
    // Nothing has started, or everything has: both are states where a countdown would be inventing a number.
    if (state.index < 0 || state.ended !== undefined) {
        return undefined;
    }
    const left = total(state.plan) * (1 - state.percent / 100) * paceOf(state, now);
    if (left < 60_000) {
        return `less than a minute left`;
    }
    return `about ${Math.round(left / 60_000)} min left`;
};

export const progressView = (state: Progress, now: number): ProgressView => ({
    steps: state.plan.map((step, at) => ({
        phase: step.phase,
        label: step.label,
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
        detail: at === state.index && state.ended === undefined ? state.detail : undefined,
    })),
    percent: Math.round(state.percent),
    position: state.index < 0 || state.ended !== undefined ? undefined : `Step ${state.index + 1} of ${state.plan.length}`,
    remaining: remainingOf(state, now),
});
