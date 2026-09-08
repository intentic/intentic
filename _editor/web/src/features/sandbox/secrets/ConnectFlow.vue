<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, ui, CopyButton } from "@intentic/ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { useChat } from "../../chat/run/useChat";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";

// One sign-in panel for every provider and mechanism (own account or translator subscription); branches only on
// the handshake shape (device: read-only poll; redirect: paste back a code or address), never on the provider. Lives
// inside whatever row or strip started the sign-in; Cancel belongs to that caller, not here.

const { kind, provider } = defineProps<{ kind: `native` | `routed`; provider: AgentProvider }>();

const { nativeConnectFlow, translatorConnectFlow, accountBusy, translatorKey, connectLabel, completeConnect, completeTranslator } = useChat();

// Own key in the busy ledger: a provider's native account and its subscription are separate connections.
const busyKey = computed(() => (kind === `native` ? provider : translatorKey(provider)));

// This row's own live handshake, or nothing; a sign-in started elsewhere never paints under the wrong row.
const flow = computed(() =>
    kind === `native`
        ? nativeConnectFlow.value?.provider === provider
            ? nativeConnectFlow.value
            : undefined
        : translatorConnectFlow.value?.provider === provider
          ? translatorConnectFlow.value
          : undefined,
);

// Destination site, not the product name (`ProviderSpec.destination`); the fallback should never be reached.
const destination = computed(() => providerSpec(provider)?.destination ?? provider);

// No-paste sign-in: finishes out of band, panel stays read-only. Wire-reported, not inferred from the provider
// name; for a minted provider it depends on the estate (e.g. z.ai polls, the mainland dead-ends).
const deviceFlow = computed(() => flow.value?.flow === `device`);

// Whether the return value is a whole address, not a shown code: true for every routed redirect and BigModel's
// minted one (both dead-end on a loopback port), false for Anthropic's paste-back (a real page shows the code).
const redirectFlow = computed(() => flow.value !== undefined && !deviceFlow.value && (kind === `routed` || flow.value.flow === `redirect`));

// Only mechanics not inferable from the button and field already shown; Anthropic's flow needs no extra line.
const hint = computed<string | undefined>(() => {
    if (!deviceFlow.value) {
        return undefined;
    }
    if (kind === `routed`) {
        return flow.value?.code ? `Sign in and approve: enter this code if the page asks for it.` : `Approve the sign-in on the page that opens.`;
    }
    // Reassurance differs per no-paste flow (Grok: code's already there; others: nothing comes back; Meta: where to
    // type its shown code). Read off the flow's own fields, not the provider, so a new sign-in needs no new branch.
    if (provider === `grok`) {
        return `Already filled in at x.ai: approve on any device.`;
    }
    return flow.value?.code
        ? `Enter this code on the page that opens: this sandbox finishes the rest and the account appears here.`
        : `Sign in on the page that opens: this sandbox finishes the rest and the account appears here.`;
});

const pastePlaceholder = computed(() => (redirectFlow.value ? `Paste the address you landed on…` : `Paste code…`));

// Fake dead-end address per flow, for the user to recognize against the real error page. Google's grant param is
// `code`, BigModel's is `authCode`; truncated like a real one since only the shape matters.
const deadEndAddress = computed(() =>
    kind === `routed` ? `localhost:8317/?code=4/0AX4…` : `127.0.0.1:8317/callback?authCode=eyJhb…`,
);

// True only for the paste-back flow: `connectLabel` is read solely by `completeConnect`. Every out-of-band flow
// lands its account through a route that never sees the field; naming there happens as a rename afterward.
const namesTheAccount = computed(() => kind === `native` && nativeConnectFlow.value?.provider === provider && nativeConnectFlow.value.flow === `paste`);

// Waiting for something to be brought back; the only state the paste listener or clipboard read applies in.
const awaitingPaste = computed(() => flow.value !== undefined && !deviceFlow.value);

// The redirect dead-ends on a loopback address the page can never load; handled two ways: the picture below
// (recognize it) and this section, which grabs the grant from a paste anywhere or the clipboard so most people never
// act on the picture at all.

// Handshake `state`: the translator flow if routed, else the native one; blank for a non-redirect sign-in.
const redirectState = computed(() => (kind === `routed` ? (translatorConnectFlow.value?.state ?? ``) : (nativeConnectFlow.value?.state ?? ``)));

// Matches this handshake's own grant: the query param plus its issuing `state`, so an unrelated clipboard string
// is ignored. Checks both `code=` and `authCode=` (BigModel names it the second way).
const isOurRedirect = (text: string): boolean =>
    (text.includes(`code=`) || text.includes(`authCode=`)) && (redirectState.value === `` || text.includes(redirectState.value));

