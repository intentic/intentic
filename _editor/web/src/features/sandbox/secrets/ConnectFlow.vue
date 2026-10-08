<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, ui } from "@intentic/ui";
import { formatList } from "@intentic/ui/format";
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import { useChat } from "../../chat/run/useChat";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { readClipboard, useCopied } from "@intentic/ui/clipboard";
import { useT } from "@intentic/ui/i18n";

// One sign-in panel for every provider and mechanism (own account or translator subscription); branches only on
// the handshake shape (device: read-only poll; redirect: paste back a code or address), never on the provider. Lives
// inside whatever row or strip started the sign-in; Cancel belongs to that caller, not here.

const t = useT();

// `roomy` is the same panel given a page to stand on rather than a strip above a composer: full-size controls, and the
// dead-end picture already open, since there the picture is reference beside the button instead of competing with it.
const { kind, provider, roomy = false } = defineProps<{ kind: `native` | `routed`; provider: AgentProvider; roomy?: boolean }>();

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
        return flow.value?.code ? t(`sandbox.connectFlow.approveEnterCode`) : t(`sandbox.connectFlow.approveOnPage`);
    }
    // Reassurance differs per no-paste flow (Grok: code's already there; others: nothing comes back; Meta: where to
    // type its shown code). Read off the flow's own fields, not the provider, so a new sign-in needs no new branch.
    if (provider === `grok`) {
        return t(`sandbox.connectFlow.alreadyFilledIn`);
    }
    return flow.value?.code ? t(`sandbox.connectFlow.enterCodeFinishesRest`) : t(`sandbox.connectFlow.signInFinishesRest`);
});

// What the reader has to come back holding, named the same way in the instruction, the field and its label, so
// the three cannot describe different objects. Whole messages per flow, since the noun alone would be English glued
// into another language's sentence.
const pasteLabel = computed(() =>
    redirectFlow.value ? t(`sandbox.connectFlow.pasteAddress`, { destination: destination.value }) : t(`sandbox.connectFlow.pasteCode`),
);
const pastePlaceholder = computed(() =>
    redirectFlow.value ? t(`sandbox.connectFlow.pasteAddressPlaceholder`) : t(`sandbox.connectFlow.pasteCodePlaceholder`),
);

