import { type AgentRunPin, quickModelKey } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { type DescribedPin, describePin } from "../../../composables/chat/modelPins";

/* ONE EDITOR OVER EVERY PINNED MODEL LIST IN THE SETTINGS, AND SEVERAL STORED SHAPES. Add, re-point, promote and
 * remove are the same four gestures whichever list they are made in, and a hand-rolled copy of each per list is
 * where the rows quietly stop agreeing about what "already in the order" means.
 *
 * What actually differs between the lists is how an entry is WRITTEN DOWN: the quick, cheaper-tier and safety
 * lists keep `${provider}:${model}` keys, while an agent-run entry is a pin carrying its own run settings
 * (AgentRunPinSchema). So the rows and the picker work in PINS, and each list says how one is stored.
 *
 * `read`/`write` rather than a settings key, because two of the lists are read through their own composables:
 * each resolves its own chain, and the row has to draw THE LIST AS THE USER WROTE IT either way. A pin whose
 * account was disconnected still belongs on screen, greyed: it is a setting they made, and a row that silently
 * stopped drawing it would look like the app had eaten it. (Every resolver drops it at run time, which is the
 * right answer THERE: no feature may fail on a credential the sandbox no longer has.)
 *
 * IT LIVES IN A MODULE OF ITS OWN rather than inside the component that first needed it. All four lists are
 * drawn by Sandbox ▸ Agent ▸ Models — including the safety judge's, which used to sit on the Safety tab and made
 * "where do I choose a model" a question with two answers — but they are four separate settings with four
 * different floors, and one editor over all of them is what keeps those four rows agreeing about what "already
 * in the order" means. */

// One row of a list, exactly as <ModelPinList> takes it: the pin as the user wrote it, described for the screen,
// with its place in the order and whatever this list has to say about how that entry runs.
export type PinnedEntry = DescribedPin & {
    readonly key: string;
    readonly index: number;
    readonly pin: AgentRunPin | undefined;
    readonly detail?: string | undefined;
};

export interface PinnedList {
    // Whether entries carry their own run settings, which the picker reads to decide whether to draw knobs.
    // Only the agent-run list does; ModelPinPicker says why.
    readonly knobs: boolean;
    readonly entries: ComputedRef<readonly PinnedEntry[]>;
    // Everything already written down, so the picker can offer those rows without letting one be pinned twice: a
    // model that vanished from the list as you used it would make you hunt for a row that was there a moment ago.
    readonly taken: ComputedRef<readonly string[]>;
    readonly apply: (index: number | undefined, pin: AgentRunPin) => void;
    readonly remove: (index: number) => void;
    readonly promote: (index: number) => void;
}

export function pinnedList<T>(list: {
    readonly read: () => readonly T[];
    readonly write: (entries: readonly T[]) => void;
    readonly decode: (entry: T) => AgentRunPin | undefined;
    readonly encode: (pin: AgentRunPin) => T;
    // What this entry says about HOW it runs, beside its name. Only a list whose pins carry run settings has
    // anything to say here, and only the fields actually set are named, so a pin left at the provider's own
    // defaults reads as just a model.
    readonly detail?: (pin: AgentRunPin) => string | undefined;
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
        taken: computed(() => entries.value.flatMap((entry) => (entry.choice === undefined ? [] : [quickModelKey(entry.choice)]))),
        // Adding appends; re-pointing an entry replaces it where it stands, because its position in the order is
        // the other half of what the user said.
        apply: (index, pin) => {
            const stored = list.encode(pin);
            const current = list.read();
            list.write(index === undefined ? [...current, stored] : current.map((held, at) => (at === index ? stored : held)));
        },
        // Emptying the list is not a broken state: it is how each row gets back to its own floor, which is why
        // removing the last one needs no confirmation and no separate "reset" control.
        remove: (index) => list.write(list.read().filter((_, at) => at !== index)),
        // One step up the order. Only up, and only where there is a step to take: with a whole list on screen,
        // "move this one earlier" repeated is the entire vocabulary needed, and a second button per row in a
        // 14rem column is how a settings page turns into a control panel.
        promote: (index) => {
            const held = [...list.read()];
            const [moved] = held.splice(index, 1);
            held.splice(index - 1, 0, moved!);
            list.write(held);
        },
    };
}
