<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { connectPitch } from "../composables/chat/access";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when the active conversation's provider+harness selection has
 * nothing to send with. What it asks for comes from the shared access table (access.ts / PROVIDER_ACCESS), the
 * same one the model picker's locks and chips read — the gate and the lock a user just clicked past must name
 * the SAME credential, and they drifted when each surface carried its own copy. The "Connect" button deep-links
 * to the Sandbox ▸ Agent tab, where the handshake lives; the picked provider rides along as `?connect=<provider>`
 * so that tab opens on its card and flashes it into view. */

const { connected, provider, harness, selectProvider, accountsLoaded } = useChat();
const router = useRouter();

const pitch = computed(() => connectPitch(provider.value, harness.value));
</script>

<template>
    <!-- "Nothing is connected" is a claim, and until the daemon has answered it is one we can't make: this gate
         used to go up on every page load, in front of a user with a perfectly good subscription, for as long as
         the liveness probe and the tunnel round-trip took. While the connections are still being read the panel
         says only that — one quiet line, no pitch, no button to press on a question that isn't settled. -->
    <div
        v-if="!accountsLoaded"
        class="flex items-center justify-center gap-2 rounded-2xl border border-line bg-overlay/40 px-4 py-5 text-center text-xs text-muted"
    >
        <Icon name="spinner" spin />Checking your AI accounts…
    </div>
    <div v-else-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <Icon name="sparkles" class="text-xl text-link" />
        <!-- An ACP agent carries its own credentials, so it never reaches this gate and has no pitch to show. -->
        <p v-if="pitch" class="text-xs text-muted">{{ pitch.copy }}</p>
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
            :label="pitch?.action ?? `Connect account`"
            size="small"
            @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
        >
            <template #icon><Icon name="link" /></template>
        </Button>
    </div>
</template>
