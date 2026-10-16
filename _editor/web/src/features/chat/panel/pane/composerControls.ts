import type { AgentProvider, PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import { isTrialProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, ref, watch } from "vue";
import { boxNameOf, scopeOffered } from "../../../../models/fleet/fleetScope";
import { useAgents } from "../../../../models/fleet/useAgents";
import { useRunners } from "../../../../models/sandbox/devices/useRunners";
import { providerDisplayLabel } from "../../../../models/providers/providerCatalog";
import { useComposerLanding } from "../../composer/composerLanding";
import { type ComposerControl, overflowRows, ridesRow } from "../../composer/composerMore";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { composerModelReading } from "../../composer/composerModelLabel";
import { modeMeta } from "../../models/catalog";
import type { RunThrough } from "../../models/run-settings/useRunThrough";
import { startingMode } from "../../../../models/conversations/run/turnDefaults";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

// The composer's row of controls for one pane: which pills ride the row and which wait in the overflow (where the
// conversation runs among them: a chip once it is placed elsewhere, an overflow row while it is here), what each pill
// reads, the one open flag per picker, and the precedence between the choices that rewrite what Send means (an armed
// edit, a workflow badge, the agent's voice).

// Where each picker opens while its own chip rides the row; the overflow button stands in for it otherwise.
export interface ControlPills {
    readonly mode: Readonly<Ref<HTMLElement | undefined>>;
    readonly placement: Readonly<Ref<HTMLElement | undefined>>;
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

// Somewhere other than this sandbox: the one placement that rides the row, since it is not the default.
const placedElsewhere = (conversation: Conversation): boolean => conversation.runner.value !== undefined || conversation.box.value !== undefined;

// What each overflow row opens: the flag of the panel that owns the choice, or, for the two with nothing to pick, the
// press itself (writing as the agent arms; landing turns the other way).
const openersOf = (flags: Record<Exclude<ComposerControl, `land`>, Ref<boolean>>, toggleLanding: () => void) =>
    ({
        mode: () => {
            flags.mode.value = true;
        },
        model: () => {
            flags.model.value = true;
        },
        placement: () => {
            flags.placement.value = true;
        },
        persona: () => {
            flags.persona.value = true;
        },
        runThrough: () => {
            flags.runThrough.value = true;
        },
        voice: () => {
            flags.voice.value = true;
        },
        land: toggleLanding,
    }) satisfies Record<ComposerControl, () => void>;

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
    // Plain words (a reader who does not write code) and a guest: what the overflow offers them (composerMore.ts).
    readonly plain: Readonly<Ref<boolean>>;
    readonly guest: Readonly<Ref<boolean>>;
}

export const useComposerControls = (host: ControlsHost) => {
    const { conversation, runThrough } = host;
    // One open flag per picker menu (desktop panel or mobile sheet), not one per surface: they drifted apart once.
    const modelOpen = ref(false);
    const modeOpen = ref(false);
    const personaOpen = ref(false);
    const placementOpen = ref(false);
    // The send's caret menu: when the message goes (a time, another agent's land), and the ways around a spent allowance.
    const laterOpen = ref(false);
    const moreOpen = ref(false);
    // Armed, the next Send places the words into the transcript as the agent's (no turn) and disarms itself.
    const voiceAgent = ref(false);

    // Where this conversation lives: undefined for this browser's own sandbox; set, the turn runs on that daemon and
    // this pane is one of its renderers, so each control that only makes sense here refuses on its own.
    const conversationBox = computed(() => conversation().box.value);
    const remote = computed(() => conversationBox.value !== undefined);
    // The box's name off the roster, not copied onto the conversation, so a rename can't go stale here.
    const remoteName = computed(() =>
        conversationBox.value === undefined ? undefined : (boxNameOf.value.get(conversationBox.value) ?? t(`chat.chatPlacementMenu.anotherSandbox`)),
    );
    const { runners: pairedRunners } = useRunners();
    const { agentById } = useAgents();
    // Offered where there is somewhere else to run, or once the chat is placed; `scopeOffered` is the board's test.
    const placementShown = computed(
        () => pairedRunners.value.length > 0 || scopeOffered.value || conversation().runner.value !== undefined || remote.value,
    );
    // Writing as the agent needs a registry entry to place into, which the chat has from its first turn on.
    const placeable = computed(() => conversation().registered.value || agentById(conversation().conversationId) !== undefined);
    // Whether its finished work lands by itself, as this chat answers it (composerLanding.ts).
    const landing = useComposerLanding(conversation);

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
        placementOffered: placementShown.value,
        placed: placedElsewhere(conversation()),
        persona: conversation().selection.actsAs.value,
        runThrough: runThrough.state.value,
        voiceAgent: voiceAgent.value,
        personaOffered: !remote.value,
        voiceOffered: placeable.value,
        landOffered: landing.offered.value,
        lands: landing.lands.value,
        landOwn: landing.own.value,
        plain: host.plain.value,
        guest: host.guest.value,
        modelLabel: modelReading.value.label,
    }));
    // Whether the send's caret may book this message for later: a booking is held by this sandbox's own daemon, for a
    // send nothing else claims (a workflow or a loop takes the message somewhere a booking cannot follow).
    const laterOffered = computed(() => supportsRoute(`agent.queueSchedule`) && !remote.value && runThrough.state.value === `idle`);
    const inRow = computed(() => ridesRow(controlSituation.value));
    const moreRows = computed(() => overflowRows(controlSituation.value));
    // Each picker opens over whichever element it was reached from, so nothing anchors to an element that has gone.
    const anchorOf = (control: ComposerControl, own: Readonly<Ref<HTMLElement | undefined>>) =>
        computed(() => (inRow.value[control] ? own.value : host.pills.more.value));

    const OPENERS = openersOf({ mode: modeOpen, model: modelOpen, placement: placementOpen, persona: personaOpen, runThrough: runThrough.open, voice: voiceAgent }, landing.toggle);

    // Only one answer to "what does send do" can hold, and an armed edit wins as the most specific act; cleared visibly
    // rather than disabled, so the precedence is seen rather than discovered by pressing Send.
    watch(host.editing, (armed) => {
        if (armed === undefined) {
            return;
        }
        voiceAgent.value = false;
        runThrough.clear();
        conversation().sendLater.value = undefined;
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
        laterOpen.value = false;
        moreOpen.value = false;
    });

    return {
        modelOpen,
        modeOpen,
        personaOpen,
        placementOpen,
        laterOpen,
        moreOpen,
        voiceAgent,
        landing,
        controlSituation,
        laterOffered,
        conversationBox,
        remote,
        pairedRunners,
        placementShown,
        placementLabel: computed(() => remoteName.value ?? conversation().runner.value ?? t(`chat.composerQuickPick.here`)),
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
        moreHint: computed(
            (): Tip => ({
                title: host.plain.value ? t(`chat.chatPane.plain.moreSettings`) : t(`chat.chatPane.moreComposerSettings`),
                rows: moreRows.value.map((row) => ({ label: row.label, value: row.value })),
            }),
        ),
        modeAnchor: anchorOf(`mode`, host.pills.mode),
        placementAnchor: anchorOf(`placement`, host.pills.placement),
        personaAnchor: anchorOf(`persona`, host.pills.persona),
        runThroughAnchor: anchorOf(`runThrough`, host.pills.runThrough),
        // A row hands off to the control that owns the choice, closing the overflow first so the next panel's
        // dismissal never catches the same press; voice and landing have nothing to pick, so their rows are the press.
        openFromMore: (control: ComposerControl): void => {
            moreOpen.value = false;
            OPENERS[control]();
        },
    };
};
