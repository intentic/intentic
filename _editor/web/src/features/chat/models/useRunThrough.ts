import type { IconName } from "@intentic/ui";
import { type LoopDesign, loopFromDesign, type Workflow } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref } from "vue";
import { useRouter } from "vue-router";
import { useAgents } from "../../agents/fleet/useAgents";
import { useLoopDesigns } from "../../agents/fleet/useLoopDesigns";
import { startLoop, stopLoop } from "../../agents/fleet/useLoops";
import { useWorkflowRuns } from "../../agents/fleet/useWorkflowRuns";
import { navigateInApp } from "../../../shell/window/mainWindow";
import type { Conversation } from "../session/conversation";
import { openRunInChat } from "../run/openRun";

// The one control for what the next message runs through, mutually exclusive states, in this precedence:
//
// - running: a loop's round count; the press stops it (outranks arming a workflow, since a running loop spends
//   money unattended)
// - workflow: the armed design's glyph and name
// - loop: the same, in the loop's glyph
// - idle: bare `fork`, since either specific glyph would read as already armed
//
// Never greyed under a workflow the way model/effort/mode are: this control is the badge, and it must stay
// pressable to undo itself.
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
    /** The picker's own open flag, left live by a picked workflow since it still holds the pick. */
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
    /** The way out to the page that owns saved loops and saved workflows. */
    readonly manage: () => void;
    /** Stops the loop; the press a running badge takes. */
    readonly end: () => Promise<void>;
    /** Drops both picks (loop and workflow). */
    readonly clear: () => void;
    readonly clearFailures: () => void;
    /** Whether the badge took this press; false means the composer's ordinary send paths still apply. */
    readonly claimSend: () => boolean;
}

export const useRunThrough = (
    conversation: Ref<Conversation>,
    composer: {
        readonly reachable: Ref<boolean>;
        readonly connected: Ref<boolean>;
        /** Words or files staged in the box; a loop needs a goal, a workflow does not. */
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

    // Read off the fleet entry rather than asked separately: whether this agent is isolated (a loop can't change that
    // mid-flight), and whether a loop is already running (the daemon refuses a second).
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

    // Sends the draft as the run's request; cleared on success, kept on failure so the message isn't lost. The started
    // run takes the screen (openRunInChat), same as the board's card.
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

    // Starts the armed loop with the draft as its goal, clearing the badge too: a loop spends money every round
    // unattended, so a badge that survived its own start would silently loop the next message too.
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
        // A pick replaces a pick, in both directions: holding both ids at once is never a reachable state.
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
        // Same errand as the persona menu's Manage; the only door left to the long loop form.
        manage: (): void => {
            open.value = false;
            // In a popped-out chat the form opens in the app's own window, not over the conversation.
            navigateInApp(router, { name: `extension`, params: { ext: `workflows` }, query: { loop: `list` } });
        },
        end: async (): Promise<void> => {
            if (!composer.reachable.value) {
                return;
            }
            // Stops the loop, not the turn: the running iteration finishes and lands before it stops.
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
        // Intercepts send ahead of the composer's own gates, since the message goes elsewhere (a workflow graph, a
        // loop).
        // A loop needs `composer.staged` as its goal; checked after the workflow since the two are never armed
        // together.
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
