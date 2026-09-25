<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { isTrialProvider, TRIAL_NOTICE, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { trialExhausted } from "../session/access";
import { useAgents } from "../../agents/fleet/useAgents";
import { modelLabelFor, trialStatus } from "../accounts/providerCatalog";
import { loadTrialStatus } from "../models/useChat-catalog";
import { usePaneView } from "./useChat-view";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { hoursLeftLine } from "../../settings/hosted-plan/hostedHours";
import { useHostedPlan } from "../../settings/hosted-plan/useHostedPlan";
import ChatAccountPanel from "../accounts/ChatAccountPanel.vue";
import { useT } from "@intentic/ui/i18n";

// What this chat's standing is, above the composer: strips for a state the conversation arrived at by itself
// (archived; then what it can send with — account gate, trial, expired credential), each with its one answering
// press. The composer's own state stays with the composer; reads this pane's conversation via the injected view,
// never the focused one.

const t = useT();

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
// spent, the only thing left to say is where the next model comes from.

// Not answering is an interruption; working for it is not — conflating the two put "Failed messages are not
// counted" over answers that had just worked. `unavailable` means no key answered (the turn is held and refunded,
// Retry is real); `degraded` means the pool answered after failing over, the ladder working as designed.
const trialUnavailable = computed(() => trialStatus.value.health === `unavailable`);
// Spent is this strip's alone to say: the account gate would otherwise report the trial as "not connected", which
// is false and contradicts the sentence under it.
const trialSpent = computed(() => trialExhausted(provider.value));
const trialNotice = computed(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    if (trialSpent.value) {
        // Names no single vendor: free-and-uncapped is a Google sign-in, a model on this machine, or a subscription the
        // reader may already hold, and the view that offers all three is one press away.
        return `Free trial used up for today. Connect a model to keep going — one of them is free.`;
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
    const answered = served === undefined ? `` : `Last answer: ${modelLabelFor(TRIAL_PROVIDER, served)}. `;
    // The pool working for its answer, said last and mildly: it explains a slower or weaker turn.
    const strained = trialStatus.value.health === `degraded` ? ` Trial capacity is tight right now, so answers can be slower.` : ``;
    return `${answered}${left}. Each agent step costs one. ${TRIAL_NOTICE}${strained}`;
});
const retryTrial = async (): Promise<void> => {
    if (!reachable.value) {
        return;
    }
    await loadTrialStatus();
    await conversation.value.turn.resume();
};

// This account's credential can no longer refresh; surfaced pre-send, before an opaque mid-turn failure.
const activeAccountReauth = computed(() => {
    const id = account.value ?? accounts.value[0]?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});
</script>

<template>
    <!-- This conversation's agent is off the board. -->
    <div v-if="activeArchived !== undefined" class="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted">
        <Icon name="box" class="shrink-0" />
        <span class="min-w-0 flex-1">{{ t(`chat.chatPaneNotices.archivedOffBoardSending`) }}</span>
        <Button
            size="small"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || busyIds.includes(activeArchived.id)"
            v-tooltip.top="t(`chat.chatPaneNotices.putAgentBackOn`)"
            @click="restore([activeArchived.id])"
        >
            {{ t(`ui.action.restore`) }}
        </Button>
    </div>
    <ChatAccountPanel />
    <!-- The free plan's last hours: the meter's own line, amber, with the door to Billing. -->
    <div
        v-if="hoursNotice"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="clock" class="shrink-0" />
        <span class="min-w-[14rem] flex-1">{{ hoursNotice }}</span>
        <Button v-if="planOffered" :as="RouterLink" to="/settings/billing" size="small" severity="secondary" :text="true" class="shrink-0">{{
            t(`chat.chatPaneNotices.billing`)
        }}</Button>
    </div>
    <!-- The trial's standing disclosure: the picker says it once at the moment of choosing. -->
    <div
        v-if="trialNotice"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-left text-2xs text-muted"
    >
        <Icon name="sparkles" class="shrink-0 text-link" />
        <!-- A floor, not `min-w-0` (ChatContinueStrip's own lesson): every control beside this is `shrink-0`. -->
        <span class="min-w-[14rem] flex-1">{{ trialNotice }}</span>
        <!-- Notice actions share one button style and baseline. -->
        <div class="flex shrink-0 items-center gap-1">
            <Button
                v-if="trialUnavailable"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable || streaming"
                v-tooltip.top="t(`chat.chatPaneNotices.askPlatformAgainPick`)"
                @click="retryTrial"
            >
                {{ t(`ui.action.retry`) }}
            </Button>
            <!-- One action, not two: the spent trial's question is "what now", and the model list was the same answer
                 arrived at sideways. Standing whenever this strip does, not only once spent — somebody halfway through
                 the day's allowance who wants to connect now should not have to run out first. A place, so a link drawn
                 as a button: Ctrl/Cmd-click keeps this conversation. -->
            <Button :as="RouterLink" to="/connect" size="small" :text="true" v-tooltip.top="t(`chat.chatPaneNotices.connectTooltip`)">
                {{ t(`chat.words.connectAModel`) }}
            </Button>
        </div>
    </div>
    <!-- Proactive re-auth: the credential exists but can no longer refresh, surfaced here (before an opaque mid-turn failure) with a jump to reconnect. -->
    <RouterLink
        v-if="activeAccountReauth"
        :to="{ path: '/connect', query: { provider } }"
        class="flex items-start gap-2 rounded-xl border border-warning/40 bg-card px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
        <span
            >{{ activeAccountReauth.detail ?? t(`chat.chatPaneNotices.accountNeedsToReconnected`) }}
            <span class="font-semibold underline">{{ t(`ui.action.reconnect`) }}</span></span
        >
    </RouterLink>
</template>
