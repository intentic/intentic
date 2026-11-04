import { advance, parseStep, type Progress, type SetupStep, setupSteps, startProgress, tick } from "@intentic/sandbox-run/setup-progress";
import { t } from "@intentic/ui/i18n";
import { setupRunView } from "../../../../components/progress/phasedRunView";
import type { ProgressStatus, ProgressStep } from "../../../../components/progress/stagedSteps";
import { type DeviceUpdateRun, foldUpdateLine, settleUpdateRun, startUpdateRun } from "./deviceUpdateStages";
import type { RunnerOp } from "./runnerFailure";

// A RUNNER BEING ADDED, UPDATED OR REMOVED, READ OFF WHAT ITS MACHINE STREAMS, so the runners list draws its long runs
// with the same card every other long run on a machine gets (<StagedProgress>) instead of a wall of docker output.
// Nothing here is new reading: a runner is a sandbox container, so each op is read by the engine that already reads its
// sandbox twin. Adding one is `ic runner up`, which announces the setup's own phases (`intentic: [pulling-image]` …, held
// to sandbox-run's setup-progress.fixture.json), so sandbox-run's setup-progress folds it as it folds `ic sandbox
// connect`. Updating one IS `ic sandbox update runner-<name>`, folded by deviceUpdateStages.ts. Removing one is a single
// step. Pure, and folded line by line into the run's own entry in the ledger: a reader back from another page finds each
// step timed from when it really began, not from when the page came back.

/** The steps of `ic runner up`, in its order. `building-environment` only when the parent ships an overlay. */
type UpPhase = `pulling-image` | `building-environment` | `starting-sandbox` | `waiting-health`;
type RunnerPhase = UpPhase | `removing`;

// The shared phases at the shared weights (a setup's seconds, only ever compared), so the pull holds the share of the
// bar it holds when a sandbox is set up. The environment build has no setup twin: an overlay that installs a toolchain
// takes minutes, which is what its weight says.
const SHARED = new Map(setupSteps({ dockerReady: true, syncing: false, os: `linux` }).map((step) => [step.phase, step.weight]));
const weighed = (phase: UpPhase): SetupStep => ({ phase, weight: SHARED.get(phase) ?? 0 });
const BUILD: SetupStep = { phase: `building-environment`, weight: 180 };

// Planned without the build: whether the parent ships an overlay is decided by its daemon when the flow leaves, so the
// step is drawn when `ic` announces it, not promised up front and ticked off unvisited.
const UP_PLAN: readonly SetupStep[] = [weighed(`pulling-image`), weighed(`starting-sandbox`), weighed(`waiting-health`)];
const REMOVE_PLAN: readonly SetupStep[] = [{ phase: `removing`, weight: 10 }];

/** A runner being added or removed: the setup engine's own state, and what this card adds to it. */
export interface RunnerRun {
    readonly progress: Progress;
    /** When each step was first heard, for the step's own clock. */
    readonly stageAt: Partial<Record<string, number>>;
    /** `ic`'s latest sentence, marker or not: what the running step is on, where the engine has no byte count. */
    readonly said: string | undefined;
    /** The machine's stream dropped before it said how the run ended: neither known done nor known stopped. */
    readonly lost: boolean;
    readonly endedAt: number | undefined;
}

/** A runner op as the ledger keeps it: which op, on which runner, and its run read by the engine that reads that op. */
export type RunnerFlow =
    | { readonly op: `create` | `remove`; readonly name: string; readonly run: RunnerRun }
    | { readonly op: `update`; readonly name: string; readonly run: DeviceUpdateRun };

/** How a run ended: on the machine's answer, on its refusal, or on its stream going down with nobody hearing which. */
export type RunnerEnd = `ok` | `failed` | `lost`;

const startRun = (plan: readonly SetupStep[], now: number): RunnerRun => ({
    progress: startProgress(plan, now),
    stageAt: { [plan[0]!.phase]: now },
    said: undefined,
    lost: false,
    endedAt: undefined,
});

export const startRunnerFlow = (op: RunnerOp, name: string, now: number): RunnerFlow =>
    op === `update` ? { op, name, run: startUpdateRun(`update`, now) } : { op, name, run: startRun(op === `create` ? UP_PLAN : REMOVE_PLAN, now) };

// `ic` narrates under one prefix; a line indented under it continues the sentence above and says nothing new.
const NARRATION = /^intentic: (?! )(?:\[[a-z-]+\] )?(.+)$/;

const weightOf = (plan: readonly SetupStep[]): number => plan.reduce((sum, step) => sum + step.weight, 0);

