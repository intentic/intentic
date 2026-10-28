import { computed, type ComputedRef, ref } from "vue";
import { useNow } from "./useNow.js";

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

/* WHAT A RUN ON A CHOICE WOULD MEET IF IT STARTED NOW, answered by the host's one rule (the composer's Send reads the same):
   its allowance is spent, and reopens at `reopensAt`. A press then books the run for that instant (AgentRunBooking)
   rather than sending it into a refusal, which is how a model chosen with no allowance left schedules work for later. */
export interface AgentRunAllowance {
    // When the spent allowance reopens (epoch ms), still ahead: the run starts by itself then.
    readonly reopensAt: number;
    // The narrowest honest label for that instant, the composer's scheduled Send's own: "40m", "21:00", "Tue 09:00".
    readonly short: string;
    // The longer form for a tooltip: "21:00, about 4 hours".
    readonly when: string;
}

/* THE BOOKING A PRESS ON A SPENT ALLOWANCE MAKES, in the wire's own words (AgentTurn's `sendAt` with `sendAtReopen`): held until the reopen, sent then, and nothing reaches the provider before. */
export interface AgentRunBooking {
    readonly sendAt: number;
    readonly sendAtReopen: true;
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
    // What a run started on `choice` at `now` would meet (AgentRunAllowance), undefined when it would go at once. Reactive
    // when read in a computed: it moves with the accounts' readings and refusals as the composer's Send does.
    allowance(
        choice: { readonly provider: string; readonly model: string; readonly account?: string | undefined; readonly harness?: string | undefined },
        now: number,
    ): AgentRunAllowance | undefined;
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
/* THE PRESS BOOKS A SPENT ALLOWANCE'S RUN FOR ITS REOPEN: the bar's verbs then say when it starts, as the button beside it does. */
        readonly schedules?: boolean | undefined;
    }): Promise<AgentRunChoice | undefined>;
}

export interface AgentRunPicker {
    // Names the job this button starts, the key the sandbox lists models by. A plain string, since an
    // unknown role falls back to the model a new chat would open on rather than crashing.
    readonly model: ComputedRef<AgentRunChoice>;
    // Whether that would start a DIFFERENT run from the sandbox's standing order. The button shows the model
    // only when it is: a control that names the standing setting on every row of a list is noise, and one that
    // stays silent about a deviation is a trap.
    readonly overridden: ComputedRef<boolean>;
/* Open the picker over the caret and answer whether the user pressed its button. */
    readonly choose: (anchor: HTMLElement, action: string) => Promise<boolean>;
/* THE VERB THE PANEL ENDED WITH, for the run the caller is about to start: continue the attempt it was opened over, or start over from it. */
    readonly resume: ComputedRef<"continue" | "start-over" | undefined>;
    // The model's allowance is spent with a reopen ahead (AgentRunAllowance), so the press starts the run then, not now;
    // undefined while it would go at once. What <AgentRunButton> draws as a time on its press.
    readonly spent: ComputedRef<AgentRunAllowance | undefined>;
    // What the caller sends with its press so the run waits for that reopen: the booking `spent` promises, or undefined
    // to start now. Every press beside the button must carry it, or the button says one thing and the run does another.
    readonly booking: ComputedRef<AgentRunBooking | undefined>;
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
    // A minute-scale clock: the label counts minutes, and a reopen passed a beat ago books for an instant the sandbox
    // already lets through.
    const now = useNow(true, 30_000);
    const spent = computed(() => models().allowance(model.value, now.value));
    return {
        model,
        overridden: computed(() => picked.value !== undefined && !sameChoice(picked.value, standing.value)),
        resume: computed(() => picked.value?.resume),
        spent,
        booking: computed(() => (spent.value === undefined ? undefined : { sendAt: spent.value.reopensAt, sendAtReopen: true as const })),
        choose: async (anchor: HTMLElement, action: string): Promise<boolean> => {
            const over = attempt?.();
            const next = await models().pick({
                anchor,
                action,
                ...(over !== undefined ? { attempt: over } : {}),
                // Every surface that presses this button sends the knobs on with the model (the daemon fills a
                // pinned entry's own in only for a run that named neither), so the rows are always offered here.
                chooseRun: true,
                // Every press beside this picker carries `booking`, so a spent model's run waits for its reopen.
                schedules: true,
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
