import { shallowRef, watch } from "vue";
import { z } from "zod";
import type { LandedMessageDraft } from "@intentic/sandbox-contract/schemas/agents";
import { commitDraftPaceKey, storedJson, storeJson } from "../../../../app/storage/browserStorage";
import { type Progress, progressAt } from "../../../../components/progress/progress";
import { useAgents } from "../../../../models/fleet/useAgents";
import { draftRunning } from "../changeOrigins";

// How long a commit message usually takes to draft, so the field's mark can fill a ring against it instead of spinning
// with no end in sight (CommitField.vue). This file only learns the expected length; the ring is the one progress model's. Learned from drafts that were written: the roster carries every live agent's,
// and the last few are kept in this browser so an archived agent's timing still counts after a reload.

/** One written draft's timing: who answered, and how long the whole draft took, start to sentence. */
export interface PaceSample {
    readonly model: string;
    readonly startedAt: number;
    readonly ms: number;
}

// Enough to cover a few models; the estimate reads only the most recent of them.
const KEPT = 24;
// The median of this many recent drafts: one slow outlier neither stalls nor rushes the ring.
const RECENT = 5;

const modelKey = (step: { readonly provider: string; readonly model: string }): string => `${step.provider}/${step.model}`;

/** A written draft's sample; undefined for one still running, one that failed, or one with no answering step. */
export const paceSample = (draft: LandedMessageDraft | undefined): PaceSample | undefined => {
    if (draft?.outcome !== `written` || draft.finishedAt === undefined) {
        return undefined;
    }
    const answered = draft.steps.findLast((step) => step.status === `answered`);
    const ms = draft.finishedAt - draft.startedAt;
    return answered === undefined || ms <= 0 ? undefined : { model: modelKey(answered), startedAt: draft.startedAt, ms };
};

/** `stored` with `fresh` folded in, one per draft, oldest first, the newest `KEPT`. */
export const mergeSamples = (stored: readonly PaceSample[], fresh: readonly PaceSample[]): readonly PaceSample[] => {
    const byDraft = new Map(stored.map((sample) => [`${sample.startedAt}:${sample.model}`, sample]));
    for (const sample of fresh) {
        // A draft already kept keeps its record, so a roster frame that taught nothing new changes nothing.
        const key = `${sample.startedAt}:${sample.model}`;
        if (!byDraft.has(key)) {
            byDraft.set(key, sample);
        }
    }
    return [...byDraft.values()].toSorted((a, b) => a.startedAt - b.startedAt).slice(-KEPT);
};

const median = (values: readonly number[]): number => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Where a running draft stands, in the one progress model (components/progress/progress.ts): how long it has run and how
 * long drafts before it took. Undefined when it is not running or nothing has been learned yet (the mark then spins, as
 * it honestly can't say more). The model being asked picks the samples when it has any, since models differ
 * several-fold. Time already spent on models that refused is added to the expectation, so a fallback starts its own
 * stretch instead of reading as late at once. How full the ring is, and when it stops promising, is the model's to say.
 */
export const draftProgress = (draft: LandedMessageDraft | undefined, now: number, samples: readonly PaceSample[]): Progress | undefined => {
    if (draft === undefined || !draftRunning(draft) || samples.length === 0) {
        return undefined;
    }
    const current = draft.steps.at(-1);
    const asking = current?.status === `asking` ? current : undefined;
    const own = asking === undefined ? [] : samples.filter((sample) => sample.model === modelKey(asking));
    const expectedMs = median((own.length > 0 ? own : samples).slice(-RECENT).map((sample) => sample.ms));
    const firstAsked = draft.steps.find((step) => step.at !== undefined)?.at;
    const detour = asking?.at === undefined || firstAsked === undefined ? 0 : Math.max(0, asking.at - firstAsked);
    return progressAt({ startedAt: draft.startedAt, expectedMs: expectedMs + detour }, now);
};

const STORAGE_KEY = commitDraftPaceKey;
const SamplesSchema = z.array(z.object({ model: z.string(), startedAt: z.number(), ms: z.number() }));

/** Every timing learned so far, oldest first. */
// allow(module-state): how fast each model drafts is this browser's, kept in its storage and the same in every sandbox
export const paceSamples = shallowRef<readonly PaceSample[]>(storedJson(STORAGE_KEY, SamplesSchema) ?? []);

// Started with the drafting receipts (draftingReceipts.ts), from module scope: a draft written while the Changes panel
// is closed still teaches the next one.
export const startDraftPace = (): void => {
    watch(
        () => useAgents().fleet.value.map((agent) => paceSample(agent.landedMessageDraft)).filter((sample) => sample !== undefined),
        (fresh) => {
            const merged = mergeSamples(paceSamples.value, fresh);
            if (merged.length === paceSamples.value.length && merged.every((sample, index) => sample === paceSamples.value[index])) {
                return;
            }
            paceSamples.value = merged;
            storeJson(STORAGE_KEY, merged);
        },
        { immediate: true },
    );
};
