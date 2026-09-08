<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { isTrialProvider, TRIAL_NOTICE } from "@intentic/sandbox-contract";
import { trialExhausted } from "../session/access";
import { useAgents } from "../../agents/fleet/useAgents";
import { trialStatus } from "../accounts/providerCatalog";
import { loadTrialStatus } from "../models/useChat-catalog";
import { usePaneView } from "./useChat-view";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { hoursLeftLine } from "../../settings/hosted-plan/hostedHours";
import { useHostedPlan } from "../../settings/hosted-plan/useHostedPlan";
import ChatAccountPanel from "../accounts/ChatAccountPanel.vue";
import ChatChooseModelButton from "../models/ChatChooseModelButton.vue";

// What this chat's standing is, above the composer: strips for a state the conversation arrived at by itself
// (archived; then what it can send with — account gate, trial, expired credential), each with its one answering
// press. The composer's own state stays with the composer; reads this pane's conversation via the injected view,
// never the focused one.

const { conversation, provider, account, accounts, streaming } = usePaneView();
const { reachable, active } = useSandbox();

// The last free hours, above the composer, to the person spending them: only on a hosted sandbox, only its owner
// (a guest can't buy more), only in the last stretch (hostedHours.ts's threshold) rather than from the first
// minute.
const { meter: hostedMeter, lowOnHours, offered: planOffered } = useHostedPlan();
const hoursNotice = computed(() => {
    if (!lowOnHours.value || hostedMeter.value === undefined || (active.value?.hosted ?? null) === null || active.value?.role !== `owner`) {
        return undefined;
    }
    return `${hoursLeftLine(hostedMeter.value)}. A sleeping machine spends none; ${planOffered.value ? `the hosted plan lifts the ceiling` : `it resets on the first`}.`;
});
const { agentById, archived, loadArchived, restore, busyIds } = useAgents();

// An archived agent can still be read in an open tab (opened from the archive view, or swept there while open);
// says so and offers the one way back, plus that sending un-archives it. Loaded on the reachable seam, not at
// setup, since the pane mounts before the daemon answers; only while the list is empty.
watch(
    reachable,
    (live) => {
        if (live && archived.value.length === 0) {
            void loadArchived();
        }
    },
    { immediate: true },
);
const activeArchived = computed(() => {
    const agent = agentById(conversation.value.conversationId);
    return agent?.archivedAt === undefined ? undefined : agent;
});

// What the trial strip says, or nothing off the trial: leads with the remaining count while there's allowance (it
// counts model calls, not turns, so one turn can spend several), then discloses routing through intentic; once
// spent, only the free Google sign-in matters.

// Not answering is an interruption; working for it is not — conflating the two put "Failed messages are not
// counted" over answers that had just worked. `unavailable` means no key answered (the turn is held and refunded,
// Retry is real); `degraded` means the pool answered after failing over, the ladder working as designed.
const trialUnavailable = computed(() => trialStatus.value.health === `unavailable`);
// Spent is this strip's alone to say: the account gate would otherwise report the trial as "not connected", which
// is false and contradicts the sentence under it. This strip takes over the gate's door to the model list once
// spent.
const trialSpent = computed(() => trialExhausted(provider.value));
const trialNotice = computed(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    if (trialSpent.value) {
        return `Free trial used up for today. Connect Google to keep going free.`;
    }
    if (trialUnavailable.value) {
        return `Free trial isn't answering right now. Failed messages are not counted.`;
    }
    const remaining = trialStatus.value.remaining;
    // Not a warning until it is one: shown once more than half the day's allowance is gone (or the pool is
    // straining), not from the first message, since a fresh count read as an imminent limit.
    const allowance = trialStatus.value.allowance;
    if (allowance > 0 && remaining > allowance / 2 && trialStatus.value.health !== `degraded`) {
        return undefined;
    }
    const left = `${remaining} free ${remaining === 1 ? `message` : `messages`} left today`;
    // Which model answered, once one has: the trial serves a different real model per message (trial-ladder.ts), so
    // this is the only way to tell a weak answer from a fallback rung. Leads the sentence only after a turn has run.
    const served = trialStatus.value.servedModel;
    const answered = served === undefined ? `` : `Last answer: ${served}. `;
    // The pool working for its answer, said last and mildly: it explains a slower or weaker turn.
    const strained = trialStatus.value.health === `degraded` ? ` Trial capacity is tight right now, so answers can be slower.` : ``;
    return `${answered}${left}. Each agent step costs one. ${TRIAL_NOTICE}${strained}`;
});
const retryTrial = async (): Promise<void> => {
    if (!reachable.value) {
        return;
    }
    await loadTrialStatus();
    await conversation.value.resume();
};

