import type { IconName, Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { NoticeModel } from "@intentic/ui/async";
import { type LoopDesign, loopFromDesign, type Workflow } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref } from "vue";
import { useRouter } from "vue-router";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useLoopDesigns } from "../../../agents/fleet/useLoopDesigns";
import { startLoop, stopLoop } from "../../../agents/fleet/useLoops";
import { useWorkflowRuns } from "../../../agents/fleet/useWorkflowRuns";
import { useOperations } from "../../../../workbench/operations/operations";
import { navigateInApp } from "../../../../workbench/window/mainWindow";
import { useListedView, WORKFLOWS } from "../../../../workbench/views/listedViews";
import type { Conversation } from "../../session/conversation";
import { openRunInChat } from "../../run/openRun";

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
}

const ICON: Record<RunThroughState, IconName> = { running: `repeat`, workflow: `sitemap`, loop: `repeat`, idle: `fork` };

// The badge's hover card: what the press does, the armed design by name, and the one consequence worth knowing first.
// The running badge already shows its round count, so its card does not repeat it.
const HINT: Record<RunThroughState, (words: BadgeWords) => Tip> = {
    running: () => ({ title: t(`chat.runThrough.stopLooping`), note: t(`chat.runThrough.roundFinishesFirst`) }),
    workflow: (words) => ({
        title: t(`chat.runThrough.workflow`),
        rows: [{ label: t(`shared.name`), value: words.name }],
        note: t(`chat.runThrough.messageIsRequest`),
    }),
    loop: (words) => ({
        title: t(`chat.runThrough.loop`),
        rows: [{ label: t(`shared.name`), value: words.name }],
        note: t(`chat.runThrough.repeatsUntilMet`),
    }),
    idle: () => ({ title: t(`chat.runThrough.runThrough`), note: t(`chat.runThrough.loopOrWorkflow`) }),
};

const LABEL: Record<RunThroughState, (words: BadgeWords) => string> = {
    running: () => t(`chat.runThrough.stopLooping`),
    workflow: (words) => t(`chat.runThrough.workflowNamed`, { name: words.name }),
    loop: (words) => t(`chat.runThrough.loopNamed`, { name: words.name }),
    idle: () => t(`chat.runThrough.runMessageThrough`),
};

export interface RunThrough {
    /** The picker's own open flag, left live by a picked workflow since it still holds the pick. */
    readonly open: Ref<boolean>;
    readonly state: ComputedRef<RunThroughState>;
    readonly icon: ComputedRef<IconName>;
    /** The armed design's name, or nothing when the badge is bare. */
    readonly name: ComputedRef<string | undefined>;
    readonly hint: ComputedRef<Tip>;
    readonly label: ComputedRef<string>;
    readonly workflow: ComputedRef<Workflow | undefined>;
    readonly loop: ComputedRef<LoopDesign | undefined>;
    /** The live loop behind a running badge, its round count. */
    readonly running: ComputedRef<{ readonly iteration: number; readonly maxIterations: number } | undefined>;
    readonly workflowFailure: ComputedRef<string | undefined>;
    readonly loopFailure: ComputedRef<string | undefined>;
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
    const workflowsPage = useListedView(WORKFLOWS);
    const { agentById } = useAgents();
    const { designs: loopDesigns } = useLoopDesigns();
    const { start: startWorkflow, designs: workflowDesigns } = useWorkflowRuns();

    const open = ref(false);
    // Starting a workflow, starting a loop and stopping one, kept with the conversation rather than this pane: a stop
    // the daemon refused leaves a loop spending money unattended, which closing the pane must not silence, and a start
    // still in the air must not be pressed into a second run by the pane drawn after it.
    const work = useOperations(() => `chat/${conversation.value.conversationId}/run-through`);
    // The cause in its own words where it gave some, else the app's sentence: the line under the box has room for one.
    const said = (failure: NoticeModel | undefined): string | undefined => failure && (failure.detail ?? failure.title);
    const workflowFailure = computed(() => said(work.at(`workflow`)?.failure));
    // A loop's start and its stop answer on the same line; whichever ended last is the one still true.
    const loopFailure = computed(() =>
        said(
            [`loop`, `stop`]
                .flatMap((act) => work.at(act) ?? [])
                .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.failure,
        ),
    );
    const clearFailures = (...acts: readonly string[]): void => {
        for (const act of acts) {
            if (work.at(act)?.state === `failed`) {
                work.dismiss(act);
            }
        }
    };

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
    const words = computed<BadgeWords>(() => ({ name: name.value ?? `` }));

