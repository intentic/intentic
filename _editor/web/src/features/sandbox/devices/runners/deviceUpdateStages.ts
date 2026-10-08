import { type ProgressStep, stepStart, stepWeight } from "../../progress/stagedProgress";
import { t } from "@intentic/ui/i18n";

// WHAT AN UPDATE OR A ROLLBACK IS DOING, READ OFF THE LINES `ic` STREAMS. Unlike the checkout rebuild's log tail, a
// device op's stream arrives whole and in order, one line at a time, so this is a fold: each line moves the run on,
// and the moment a step's first line lands is the moment that step began. Every step is recognised by what `ic` itself
// prints (recreate.rs, preflight.rs, backup.rs) and by docker's own pull output, which `ic` passes through verbatim.

/** The three things `ic sandbox update` does, in the order it does them. A rollback skips the first. */
export type DeviceUpdateStage = "download" | "check" | "swap";

/** The two verbs drawn as steps: the ones that recreate a sandbox onto another image and take minutes doing it. */
export type StagedVerb = "update" | "rollback";

// Words are getters, so each read says them in the language active at that moment.
const step = (key: DeviceUpdateStage, weight: number): ProgressStep<DeviceUpdateStage> => ({
    key,
    get label() {
        return t(`sandbox.deviceUpdateStages.${key}Label`);
    },
    get note() {
        return t(`sandbox.deviceUpdateStages.${key}Note`);
    },
    weight,
});

// Weights are a real update's: the download is most of it, the read-only pre-flight and the backup are seconds to a
// minute, and the swap is the half-minute the sandbox is away plus its first answer. A rollback downloads nothing —
// its image is already on the machine — so its checks and its swap are the whole of it.
const STEPS: Readonly<Record<StagedVerb, readonly ProgressStep<DeviceUpdateStage>[]>> = {
    update: [step(`download`, 0.6), step(`check`, 0.15), step(`swap`, 0.25)],
    rollback: [step(`check`, 0.4), step(`swap`, 0.6)],
};

export const stagedSteps = (verb: StagedVerb): readonly ProgressStep<DeviceUpdateStage>[] => STEPS[verb];

export const isStagedVerb = (verb: string): verb is StagedVerb => verb === `update` || verb === `rollback`;

const RANK: Record<DeviceUpdateStage, number> = { download: 0, check: 1, swap: 2 };

// `ic` narrates under one prefix; a line indented under it continues the sentence above and says nothing new.
const NARRATION = /^intentic: (?! )(.*)$/;
// Docker's non-interactive pull: one line per layer per state, each opening with the layer's short id.
const LAYER_LINE = /^([0-9a-f]{12}): (.+)$/;
const LAYER_DONE = /^(Pull complete|Already exists)$/;
// The lines docker prints for every layer up front, before any of them moves: until one says something else, the
// list is still being announced, and a count over it would leap ahead on the first layer that already exists.
const LAYER_ANNOUNCED = /^(Pulling fs layer|Already exists|Waiting)$/;
// The pull's own frame around the layers, which says which step this is even when no layer had to move.
const PULL_FRAME = /^(\S+: Pulling from |Digest: sha256:|Status: )/;
// BuildKit's step lines, from an approved environment overlay rebuilt onto the new base.
const BUILD_LINE = /^#\d+(?:\s|$)/;

