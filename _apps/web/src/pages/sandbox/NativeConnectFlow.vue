<script setup lang="ts">
import { cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import { useChat } from "../../composables/chat/useChat";

/* The live native sign-in (Claude / Grok / Kimi), as it is actually performed: open the provider, then deal
 * with the code it wants. Its own component because the Agent tab opens it from two different rows — the
 * "no account yet" row and the "add another account" row — and useChat is a module singleton, so this reads
 * the same handshake either way with nothing threaded through props.
 *
 * The handshake is started by the row that renders this (and by a tab switch, so the open-URL anchor is a
 * real user gesture rather than a blocked popup) — which is exactly why it also owns a way out. */

const { managedProvider, authorizeUrl, userCode, connectLabel, completeConnect, cancelConnect } = useChat();

// Grok (xAI OAuth) opens x.ai on any device and connects on approval, so it shows a code to APPROVE. Anthropic
// and Moonshot hand back something to paste instead.
const deviceFlow = computed(() => managedProvider.value === `grok`);
const openLabel = computed(() =>
    managedProvider.value === `grok` ? `Open x.ai` : managedProvider.value === `kimi` ? `Open Moonshot` : `Open Anthropic`,
);
const pastePlaceholder = computed(() => (managedProvider.value === `kimi` ? `Paste API key…` : `Paste code…`));
// Only the mechanics a user cannot infer from the button they just pressed and the field in front of them.
// Anthropic's flow says everything it needs to in "Open Anthropic" + "Paste code…", so it gets no line at all.
const connectNote = computed(() =>
    deviceFlow.value
        ? `Already filled in at x.ai — approve on any device.`
        : managedProvider.value === `kimi`
          ? `Create an API key on your Kimi account, then paste it here.`
          : undefined,
);

const connectCode = ref(``);
const finishConnect = async (): Promise<void> => {
    const code = connectCode.value.trim();
    if (code.length === 0) {
        return;
    }
    const ok = await completeConnect(code);
    if (ok) {
        connectCode.value = ``;
    }
};

// The display name is a rename, not a step: the daemon derives one from the sign-in identity when it's blank.
// Leading the flow with that field made every connect look like a form to fill in before anything would
// happen, so it stays folded away until asked for — and re-folds with the handshake, never carrying a stale
// open state into the next one.
const namingAccount = ref(false);
watch(authorizeUrl, (url) => {
    if (url === null) {
        namingAccount.value = false;
    }
});
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-center gap-2">
            <Button v-if="authorizeUrl" as="a" :label="openLabel" size="small" :href="authorizeUrl" target="_blank" rel="noopener">
                <template #icon><Icon name="external-link" /></template>
            </Button>
            <span v-if="userCode" class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for approval…</span>
            <Button class="ml-auto shrink-0" label="Cancel" size="small" severity="secondary" :text="true" @click="cancelConnect" />
        </div>
        <!-- Above what it describes, never below: this line is the instruction for the code or the field that
             follows it, and an instruction read afterwards is read too late. -->
        <p v-if="connectNote" class="text-2xs text-subtle">{{ connectNote }}</p>
        <!-- The device code is read, not typed: one line, at a size you can read off a second screen, with copy
             as an icon rather than a chip competing with the real action. -->
        <div v-if="deviceFlow && userCode" class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
            <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{ userCode }}</span>
            <CopyButton :text="userCode" />
        </div>
        <div v-if="!deviceFlow" class="flex gap-2">
            <input
                v-model="connectCode"
                name="connectCode"
                :placeholder="pastePlaceholder"
                :class="cmp.input(`min-w-0 flex-1 py-1.5`)"
                @keydown.enter="finishConnect"
            />
            <Button label="Finish" size="small" :disabled="connectCode.trim().length === 0" @click="finishConnect" />
        </div>
        <button
            v-if="!namingAccount"
            type="button"
            class="cursor-pointer self-start text-2xs text-subtle transition-colors hover:text-content"
            @click="namingAccount = true"
        >
            Name this account…
        </button>
        <input v-else v-model="connectLabel" name="accountLabel" placeholder="Account name" :class="cmp.input(`min-w-0 py-1.5`)" />
    </div>
</template>