    // Sends the draft as the run's request; cleared on success, kept on failure so the message isn't lost. The started
    // run takes the screen (openRunInChat), same as the board's card.
    const sendThroughWorkflow = async (design: Workflow): Promise<void> => {
        clearFailures(`workflow`);
        const chat = conversation.value;
        const request = composer.draft.value.trim();
        await work.run(`workflow`, {
            what: t(`chat.runThrough.startingWorkflow`, { name: design.name }),
            failed: t(`chat.runThrough.workflowNotStarted`),
            done: () => t(`chat.runThrough.workflowStarted`, { name: design.name }),
            task: async () => {
                const run = await startWorkflow.mutateAsync({ id: design.id, ...(request === `` ? {} : { request }) });
                chat.draft.value = ``;
                chat.workflowId.value = undefined;
                await openRunInChat(run);
            },
        });
    };

    // Starts the armed loop with the draft as its goal, clearing the badge too: a loop spends money every round
    // unattended, so a badge that survived its own start would silently loop the next message too.
    const sendThroughLoop = async (design: LoopDesign): Promise<void> => {
        clearFailures(`loop`, `stop`);
        const chat = conversation.value;
        const goal = composer.draft.value.trim();
        const loopOf = loopFromDesign(design, { conversationId: chat.conversationId, goal, isolated: isolated.value });
        await work.run(`loop`, {
            what: t(`chat.runThrough.startingLoop`, { name: design.name }),
            failed: t(`chat.runThrough.loopNotStarted`),
            done: () => t(`chat.runThrough.loopStarted`, { name: design.name }),
            task: async () => {
                await startLoop(loopOf);
                chat.draft.value = ``;
                chat.loopId.value = undefined;
            },
        });
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
            clearFailures(`loop`, `stop`);
            conversation.value.loopId.value = design?.id;
            if (design !== undefined) {
                conversation.value.workflowId.value = undefined;
            }
        },
        pickWorkflow: (design: Workflow | undefined): void => {
            open.value = false;
            clearFailures(`workflow`);
            conversation.value.workflowId.value = design?.id;
            if (design !== undefined) {
                conversation.value.loopId.value = undefined;
            }
        },
        // Same errand as the persona menu's Manage; the only door left to the long loop form. That form is the Workflows
        // extension's page, a listed extension: where it isn't installed or is off, the door is where to set it up.
        manage: (): void => {
            open.value = false;
            // In a popped-out chat the form opens in the app's own window, not over the conversation.
            navigateInApp(
                router,
                workflowsPage.state.value === `here` ? { name: `extension`, params: { ext: WORKFLOWS.view }, query: { loop: `list` } } : workflowsPage.setUp.value,
            );
        },
        end: async (): Promise<void> => {
            if (!composer.reachable.value) {
                return;
            }
            // Stops the loop, not the turn: the running iteration finishes and lands before it stops. A refused stop leaves
            // it spending unattended, so it is said under the box rather than dropped, and raised wherever the reader is
            // when the pane was closed before the answer came.
            clearFailures(`loop`, `stop`);
            const conversationId = conversation.value.conversationId;
            await work.run(`stop`, {
                what: t(`chat.runThrough.stoppingLoop`),
                failed: t(`chat.runThrough.loopNotStopped`),
                done: () => t(`chat.runThrough.loopStopped`),
                task: () => stopLoop(conversationId),
            });
        },
        clear: (): void => {
            conversation.value.workflowId.value = undefined;
            conversation.value.loopId.value = undefined;
        },
        clearFailures: (): void => clearFailures(`workflow`, `loop`, `stop`),
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