// Each of `ic`'s own sentences that marks a step, by the words it opens with.
const MARKS: readonly (readonly [RegExp, DeviceUpdateStage])[] = [
    [
        /^(pulling |using the update prepared earlier|the prepared update no longer fits|.* has moved since the update was downloaded|building .* (from the approved overlay|the overlay's tooling)|using .*, the environment build|no approved environment recipe)/,
        `download`,
    ],
    [
        /^(pre-flighting |skipping the state-conversion pre-flight|backed up |applying the shape saved|rolling back to |.* is gone from this machine|.* is not on this machine any more)/,
        `check`,
    ],
    [
        /^(recreating the sandbox |the agents' turns this restart cuts|recreated without the local shortcut|waiting for the sandbox daemon|sandbox (updated|rolled back) to |the previous sandbox container was restored)/,
        `swap`,
    ],
];

// The sentences that end the run, whatever the stream does next: a sandbox already current, or one that came up.
const FINISHED = /^(sandbox (updated|rolled back) to |no newer sandbox image is available yet)/;

export interface DeviceUpdateRun {
    readonly verb: StagedVerb;
    readonly startedAt: number;
    readonly endedAt: number | undefined;
    /** How it ended: `severed` is an op on the sandbox serving this page, whose stream went down with it mid-swap. */
    readonly phase: "running" | "done" | "failed" | "severed";
    readonly stage: DeviceUpdateStage;
    readonly stageAt: Partial<Record<DeviceUpdateStage, number>>;
    /** The running step's latest sentence from `ic`, without its prefix. */
    readonly said: string | undefined;
    /** Docker's layers by id, true once pulled or already present: the one real fraction inside the download. */
    readonly layers: Readonly<Record<string, boolean>>;
    /** Docker has finished naming the layers and started moving one, so their count is a fraction worth drawing. */
    readonly moving: boolean;
    /** `ic` said the run reached its end, so a stream that drops after it lost nothing. */
    readonly finished: boolean;
    /** How far along, 0–1, never decreasing. */
    readonly fraction: number;
    readonly lines: readonly string[];
}

export const startUpdateRun = (verb: StagedVerb, at: number): DeviceUpdateRun => {
    const first = stagedSteps(verb)[0]!.key;
    return {
        verb,
        startedAt: at,
        endedAt: undefined,
        phase: `running`,
        stage: first,
        stageAt: { [first]: at },
        said: undefined,
        layers: {},
        moving: false,
        finished: false,
        fraction: 0,
        lines: [],
    };
};

/** The step a line is evidence of, or undefined for one that says nothing about where the run is. */
const stageOfLine = (line: string): DeviceUpdateStage | undefined => {
    const narrated = NARRATION.exec(line);
    if (narrated !== null) {
        return MARKS.find(([pattern]) => pattern.test(narrated[1]!))?.[1];
    }
    if (LAYER_LINE.test(line) || PULL_FRAME.test(line) || BUILD_LINE.test(line)) {
        return `download`;
    }
    return undefined;
};

const pulled = (layers: Readonly<Record<string, boolean>>): { done: number; total: number } => {
    const states = Object.values(layers);
    return { done: states.filter(Boolean).length, total: states.length };
};

const fractionOf = (run: Pick<DeviceUpdateRun, `verb` | `stage` | `layers` | `moving`>): number => {
    const steps = stagedSteps(run.verb);
    const { done, total } = pulled(run.layers);
    const within = run.stage === `download` && run.moving && total > 0 ? done / total : 0;
    return Math.min(1, stepStart(steps, run.stage) + stepWeight(steps, run.stage) * within);
};

/** One more line from the machine: where it moves the run, and what the running step says now. */
export const foldUpdateLine = (run: DeviceUpdateRun, line: string, at: number): DeviceUpdateRun => {
    const steps = stagedSteps(run.verb);
    const lines = [...run.lines, line];
    const found = stageOfLine(line);
    // A step this verb does not have (a rollback that has to pull its image back) counts as its first.
    const stage = found === undefined ? undefined : steps.some((each) => each.key === found) ? found : steps[0]!.key;
    // A lower step after a higher one is the swap's own docker work or a health line, never the run going back.
    const advances = stage !== undefined && RANK[stage] > RANK[run.stage];
    const current = advances ? stage : run.stage;
    const narrated = NARRATION.exec(line)?.[1]?.trim();
    // Any of `ic`'s own sentences about the running step is its latest word, recognised or not ("another ic run is
    // working on it — waiting…"); one about an earlier step is not, and a step just begun has said nothing yet.
    const fresh = narrated !== undefined && narrated !== `` && (stage === undefined || stage === current);
    const said = fresh ? narrated : advances ? undefined : run.said;
    const layer = LAYER_LINE.exec(line);
    const layers =
        layer === null || current !== `download`
            ? run.layers
            : { ...run.layers, [layer[1]!]: run.layers[layer[1]!] === true || LAYER_DONE.test(layer[2]!.trim()) };
    const next = {
        ...run,
        lines,
        stage: current,
        stageAt: advances && run.stageAt[current] === undefined ? { ...run.stageAt, [current]: at } : run.stageAt,
        said,
        layers,
        moving: run.moving || (layer !== null && current === `download` && !LAYER_ANNOUNCED.test(layer[2]!.trim())),
        finished: run.finished || (narrated !== undefined && FINISHED.test(narrated)),
    };
    return { ...next, fraction: Math.max(run.fraction, fractionOf(next)) };
};

/** The run ended: on the machine's last word, on a refusal, or on the stream going down with the sandbox it updated. */
export const settleUpdateRun = (run: DeviceUpdateRun, ok: boolean, severing: boolean, at: number): DeviceUpdateRun => {
    if (!ok) {
        return { ...run, phase: `failed`, endedAt: at };
    }
    // The connection went with the sandbox before `ic` could say it came up: the swap is under way, not known done.
    if (severing && !run.finished) {
        return { ...run, phase: `severed`, endedAt: at };
    }
    return { ...run, phase: `done`, endedAt: at, fraction: run.stage === stagedSteps(run.verb).at(-1)!.key ? 1 : run.fraction };
};

/** What the running step is on, said for a reader: docker's layer count while it downloads, else `ic`'s sentence. */
export const updateDetail = (run: DeviceUpdateRun): string | undefined => {
    const { done, total } = pulled(run.layers);
    // Not while docker is still naming the layers: "1 of 5" over an empty bar would say it had started when it had not.
    if (run.stage === `download` && run.moving && total > 0) {
        return t(`sandbox.deviceUpdateStages.layersOf`, { done, total }, total);
    }
    return run.said;
};
