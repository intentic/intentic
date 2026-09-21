// WHAT A REBUILD IS DOING, READ OFF A TAIL. `dev-rebuild-log` hands back the last 80 lines of a log that runs to
// hundreds of thousands, so nothing here may depend on having seen the log's first line: each stage is recognised by
// output that stage keeps producing. The caller holds the answer monotonic across polls, because a marker scrolling out
// of the tail is not a build going backwards.

/** The three things `pnpm rebuild:sandbox` does, in the order it does them. */
export type DevRebuildStage = "compile" | "image" | "swap";

export const DEV_REBUILD_STAGES = ["compile", "image", "swap"] as const;

export interface DevRebuildStep {
    readonly key: DevRebuildStage;
    readonly label: string;
    /** What the sandbox is doing meanwhile, said once per step rather than as a paragraph under the card. */
    readonly note: string;
    /** Share of the whole rebuild, so the bar's segments are sized by time rather than by count. */
    readonly weight: number;
}

// Weights are this repo's own rebuild: a warm turbo compile and the prune are minutes, the image build is most of it,
// and the container swap is the ~30s the sandbox is actually away.
export const DEV_REBUILD_STEPS: readonly DevRebuildStep[] = [
    { key: `compile`, label: `Compiling your packages`, note: `Turbo builds what the image bakes in`, weight: 0.3 },
    { key: `image`, label: `Building the image`, note: `Docker layers the compiled trees onto the base`, weight: 0.6 },
    { key: `swap`, label: `Restarting onto it`, note: `Your sandbox comes back on the new image`, weight: 0.1 },
];

const rank = (stage: DevRebuildStage): number => DEV_REBUILD_STAGES.indexOf(stage);

/** Where a step's segment of the bar starts, so a finished step reads as finished however the next one is going. */
export const stageStart = (stage: DevRebuildStage): number =>
    DEV_REBUILD_STEPS.filter((step) => rank(step.key) < rank(stage)).reduce((sum, step) => sum + step.weight, 0);

const weightOf = (stage: DevRebuildStage): number => DEV_REBUILD_STEPS.find((step) => step.key === stage)?.weight ?? 0;

// Every line of a BuildKit build in a pipe opens with its step number; `=> ` is the classic renderer's form.
const IMAGE_LINE = /^(?:#\d+(?:\s|$)|\s*=>[ >])/;
// ic, recreate.sh and dev-sandbox.sh all narrate under this one prefix, and nothing before the swap prints it.
const SWAP_LINE = /^intentic: /;
// The prepare script's last word: the only marker for the gap between the compile ending and docker's first line.
const TREES_READY = /image trees ready in/;
// BuildKit's own step counter — the one honest fraction anything in this build reports.
const LAYER = /\[[^[\]]*?(\d+)\/(\d+)\]/;
// Turbo prefixes each task's output with the package it is building.
const TURBO_TASK = /^(@[^\s:]+):[\w-]+:/;

export interface DevRebuildLayers {
    readonly done: number;
    readonly total: number;
}

export interface DevRebuildProgress {
    readonly stage: DevRebuildStage;
    /** What the stage is on right now, in the tool's own words; absent when the tail says nothing specific. */
    readonly detail: string | undefined;
    readonly layers: DevRebuildLayers | undefined;
}

const layersIn = (line: string): DevRebuildLayers | undefined => {
    const match = LAYER.exec(line);
    if (match === null) {
        return undefined;
    }
    const done = Number(match[1]);
    const total = Number(match[2]);
    return total > 0 && done <= total ? { done, total } : undefined;
};

const classify = (line: string): DevRebuildProgress | undefined => {
    if (SWAP_LINE.test(line)) {
        const said = line.slice(`intentic: `.length).trim();
        return { stage: `swap`, detail: said === `` ? undefined : said, layers: undefined };
    }
    if (IMAGE_LINE.test(line)) {
        return { stage: `image`, detail: undefined, layers: layersIn(line) };
    }
    if (TREES_READY.test(line)) {
        return { stage: `image`, detail: undefined, layers: undefined };
    }
    const turbo = TURBO_TASK.exec(line);
    return turbo === null ? undefined : { stage: `compile`, detail: turbo[1], layers: undefined };
};

/**
 * The furthest stage this tail is evidence of, with the latest detail that stage printed. Undefined when the tail says
 * nothing recognisable, which is a read to ignore rather than a stage to report.
 */
export const readRebuildProgress = (lines: readonly string[]): DevRebuildProgress | undefined => {
    let stage: DevRebuildStage | undefined;
    let detail: string | undefined;
    let layers: DevRebuildLayers | undefined;
    for (const line of lines) {
        const found = classify(line);
        // A lower stage inside the tail is the swap's own docker work, never the build returning to it.
        if (found === undefined || (stage !== undefined && rank(found.stage) < rank(stage))) {
            continue;
        }
        if (stage === undefined || rank(found.stage) > rank(stage)) {
            stage = found.stage;
            detail = undefined;
            layers = undefined;
        }
        detail = found.detail ?? detail;
        layers = found.layers ?? layers;
    }
    return stage === undefined ? undefined : { stage, detail, layers };
};

/** How far along the whole rebuild is, 0–1: completed stages in full, plus docker's own layer count inside the image. */
export const rebuildFraction = (progress: DevRebuildProgress): number => {
    const within = progress.stage === `image` && progress.layers !== undefined ? progress.layers.done / progress.layers.total : 0;
    return Math.min(1, stageStart(progress.stage) + weightOf(progress.stage) * within);
};