// Fake dead-end address per flow, for the user to recognize against the real error page: the redirect the page was
// actually sent to (`redirect_uri`, or BigModel's `redirect`), then a grant truncated like a real one since only the
// shape matters. BigModel names its grant `authCode`, everyone else `code`.
const redirectTarget = computed(() => {
    try {
        const query = new URL(flow.value?.url ?? ``).searchParams;
        return (query.get(`redirect_uri`) ?? query.get(`redirect`) ?? ``).replace(/^https?:\/\//, ``);
        // allow(silent-catch): A malformed authorization URL has no redirect target to display.
    } catch {
        return ``;
    }
});
const deadEndAddress = computed(() => {
    const grant = provider === `zai` ? `authCode=eyJhb…` : `code=4/0AX4…`;
    return `${redirectTarget.value === `` ? `localhost` : redirectTarget.value}?${grant}`;
});

// Who of the owner's is watching where the redirect lands (a device agent, a browser extension): with anyone, the
// sign-in finishes by itself once approved on that machine, and the paste is the way in from anywhere else.
const catchers = computed(() => flow.value?.catchers ?? []);
const watching = computed(() => !deviceFlow.value && catchers.value.length > 0);
const watchedOn = computed(() =>
    formatList(
        catchers.value.map((catcher) => catcher.label),
        `disjunction`,
    ),
);
// Asked for by the reader signing in somewhere nothing watches; until then the paste field stays out of the way.
const pasteInstead = ref(false);
const bringItBack = (): void => {
    pasteInstead.value = true;
    connectSent.value = true;
};

// The picture of the dead-end page is reference, not an instruction, so it stays folded until asked for: at full
// size it outweighs the real button ten to one and wears the emphasis ring, which is why it got clicked. On a roomy
// host it opens with the panel, where there is width for it to sit beside the field instead of on top of it.
const showDeadEnd = ref(roomy);

// One size decision, read by every control here, so the two hosts cannot drift into two different panels.
const controlSize = computed<`small` | undefined>(() => (roomy ? undefined : `small`));
const bodyText = computed(() => (roomy ? `text-xs` : `text-2xs`));

// True only for the paste-back flow: `connectLabel` is read solely by `completeConnect`. Every out-of-band flow
// lands its account through a route that never sees the field; naming there happens as a rename afterward.
const namesTheAccount = computed(
    () => kind === `native` && nativeConnectFlow.value?.provider === provider && nativeConnectFlow.value.flow === `paste`,
);

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
const submitNote = computed(() => t(`sandbox.connectFlow.finishingWith`, { destination: destination.value }));

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

// A device sign-in's code goes with the press that opens its page, which asks for it: a reader who had to come back
// for it pressed Open three times and copied it by hand. Written inside the press, the gesture a clipboard write
// needs; the code stays on screen and copies on a press of its own for a browser that refuses.
// Each press acknowledges itself for a moment: the held note below was already up after Open, so a press on the code
// changed nothing on screen, and a reader pressed it four times over.
const { copied: justCopied, copy: copyText } = useCopied();
// Held, not flashed: the note says the code is on the clipboard for as long as the flow waits on it.
const codeCopied = ref(false);
// The browser refused the write (no clipboard off a secure page, a press it would not count, a declined permission):
// said, and the code put in a field already selected, since text inside a button cannot be selected by hand everywhere.
const copyRefused = ref(false);
const codeField = useTemplateRef<HTMLInputElement>(`codeField`);
// Counts the presses, so one made while the last one's Copied is still up redraws it and is announced again.
const copyPresses = ref(0);
const forgetCodeCopied = (): void => {
    codeCopied.value = false;
    copyRefused.value = false;
};
const copyCode = async (event?: Event): Promise<void> => {
    const code = flow.value?.code;
    if (code === undefined || code === ``) {
        return;
    }
    const landed = await copyText(code, event?.target instanceof Element ? event.target : undefined);
    copyPresses.value += 1;
    codeCopied.value = landed;
    copyRefused.value = !landed;
    if (!landed) {
        await nextTick();
        codeField.value?.focus();
        codeField.value?.select();
    }
};
// What the live region says, so a press is heard as well as seen.
const copyAnnouncement = computed(() => (copyRefused.value ? t(`sandbox.connectFlow.copyRefused`) : justCopied.value ? t(`ui.action.copied`) : ``));
const openDevicePage = (event: Event): void => {
    void copyCode(event);
    openedProvider();
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
    // Unread when permission is refused; a manual paste remains available.
    void readClipboard(pasteField.value).then((text) => {
        const value = (text ?? ``).trim();
        if (isOurRedirect(value)) {
            pasted.value = value;
        }
    });
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
        pasteInstead.value = false;
        pasted.value = ``;
        wentToProvider.value = false;
        forgetCodeCopied();
        showDeadEnd.value = roomy;
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
            <Button
                as="a"
                class="self-start touch-target"
                :size="controlSize"
                :href="flow.url"
                target="_blank"
                rel="noopener"
                @click="openDevicePage"
            >
                <ProviderLogo :provider="provider" />{{ t(`ui.action.open`) }} {{ destination }}<Icon name="external-link" />
            </Button>
            <!-- Placed above what it describes: an instruction read after the fact is read too late. -->
            <p v-if="hint" :class="[bodyText, `text-subtle`]">{{ hint }}</p>
            <!-- Device code is read, not typed: sized for a second screen, and copied by a press on it as well as by the icon. -->
            <div
                v-if="flow.code"
                class="relative flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5 text-base"
            >
                <!-- A refused copy leaves the code in a field already selected, for the reader's own copy. -->
                <input
                    v-if="copyRefused"
                    ref="codeField"
                    readonly
                    :value="flow.code"
                    :aria-label="t(`sandbox.connectFlow.codeLabel`)"
                    :class="ui.input({ size: `inline` }, `min-w-0 flex-1 font-mono font-semibold tracking-[0.2em]`)"
                    @focus="codeField?.select()"
                />
                <button
                    v-else
                    type="button"
                    class="min-w-0 truncate text-left font-mono text-base font-semibold tracking-[0.2em] text-content"
                    :title="t(`sandbox.connectFlow.copyCode`)"
                    @click="copyCode"
                >
                    {{ flow.code }}
                </button>
                <button
                    type="button"
                    :aria-label="t(`sandbox.connectFlow.copyCode`)"
                    :class="ui.iconButton({ tone: `subtle` }, justCopied && `w-auto px-1.5 text-success`)"
                    @click="copyCode"
                >
                    <!-- Keyed by the press, so each one pops its own tick (the checkbox's) rather than leaving the last one standing. -->
                    <span
                        :key="justCopied ? copyPresses : 0"
                        class="flex items-center gap-1 text-2xs"
                        :class="{ 'motion-safe:animate-[ui-check-in_160ms_cubic-bezier(0.2,0.9,0.3,1.25)]': justCopied }"
                    >
                        <Icon :name="justCopied ? `check` : `copy`" />
                        <span v-if="justCopied" aria-hidden="true">{{ t(`ui.action.copied`) }}</span>
                    </span>
                </button>
                <span class="sr-only" aria-live="polite"
                    ><span :key="copyPresses">{{ copyAnnouncement }}</span></span
                >
            </div>
            <p v-if="flow.code && copyRefused" :class="[bodyText, `text-warning`]">{{ t(`sandbox.connectFlow.copyRefused`) }}</p>
            <p v-else-if="flow.code && codeCopied" :class="[bodyText, `text-subtle`]">{{ t(`sandbox.connectFlow.codeCopied`) }}</p>
            <!-- Kept beside the copied note: the wait is still on after the code went to the clipboard. -->
            <p class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />{{ t(`sandbox.connectFlow.waitingApproval`) }}</p>
        </template>

        <!-- Watched on the owner's own machine: going is the whole of it, and the paste is folded behind "somewhere else". -->
        <template v-else-if="watching && !pasteInstead && pasted.trim() === ``">
            <p :class="[bodyText, `text-muted`]">{{ t(`sandbox.connectFlow.finishesOn`, { where: watchedOn }) }}</p>
            <Button
                as="a"
                class="self-start touch-target"
                :size="controlSize"
                :href="flow.url"
                target="_blank"
                rel="noopener"
                @click="openedProvider"
            >
                <ProviderLogo :provider="provider" />{{ t(`ui.action.open`) }} {{ destination }}<Icon name="external-link" />
            </Button>
            <p v-if="connectSent" class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="spinner" spin />{{ t(`sandbox.connectFlow.waitingOn`, { where: watchedOn }) }}
            </p>
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="bringItBack">
                {{ t(`sandbox.connectFlow.notThere`, { where: watchedOn }) }}
            </button>
        </template>

        <!-- Step one, and the only thing on the panel: what to come back with is said BEFORE the trip, since afterwards there are two tabs between the reader and this sentence. -->
        <template v-else-if="!broughtBack">
            <i18n-t v-if="redirectFlow" keypath="sandbox.connectFlow.comeBackWithAddress" tag="p" :class="[bodyText, `text-muted`]" scope="global">
                <template #destination>{{ destination }}</template>
                <template #wontLoad
                    ><span class="font-semibold text-content">{{ t(`sandbox.connectFlow.wontLoad`) }}</span></template
                >
            </i18n-t>
            <p v-else :class="[bodyText, `text-muted`]">{{ t(`sandbox.connectFlow.comeBackWithCode`) }}</p>
            <Button
                as="a"
                class="self-start touch-target"
                :size="controlSize"
                :href="flow.url"
                target="_blank"
                rel="noopener"
                @click="openedProvider"
            >
                <ProviderLogo :provider="provider" />{{ t(`ui.action.open`) }} {{ destination }}<Icon name="external-link" />
            </Button>
            <!-- The way in for someone who already made the trip (a reopened panel, a second tab); without it the only way out of step one was Cancel. -->
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="connectSent = true">
                {{ t(`sandbox.connectFlow.alreadyPasteHere`) }}
            </button>
        </template>

        <!-- Step two: the field is the subject now, so nothing else on the panel competes for the press. -->
        <template v-else>
            <label :for="pasteFieldId" :class="[bodyText, `text-muted`]">{{ pasteLabel }}</label>
            <div class="flex gap-2">
                <input
                    :id="pasteFieldId"
                    ref="pasteField"
                    v-model="pasted"
                    name="connectCode"
                    :placeholder="pastePlaceholder"
                    :class="roomy ? ui.input(`min-w-0 flex-1 font-mono`) : ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                    @keydown.enter="finish"
                />
                <Button
                    :label="t(`sandbox.connectFlow.finish`)"
                    class="touch-target"
                    :size="controlSize"
                    :disabled="pasted.trim().length === 0"
                    @click="finish"
                />
            </div>
            <div class="flex flex-wrap items-center gap-x-4">
                <a :class="ui.textButton({ size: `xs` })" :href="flow.url" target="_blank" rel="noopener" @click="openedProvider">
                    {{ t(`sandbox.connectFlow.openAgain`, { destination }) }}<Icon name="external-link" />
                </a>
                <!-- The dead-end page as reference rather than instruction: folded, and inert, so a press on it can't be swallowed by a picture. -->
                <button v-if="redirectFlow" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="showDeadEnd = !showDeadEnd">
                    <Icon :name="showDeadEnd ? `chevron-down` : `chevron-right`" />{{ t(`sandbox.connectFlow.whatPageLooksLike`) }}
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
                    <span class="text-2xs text-subtle">{{ t(`sandbox.connectFlow.siteCantReached`) }}</span>
                </div>
            </div>
            <template v-if="namesTheAccount">
                <button v-if="!namingAccount" type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="namingAccount = true">
                    {{ t(`sandbox.connectFlow.nameAccount`) }}
                </button>
                <input
                    v-else
                    v-model="connectLabel"
                    name="accountLabel"
                    :placeholder="t(`sandbox.words.accountName`)"
                    :class="ui.input({ size: `sm` }, `min-w-0`)"
                />
            </template>
        </template>
    </div>
</template>