// The build announced: drawn after the download, where `ic` runs it, keeping the cursor on the step it is on. The work
// already done is the same work in a longer plan, so its share is rescaled to it: kept at the shorter plan's share, the
// new step would open most of the way full.
const withBuild = (progress: Progress): Progress => {
    if (progress.plan.some((step) => step.phase === BUILD.phase)) {
        return progress;
    }
    const on = progress.plan[progress.index]?.phase;
    const after = progress.plan.findIndex((step) => step.phase === `pulling-image`) + 1;
    const plan = [...progress.plan.slice(0, after), BUILD, ...progress.plan.slice(after)];
    const share = weightOf(progress.plan) / Math.max(weightOf(plan), 1);
    return {
        ...progress,
        plan,
        index: on === undefined ? progress.index : plan.findIndex((step) => step.phase === on),
        percent: progress.floor + (progress.percent - progress.floor) * share,
    };
};

const foldRun = (run: RunnerRun, line: string, now: number): RunnerRun => {
    const marked = parseStep(line);
    const before = marked?.phase === BUILD.phase ? withBuild(run.progress) : run.progress;
    const progress = advance(before, { kind: `line`, text: line }, now);
    const phase = progress.plan[progress.index]?.phase;
    const said = NARRATION.exec(line)?.[1]?.trim();
    return {
        ...run,
        progress,
        stageAt: phase === undefined || run.stageAt[phase] !== undefined ? run.stageAt : { ...run.stageAt, [phase]: now },
        // A new step has said nothing yet but its own marker; an older step's sentence is not this one's.
        said: said !== undefined && said !== `` ? said : progress.index === run.progress.index ? run.said : undefined,
    };
};

/** One more line from the machine. */
export const foldRunnerFlow = (flow: RunnerFlow, line: string, now: number): RunnerFlow =>
    flow.op === `update` ? { ...flow, run: foldUpdateLine(flow.run, line, now) } : { ...flow, run: foldRun(flow.run, line, now) };

/** The run ended. A lost stream on an update reads as its swap gone out of sight, which is what the update card draws. */
export const settleRunnerFlow = (flow: RunnerFlow, end: RunnerEnd, now: number): RunnerFlow => {
    if (flow.op === `update`) {
        return { ...flow, run: settleUpdateRun(flow.run, end !== `failed`, end === `lost`, now) };
    }
    const progress = advance(flow.run.progress, { kind: `exit`, ok: end === `ok` }, now);
    return { ...flow, run: { ...flow.run, progress, lost: end === `lost`, endedAt: now } };
};

/** What <StagedProgress> takes for a runner being added or removed, at `now`. */
export interface RunnerRunView {
    readonly steps: readonly ProgressStep[];
    readonly stage: string;
    readonly status: ProgressStatus;
    /** How far along, 0 to 1, never falling. */
    readonly measured: number;
    readonly detail: string | undefined;
    /** "about 3 minutes left", while there is something honest to say. */
    readonly remaining: string | undefined;
}

// Words are read at each call, so the card speaks the language active at that moment.
const KEYS = {
    "pulling-image": `pullingImage`,
    "building-environment": `buildingEnvironment`,
    "starting-sandbox": `startingSandbox`,
    "waiting-health": `waitingHealth`,
    removing: `removing`,
} as const satisfies Record<RunnerPhase, string>;
const isRunnerPhase = (phase: string): phase is RunnerPhase => Object.hasOwn(KEYS, phase);

const stepOf = (step: SetupStep, whole: number): ProgressStep => {
    const key = isRunnerPhase(step.phase) ? KEYS[step.phase] : undefined;
    return {
        key: step.phase,
        label: key === undefined ? step.phase : t(`sandbox.runnerStages.${key}Label`),
        note: key === undefined ? `` : t(`sandbox.runnerStages.${key}Note`),
        weight: step.weight / whole,
    };
};

export const runnerRunView = (run: RunnerRun, now: number): RunnerRunView => {
    const progress = tick(run.progress, now);
    const view = setupRunView(progress, now);
    const whole = Math.max(weightOf(progress.plan), 1);
    return {
        steps: progress.plan.map((step) => stepOf(step, whole)),
        // A run that came up did every step, whichever markers an older `ic` left unsaid.
        stage: progress.ended === `ok` ? (progress.plan.at(-1)?.phase ?? view.stage) : view.stage,
        status: run.lost ? `unheard` : view.status,
        measured: view.measured,
        // The image's bytes while they come; otherwise the machine's latest sentence about the step it is on.
        detail: progress.download === undefined ? (run.said ?? view.detail) : view.detail,
        remaining: view.remaining,
    };
};
