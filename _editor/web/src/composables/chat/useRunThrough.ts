import type { IconName } from "@intentic/ui";
import { type LoopDesign, loopFromDesign, type Workflow } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref } from "vue";
import { useRouter } from "vue-router";
import { useAgents } from "../agents/useAgents";
import { useLoopDesigns } from "../agents/useLoopDesigns";
import { startLoop, stopLoop } from "../agents/useLoops";
import { useWorkflowRuns } from "../agents/useWorkflowRuns";
import { navigateInApp } from "../mainWindow";
import type { Conversation } from "./conversation";
import { openRunInChat } from "./openRun";

/* --- THE RUN-THROUGH BADGE ------------------------------------------------------------------------
 * ONE control for the one question, what is the next message run THROUGH, and it took two pills far too long
 * to admit they were asking it. A loop repeats the message here until a bar is cleared; a workflow hands it to a
 * design of sessions that are not this one. Different machines, mutually exclusive answers, and the old row
 * expressed that exclusivity by greying whichever pill you hadn't used yet.
 *
 * FOUR STATES, in this precedence:
 *
 *  - RUNNING a loop, the round count, and the press ENDS it. Outranks everything, including a workflow the user
 *    might otherwise want to arm mid-loop: a loop already going spends money with nobody pressing anything
 *    between rounds, so the one press it needs is the way out, and a badge that hid the stop behind a menu would
 *    leave the fleet board as the only exit. One press ends it and the badge is a picker again.
 *  - WORKFLOW armed, the design's own glyph and name, in the active tint.
 *  - LOOP armed, the same, in the loop's glyph.
 *  - Nothing, a bare `fork`: a message taking some route other than straight down into this chat. Neither of
 *    the two specific glyphs, deliberately, since either would read as one of them already being armed.
 *
 * The state is decided ONCE and the glyph, the name, the tooltip and the aria label are lookups on it. They used
 * to be four ladders of ifs in four different orders, which is exactly how a control with four states grows a
 * fifth nobody meant.
 *
 * Never greyed under a workflow badge the way model, effort, mode and persona are. Those describe a turn the
 * workflow send doesn't make; this one IS the badge, and a control you cannot press to undo is a trap. */
export type RunThroughState = `running` | `workflow` | `loop` | `idle`;

interface BadgeWords {
    /** The armed design's name, empty only in states that don't say one. */
    readonly name: string;
    /** Which round a running loop is on. */
    readonly iteration: number;
}

const ICON: Record<RunThroughState, IconName> = { running: `repeat`, workflow: `sitemap`, loop: `repeat`, idle: `fork` };

const HINT: Record<RunThroughState, (words: BadgeWords) => string> = {
    running: (words) => `Stop looping, iteration ${words.iteration} finishes first. Use Stop to cut it short.`,
    workflow: (words) => `Send runs "${words.name}" with this message as its request`,
    loop: (words) => `Send runs "${words.name}", this message is the goal, repeated until it is met`,
    idle: () => `Repeat this message until a goal is met, or run it through a workflow`,
};

const LABEL: Record<RunThroughState, (words: BadgeWords) => string> = {
    running: () => `Stop looping`,
    workflow: (words) => `Workflow: ${words.name}`,
    loop: (words) => `Loop: ${words.name}`,
    idle: () => `Run this message through a loop or a workflow`,
};

export interface RunThrough {
    /** The picker's own open flag, the one control a picked workflow leaves live, because it holds the pick. */
    readonly open: Ref<boolean>;
    readonly state: ComputedRef<RunThroughState>;
    readonly icon: ComputedRef<IconName>;
    /** The armed design's name, or nothing when the badge is bare. */
    readonly name: ComputedRef<string | undefined>;
    readonly hint: ComputedRef<string>;
    readonly label: ComputedRef<string>;
    readonly workflow: ComputedRef<Workflow | undefined>;
    readonly loop: ComputedRef<LoopDesign | undefined>;
    /** The live loop behind a running badge, its round count. */
    readonly running: ComputedRef<{ readonly iteration: number; readonly maxIterations: number } | undefined>;
    readonly workflowFailure: Ref<string | undefined>;
    readonly loopFailure: Ref<string | undefined>;
    readonly pickLoop: (design: LoopDesign | undefined) => void;
    readonly pickWorkflow: (workflow: Workflow | undefined) => void;
    /** The way out to the page that owns saved loops AND saved workflows. */
    readonly manage: () => void;
    /** Stop the loop, the press a running badge is. */
    readonly end: () => Promise<void>;
    /** Drop both picks: what an armed edit does to every other answer to "what happens when I press send". */
    readonly clear: () => void;
    readonly clearFailures: () => void;
    /** Whether the badge took this press. False means the composer's ordinary send paths still apply. */
    readonly claimSend: () => boolean;
}

