<script setup lang="ts">
import { Button, Icon, Notice, toneTint } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { lowHoursNotice } from "../../../models/hosted-plan/hostedHours";
import { useHostedPlan } from "../../../models/hosted-plan/useHostedPlan";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";
import { standbyNotice } from "./standby/standbyNotice";
import ChatAccountPanel from "../accounts/ChatAccountPanel.vue";
import ChatPrivacyStrip from "./privacy/ChatPrivacyStrip.vue";
import ChatTrialStrip from "./ChatTrialStrip.vue";
import ComputerHarnessStrip from "../models/computer/ComputerHarnessStrip.vue";
import { computerAgents } from "../../../client/sandbox/useDaemonRoutes";
import { useT } from "@intentic/ui/i18n";
import { here, page } from "../../../lib/routes/links";
import { modelsPath } from "../../../lib/routes/modelsPath";

// Whether this chat can send, above the composer and its dock: the account gate, the privacy shield, the trial, the
// hosted hours, an expired credential, each with its one answering press. What to do with what the chat did (its land,
// its commit, a request to read it) is the dock's (ChatPaneLines). The composer's own state stays with the composer; reads this pane's conversation via the injected view,
// never the focused one.

const t = useT();

const { conversation, provider, accounts } = usePaneView();
const { active } = useSandbox();

// The last of the hours THIS sandbox spends, above the composer, to the person spending them: only on a hosted
// sandbox, only its owner (a guest can't buy more), only in the last stretch (hostedHours.ts's threshold) rather than
// from the first minute. The account's free hours or the machine's own month on its slot, whichever it spends.
const { state: hostedPlan, offered: planOffered } = useHostedPlan();
// A copy on standby says which machine runs the sandbox, and that nothing starts here (standbyNotice.ts).
const { info: sandboxInfo } = useSandboxVersion();
const standbyLine = computed(() => standbyNotice(sandboxInfo.value));
const hoursNotice = computed(() =>
    (active.value?.hosted ?? null) === null || active.value?.tier !== `owner` ? undefined : lowHoursNotice(hostedPlan.value, active.value?.id),
);
// The credential the next turn runs on can no longer refresh; surfaced pre-send, before an opaque mid-turn failure.
// Asked of the account the turn will actually run on (servingAccount), never the first listed: on auto, an expired
// first account is one the turn skips.
const activeAccountReauth = computed(() => {
    const id = conversation.value.selection.servingAccount.value?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});
</script>

<template>
    <!-- A chat on this computer has none of a sandbox's standing to report, only whether its coding agent can run. -->
    <ComputerHarnessStrip v-if="computerAgents" />
    <template v-else>
        <ChatAccountPanel />
        <!-- Whether the privacy shield lets this conversation's provider run, said before the send rather than after it. -->
        <ChatPrivacyStrip />
        <!-- The free plan's last hours: the meter's own line, amber, with the door to Billing. -->
        <Notice v-if="standbyLine" tone="warning" size="sm">{{ standbyLine }}</Notice>
        <Notice v-if="hoursNotice" tone="warning" icon="clock" size="sm">
            {{ hoursNotice }}
            <template v-if="planOffered" #actions>
                <Button :as="RouterLink" :to="here(page.account(`billing`))" size="small" thumb tier="quiet">{{ t(`chat.chatPaneNotices.billing`) }}</Button>
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
            <Icon name="exclamation-triangle" class="shrink-0" />
            <span
                >{{ activeAccountReauth.detail ?? t(`chat.chatPaneNotices.accountNeedsToReconnected`) }}
                <span class="font-semibold underline">{{ t(`ui.action.reconnect`) }}</span></span
            >
        </RouterLink>
    </template>
</template>
