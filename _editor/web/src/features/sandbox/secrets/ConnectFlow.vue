<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, ui, CopyButton } from "@intentic/ui";
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import { useChat } from "../../chat/run/useChat";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";

// One sign-in panel for every provider and mechanism (own account or translator subscription); branches only on
// the handshake shape (device: read-only poll; redirect: paste back a code or address), never on the provider. Lives
// inside whatever row or strip started the sign-in; Cancel belongs to that caller, not here.

const { kind, provider } = defineProps<{ kind: `native` | `routed`; provider: AgentProvider }>();

const { nativeConnectFlow, translatorConnectFlow, accountBusy, connectLabel, completeConnect, completeTranslator, connectSent } = useChat();

// This panel's own exchange, not the shared busy ledger: what was brought back is being redeemed right now, and
// it is the only thing the panel shows while it runs.
const submitting = ref(false);

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

// What the reader has to come back holding, named the same way in the instruction, the field and its label, so
// the three cannot describe different objects.
const grantNoun = computed(() => (redirectFlow.value ? `the address ${destination.value} lands on` : `the code`));
const pastePlaceholder = computed(() => (redirectFlow.value ? `Paste the address…` : `Paste the code…`));

// Fake dead-end address per flow, for the user to recognize against the real error page. Google's grant param is
// `code`, BigModel's is `authCode`; truncated like a real one since only the shape matters.
const deadEndAddress = computed(() =>
    kind === `routed` ? `localhost:8317/?code=4/0AX4…` : `127.0.0.1:8317/callback?authCode=eyJhb…`,
);

// The picture of the dead-end page is reference, not an instruction, so it stays folded until asked for: at full
// size it outweighs the real button ten to one and wears the emphasis ring, which is why it got clicked.
const showDeadEnd = ref(false);

// True only for the paste-back flow: `connectLabel` is read solely by `completeConnect`. Every out-of-band flow
// lands its account through a route that never sees the field; naming there happens as a rename afterward.
const namesTheAccount = computed(() => kind === `native` && nativeConnectFlow.value?.provider === provider && nativeConnectFlow.value.flow === `paste`);

// The grant is spent and the daemon is still minting the credential behind it: a native redirect lands its
// account through the poll rather than the response, so accepted is not yet connected.
const redeemed = computed(() => kind === `native` && nativeConnectFlow.value?.provider === provider && nativeConnectFlow.value.redeemed);

// Nothing here is the user's to do: what they brought back is being redeemed, or already has been.
const redeeming = computed(() => submitting.value || redeemed.value);

// Waiting for something to be brought back; the only state the paste listener or clipboard read applies in. A
// grant already in hand is not waiting: a second arrival has nothing left to finish.
const awaitingPaste = computed(() => flow.value !== undefined && !deviceFlow.value && !redeeming.value);

// Said in place of everything else while it runs; naming the provider distinguishes this wait from the sign-in
// that already happened in the other tab.
const submitNote = computed(() => `Finishing sign-in with ${destination.value}…`);

// The redirect dead-ends on a loopback address the page can never load; handled two ways: the picture below
// (recognize it) and this section, which grabs the grant from a paste anywhere or the clipboard so most people never
// act on the picture at all.

// Handshake `state`: the translator flow if routed, else the native one; blank for a non-redirect sign-in.
const redirectState = computed(() => (kind === `routed` ? (translatorConnectFlow.value?.state ?? ``) : (nativeConnectFlow.value?.state ?? ``)));

// Matches this handshake's own grant: the query param plus its issuing `state`, so an unrelated clipboard string
// is ignored. Checks both `code=` and `authCode=` (BigModel names it the second way).
const isOurRedirect = (text: string): boolean =>
    (text.includes(`code=`) || text.includes(`authCode=`)) && (redirectState.value === `` || text.includes(redirectState.value));

// Shared field for the paste flows: a code or a redirect URL, handed to whichever handshake is live. Cleared
// only once redeemed, so a refused address stays put and the retry is a second press, not a second trip.
const pasted = ref(``);
const finish = async (): Promise<void> => {
    const value = pasted.value.trim();
    if (value.length === 0 || submitting.value || accountBusy.value !== undefined) {
        return;
    }
    submitting.value = true;
    try {
        if (await (kind === `routed` ? completeTranslator(value) : completeConnect(value))) {
            pasted.value = ``;
        }
    } finally {
        submitting.value = false;
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

// A paste sign-in is two turns and only one of them is the reader's at a time: before the trip the single action
// is going, after it bringing the grant back. Both on screen at once is what let the picture outweigh the button
// above it, and put "it arrives on its own" over a field demanding otherwise.
const broughtBack = computed(() => connectSent.value || pasted.value.trim().length > 0);

// Opening the provider is what turns this from our step into theirs; also arms the clipboard read on return.
const openedProvider = (): void => {
    wentToProvider.value = true;
    connectSent.value = true;
};

// The field is the whole of step two, so arriving there puts the caret in it: coming back from the provider the
// next keystroke is a paste, and on a phone the clipboard read below cannot run at all.
const pasteFieldId = useId();
const pasteField = useTemplateRef<HTMLInputElement>(`pasteField`);
watch(broughtBack, (now) => {
    if (now) {
        void nextTick(() => pasteField.value?.focus());
    }
});

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
        showDeadEnd.value = false;
    }
});
</script>

