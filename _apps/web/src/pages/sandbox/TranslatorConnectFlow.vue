<script setup lang="ts">
import type { KeyedProvider } from "@intentic/sandbox-contract";
import { cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { useChat } from "../../composables/chat/useChat";

/* The live routed-subscription sign-in (ChatGPT / SuperGrok / Google via the translator), as it is actually
 * performed: open the provider, then deal with what it hands back. Its own component because the Agent tab
 * opens it from two different rows — the "not connected" row and the "add another account" row — and useChat
 * is a module singleton, so this reads the same handshake either way (mirroring NativeConnectFlow).
 *
 * A one-time `code` means the provider polls itself and the card only waits; an empty code means the provider
 * redirects to a loopback URL only the sandbox binds, so the card asks for the landing URL back instead. */

const props = defineProps<{ provider: KeyedProvider }>();

const { translatorConnectFlow, translatorBusy, completeTranslator, cancelTranslatorConnect } = useChat();

// Each provider's destination and the one instruction a user can't infer from the field in front of them.
const OPEN_LABEL: Record<KeyedProvider, string> = { codex: `Open ChatGPT`, grok: `Open x.ai`, gemini: `Open Google` };
const LOGIN_HINT: Record<KeyedProvider, string> = {
    codex: `Sign in, then enter this code.`,
    grok: `Sign in, then enter this code.`,
    // The dead-end landing page is the one thing a user cannot work out on their own, so it stays in full.
    gemini: `The page Google lands on won't load — that's expected, it points back inside the sandbox. Copy its whole address and paste it below.`,
};

// The pasted redirect URL for a routed login that can't self-complete (Google's — see completeTranslator).
const redirectUrl = ref(``);
const finishTranslator = async (): Promise<void> => {
    if (redirectUrl.value.trim().length === 0) {
        return;
    }
    await completeTranslator(redirectUrl.value);
    redirectUrl.value = ``;
};
</script>

<template>
    <div v-if="translatorConnectFlow && translatorConnectFlow.provider === props.provider" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-center gap-2">
            <Button as="a" :label="OPEN_LABEL[props.provider]" size="small" :href="translatorConnectFlow.url" target="_blank" rel="noopener">
                <template #icon><Icon name="external-link" /></template>
            </Button>
            <span class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for sign-in…</span>
            <Button class="ml-auto shrink-0" label="Cancel" size="small" severity="secondary" :text="true" @click="cancelTranslatorConnect" />
        </div>
        <p class="text-2xs text-subtle">{{ LOGIN_HINT[props.provider] }}</p>
        <!-- A one-time code means the provider polls itself; no code means it redirects, and the landing URL
             carries the grant the sandbox never received. -->
        <div v-if="translatorConnectFlow.code" class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
            <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{ translatorConnectFlow.code }}</span>
            <CopyButton :text="translatorConnectFlow.code" />
        </div>
        <div v-else class="flex gap-2">
            <input
                v-model="redirectUrl"
                type="text"
                :class="cmp.input(`min-w-0 flex-1 py-1.5`)"
                placeholder="Paste the address you landed on…"
                @keyup.enter="finishTranslator"
            />
            <Button
                label="Finish"
                size="small"
                :disabled="redirectUrl.trim().length === 0"
                :loading="translatorBusy === props.provider"
                @click="finishTranslator"
            />
        </div>
    </div>
</template>
