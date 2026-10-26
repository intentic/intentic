import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { storedValue, storeValue } from "../../../../app/storage/browserStorage";
import { DEV_REBUILD_STEPS, type DevRebuildStage, type DevRebuildStep } from "./devRebuildStages";

// HOW LONG THE LAST REBUILD TOOK, STEP BY STEP, so the next one can say how long it has left. The bar used to be cut
// into fixed thirds and sixths written down once for this repo, and the card said nothing about time at all: what the
// reader most wants to know ("when will my sandbox restart?") had no answer. The answer is the last run this browser
// watched end to end, on this sandbox: same checkout, same machine, the nearest thing to the next one there is. Nothing
// is estimated before one exists: a card with no past run says how long it has been going, never how long it will take.

export interface PastRebuild {
    /** Each step's own length, waits at the gate left out: the hold is the owner's time, not the build's. */
    readonly ms: Readonly<Record<DevRebuildStage, number>>;
    /** Turbo's task count, for "23 of 48" while the next compile has not said its total yet. */
    readonly tasks: number | undefined;
    readonly at: number;
}

const PastRebuildSchema = z.object({
    ms: z.object({ compile: z.number().nonnegative(), image: z.number().nonnegative(), swap: z.number().nonnegative() }),
    tasks: z.number().int().positive().optional(),
    at: z.number(),
});

const keyOf = (slug: string): string => `intentic.devRebuild.${slug}.took`;

/** The last rebuild of this sandbox this browser saw end to end; undefined when it has seen none. */
export const pastRebuild = (slug: string): PastRebuild | undefined => {
    const text = storedValue(keyOf(slug));
    // Storage outlives every version of this page, so a record is parsed rather than trusted.
    const record = text === undefined ? undefined : parseJsonWith(text, PastRebuildSchema);
    return record === undefined ? undefined : { ms: record.ms, tasks: record.tasks, at: record.at };
};

export interface FinishedRebuild {
    readonly startedAt: number | undefined;
    readonly endedAt: number | undefined;
    readonly stageAt: Partial<Record<DevRebuildStage, number>>;
    /** Time the gate held the restart, which the image step's clock ran through. */
    readonly waitedMs: number;
    readonly tasks: number | undefined;
}

/**
 * Keeps a finished run as the next one's measure, when this browser saw each step begin. A run adopted mid-flight dated
 * its steps from whenever it happened to look, and would teach the next card a wrong length, so it teaches nothing.
 */
export const keepRebuild = (slug: string, run: FinishedRebuild): PastRebuild | undefined => {
    const { compile, image, swap } = run.stageAt;
    if (run.startedAt === undefined || run.endedAt === undefined || compile === undefined || image === undefined || swap === undefined) {
        return undefined;
    }
    const ms = { compile: image - compile, image: Math.max(0, swap - image - run.waitedMs), swap: run.endedAt - swap };
    if (ms.compile < 0 || ms.swap < 0) {
        return undefined;
    }
    const kept: PastRebuild = { ms, tasks: run.tasks, at: run.endedAt };
    storeValue(keyOf(slug), JSON.stringify(kept));
    return kept;
};

export interface TimedStep extends DevRebuildStep {
    /** How long this step took last time; absent with no past run. */
    readonly expectedMs: number | undefined;
}

// The step's words stay getters, so each read says them in the language active at that moment.
const timed = (step: DevRebuildStep, weight: number, expectedMs: number | undefined): TimedStep => ({
    key: step.key,
    get label() {
        return step.label;
    },
    get note() {
        return step.note;
    },
    weight,
    expectedMs,
});

/**
 * The three steps, sized by how long each took last time, or by this repo's usual shares when nothing here has watched
 * one. A step so short it would round to nothing keeps a sliver, so a running one still has somewhere to fill.
 */
export const timedSteps = (past: PastRebuild | undefined): readonly TimedStep[] => {
    const whole = past === undefined ? 0 : past.ms.compile + past.ms.image + past.ms.swap;
    return DEV_REBUILD_STEPS.map((step) =>
        past === undefined || whole <= 0 ? timed(step, step.weight, undefined) : timed(step, Math.max(0.04, past.ms[step.key] / whole), past.ms[step.key]),
    );
};
