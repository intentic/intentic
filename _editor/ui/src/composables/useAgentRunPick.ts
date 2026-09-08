import { computed, type ComputedRef, ref } from "vue";

/* THE MODEL A SURFACE-STARTED RUN WILL OPEN ON, AND THE OVERRIDE FOR IT, the state behind every
 * <AgentRunButton> in the app, written once so the seven surfaces that start an agent for you cannot each invent
 * their own idea of what the caret means.
 *
 * WHY IT IS PARAMETERISED rather than reaching for the setting itself: this kit is loaded from two worlds. The
 * shell resolves the sandbox's agent-run list through its own composables and raises the picker through module
 * state; an extension holds an opaque host handle and asks `api.models` for both. Neither can import the
 * other's, and the answer they give is the same answer, so what varies is passed in, and it is two functions
 * wide (`ModelPicking`) because that is all this needs.
 *
 * A REF WITH A FALLBACK, not a watcher seeding a ref. The distinction is the whole behaviour of the caret: the
 * standing setting answers until the user picks, and from the instant they do, their pick answers. A watcher
 * would re-seed under them the moment the setting refetched, silently undoing a choice they had already made,
 * on the click that was about to spend money.
 *
 * THE OVERRIDE IS FOR THAT RUN AND NO LONGER. It is component state, so it dies with the row, and `clear()`
 * ends it explicitly once a run has been started. Anything stickier would be a second place to configure the
 * standing model, disagreeing with Sandbox ▸ Agent ▸ Models with nothing on screen to say which one won. */

// What the run is going to open on, as the app names it. Structural on purpose, the shell's ModelChoice and an
// extension's PickedModel are both this, and neither package can see the other's type.
export interface AgentRunChoice {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
    /* HOW HARD IT THINKS, the second half of what a run costs and the second thing the caret can re-point. It
     * rides here rather than being left to the daemon for the reason the model does: the pinned entry's own
     * effort is applied only to a turn that named NO model (turn-resume.ts), so a run the caret re-pointed and
     * this did not carry would quietly drop to the provider's default tier. Absent ⇒ nothing chosen, and the
     * turn goes out without one. */
    readonly effort?: string | undefined;
    // What the app calls that tier ("X-High"), for the button, since only the host holds the scale. Absent
    // whenever `effort` is.
    readonly effortLabel?: string | undefined;
    /* THE OTHER TWO KNOBS THE PICKER NOW OFFERS A RUN, and they ride for exactly the reason the tier does. A
     * `max` pick beside thinking left unset is a different turn from one beside thinking OFF (the daemon reads
     * the pair together: sendableEffort/sendableThinking), and `fast` is bought at a higher rate — so a caret
     * that could set them and a turn that dropped them would be charging the user for a choice it discarded.
     * Absent ⇒ nothing chosen, and the model's own default answers, which is not the same as `false`. */
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}

/* WHETHER TWO SELECTIONS WOULD START THE SAME RUN, which is the only question `overridden` is really asking.
 * Someone who opens the caret, reads the panel and presses its button without changing anything has CHOSEN,
 * and the button must not then announce a deviation: the inline "✨ Opus 4.6 · High" label exists to make an
 * invisible re-point visible, and worn by a run that matches the sandbox's standing order it is noise on every
 * row of a list. Compared field by field rather than by identity, because the pick arrives as a fresh object
 * every time. */
const sameChoice = (left: AgentRunChoice, right: AgentRunChoice): boolean =>
    left.provider === right.provider &&
    left.model === right.model &&
    left.account === right.account &&
    left.harness === right.harness &&
    left.effort === right.effort &&
    left.thinking === right.thinking &&
    left.fast === right.fast;

/* The two questions this asks of whichever world it is running in: what would run if nobody chose, and let them
 * choose.
 *
 * `agentRun(role)` is A READ, and the two halves of that word both matter for the implementer. Reactive: it is
 * called inside the computed below, so it has to answer freshly when its host's own state moves. And a read
 * only, it must not ENTER a composable, because a computed getter and a click handler are where this is called
 * from and neither of those is a setup. A host that reaches for vue-query on each call fails twice over: the
 * lookup throws where there is no injection context, and the calls that do land leave a query observer apiece
 * that nothing will dispose. Resolve that state once, where the host is set up, and read it here.
 *
 * IT TAKES A ROLE because the sandbox keeps one model list per JOB rather than one for "agent runs" as a class
 * (sandbox-contract model-roles.ts). A Fix button on a red pipeline and a Generate button on a documentation
 * sweep are both this component and are not the same spend, so the button that is about to spend it says which
 * one it is. */
