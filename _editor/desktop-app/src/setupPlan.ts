import { parseStep, type RunEvent } from "./desktop";

/* WHAT AN INSTALL IS GOING TO DO, SAID BEFORE IT DOES IT.
 *
 * The window used to show one line, whatever the script last said, and nothing else: no idea how many
 * steps there were, which one this was, or whether the four silent minutes in the middle were a download or
 * a hang. That is the shape people abandon, and they abandon it during the image pull, which is the one
 * stretch where nothing prints and everything is fine.
 *
 * So the run is modelled as a PLAN the screen can draw in full at t=0, every step, in order, with the ones
 * that will not happen on this machine left out, and the script's own `intentic: [phase] …` markers move a
 * cursor down it. The scripts name the phase rather than the screen recognising the sentence (see
 * ic's util::step): copy is reworded all the time, and a progress bar that moves when someone fixes a typo
 * is worse than no progress bar.
 *
 * WEIGHTS ARE SECONDS, AND THEY ARE GUESSES. They exist to keep the bar honest about how much is LEFT rather
 * than how many steps are left, "9 of 10 steps" on the far side of a four-minute pull is a lie a step
 * counter tells and a weighted bar does not. They are compared to each other and to observed pace, never
 * shown, so being wrong about one costs a slightly-off estimate and nothing more. */

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
    /** `windows` swaps the first two steps and renames them, see below. */
    readonly os: string;
}

/* The steps that always happen, in the order the flow takes them: the shim checks Docker and fetches the
 * installer, then it preflights, redeems the code, pulls, starts, waits, verifies and connects the machine.
 *
 * WINDOWS TAKES THE FIRST TWO IN THE OTHER ORDER, and that is a real difference rather than a cosmetic one.
 * "Does this machine have Docker" is one question on Linux and a dozen on Windows, virtualization,
 * WSL2, the two Windows features behind it, a pending restart, the package manager this PC may not have,
 * and that examination lives in the installer binary, so the binary has to be here before it can happen.
 * Drawing the steps in the order they will actually run is the entire contract of this screen. */
export const setupPlan = (input: PlanInput): readonly PlanStep[] => {
    const windows = input.os === `windows`;
    const fetch: PlanStep = { phase: `fetching-ic`, label: `Fetch the installer`, weight: 15 };
    const check: PlanStep = {
        phase: `checking-docker`,
        label: windows ? `Check what Docker needs` : `Check Docker`,
        weight: windows ? 12 : 5,
    };
    // The only step that can dominate the whole install, a ~600 MB download, an installer, a first-run
    // dialog, and on Windows possibly turning on WSL2 as well. Its weight is the reason the bar crawls
    // honestly on a machine that needs it instead of sitting at 90% for ten minutes.
    const install: PlanStep[] = input.dockerReady
        ? []
        : [{ phase: `installing-docker`, label: windows ? `Set up Docker` : `Install Docker`, weight: windows ? 600 : 420 }];
    return [
        ...(windows ? [fetch, check, ...install] : [check, ...install, fetch]),
        { phase: `preflight`, label: `Check this device`, weight: 10 },
        { phase: `claiming-code`, label: `Redeem your setup code`, weight: 5 },
        // The second long one, and the one people meet on every first install. It reports real progress (docker
        // names each layer as it lands), so this weight only has to be right about its share of the whole.
        { phase: `pulling-image`, label: `Download the sandbox image`, weight: 240 },
        { phase: `starting-sandbox`, label: `Start your sandbox`, weight: 25 },
        { phase: `waiting-health`, label: `Wait for it to come up`, weight: 40 },
        { phase: `verifying`, label: `Check it answers`, weight: 20 },
        ...(input.syncing ? [{ phase: `desktop-sync`, label: `Set up folder sync`, weight: 45 }] : []),
        /* THE THIRD DOWNLOAD, and it was weighted as if it were a handshake. This step fetches the host agent,
         * a ~100 MB single-file binary, and it prints one line before it ("Downloading the intentic machine
         * agent…") and nothing at all until it lands. At weight 20 the bar reached 99% and the estimate read
         * "less than a minute left" before the download had started, so the last thing a first install showed
         * was a full bar not moving — the exact "is it stuck?" this plan exists to answer, arriving at the one
         * moment the user is most ready to believe the install had finished and something else had gone wrong.
         * Sized against `pulling-image` (240) by what each actually transfers.
         *
         * Still sized for the download, because a first install is what this plan draws: the installers now
         * skip it entirely when the machine already has the published agent, so on a RE-RUN this step lands in
         * about a second and the bar simply arrives early — which is the harmless direction. */
        { phase: `connecting-machine`, label: `Connect this device`, weight: 75 },
    ];
};

/* --- docker's own account of the pull ---
 *
 * Spawned without a terminal, `docker pull` cannot draw its bars, so it prints one line per layer per state
 * change instead, which is better for us than the bars would be: no cursor tricks to undo, and a layer's
 * last word is its state. Counting them is REAL progress through the biggest download in the install, and it
 * is the difference between a bar that creeps on a timer and one that means something.
 *
 * The total grows as docker announces layers, so early fractions are over-optimistic; `percent` below is
 * clamped monotonic, which is what keeps that from ever reading as the bar going backwards. */
const LAYER = /^([0-9a-f]{6,}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/;

// How far through one layer each state is. Downloading and extracting are the two that take time; the rest
// are announcements either side of them.
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
    /** Never allowed to fall, see LAYER above for the one thing that would otherwise make it. */
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

/* HOW FAR INTO THE RUNNING STEP WE ARE, 0..1. Docker's layers when there are any; otherwise the clock,
 * against this step's own weight and capped short of the end, a timer that reaches 100% is a bar claiming a
 * step is finished when the only thing that knows is the script, which has not said so yet. */
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
    // Capped below 100: only the exit says a run is finished, and a bar that fills while the last step is
    // still working is the same lie as a timer that reaches the end.
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
        // A phase this plan does not carry (SELF_HOST's host tunnel, say) is narration, not a step: it says
        // what is happening under the step that is running rather than moving the cursor somewhere the
        // checklist cannot draw. So is a phase we have already passed, the cursor only ever goes forward.
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

/* WHAT THE ESTIMATE IS MADE OF. The plan's weights are a guess about a normal machine; the run itself is the
 * correction. Pace is how long this machine has actually taken per unit of weight so far, and the estimate is
 * the remaining weight at that pace, so a slow disk or a throttled connection stretches the number instead
 * of being contradicted by it.
 *
 * Clamped either side of the nominal second-per-unit, because the first seconds of a run measure almost
 * nothing: without it, one quick step at the start reports "less than a minute" for an install that is about
 * to spend four of them downloading. */
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
                  ? // A run that stopped leaves the steps it never reached as neither done nor pending: they
                    // are not waiting for anything any more, and drawing them as if they were is how a failed
                    // install reads as one that is still going.
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