export const useRunThrough = (
    conversation: Ref<Conversation>,
    composer: {
        readonly reachable: Ref<boolean>;
        readonly connected: Ref<boolean>;
        /** Words or files in the box, a loop needs a goal, a workflow does not. */
        readonly staged: Ref<boolean>;
        readonly draft: Ref<string>;
    },
): RunThrough => {
    const router = useRouter();
    const { agentById } = useAgents();
    const { designs: loopDesigns } = useLoopDesigns();
    const { start: startWorkflow, designs: workflowDesigns } = useWorkflowRuns();

    const open = ref(false);
    const workflowFailure = ref<string>();
    const loopFailure = ref<string>();

    /* Two things are read off the fleet entry rather than asked anywhere: whether this agent works in its own
     * worktree (a loop cannot change that mid-flight), and whether one is already running (the daemon refuses a
     * second, so offering one would only spend a round to say no). */
    const activeLoop = computed(() => agentById(conversation.value.conversationId)?.loop);
    const looping = computed(() => activeLoop.value?.state === `running`);
    const isolated = computed(() => agentById(conversation.value.conversationId)?.branch !== undefined);

    const workflow = computed(() => workflowDesigns.value.find((design) => design.id === conversation.value.workflowId.value));
    const loop = computed(() => loopDesigns.value.find((design) => design.id === conversation.value.loopId.value));

    const state = computed<RunThroughState>(() => {
        if (looping.value) {
            return `running`;
        }
        if (workflow.value !== undefined) {
            return `workflow`;
        }
        return loop.value === undefined ? `idle` : `loop`;
    });
    const name = computed(() => workflow.value?.name ?? loop.value?.name);
    const words = computed<BadgeWords>(() => ({ name: name.value ?? ``, iteration: activeLoop.value?.iteration ?? 0 }));

    /* Send the draft as a run's request. The draft is cleared on success for the reason an ordinary send clears
     * it, the text has gone somewhere, and KEPT on failure, because the message is all the user has and a
     * control that eats it is one nobody presses twice. Then the run takes the screen (openRunInChat), which is
     * the same landing the board's card gives it. */
    const sendThroughWorkflow = async (design: Workflow): Promise<void> => {
        workflowFailure.value = undefined;
        const request = composer.draft.value.trim();
        try {
            const run = await startWorkflow.mutateAsync({ id: design.id, ...(request === `` ? {} : { request }) });
            composer.draft.value = ``;
            conversation.value.workflowId.value = undefined;
            await openRunInChat(run);
        } catch (error) {
            workflowFailure.value = error instanceof Error ? error.message : `The workflow could not be started.`;
        }
    };

    /* Start the armed loop with the draft as its goal. The badge clears too, and that is the one thing here that
     * must not be forgotten: a loop spends money per round with nobody pressing anything in between, so a badge
     * that survived its own start would turn the next ordinary message into a second paid loop, silently. */
    const sendThroughLoop = async (design: LoopDesign): Promise<void> => {
        loopFailure.value = undefined;
        const goal = composer.draft.value.trim();
        try {
            await startLoop(loopFromDesign(design, { conversationId: conversation.value.conversationId, goal, isolated: isolated.value }));
            composer.draft.value = ``;
            conversation.value.loopId.value = undefined;
        } catch (error) {
            loopFailure.value = error instanceof Error ? error.message : `The loop could not be started.`;
        }
    };

    return {
        open,
        state,
        icon: computed(() => ICON[state.value]),
        name,
        hint: computed(() => HINT[state.value](words.value)),
        label: computed(() => LABEL[state.value](words.value)),
        workflow,
        loop,
        running: computed(() => (looping.value ? activeLoop.value : undefined)),
        workflowFailure,
        loopFailure,
        // A pick REPLACES a pick, in both directions. The composer can only run the next message one way, so
        // holding both ids at once was never a state a person could mean, only one they could reach.
        pickLoop: (design: LoopDesign | undefined): void => {
            open.value = false;
            loopFailure.value = undefined;
            conversation.value.loopId.value = design?.id;
            if (design !== undefined) {
                conversation.value.workflowId.value = undefined;
            }
        },
        pickWorkflow: (design: Workflow | undefined): void => {
            open.value = false;
            workflowFailure.value = undefined;
            conversation.value.workflowId.value = design?.id;
            if (design !== undefined) {
                conversation.value.loopId.value = undefined;
            }
        },
        // The same errand the persona menu's "Manage" runs, and the only door to the long loop form now that the
        // composer carries none.
        manage: (): void => {
            open.value = false;
            // In a popped-out chat the form opens in the app's own window, not over the conversation.
            navigateInApp(router, { name: `extension`, params: { ext: `workflows` }, query: { loop: `list` } });
        },
        end: async (): Promise<void> => {
            if (!composer.reachable.value) {
                return;
            }
            // Stops the LOOP, not the turn: whatever iteration is running finishes and lands. Abandoning it
            // outright is this plus the Stop button beside it, which is exactly how it reads on screen.
            await stopLoop(conversation.value.conversationId).catch(() => undefined);
        },
        clear: (): void => {
            conversation.value.workflowId.value = undefined;
            conversation.value.loopId.value = undefined;
        },
        clearFailures: (): void => {
            workflowFailure.value = undefined;
            loopFailure.value = undefined;
        },
        /* THE BADGE INTERCEPTS THE SEND, ahead of every gate the composer applies to a message going into this
         * chat, a pending plan, a running turn to steer, staged attachments. This message is not one: it goes to
         * a graph of sessions that are not this chat, or to a loop that drives its own turns. `connected` still
         * applies: with no daemon there is nothing to start.
         *
         * Unlike a workflow's, a loop's send needs a GOAL, a loop with an empty one has nothing to converge on
         * and the daemon's own schema refuses it, so it gates on the composer actually holding something rather
         * than on `canSend`, which is also true for the presses that send something OTHER than the draft (a queue
         * to flush, a stopped turn to continue). A loop started off one of those would go up with no goal at all.
         *
         * The loop is checked BELOW the workflow because a workflow greys the loop pill: the two can never be
         * armed at once, so the order is a formality kept explicit rather than a precedence. */
        claimSend: (): boolean => {
            if (!composer.connected.value) {
                return false;
            }
            const armedWorkflow = workflow.value;
            if (armedWorkflow !== undefined) {
                void sendThroughWorkflow(armedWorkflow);
                return true;
            }
            const armedLoop = loop.value;
            if (armedLoop === undefined || !composer.staged.value || looping.value) {
                return false;
            }
            void sendThroughLoop(armedLoop);
            return true;
        },
    };
};
