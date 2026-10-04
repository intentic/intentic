<script setup lang="ts">
import { withConversationTrust } from "@intentic/sandbox-contract";
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { usePrivacyShield } from "../../sandbox/agent-settings/safety/usePrivacyShield";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { privacyStanding } from "./privacyStanding";
import { usePaneView } from "./useChat-view";

// The privacy shield's word on this conversation, above the composer: that its provider would be turned away before the
// send rather than after it, with the narrow way through (this conversation only), and once that is granted a quiet line
// that it is, which takes it back. Granting is the owner's alone, as every change to the policy is.

const t = useT();
const { conversation, provider, capabilities, queuePaused, lastFailure, resumeQueue, streaming } = usePaneView();
const { reachable, active } = useSandbox();
const { status, updatePolicy, isSaving } = usePrivacyShield();

const standing = computed(() => privacyStanding(status.value, provider.value, capabilities.value, conversation.value.conversationId));
const owner = computed(() => active.value?.role === `owner`);
const failed = ref(false);

const grant = async (on: boolean): Promise<void> => {
    const now = standing.value;
    if (now === undefined) {
        return;
    }
    failed.value = false;
    try {
        await updatePolicy((policy) => withConversationTrust(policy, conversation.value.conversationId, now.provider, on));
    } catch {
        // allow(silent-catch): the strip says it failed beside the press; the policy query puts back what is held.
        failed.value = true;
        return;
    }
    // A message the refusal held goes now: letting the provider through is what the press was for.
    if (on && queuePaused.value === `refused` && lastFailure.value?.code === `privacy-unshielded`) {
        await resumeQueue();
    }
};

const safety = { name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } } as const;
</script>

<template>
    <div
        v-if="standing?.kind === `refused`"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="shield" class="shrink-0" />
        <!-- A floor, not `min-w-0`: every control beside this is `shrink-0` (ChatPaneNotices' strips). -->
        <span class="min-w-[14rem] flex-1">
            {{ t(`chat.chatPaneNotices.privacyRefused`, { provider: standing.label }) }}
            <template v-if="!owner">{{ " " }}{{ t(`chat.chatPaneNotices.privacyOwnerOnly`) }}</template>
            <template v-if="failed">{{ " " }}{{ t(`chat.chatPaneNotices.privacyGrantFailed`) }}</template>
        </span>
        <div class="flex shrink-0 items-center gap-1">
            <Button
                v-if="owner"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable || isSaving || streaming"
                v-tooltip.top="{
                    title: t(`chat.chatPaneNotices.privacyLetReadTitle`),
                    note: t(`chat.chatPaneNotices.privacyLetReadNote`),
                }"
                @click="grant(true)"
            >
                {{ t(`chat.chatPaneNotices.privacyLetRead`, { provider: standing.label }) }}
            </Button>
            <Button :as="RouterLink" :to="safety" size="small" severity="secondary" :text="true">{{ t(`chat.chatPaneNotices.privacySafety`) }}</Button>
        </div>
    </div>
    <!-- Granted: said for as long as it holds, since this conversation's reads leave unmasked while it does. -->
    <div v-else-if="standing?.kind === `granted`" class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-card px-3 py-2 text-left text-2xs text-muted shadow-sm">
        <Icon name="shield" class="shrink-0" />
        <span class="min-w-[14rem] flex-1">
            {{ t(`chat.chatPaneNotices.privacyGranted`, { provider: standing.label }) }}
            <template v-if="failed">{{ " " }}{{ t(`chat.chatPaneNotices.privacyGrantFailed`) }}</template>
        </span>
        <Button
            v-if="owner"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || isSaving"
            v-tooltip.top="{ title: t(`chat.chatPaneNotices.privacyTakeBackTitle`) }"
            @click="grant(false)"
        >
            {{ t(`chat.chatPaneNotices.privacyTakeBack`) }}
        </Button>
    </div>
</template>
