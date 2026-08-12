import { computed, type ComputedRef, ref } from "vue";

/* THE MODEL A SURFACE-STARTED RUN WILL OPEN ON, AND THE OVERRIDE FOR IT — the state behind every
 * <AgentRunButton> in the app, written once so the six surfaces that start an agent for you cannot each invent
 * their own idea of what the caret means.
 *
 * WHY IT IS PARAMETERISED rather than reaching for the setting itself: this kit is loaded from two worlds. The
 * shell resolves the sandbox's agent-run list through its own composables and raises the picker through module
 * state; an extension holds an opaque host handle and asks `api.models` for both. Neither can import the
 * other's, and the answer they give is the same answer — so what varies is passed in, and it is two functions
 * wide (`ModelPicking`) because that is all this needs.
 *
 * A REF WITH A FALLBACK, not a watcher seeding a ref. The distinction is the whole behaviour of the caret: the
 * standing setting answers until the user picks, and from the instant they do, their pick answers. A watcher
 * would re-seed under them the moment the setting refetched — silently undoing a choice they had already made,
 * on the click that was about to spend money.
 *
 * THE OVERRIDE IS FOR THAT RUN AND NO LONGER. It is component state, so it dies with the row, and `clear()`
 * ends it explicitly once a run has been started. Anything stickier would be a second place to configure the
 * standing model, disagreeing with Sandbox ▸ Agent ▸ Models with nothing on screen to say which one won. */

// What the run is going to open on, as the app names it. Structural on purpose — the shell's ModelChoice and an
// extension's PickedModel are both this, and neither package can see the other's type.
export interface AgentRunChoice {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
}

// The two questions this asks of whichever world it is running in: what would run if nobody chose, and let them
// choose. `agentRun()` is read inside a computed, so it must be reactive when its host is.
export interface ModelPicking {
    agentRun(): AgentRunChoice;
    pick(options: {
        readonly anchor: HTMLElement;
        readonly provider: string;
        readonly model: string;
        readonly account?: string | undefined;
        readonly harness?: string | undefined;
    }): Promise<AgentRunChoice | undefined>;
}

export interface AgentRunPicker {
    // What the next run opens on — the user's pick if they made one, else the sandbox's standing list.
    readonly model: ComputedRef<AgentRunChoice>;
    // Whether that is a deviation. The button shows the model only when it is: a control that names the
    // standing setting on every row of a list is noise, and one that stays silent about a deviation is a trap.
    readonly overridden: ComputedRef<boolean>;
    // Open the picker over the caret. Anchored to the element the caller hands back, because in a popped-out
    // panel the overlay has to measure and dismiss against THAT window rather than the opener's.
    readonly choose: (anchor: HTMLElement) => Promise<void>;
    // Back to the standing setting — called once a run has been started with the pick, so the next one on the
    // same row does not silently inherit a choice made for a different failure.
    readonly clear: () => void;
}

export function useAgentRunPick(models: () => ModelPicking): AgentRunPicker {
    const picked = ref<AgentRunChoice | undefined>(undefined);
    const model = computed<AgentRunChoice>(() => picked.value ?? models().agentRun());
    return {
        model,
        overridden: computed(() => picked.value !== undefined),
        choose: async (anchor: HTMLElement): Promise<void> => {
            const next = await models().pick({
                anchor,
                provider: model.value.provider,
                model: model.value.model,
                ...(model.value.account !== undefined ? { account: model.value.account } : {}),
                ...(model.value.harness !== undefined ? { harness: model.value.harness } : {}),
            });
            if (next !== undefined) {
                picked.value = next;
            }
        },
        clear: (): void => {
            picked.value = undefined;
        },
    };
}