export interface ModelPicking {
    agentRun(role: string): AgentRunChoice;
    pick(options: {
        readonly anchor: HTMLElement;
        readonly provider: string;
        readonly model: string;
        readonly account?: string | undefined;
        readonly harness?: string | undefined;
        // What the run currently stands at, so the panel opens where the run is rather than at "Default".
        readonly effort?: string | undefined;
        readonly thinking?: boolean | undefined;
        readonly fast?: boolean | undefined;
        /* THE VERB ON THE PANEL'S OWN BUTTON, which is what makes the picker end in a press instead of in a
         * click on a list row. The caller supplies it because only the caller knows what the press does; this
         * one passes the button's own label, so the panel a "Fix with agent" caret opens is closed by a bar
         * that says "Fix with agent" — the same words, the same act, one click from wherever in the panel the
         * user finished configuring. */
        readonly action?: string | undefined;
        /* ASK FOR THE MODEL'S OWN RUN SETTINGS TOO — effort, extended thinking, speed. The host's picker is one
         * panel over several questions, and only some of its callers can honour an answer about how hard a
         * model thinks: a run button does (all three ride onto the turn it starts), while the chat sets its own
         * in the composer and a workflow step stores a pair and an account and nothing else. A control whose
         * answer is dropped is worse than no control, so the rows are drawn only for a caller that says it
         * carries the fields. This composable always does. */
        readonly chooseRun?: boolean;
    }): Promise<AgentRunChoice | undefined>;
}

export interface AgentRunPicker {
    // What the next run opens on, the user's pick if they made one, else the sandbox's standing list.
    readonly model: ComputedRef<AgentRunChoice>;
    // Whether that would start a DIFFERENT run from the sandbox's standing order. The button shows the model
    // only when it is: a control that names the standing setting on every row of a list is noise, and one that
    // stays silent about a deviation is a trap.
    readonly overridden: ComputedRef<boolean>;
    /* Open the picker over the caret and answer whether the user pressed its button. Anchored to the element the
     * caller hands back, because in a popped-out panel the overlay has to measure and dismiss against THAT
     * window rather than the opener's; `action` is the verb that button carries.
     *
     * TRUE MEANS START THE RUN, and that is the whole point of the return value: configuring the run and
     * starting it are one act, so the press that ends the panel is the press that spends the money. False is a
     * dismissal — Escape, a click outside, the sheet's backdrop — and changes nothing at all. */
    readonly choose: (anchor: HTMLElement, action: string) => Promise<boolean>;
    // Back to the standing setting, called once a run has been started with the pick, so the next one on the
    // same row does not silently inherit a choice made for a different failure.
    readonly clear: () => void;
}

/* `role` names the job this button starts, which is what the sandbox keys its model lists by. A plain string
 * rather than the contract's union, for the reason every other id crossing this boundary is one: the kit is
 * loaded by extensions that cannot see the daemon's types, and an unknown role is answered by the host with the
 * composer's own model — the same floor an unpinned one gets — rather than by a crash in somebody's panel. */
export function useAgentRunPick(models: () => ModelPicking, role: string): AgentRunPicker {
    const picked = ref<AgentRunChoice | undefined>(undefined);
    const standing = computed<AgentRunChoice>(() => models().agentRun(role));
    const model = computed<AgentRunChoice>(() => picked.value ?? standing.value);
    return {
        model,
        overridden: computed(() => picked.value !== undefined && !sameChoice(picked.value, standing.value)),
        choose: async (anchor: HTMLElement, action: string): Promise<boolean> => {
            const next = await models().pick({
                anchor,
                action,
                // Every surface that presses this button sends the knobs on with the model (the daemon fills a
                // pinned entry's own in only for a run that named neither), so the rows are always offered here.
                chooseRun: true,
                provider: model.value.provider,
                model: model.value.model,
                ...(model.value.account !== undefined ? { account: model.value.account } : {}),
                ...(model.value.harness !== undefined ? { harness: model.value.harness } : {}),
                ...(model.value.effort !== undefined ? { effort: model.value.effort } : {}),
                ...(model.value.thinking !== undefined ? { thinking: model.value.thinking } : {}),
                ...(model.value.fast !== undefined ? { fast: model.value.fast } : {}),
            });
            if (next === undefined) {
                return false;
            }
            picked.value = next;
            return true;
        },
        clear: (): void => {
            picked.value = undefined;
        },
    };
}
