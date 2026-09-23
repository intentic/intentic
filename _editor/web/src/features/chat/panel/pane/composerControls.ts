import { type AgentProvider, isTrialProvider, type PermissionMode } from "@intentic/sandbox-contract";
import { computed, type Ref, ref, watch } from "vue";
import { boxNameOf, scopeOffered } from "../../../agents/fleet/fleetScope";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useRunners } from "../../../sandbox/devices/runners/useRunners";
import { providerDisplayLabel } from "../../accounts/providerCatalog";
import { type ComposerControl, overflowRows, ridesRow } from "../../composer/composerMore";
import { composerModelReading } from "../../composer/composerModelLabel";
import { modeMeta } from "../../models/catalog";
import type { RunThrough } from "../../models/run-settings/useRunThrough";
import { startingMode } from "../../run/turnDefaults";
import type { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../../transcript/transcript";

// The composer's row of controls for one pane: which pills ride the row and which wait in the overflow, where the
// conversation runs, what each pill reads, the one open flag per picker, and the precedence between the choices that
// rewrite what Send means (an armed edit, a workflow badge, the agent's voice).

// Where each picker opens while its own chip rides the row; the overflow button stands in for it otherwise.
export interface ControlPills {
    readonly mode: Readonly<Ref<HTMLElement | undefined>>;
    readonly persona: Readonly<Ref<HTMLElement | undefined>>;
    readonly runThrough: Readonly<Ref<HTMLElement | undefined>>;
    readonly more: Readonly<Ref<HTMLElement | undefined>>;
}

// Where the next agent runs: this sandbox (neither), one of its runners, or another box. The two axes are one choice,
// so each pick clears the other: a runner belongs to the sandbox that paired it, and "that runner in another box" names
// nothing there. Refused once the board has seen the conversation, since placement latches with the branch then.
export const placeConversation = (
    conversation: Conversation,
    at: { readonly box?: string | undefined; readonly runner?: string | undefined },
): boolean => {
    if (conversation.registered.value) {
        return false;
    }
    conversation.box.value = at.box;
    conversation.runner.value = at.runner;
    return true;
};

export interface ControlsHost {
    readonly conversation: () => Conversation;
    // The posture the mode pill names: the live turn's own when it moved itself, else the pick.
    readonly mode: Readonly<Ref<PermissionMode>>;
    readonly provider: Readonly<Ref<AgentProvider>>;
    readonly model: Readonly<Ref<string>>;
    readonly runThrough: Pick<RunThrough, "open" | "state" | "clear">;
    // A picked workflow takes the composer over: its badge greys the setting pills.
    readonly steered: Readonly<Ref<boolean>>;
    readonly editing: Readonly<Ref<ChatMessage | undefined>>;
    readonly pills: ControlPills;
}

export const useComposerControls = (host: ControlsHost) => {
    const { conversation, runThrough } = host;
    // One open flag per picker menu (desktop panel or mobile sheet), not one per surface: they drifted apart once.
    const modelOpen = ref(false);
    const modeOpen = ref(false);
    const personaOpen = ref(false);
    const placementOpen = ref(false);
    const moreOpen = ref(false);
    // Armed, the next Send places the words into the transcript as the agent's (no turn) and disarms itself.
    const voiceAgent = ref(false);

    // Where this conversation lives: undefined for this browser's own sandbox; set, the turn runs on that daemon and
    // this pane is one of its renderers, so each control that only makes sense here refuses on its own.
    const conversationBox = computed(() => conversation().box.value);
    const remote = computed(() => conversationBox.value !== undefined);
    // The box's name off the roster, not copied onto the conversation, so a rename can't go stale here.
    const remoteName = computed(() =>
        conversationBox.value === undefined ? undefined : (boxNameOf.value.get(conversationBox.value) ?? `another sandbox`),
    );
    const { runners: pairedRunners } = useRunners();
    const { agentById } = useAgents();
    // Offered where there is somewhere else to run, or once the chat is placed; `scopeOffered` is the board's test.
    const placementShown = computed(
        () => pairedRunners.value.length > 0 || scopeOffered.value || conversation().runner.value !== undefined || remote.value,
    );
    // Writing as the agent needs a registry entry to place into, which the chat has from its first turn on.
    const placeable = computed(() => conversation().registered.value || agentById(conversation().conversationId) !== undefined);

    // The pill's own rule (composerModelLabel.ts), read here for the accessible name beside it too.
    const modelReading = computed(() =>
        composerModelReading({
            provider: host.provider.value,
            harness: conversation().selection.harness.value,
            model: host.model.value,
            auto: conversation().selection.auto.value,
        }),
    );

    // What the row shows vs. what the overflow holds (composerMore.ts owns the rule; this is its reading).
    const controlSituation = computed(() => ({
        mode: host.mode.value,
        startingMode: startingMode(conversation().isolated.value),
        persona: conversation().selection.actsAs.value,
        runThrough: runThrough.state.value,
        voiceAgent: voiceAgent.value,
        personaOffered: !remote.value,
        voiceOffered: placeable.value,
    }));
    const inRow = computed(() => ridesRow(controlSituation.value));
    const moreRows = computed(() => overflowRows(controlSituation.value));
    // Each picker opens over whichever element it was reached from, so nothing anchors to an element that has gone.
    const anchorOf = (control: ComposerControl, own: Readonly<Ref<HTMLElement | undefined>>) =>
        computed(() => (inRow.value[control] ? own.value : host.pills.more.value));

    // Only one answer to "what does send do" can hold, and an armed edit wins as the most specific act; cleared visibly
    // rather than disabled, so the precedence is seen rather than discovered by pressing Send.
    watch(host.editing, (armed) => {
        if (armed === undefined) {
            return;
        }
        voiceAgent.value = false;
        runThrough.clear();
    });
    // A workflow badge takes the composer over: an armed voice under it misattributes the next send, and the panels
    // its greyed pills open close with them. Run-through stays live, since it holds the pick.
    watch(host.steered, (steered) => {
        if (!steered) {
            return;
        }
        voiceAgent.value = false;
        modelOpen.value = false;
        modeOpen.value = false;
        personaOpen.value = false;
        moreOpen.value = false;
    });

    return {
        modelOpen,
        modeOpen,
        personaOpen,
        placementOpen,
        moreOpen,
        voiceAgent,
        conversationBox,
        remote,
        pairedRunners,
        placementShown,
        placementLabel: computed(() => remoteName.value ?? conversation().runner.value ?? `Here`),
        modelReading,
        modelLabelText: computed(() => modelReading.value.label),
        // Our own text, always a real model name; `providerDisplayLabel` covers capability-derived providers too.
        providerName: computed(() => providerDisplayLabel(host.provider.value)),
        // The trial has no vendor to name: it's the product's own channel, not somebody's account.
        onTrial: computed(() => isTrialProvider(host.provider.value)),
        modeLabel: computed(() => modeMeta(host.mode.value).label),
        modeIcon: computed(() => modeMeta(host.mode.value).icon),
        inRow,
        moreRows,
        // What's behind the overflow button, said on the button: the one thing it owes a reader before the press.
        moreHint: computed(() => moreRows.value.map((row) => row.label).join(` · `)),
        modeAnchor: anchorOf(`mode`, host.pills.mode),
        personaAnchor: anchorOf(`persona`, host.pills.persona),
        runThroughAnchor: anchorOf(`runThrough`, host.pills.runThrough),
        // A row hands off to the control that owns the choice, closing the overflow first so the next panel's
        // dismissal never catches the same press; voice has nothing to pick, so its row is the press itself.
        openFromMore: (control: ComposerControl): void => {
            moreOpen.value = false;
            if (control === `mode`) {
                modeOpen.value = true;
            } else if (control === `persona`) {
                personaOpen.value = true;
            } else if (control === `runThrough`) {
                runThrough.open.value = true;
            } else {
                voiceAgent.value = true;
            }
        },
    };
};
