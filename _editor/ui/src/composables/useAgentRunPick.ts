import { computed, type ComputedRef, ref } from "vue";

/* THE MODEL A SURFACE-STARTED RUN WILL OPEN ON, AND THE OVERRIDE FOR IT, the state behind every <AgentRunButton> in the app. */

// What the run opens on; structural, since the shell's ModelChoice and an extension's PickedModel are both this.
export interface AgentRunChoice {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
    // How hard it thinks, applied only to a turn that names no model, so a re-pointed run must carry it
    // explicitly or silently drop to the provider's default tier.
    readonly effort?: string | undefined;
    // What the app calls that tier, since only the host holds the scale; absent whenever `effort` is.
    readonly effortLabel?: string | undefined;
/* THE OTHER TWO KNOBS THE PICKER NOW OFFERS A RUN, and they ride for exactly the reason the tier does. */
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
/* WHAT THE PRESS DOES TO THE ATTEMPT ALREADY MADE, when the panel was opened over one (`attempt` on the pick): continue it, or start over from it. */
    readonly resume?: "continue" | "start-over" | undefined;
}

/* THE ATTEMPT A RUN BUTTON STANDS BESIDE, when there is one: a line naming it, and whether it can be continued from here. */
export interface AgentRunAttempt {
    readonly summary: string;
    readonly continuable: boolean;
}

/* WHETHER TWO SELECTIONS WOULD START THE SAME RUN, which is the only question `overridden` is really asking. */
const sameChoice = (left: AgentRunChoice, right: AgentRunChoice): boolean =>
    left.provider === right.provider &&
    left.model === right.model &&
    left.account === right.account &&
    left.harness === right.harness &&
    left.effort === right.effort &&
    left.thinking === right.thinking &&
    left.fast === right.fast;

/* The two questions this asks of whichever world it is running in: what would run if nobody chose, and let them choose. */
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
/* THE VERB ON THE PANEL'S OWN BUTTON, which is what makes the picker end in a press instead of in a click on a list row. */
        readonly action?: string | undefined;
/* ASK FOR THE MODEL'S OWN RUN SETTINGS TOO — effort, extended thinking, speed. */
        readonly chooseRun?: boolean;
        // The attempt the bar's verbs are about (AgentRunAttempt); absent, the bar carries `action` alone.
        readonly attempt?: AgentRunAttempt | undefined;
    }): Promise<AgentRunChoice | undefined>;
}

export interface AgentRunPicker {
    // Names the job this button starts, the key the sandbox lists models by. A plain string, since an
    // unknown role falls back to the composer's own model rather than crashing.
    readonly model: ComputedRef<AgentRunChoice>;
    // Whether that would start a DIFFERENT run from the sandbox's standing order. The button shows the model
    // only when it is: a control that names the standing setting on every row of a list is noise, and one that
    // stays silent about a deviation is a trap.
    readonly overridden: ComputedRef<boolean>;
/* Open the picker over the caret and answer whether the user pressed its button. */
    readonly choose: (anchor: HTMLElement, action: string) => Promise<boolean>;
/* THE VERB THE PANEL ENDED WITH, for the run the caller is about to start: continue the attempt it was opened over, or start over from it. */
    readonly resume: ComputedRef<"continue" | "start-over" | undefined>;
    // Back to the standing setting, called once a run has been started with the pick, so the next one on the
    // same row does not silently inherit a choice made for a different failure.
    readonly clear: () => void;
}

// Back to the standing setting, called once a run starts, so the next press doesn't inherit this pick. `attempt` is
// read at the moment the caret opens, since the attempt beside a row changes with the fleet while the row stands.
export function useAgentRunPick(models: () => ModelPicking, role: string, attempt?: () => AgentRunAttempt | undefined): AgentRunPicker {
    const picked = ref<AgentRunChoice | undefined>(undefined);
    const standing = computed<AgentRunChoice>(() => models().agentRun(role));
    const model = computed<AgentRunChoice>(() => picked.value ?? standing.value);
    return {
        model,
        overridden: computed(() => picked.value !== undefined && !sameChoice(picked.value, standing.value)),
        resume: computed(() => picked.value?.resume),
        choose: async (anchor: HTMLElement, action: string): Promise<boolean> => {
            const over = attempt?.();
            const next = await models().pick({
                anchor,
                action,
                ...(over !== undefined ? { attempt: over } : {}),
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
