<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import { useChat } from "../../composables/chat/useChat";

/* THE sign-in panel — one component for all five providers and both mechanisms (a provider's own account and a
 * translator subscription), because a user signing in does the same three things every time: go to the
 * provider, deal with the one thing it hands back, come back. There were two of these, and they had quietly
 * drifted apart (one waited with a spinner, the other didn't; one could name the account, the other couldn't;
 * the same "Cancel" sat in two different places) — which is exactly the drift a user reads as "these providers
 * work differently" when the only real difference is the shape of the token.
 *
 * That real difference is the ONE branch here: a device flow means the provider polls itself and the panel is
 * read-only; a redirect flow hands the user something to paste back (Anthropic's authorization code or the
 * address Google dead-ends on).
 *
 * Cancel deliberately does NOT live here: it belongs in the row's single action slot, where the button that
 * started this sign-in was — see AiAccountSection. useChat is a module singleton, so this reads the live
 * handshake with nothing threaded through props but which row it is unfolding under. */

const { kind, provider } = defineProps<{ kind: `native` | `routed`; provider: AgentProvider }>();

const { nativeConnectFlow, translatorConnectFlow, accountBusy, translatorKey, connectLabel, completeConnect, completeTranslator } = useChat();

// This flow's own key in the account-write ledger — the two mechanisms of one provider (Grok's xAI account and
// its SuperGrok subscription) are separate connections, so "Finish" must spin for one and not the other.
const busyKey = computed(() => (kind === `native` ? provider : translatorKey(provider)));

// The live handshake belonging to THIS row, or nothing — the flows carry their provider, so a sign-in started
// on one row can never paint itself under another.
const flow = computed(() =>
    kind === `native`
        ? nativeConnectFlow.value?.provider === provider
            ? nativeConnectFlow.value
            : undefined
        : translatorConnectFlow.value?.provider === provider
          ? translatorConnectFlow.value
          : undefined,
);

// Where the sign-in actually happens — the destination, not the provider's product name: a user about to leave
// this page wants to recognize the site they land on.
const DESTINATION: Record<string, string> = {
    claude: `Anthropic`,
    codex: `ChatGPT`,
    grok: `x.ai`,
    kimi: `Kimi Code`,
    gemini: `Google`,
};
const openLabel = computed(() => `Open ${DESTINATION[provider] ?? provider}`);

const deviceFlow = computed(() => {
    const live = flow.value;
    return live !== undefined && (`flow` in live ? live.flow === `device` : live.code !== ``);
});

// Only the mechanics a user cannot infer from the button they just pressed and the field in front of them.
// Anthropic's flow says everything it needs to in "Open Anthropic" + "Paste code…", so it gets no line at all.
const hint = computed<string | undefined>(() => {
    if (deviceFlow.value) {
        return kind === `native`
            ? `Already filled in at x.ai — approve on any device.`
            : flow.value?.code
              ? `Sign in and approve — enter this code if the page asks for it.`
              : `Approve the sign-in on the page that opens.`;
    }
    if (kind === `routed`) {
        // The dead-end landing page is the one thing a user cannot work out on their own, so it stays in full.
        return `The page Google lands on won't load — that's expected, it points back inside the sandbox. Copy its whole address and paste it below.`;
    }
    return undefined;
});

const pastePlaceholder = computed(() => (kind === `routed` ? `Paste the address you landed on…` : `Paste code…`));

// The one field the paste flows share: an authorization code or redirect URL — the panel takes
// the string and hands it to whichever half of the handshake is live.
const pasted = ref(``);
const finish = async (): Promise<void> => {
    const value = pasted.value.trim();
    if (value.length === 0) {
        return;
    }
    if (kind === `routed`) {
        await completeTranslator(value);
        pasted.value = ``;
        return;
    }
    if (await completeConnect(value)) {
        pasted.value = ``;
    }
};

// The display name is a rename, not a step: the daemon derives one from the sign-in identity when it's blank.
// Leading the flow with that field made every connect look like a form to fill in before anything would happen,
// so it stays folded away until asked for — and re-folds with the handshake, never carrying a stale open state
// into the next one. Native only: a translator subscription is named by the account it signs in as.
const namingAccount = ref(false);
watch(flow, (live) => {
    if (live === undefined) {
        namingAccount.value = false;
    }
});
</script>

<template>
    <div v-if="flow" class="flex flex-col gap-2.5">
        <!-- `self-start`: the column would stretch it edge to edge, which reads as a banner rather than as the
             first step of three. -->
        <Button as="a" class="self-start" :label="openLabel" size="small" :href="flow.url" target="_blank" rel="noopener">
            <template #icon><Icon name="external-link" /></template>
        </Button>
        <!-- Above what it describes, never below: this line is the instruction for the code or the field that
             follows it, and an instruction read afterwards is read too late. -->
        <p v-if="hint" class="text-2xs text-subtle">{{ hint }}</p>
        <!-- A device code is read, not typed: one line, at a size you can read off a second screen, with copy as
             an icon rather than a chip competing with the real action. -->
        <div v-if="deviceFlow && flow.code" class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
            <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{ flow.code }}</span>
            <CopyButton :text="flow.code" />
        </div>
        <p v-else-if="deviceFlow" class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for approval…</p>
        <div v-else class="flex gap-2">
            <input
                v-model="pasted"
                name="connectCode"
                :placeholder="pastePlaceholder"
                :class="cmp.input(`min-w-0 flex-1 py-1.5`)"
                @keydown.enter="finish"
            />
            <Button label="Finish" size="small" :disabled="pasted.trim().length === 0" :loading="accountBusy === busyKey" @click="finish" />
        </div>
        <template v-if="kind === `native`">
            <button
                v-if="!namingAccount"
                type="button"
                class="cursor-pointer self-start text-2xs text-subtle transition-colors hover:text-content"
                @click="namingAccount = true"
            >
                Name this account…
            </button>
            <input v-else v-model="connectLabel" name="accountLabel" placeholder="Account name" :class="cmp.input(`min-w-0 py-1.5`)" />
        </template>
    </div>
</template>
