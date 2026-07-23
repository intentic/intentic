<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when the active conversation's provider+harness selection has
 * nothing to send with. A codex/grok chat routed under the Claude Code harness is served by the translator's
 * subscription connection, so the gate asks for that by name; anything else needs the provider's account. The
 * "Connect" button deep-links to the Sandbox ▸ Agent tab — the account's home, where the connect handshake and
 * per-account management live. The picked provider rides along as `?connect=<provider>` so the Agent tab opens
 * on that provider's card (which also holds its "Under Claude Code" row) and flashes it into view. */

const { connected, provider, harness, selectProvider } = useChat();
const router = useRouter();

// A routed (claude-code harness) codex/grok chat needs the provider's subscription in the translator — a
// different credential from the native account, so the gate's copy and button say so.
const routed = computed(() => (provider.value === `codex` || provider.value === `grok`) && harness.value === `claude-code`);
</script>

<template>
    <div v-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <Icon name="sparkles" class="text-xl text-link" />
        <p class="text-sm text-muted">
            <template v-if="routed">
                Connect your {{ provider === `codex` ? `ChatGPT` : `SuperGrok` }} subscription to run
                {{ provider === `codex` ? `Codex` : `Grok` }} under Claude Code.
            </template>
            <template v-else>
                Connect your {{ provider === `codex` ? `ChatGPT` : provider === `grok` ? `Grok` : `Claude` }} account to start chatting.
            </template>
        </p>
        <!-- Point this chat at whichever provider is connected, straight from the gate, so picking a
             not-yet-connected provider is never a dead end. -->
        <div class="flex items-center gap-1">
            <button
                v-for="tab in providerTabs"
                :key="tab.value"
                type="button"
                class="composer-ghost h-7 px-2.5 text-xs font-medium"
                :class="{ 'composer-active': provider === tab.value }"
                @click="selectProvider(tab.value)"
                :aria-pressed="provider === tab.value"
            >
                {{ tab.label }}
            </button>
        </div>
        <Button
            :label="routed ? `Connect subscription` : `Connect account`"
            size="small"
            @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
        >
            <template #icon><Icon name="link" /></template>
        </Button>
    </div>
</template>
