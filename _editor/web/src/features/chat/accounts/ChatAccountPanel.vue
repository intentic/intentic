<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { type AgentProvider, PROVIDER_VENDOR } from "@intentic/sandbox-contract";
import { accessKnown, connectPitch, trialExhausted } from "../session/access";
import { providerDisplayLabel } from "./providerCatalog";
import { useChat } from "../run/useChat";
import { usePaneView } from "../panel/useChat-view";
import ConnectFlow from "../../sandbox/secrets/ConnectFlow.vue";
import ChatChooseModelButton from "../models/ChatChooseModelButton.vue";
import ProviderLogo from "./ProviderLogo.vue";

// The one strip above the composer when this chat has nothing to send with; it never pitches a
// subscription, only opens the model picker. Waits for `accessKnown` (both accounts and endpoints)
// before claiming "not connected", and stands down for a spent trial, which is connected but metered out.

const view = usePaneView();
const { connected, provider, harness } = view;
// Cannot-send from a spent trial is not a missing connection; not this strip's to report.
const trialSpent = computed(() => trialExhausted(provider.value));
const { nativeConnectFlow, translatorConnectFlow, cancelConnect, cancelTranslatorConnect, setManagedProvider, startConnect, connectTranslator } =
    useChat();

// Read from the store, not remembered, so a handshake started elsewhere is still finishable here.
const live = computed<{ kind: `native` | `routed`; provider: AgentProvider } | undefined>(() => {
    if (nativeConnectFlow.value !== undefined) {
        return { kind: `native`, provider: nativeConnectFlow.value.provider };
    }
    if (translatorConnectFlow.value !== undefined) {
        return { kind: `routed`, provider: translatorConnectFlow.value.provider };
    }
    return undefined;
});
const abandon = (): void => (live.value?.kind === `native` ? cancelConnect() : cancelTranslatorConnect());

// Named as what to connect, not the runtime; `pitch` is absent where there's no account to connect.
const providerName = computed(() => PROVIDER_VENDOR[provider.value as keyof typeof PROVIDER_VENDOR] ?? providerDisplayLabel(provider.value));
const pitch = computed(() => connectPitch(provider.value, harness.value));

// Starts sign-in for the selected provider, and sets it on the account card too so the two agree on
// what just connected. Which mechanism runs mirrors the daemon's own split: translator for
// ChatGPT/Kimi/Google, a stored account otherwise.
const connect = async (): Promise<void> => {
    const target = provider.value;
    setManagedProvider(target);
    // Awaited so the button holds while the flow is being opened, rather than looking untouched.
    await (target === `codex` || target === `kimi` || target === `gemini` ? connectTranslator(target) : startConnect());
};
</script>

<template>
    <!--
        Shown until `accessKnown`: "not connected" is a claim this panel can't make before both account and
        endpoint reads land. One quiet line, no button, while the question isn't settled.
    -->
    <p v-if="!accessKnown" class="flex items-center justify-center gap-2 px-4 py-3 text-center text-2xs text-subtle">
        <Icon name="spinner" spin class="shrink-0" />Checking your AI accounts…
    </p>

    <!--
        The sign-in, once running, takes the whole strip; Cancel is the only other control, and abandoning
        it restores the line below.
    -->
    <div v-else-if="live" class="flex flex-col gap-2 rounded-2xl border border-line bg-card px-4 py-3">
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="live.provider" class="shrink-0 text-link" />
            <span class="min-w-0 flex-1 truncate text-left text-xs font-medium text-body">Connecting {{ providerDisplayLabel(live.provider) }}</span>
            <button type="button" :class="ui.linkButton(`shrink-0 text-2xs text-subtle hover:text-content hover:no-underline`)" @click="abandon">
                Cancel
            </button>
        </div>
        <ConnectFlow :kind="live.kind" :provider="live.provider" />
    </div>

    <!--
        Names what this chat is pointed at; the model list leads (free to look at, holds every option),
        the provider's own sign-in follows.
    -->
    <div
        v-else-if="!connected && !trialSpent"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl border border-line bg-card px-4 py-3 text-2xs text-muted"
    >
        <Icon name="lock" class="shrink-0 text-subtle" />
        <span class="min-w-0 flex-1 text-left">{{ providerName }} isn't connected in this sandbox.</span>
        <ChatChooseModelButton />
        <button
            v-if="pitch"
            type="button"
            :class="ui.linkButton(`shrink-0 text-2xs text-subtle hover:text-content hover:no-underline`)"
            @click="connect"
        >
            {{ pitch.action }}
        </button>
    </div>
</template>
