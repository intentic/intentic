<script setup lang="ts">
import type { PrivacyShieldStatus } from "@intentic/sandbox-contract/schemas/privacy";
import type { PrivacyLeaks } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { AgentRunButton, Button, Row, type TooltipValue, useAgentRunPick } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { shellModelPicking } from "../../../models/conversations/accounts/shellModelPicking";
import { FIX_ROLE } from "../../../models/fixes/agentFix";
import { startAgent } from "../../../models/fleet/agentActions";
import { useAgents } from "../../../models/fleet/useAgents";
import { hardeningPrompt } from "../../../models/sandbox/privacyHardening";

// The press that starts a hardening session (privacyHardening.ts), on the run Fix with agent stands at and re-pointed
// for this run alone by its caret, as every run button's is (AgentRunButton). What the agent will see depends on the
// provider it runs on, so the hint says it for the model the button stands at now: a trusted or local one reads the
// leaked values, any other their outlines only. The session it started, while still on the board, is opened rather
// than a second one started blind.

const t = useT();

const { confirmed, suspected, status, session } = defineProps<{
    confirmed: number;
    suspected: number;
    status: PrivacyShieldStatus;
    session: PrivacyLeaks[`session`];
}>();

const emit = defineEmits<{ started: [conversationId: string] }>();

const picker = useAgentRunPick(shellModelPicking, FIX_ROLE);

const trusted = computed(() => {
    const provider = picker.model.value.provider;
    return status.policy.trusted.includes(provider) || status.providers.some((entry) => entry.id === provider && entry.local);
});

const hint = computed(
    (): TooltipValue => ({
        title: t(`sandbox.agentPrivacyShield.leaks.harden.hintTitle`),
        note:
            confirmed === 0
                ? t(`sandbox.agentPrivacyShield.leaks.harden.noneConfirmed`)
                : trusted.value
                  ? t(`sandbox.agentPrivacyShield.leaks.harden.trusted`)
                  : t(`sandbox.agentPrivacyShield.leaks.harden.untrusted`),
    }),
);

const { fleet, open } = useAgents();
// Only a session still on the board: an archived one is done, and the next press starts afresh.
const running = computed(() => (session === undefined ? undefined : fleet.value.find((agent) => agent.id === session.conversationId)));

const run = (): void => {
    const id = startAgent(hardeningPrompt({ confirmed, suspected, trusted: trusted.value }), undefined, picker.model.value);
    emit(`started`, id);
    picker.clear();
};
</script>

<template>
    <Row icon="sparkles" :title="t(`sandbox.agentPrivacyShield.leaks.harden.title`)" :description="t(`sandbox.agentPrivacyShield.leaks.harden.description`)">
        <template #control>
            <Button v-if="running !== undefined" size="small" tier="quiet" @click="open(running)">{{ t(`sandbox.agentPrivacyShield.leaks.harden.open`) }}</Button>
            <AgentRunButton
                :label="t(`sandbox.agentPrivacyShield.leaks.harden.run`, { count: confirmed })"
                :picker="picker"
                tier="boring"
                icon="sparkles"
                size="small"
                :disabled="confirmed === 0"
                :hint="hint"
                @run="run"
            />
        </template>
        <!-- A disabled press may never show its hint, so why it is off is said under the row too. -->
        <template v-if="confirmed === 0" #below>
            <p class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.leaks.harden.noneConfirmed`) }}</p>
        </template>
    </Row>
</template>
