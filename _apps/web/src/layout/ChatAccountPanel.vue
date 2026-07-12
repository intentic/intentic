<script setup lang="ts">
import Button from "primevue/button";
import { useRouter } from "vue-router";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when the active conversation's provider has no account yet. It
 * offers a provider pick and a "Connect account" button that deep-links to the Sandbox ▸ Agent tab — the
 * account's home, where the connect handshake and per-account management live. */

const { connected, provider, selectProvider } = useChat();
const router = useRouter();
</script>

<template>
    <div v-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <Icon name="sparkles" class="text-xl text-link" />
        <p class="text-sm text-muted">
            Connect your {{ provider === `codex` ? `ChatGPT` : provider === `grok` ? `Grok` : `Claude` }} account to start chatting.
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
        <Button label="Connect account" size="small" @click="router.push('/sandbox/agent')">
            <template #icon><Icon name="link" /></template>
        </Button>
    </div>
</template>
