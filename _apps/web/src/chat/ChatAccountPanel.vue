<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when the active conversation's provider+harness selection has
 * nothing to send with. Codex always authenticates through the translator's ChatGPT SUBSCRIPTION (native or
 * under the Claude Code harness), as does a Grok chat routed under the Claude Code harness — the gate asks for
 * the subscription by name; anything else needs the provider's account. The "Connect" button deep-links to the
 * Sandbox ▸ Agent tab, where the connect handshake lives. The picked provider rides along as `?connect=<provider>`
 * so the Agent tab opens on that provider's card and flashes it into view. */

const { connected, provider, harness, selectProvider } = useChat();
const router = useRouter();

// Whether this selection is served by a translator SUBSCRIPTION rather than a native account: Codex always, and
// Grok under the Claude Code harness. The gate's copy and button then say "subscription".
const subscription = computed(() => provider.value === `codex` || (provider.value === `grok` && harness.value === `claude-code`));
</script>

<template>
    <div v-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <Icon name="sparkles" class="text-xl text-link" />
        <p class="text-sm text-muted">
            <template v-if="subscription">
                Connect your {{ provider === `codex` ? `ChatGPT` : `SuperGrok` }} subscription to run {{ provider === `codex` ? `Codex` : `Grok`
                }}{{ provider === `codex` ? `` : ` under Claude Code` }}.
            </template>
            <template v-else>
                Connect your {{ provider === `grok` ? `Grok` : provider === `kimi` ? `Kimi Code` : `Claude` }} account to start chatting.
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
            :label="subscription ? `Connect subscription` : `Connect account`"
            size="small"
            @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
        >
            <template #icon><Icon name="link" /></template>
        </Button>
    </div>
</template>
