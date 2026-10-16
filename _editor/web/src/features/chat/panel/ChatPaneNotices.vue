<script setup lang="ts">
import { Button, Icon, Notice, toneTint } from "@intentic/ui";
import { computed, watch } from "vue";
import { RouterLink } from "vue-router";
import { useAgents } from "../../../models/fleet/useAgents";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { lowHoursNotice } from "../../../models/hosted-plan/hostedHours";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import ChatAccountPanel from "../accounts/ChatAccountPanel.vue";
import ChatPrivacyStrip from "./privacy/ChatPrivacyStrip.vue";
import ChatTrialStrip from "./ChatTrialStrip.vue";
import NeedsStrip from "../../needs/NeedsStrip.vue";
import { useT } from "@intentic/ui/i18n";
import { modelsPath } from "../../../lib/routes/modelsPath";

// What this chat's standing is, above the composer: strips for a state the conversation arrived at by itself
// (archived; then what it can send with — account gate, trial, expired credential), each with its one answering
// press. The composer's own state stays with the composer; reads this pane's conversation via the injected view,
// never the focused one.

const t = useT();

const { conversation, provider, accounts } = usePaneView();
const { reachable, active } = useSandbox();

// The last of the hours THIS sandbox spends, above the composer, to the person spending them: only on a hosted
// sandbox, only its owner (a guest can't buy more), only in the last stretch (hostedHours.ts's threshold) rather than
// from the first minute. The account's free hours or the machine's own month on its slot, whichever it spends.
const { state: hostedPlan, offered: planOffered } = useHostedPlan();
const hoursNotice = computed(() =>
    (active.value?.hosted ?? null) === null || active.value?.role !== `owner` ? undefined : lowHoursNotice(hostedPlan.value, active.value?.id),
);
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

// The credential the next turn runs on can no longer refresh; surfaced pre-send, before an opaque mid-turn failure.
// Asked of the account the turn will actually run on (servingAccount), never the first listed: on auto, an expired
// first account is one the turn skips.
const activeAccountReauth = computed(() => {
    const id = conversation.value.selection.servingAccount.value?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});
</script>

<template>
    <!-- What this conversation still waits on people for (docs/architecture/needs.md): answerable here, above the composer. -->
    <NeedsStrip :conversation-id="conversation.conversationId" />
    <!-- This conversation's agent is off the board. -->
    <div v-if="activeArchived !== undefined" class="flex items-center gap-2 rounded-xl bg-card shadow-sm px-3 py-2 text-2xs text-muted">
        <Icon name="box" class="shrink-0" />
        <span class="min-w-0 flex-1">{{ t(`chat.chatPaneNotices.archivedOffBoardSending`) }}</span>
        <Button
            size="small"
            thumb
            tier="quiet" tone="accent"
            class="shrink-0"
            :disabled="!reachable || busyIds.includes(activeArchived.id)"
            @click="restore([activeArchived.id])"
        >
            {{ t(`ui.action.restore`) }}
        </Button>
    </div>
    <ChatAccountPanel />
    <!-- Whether the privacy shield lets this conversation's provider run, said before the send rather than after it. -->
    <ChatPrivacyStrip />
    <!-- The free plan's last hours: the meter's own line, amber, with the door to Billing. -->
    <Notice v-if="hoursNotice" tone="warning" icon="clock" size="sm">
        {{ hoursNotice }}
        <template v-if="planOffered" #actions>
            <Button :as="RouterLink" to="/settings/billing" size="small" thumb tier="quiet">{{ t(`chat.chatPaneNotices.billing`) }}</Button>
        </template>
    </Notice>
    <!-- The trial's standing: what is left of the day's allowance, and the way off it. -->
    <ChatTrialStrip />
    <!-- Proactive re-auth: the credential exists but can no longer refresh, surfaced here (before an opaque mid-turn failure) with a jump to reconnect. -->
    <RouterLink
        v-if="activeAccountReauth"
        :to="modelsPath({ provider })"
        class="flex items-start gap-2 rounded-xl border px-3 py-2 text-left text-2xs text-warning"
        :class="toneTint(`warning`, `strong`)"
    >
        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
        <span
            >{{ activeAccountReauth.detail ?? t(`chat.chatPaneNotices.accountNeedsToReconnected`) }}
            <span class="font-semibold underline">{{ t(`ui.action.reconnect`) }}</span></span
        >
    </RouterLink>
</template>
