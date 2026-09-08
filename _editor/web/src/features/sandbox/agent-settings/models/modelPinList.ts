import { type ModelPin, modelPinKey } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { effortLabelOf } from "../../../chat/models/effortScale";
import { type DescribedPin, describePin } from "../../../chat/models/modelPins";

// One editor (add, re-point, promote, remove) over every pinned-model list; lists differ only in how an entry is stored
// (a key string vs. a full ModelPin), each declaring its own encode/decode. Uses read/write rather than a settings key
// since some lists resolve through their own composables and must draw entries as written, not as resolved.

// One row of a list, exactly as `<ModelPinList>` takes it: the pin as written, described, with its place in the order.
export type PinnedEntry = DescribedPin & {
    readonly key: string;
    readonly index: number;
    readonly pin: ModelPin | undefined;
    readonly detail?: string | undefined;
};

export interface PinnedList {
    // Whether entries carry their own run settings, read by the picker to decide whether to draw knobs.
    readonly knobs: boolean;
    readonly entries: ComputedRef<readonly PinnedEntry[]>;
    // Every entry already in the list, so the picker can offer it without letting one be pinned twice.
    readonly taken: ComputedRef<readonly string[]>;
    readonly apply: (index: number | undefined, pin: ModelPin) => void;
    readonly remove: (index: number) => void;
    readonly promote: (index: number) => void;
}

export function pinnedList<T>(list: {
    readonly read: () => readonly T[];
    readonly write: (entries: readonly T[]) => void;
    readonly decode: (entry: T) => ModelPin | undefined;
    readonly encode: (pin: ModelPin) => T;
    // What an entry says about how it runs, beside its name; only set fields are named, so defaults read as bare.
    readonly detail?: (pin: ModelPin) => string | undefined;
    readonly knobs?: boolean;
}): PinnedList {
    const entries = computed<readonly PinnedEntry[]>(() =>
        list.read().map((stored, index) => {
            const pin = list.decode(stored);
            const described = describePin(pin, String(stored));
            return {
                key: `${index}:${described.label}`,
                index,
                pin,
                detail: pin === undefined ? undefined : list.detail?.(pin),
                ...described,
            };
        }),
    );
    return {
        knobs: list.knobs === true,
        entries,
        taken: computed(() => entries.value.flatMap((entry) => (entry.choice === undefined ? [] : [modelPinKey(entry.choice)]))),
        // Adding appends; re-pointing replaces the entry in place, since its position is part of what was said.
        apply: (index, pin) => {
            const stored = list.encode(pin);
            const current = list.read();
            list.write(index === undefined ? [...current, stored] : current.map((held, at) => (at === index ? stored : held)));
        },
        // Emptying isn't a broken state, it's how a row returns to its own default; no confirmation needed.
        remove: (index) => list.write(list.read().filter((_, at) => at !== index)),
        // Moves up only, and only if there's room to: with the full list visible, repeating that covers every
        // reordering need.
        promote: (index) => {
            const held = [...list.read()];
            const [moved] = held.splice(index, 1);
            held.splice(index - 1, 0, moved!);
            list.write(held);
        },
    };
}

// One-line summary of a pin's knobs, for lists whose pins carry them; only fields actually set are named. Clamped like
// the composer's own effort (effortScale.ts), since a stored `max` may exceed this model's scale.
export const pinKnobSummary = (pin: ModelPin): string | undefined => {
    const effort = effortLabelOf(pin.effort, pin.provider, pin.model, pin.thinking);
    return (
        [
            ...(effort === undefined ? [] : [effort]),
            ...(pin.thinking === undefined ? [] : [pin.thinking ? `thinking` : `no thinking`]),
            ...(pin.fast === true ? [`fast`] : []),
            ...(pin.harness === `claude-code` ? [`Claude Code`] : []),
        ].join(` · `) || undefined
    );
};
