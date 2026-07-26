<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when the active conversation's provider+harness selection has
 * nothing to send with. Codex and Gemini always authenticate through a translator SUBSCRIPTION (native or under
 * the Claude Code harness), as does a Grok chat routed under the Claude Code harness — the gate asks for the
 * subscription by name; anything else needs the provider's account. The "Connect" button deep-links to the
 * Sandbox ▸ Agent tab, where the connect handshake lives. The picked provider rides along as `?connect=<provider>`
 * so the Agent tab opens on that provider's card and flashes it into view. */

const { connected, provider, harness, selectProvider } = useChat();
const router = useRouter();

// Whether this selection is served by a translator SUBSCRIPTION rather than a native account: Codex and Gemini
// always, and Grok under the Claude Code harness. The gate's copy and button then say "subscription".
const subscription = computed(
    () => provider.value === `codex` || provider.value === `gemini` || (provider.value === `grok` && harness.value === `claude-code`),
);
// What the user connects, and what it lets them run. Grok and Gemini run under Claude Code when routed, which is
// worth saying out loud — the harness is what makes a non-Claude subscription usable here at all.
const SUBSCRIPTION_COPY: Record<string, { account: string; runs: string }> = {
    codex: { account: `ChatGPT subscription`, runs: `Codex` },
    grok: { account: `SuperGrok subscription`, runs: `Grok under Claude Code` },
    gemini: { account: `Google account`, runs: `Gemini under Claude Code` },
};
const subscriptionCopy = computed(() => SUBSCRIPTION_COPY[provider.value]);
// The native-account providers name themselves; anything unlisted is an ACP agent, which never gates here.
const ACCOUNT_LABEL: Record<string, string> = { claude: `Claude`, grok: `Grok`, kimi: `Kimi Code` };
const accountLabel = computed(() => ACCOUNT_LABEL[provider.value] ?? `Claude`);
</script>

<template>
    <div v-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <Icon name="sparkles" class="text-xl text-link" />
        <p class="text-xs text-muted">
            <template v-if="subscription && subscriptionCopy">
                Connect your {{ subscriptionCopy.account }} to run {{ subscriptionCopy.runs }}.
            </template>
            <template v-else> Connect your {{ accountLabel }} account to start chatting. </template>
        </p>
        <!-- Point this chat at whichever provider is connected, straight from the gate, so picking a
             not-yet-connected provider is never a dead end. -->
        <!-- Wraps rather than overflowing: the gate sits in a narrow side panel, where five tabs never fit on one row. -->
        <div class="flex flex-wrap items-center justify-center gap-1">
            <button
                v-for="tab in providerTabs"
                :key="tab.value"
                type="button"
                class="composer-ghost h-7 shrink-0 whitespace-nowrap px-2.5 text-2xs font-medium"
                :class="{ 'composer-active': provider === tab.value }"
                @click="selectProvider(tab.value)"
                :aria-pressed="provider === tab.value"
            >
                {{ tab.label }}
            </button>
        </div>
        <Button
            :label="subscription ? `Connect subscription` : `Connect account`"
            size="small"
            @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
        >
            <template #icon><Icon name="link" /></template>
        </Button>
    </div>
</template>