// This account's credential can no longer refresh; surfaced pre-send, before an opaque mid-turn failure.
const activeAccountReauth = computed(() => {
    const id = account.value ?? accounts.value[0]?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});
</script>

<template>
    <!--
        This conversation's agent is off the board. Muted, not a warning: archiving loses nothing (branch, diff,
        transcript, counters all stay). Sending from here un-archives it, deliberately, without sending anything yet.
    -->
    <div v-if="activeArchived !== undefined" class="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted">
        <Icon name="box" class="shrink-0" />
        <span class="min-w-0 flex-1">Archived: off the board. Sending a message restores it.</span>
        <Button
            size="small"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || busyIds.includes(activeArchived.id)"
            v-tooltip.top="'Put this agent back on the board now'"
            @click="restore([activeArchived.id])"
        >
            Restore
        </Button>
    </div>
    <ChatAccountPanel />
    <!--
        The free lane's last hours: the meter's own line, amber, with the door to Billing. Same box as the trial strip
        below, since both say what this chat runs on and for how much longer.
    -->
    <div
        v-if="hoursNotice"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="clock" class="shrink-0" />
        <span class="min-w-[14rem] flex-1">{{ hoursNotice }}</span>
        <Button v-if="planOffered" :as="RouterLink" to="/settings/billing" size="small" severity="secondary" :text="true" class="shrink-0">Billing</Button>
    </div>
    <!--
        The trial's standing disclosure: the picker says it once at the moment of choosing, this says it for as long as
        the choice holds (the typer may not be the picker). Exhausted, it becomes the signpost to the free Google
        sign-in — and the only thing on screen, since a spent trial can't send.
    -->
    <div
        v-if="trialNotice"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-left text-2xs text-muted"
    >
        <Icon name="sparkles" class="shrink-0 text-link" />
        <!--
            A floor, not `min-w-0` (ChatContinueStrip's own lesson): every control beside this is `shrink-0`, so a
            shrinkable sentence never triggers `flex-wrap` and the buttons can't drop to their own row.
        -->
        <span class="min-w-[14rem] flex-1">{{ trialNotice }}</span>
        <!--
            The actions, one box, one baseline: they were siblings of the sentence (a kit button beside a hand-rolled link
            chip, two sizes, three baselines) with nothing lined up. One kit control each, in one box, fixes alignment at
            the source and keeps them together when the row wraps.
        -->
        <div class="flex shrink-0 items-center gap-1">
            <Button
                v-if="trialUnavailable"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable || streaming"
                v-tooltip.top="'Ask the platform again, and pick this chat back up if the trial answers'"
                @click="retryTrial"
            >
                Retry
            </Button>
            <!--
                The door the account gate used to hold, standing here while this strip does: spent, the model list is every
                other way to send.
            -->
            <ChatChooseModelButton v-if="trialSpent" />
            <!--
                A place, so a link, drawn as a button: the sign-in has an address, and Ctrl/Cmd-click opens it in another tab
                rather than losing this conversation. `as` keeps the anchor while the kit owns the pixels.
            -->
            <Button
                :as="RouterLink"
                :to="{ path: '/sandbox/agent', query: { connect: 'gemini' } }"
                size="small"
                :text="true"
                v-tooltip.top="'Sign in with Google: no daily cap, still no subscription'"
            >
                Connect Google
            </Button>
        </div>
    </div>
    <!--
        Proactive re-auth: the credential exists but can no longer refresh, surfaced here (before an opaque mid-turn
        failure) with a jump to reconnect.
    -->
    <RouterLink
        v-if="activeAccountReauth"
        :to="{ path: '/sandbox/agent', query: { connect: provider } }"
        class="flex items-start gap-2 rounded-xl border border-warning/40 bg-card px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
        <span
            >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }} <span class="font-semibold underline">Reconnect</span></span
        >
    </RouterLink>
</template>
