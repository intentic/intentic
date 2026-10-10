import { sandboxRef, sandboxShallowRef } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { activeSandboxId } from "../../lib/activeSandbox";
import type { StepId } from "./steps";

// Which of the places pointing at a step gets to: one beacon on screen at a time is the whole rule, since two marks
// each saying "here" teach the reader that neither means it. Every TourMark for a step registers while mounted; the
// one with the highest priority leads (the page where the step is done outranks the composer, which outranks the
// rail tile that leads there), so the beacon walks toward the step as the reader does.

// A step, or one of the moments between them that is a hint rather than a thing to do.
export type MarkStep = StepId | `board`;

interface Mounted {
    readonly key: number;
    readonly place: string;
    readonly priority: number;
}

const mounted = sandboxShallowRef<ReadonlyMap<MarkStep, readonly Mounted[]>>(() => new Map());
let keys = 0;

export const registerMark = (
    step: MarkStep,
    place: string,
    priority: number,
): { readonly lead: ComputedRef<boolean>; readonly release: () => void } => {
    keys += 1;
    const entry: Mounted = { key: keys, place, priority };
    const next = new Map(mounted.value);
    next.set(step, [...(next.get(step) ?? []), entry]);
    mounted.value = next;
    return {
        // Ties go to the mark mounted last: the one that just came on screen is where the reader just went.
        lead: computed(() => {
            const marks = mounted.value.get(step) ?? [];
            const best = marks.reduce<Mounted | undefined>(
                (top, mark) =>
                    top === undefined || mark.priority > top.priority || (mark.priority === top.priority && mark.key > top.key) ? mark : top,
                undefined,
            );
            return best?.key === entry.key;
        }),
        release: () => {
            const after = new Map(mounted.value);
            const left = (after.get(step) ?? []).filter((mark) => mark.key !== entry.key);
            if (left.length === 0) {
                after.delete(step);
            } else {
                after.set(step, left);
            }
            mounted.value = after;
        },
    };
};

// Which hints opened by themselves already on this device, as `step:place`: each says its piece once, unasked, and
// after that only when its beacon is pressed. Per device, since a hint is about the screen it is drawn on.
const hintedKey = (sandboxId: string | undefined): string => `intentic.tour.hinted.${sandboxId ?? `local`}`;

const readHinted = (sandboxId: string | undefined): ReadonlySet<string> => {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(hintedKey(sandboxId)) ?? `[]`);
        return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === `string`) : []);
        // allow(silent-catch): unreadable storage reads as nothing hinted yet, so each hint may open once more.
    } catch {
        return new Set();
    }
};

const hinted = sandboxRef(() => readHinted(activeSandboxId.value));

export const wasHinted = (step: MarkStep, place: string): boolean => hinted.value.has(`${step}:${place}`);

export const markHinted = (step: MarkStep, place: string): void => {
    const next = new Set(hinted.value).add(`${step}:${place}`);
    hinted.value = next;
    try {
        localStorage.setItem(hintedKey(activeSandboxId.value), JSON.stringify([...next]));
        // allow(silent-catch): a browser that refuses storage opens the hint again next visit, which is harmless.
    } catch {}
};