// Shared field for the paste flows: a code or a redirect URL, handed to whichever handshake is live.
const pasted = ref(``);
const finish = async (): Promise<void> => {
    const value = pasted.value.trim();
    if (value.length === 0 || accountBusy.value !== undefined) {
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

// Filling the field is the whole interaction, no second press. Watches the value, not the paste event, so every
// arrival path (field, window, clipboard) shares one rule, firing only once it carries this handshake's own state.
watch(pasted, (value) => {
    if (redirectFlow.value && awaitingPaste.value && isOurRedirect(value.trim())) {
        void finish();
    }
});

// Catches a paste anywhere on the window while waiting, so the user needn't click the field first; ignores any
// paste aimed at an actual input (ours included, v-model already handles that).
const onWindowPaste = (event: ClipboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(`input, textarea, [contenteditable="true"]`) != null) {
        return;
    }
    const text = event.clipboardData?.getData(`text`).trim() ?? ``;
    if (text !== ``) {
        event.preventDefault();
        pasted.value = text;
    }
};

// One clipboard read, only on the first return from the provider, to avoid re-prompting on every window focus.
// Best-effort (Firefox/Safari/a declined Chrome prompt all silently no-op); an optimization on top of the paste path,
// never a replacement.
const wentToProvider = ref(false);
const onReturn = (): void => {
    if (!wentToProvider.value || !awaitingPaste.value || document.visibilityState !== `visible` || accountBusy.value !== undefined) {
        return;
    }
    wentToProvider.value = false;
    void navigator.clipboard
        ?.readText()
        .then((text) => {
            const value = text.trim();
            if (isOurRedirect(value)) {
                pasted.value = value;
            }
        })
        .catch(() => undefined);
};

// Armed only while a handshake is live; an idle panel shouldn't watch window pastes or the clipboard.
let armed = false;
const arm = (on: boolean): void => {
    if (on === armed) {
        return;
    }
    armed = on;
    if (on) {
        window.addEventListener(`paste`, onWindowPaste);
        window.addEventListener(`focus`, onReturn);
        document.addEventListener(`visibilitychange`, onReturn);
        return;
    }
    window.removeEventListener(`paste`, onWindowPaste);
    window.removeEventListener(`focus`, onReturn);
    document.removeEventListener(`visibilitychange`, onReturn);
};
watch(awaitingPaste, arm, { immediate: true });
onUnmounted(() => arm(false));

// Naming is a rename, not a required step (the daemon derives one when blank); folded away until asked for, and
// re-folds with each new handshake. Native only, a subscription is named by the account it signs in as.
const namingAccount = ref(false);
watch(flow, (live) => {
    if (live === undefined) {
        namingAccount.value = false;
        pasted.value = ``;
        wentToProvider.value = false;
    }
});
</script>

<template>
    <div v-if="flow" class="flex flex-col gap-2.5">
        <!-- `self-start`: without it the button stretches edge to edge, reading as a banner, not step one of three. -->
        <Button as="a" class="self-start" size="small" :href="flow.url" target="_blank" rel="noopener" @click="wentToProvider = true">
            <ProviderLogo :provider="provider" />Open {{ destination }}<Icon name="external-link" />
        </Button>
        <!-- Placed above what it describes: an instruction read after the fact is read too late. -->
        <p v-if="hint" class="text-2xs text-subtle">{{ hint }}</p>
        <!-- Device code is read, not typed: sized for a second screen, with copy as an icon, not a competing chip. -->
        <div v-if="deviceFlow && flow.code" class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
            <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{ flow.code }}</span>
            <CopyButton :text="flow.code" />
        </div>
        <p v-else-if="deviceFlow" class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for approval…</p>
        <template v-else>
            <!--
                Shows the dead-end page before they meet it, so they recognize rather than read about it once two tabs away.
                Only for redirects that actually dead-end (Google, BigModel); Anthropic's paste-back needs none of this.
            -->
            <template v-if="redirectFlow">
                <p class="text-2xs text-muted">
                    After {{ destination }}, the <span class="font-semibold text-content">page won't load</span>. That's normal, it points back inside
                    your sandbox.
                </p>
                <div class="overflow-hidden rounded-lg border border-line bg-canvas select-none" aria-hidden="true">
                    <div class="flex items-center gap-2 border-b border-line-subtle px-2 py-1.5">
                        <span class="flex shrink-0 gap-1">
                            <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                            <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                            <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                        </span>
                        <span
                            class="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-primary-500 bg-overlay px-1.5 py-0.5 ring-2 ring-primary-500/25"
                        >
                            <Icon name="unlock" class="shrink-0 text-[0.6rem] text-subtle" />
                            <span class="truncate font-mono text-[0.6rem] text-content">{{ deadEndAddress }}</span>
                        </span>
                    </div>
                    <div class="flex flex-col items-center gap-1 px-3 py-3">
                        <Icon name="globe" class="text-base text-content/20" />
                        <span class="text-2xs text-subtle">This site can't be reached</span>
                    </div>
                </div>
                <p class="flex items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="sparkles" class="shrink-0 text-link" />Copy the highlighted address: it lands here on its own.
                </p>
            </template>
            <div class="flex gap-2">
                <input
                    v-model="pasted"
                    name="connectCode"
                    :placeholder="pastePlaceholder"
                    :class="ui.inputSm(`min-w-0 flex-1`)"
                    @keydown.enter="finish"
                />
                <Button label="Finish" size="small" :disabled="pasted.trim().length === 0" :loading="accountBusy === busyKey" @click="finish" />
            </div>
        </template>
        <template v-if="namesTheAccount">
            <button v-if="!namingAccount" type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="namingAccount = true">
                Name this account…
            </button>
            <input v-else v-model="connectLabel" name="accountLabel" placeholder="Account name" :class="ui.inputSm(`min-w-0`)" />
        </template>
    </div>
</template>