<template>
    <div v-if="flow" class="flex flex-col gap-2.5">
<!-- The exchange takes the whole panel rather than spinning one button inside it: what was brought back is already spent. -->
        <p v-if="redeeming" class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />{{ submitNote }}</p>
        <!-- Out-of-band sign-in: the page finishes it, so the button and the wait are the whole panel. -->
        <template v-else-if="deviceFlow">
            <!-- `self-start`: without it the button stretches edge to edge, reading as a banner, not step one of three. -->
            <Button as="a" class="self-start touch-target" size="small" :href="flow.url" target="_blank" rel="noopener" @click="openedProvider">
                <ProviderLogo :provider="provider" />Open {{ destination }}<Icon name="external-link" />
            </Button>
            <!-- Placed above what it describes: an instruction read after the fact is read too late. -->
            <p v-if="hint" class="text-2xs text-subtle">{{ hint }}</p>
            <!-- Device code is read, not typed: sized for a second screen, with copy as an icon, not a competing chip. -->
            <div v-if="flow.code" class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
                <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{ flow.code }}</span>
                <CopyButton :text="flow.code" />
            </div>
            <p v-else class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for approval…</p>
        </template>

<!-- Step one, and the only thing on the panel: what to come back with is said BEFORE the trip, since afterwards there are two tabs between the reader and this sentence. -->
        <template v-else-if="!broughtBack">
            <p class="text-2xs text-muted">
                Sign in, then come back here with {{ grantNoun }}<template v-if="redirectFlow">
                    — its last page <span class="font-semibold text-content">won't load</span>, and that's expected</template
                >.
            </p>
            <Button as="a" class="self-start touch-target" size="small" :href="flow.url" target="_blank" rel="noopener" @click="openedProvider">
                <ProviderLogo :provider="provider" />Open {{ destination }}<Icon name="external-link" />
            </Button>
<!-- The way in for someone who already made the trip (a reopened panel, a second tab); without it the only way out of step one was Cancel. -->
            <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="connectSent = true">Already have it? Paste it here</button>
        </template>

        <!-- Step two: the field is the subject now, so nothing else on the panel competes for the press. -->
        <template v-else>
            <label :for="pasteFieldId" class="text-2xs text-muted">Paste {{ grantNoun }}</label>
            <div class="flex gap-2">
                <input
                    :id="pasteFieldId"
                    ref="pasteField"
                    v-model="pasted"
                    name="connectCode"
                    :placeholder="pastePlaceholder"
                    :class="ui.inputSm(`min-w-0 flex-1 font-mono`)"
                    @keydown.enter="finish"
                />
                <Button label="Finish" class="touch-target" size="small" :disabled="pasted.trim().length === 0" @click="finish" />
            </div>
            <div class="flex flex-wrap items-center gap-x-4">
                <a :class="ui.linkButton(`text-2xs`)" :href="flow.url" target="_blank" rel="noopener" @click="openedProvider">
                    Open {{ destination }} again<Icon name="external-link" />
                </a>
<!-- The dead-end page as reference rather than instruction: folded, and inert, so a press on it can't be swallowed by a picture. -->
                <button v-if="redirectFlow" type="button" :class="ui.textAction(`text-2xs`)" @click="showDeadEnd = !showDeadEnd">
                    <Icon :name="showDeadEnd ? `chevron-down` : `chevron-right`" />What that page looks like
                </button>
            </div>
            <div
                v-if="redirectFlow && showDeadEnd"
                class="pointer-events-none overflow-hidden rounded-lg border border-line bg-canvas select-none"
                aria-hidden="true"
            >
                <div class="flex items-center gap-2 border-b border-line-subtle px-2 py-1.5">
                    <span class="flex shrink-0 gap-1">
                        <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                        <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                        <span class="h-1.5 w-1.5 rounded-full bg-content/20"></span>
                    </span>
                    <span class="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-overlay px-1.5 py-0.5">
                        <Icon name="unlock" class="shrink-0 text-[0.6rem] text-subtle" />
                        <span class="truncate font-mono text-[0.6rem] text-content">{{ deadEndAddress }}</span>
                    </span>
                </div>
                <div class="flex flex-col items-center gap-1 px-3 py-3">
                    <Icon name="globe" class="text-base text-content/20" />
                    <span class="text-2xs text-subtle">This site can't be reached</span>
                </div>
            </div>
            <template v-if="namesTheAccount">
                <button v-if="!namingAccount" type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="namingAccount = true">
                    Name this account…
                </button>
                <input v-else v-model="connectLabel" name="accountLabel" placeholder="Account name" :class="ui.inputSm(`min-w-0`)" />
            </template>
        </template>
    </div>
</template>
