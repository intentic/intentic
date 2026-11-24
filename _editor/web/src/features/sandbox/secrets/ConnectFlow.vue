<script setup lang="ts">
import { providerHas, providerTraits } from "@intentic/sandbox-contract/models/providers/provider-traits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { Button, ui } from "@intentic/ui";
import { formatList } from "@intentic/ui/format";
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import { useChat } from "../../../models/conversations/run/useChat";
import { signInTabBlocked } from "../../../models/conversations/run/signInTab";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import SignInRing from "./SignInRing.vue";
import ConnectTripNote from "./ConnectTripNote.vue";
import OpenProvider from "./OpenProvider.vue";
import DeadEndPicture from "./DeadEndPicture.vue";
import DeviceCode from "./DeviceCode.vue";
import { isOurCode, isOurRedirect } from "./grantShape";
import { useSignInClock } from "./signInClock";
import { readClipboard, useCopied } from "@intentic/ui/clipboard";
import { useT } from "@intentic/ui/i18n";
import { onScreen } from "../../../workbench/window/onScreen";
import { connectTripNote } from "./connectFlowNotes";

// One sign-in panel for every provider and mechanism (own account or translator subscription); branches only on
// the handshake shape (device: read-only poll; redirect: paste back a code or address), never on the provider. Lives
// inside the attempt that started the sign-in (ConnectAttempt.vue), which owns Cancel and the steps drawn above it.
//
// EACH STEP IS ONE BLOCK: a line saying what to do (or what is happening), the thing it is about (the code, the field, the
// machine waited on), then its buttons. Not a run of sentences and look-alike links: the reader's one question at every
// step is "do I have to do anything?", and the block answers it at a glance. Each step enters with the app's arrival
// (`ui-enter`), while the attempt eases its height (HeightGlide), so moving on reads as moving on.

const t = useT();

// `problem` is a sentence about the step just tried (a pasted address the sandbox refused), said at the field it is about.
const { kind, provider, problem } = defineProps<{ kind: `native` | `routed`; provider: AgentProvider; problem?: string | undefined }>();
// `elsewhere`: the reader would rather not go through this provider's sign-in after reading what it shows; the host ends
// the attempt, which puts the other providers back in front of them. `stage`: which of the three steps (Open, Sign in,
// Connect) this one is, for the steps the attempt draws above it (ConnectSteps.vue).
const emit = defineEmits<{ elsewhere: []; stage: [stage: 0 | 1 | 2] }>();

const { nativeConnectFlow, translatorConnectFlow, accountBusy, connectLabel, completeConnect, completeTranslator, connectSent, connectCodeCopied } =
    useChat();

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
    if (providerHas(provider, `signInCodePrefilled`)) {
        return t(`sandbox.connectFlow.alreadyFilledIn`);
    }
    return flow.value?.code ? t(`sandbox.connectFlow.enterCodeFinishesRest`) : t(`sandbox.connectFlow.signInFinishesRest`);
});

// What the reader has to come back holding, named the same way in the instruction, the field and its label, so
// the three cannot describe different objects. Whole messages per flow, since the noun alone would be English glued
// into another language's sentence.
// Devin's page hands over what it calls "an authentication token for Devin CLI", so here it is a token too: a reader told
// to paste a code, holding a token the page said to use only in Devin CLI, had a reason to stop (UX review 2026-10-18, F09).
const token = computed(() => providerTraits(provider)?.pasteBack === `token` && !redirectFlow.value);
const pasteLabel = computed(() => {
    if (redirectFlow.value) {
        return t(`sandbox.connectFlow.pasteAddress`, { destination: destination.value });
    }
    return token.value ? t(`sandbox.connectFlow.pasteToken`) : t(`sandbox.connectFlow.pasteCode`);
});
const pastePlaceholder = computed(() => {
    if (redirectFlow.value) {
        return t(`sandbox.connectFlow.pasteAddressPlaceholder`, { destination: destination.value });
    }
    return token.value ? t(`sandbox.connectFlow.pasteTokenPlaceholder`) : t(`sandbox.connectFlow.pasteCodePlaceholder`);
});

// What the provider's pages will show that Intentic's words don't prepare for, said before the trip (connectFlowNotes.ts).
const tripNote = computed(() => (flow.value === undefined ? undefined : connectTripNote(provider, { redirect: redirectFlow.value })));

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
// Where the landing is caught, short enough to read at a glance: one or two by name, more by how many. The list in full
// ("marta, omen, radarsu-server, or rog…") ran off the line, and named machines the reader was not deciding between.
const watchedOn = computed(() => {
    const labels = catchers.value.map((catcher) => catcher.label);
    return labels.length <= 2 ? formatList(labels, `disjunction`) : t(`sandbox.connectFlow.yourDevices`, { count: labels.length });
});
// Asked for by the reader signing in somewhere nothing watches; until then the paste field stays out of the way.
const pasteInstead = ref(false);
const bringItBack = (): void => {
    pasteInstead.value = true;
    connectSent.value = true;
};
// Still watched this long after the trip, the landing may never reach the watcher (another machine's browser, a port the
// browser could not reach): the field comes forward rather than staying behind "Signing in elsewhere?", and the watch
// carries on beside it. A watcher gone altogether ends the wait at once instead (keepWatchers, useChat-connect.ts).
const WATCH_PATIENCE_MS = 30_000;
let patience: ReturnType<typeof setTimeout> | undefined;
const waitingOnWatch = computed(() => watching.value && connectSent.value && !pasteInstead.value);
// When that wait began, for the time it has run, said beside it: a wait that visibly counts is one that is still alive.
const waitingSince = ref<number | undefined>(undefined);
watch(waitingOnWatch, (waiting) => {
    clearTimeout(patience);
    patience = waiting ? setTimeout(bringItBack, WATCH_PATIENCE_MS) : undefined;
    waitingSince.value = waiting ? Date.now() : undefined;
}, { immediate: true });
onUnmounted(() => clearTimeout(patience));

// How long the wait has run and how long the attempt has left (signInClock.ts).
const { waited, expiry: expiryWords, expiryNear } = useSignInClock(
    () => flow.value?.expiresAt,
    () => waitingSince.value,
);

// The picture of the dead-end page is reference, not an instruction, so it stays folded until asked for: at full
// size it outweighed the real button ten to one and wore the emphasis ring, which is why it got clicked. Opened, it is a
// thumbnail beside the sentence it illustrates.
const showDeadEnd = ref(false);

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

// Handshake `state`: the translator flow if routed, else the native one; blank for a non-redirect sign-in.
const redirectState = computed(() => (kind === `routed` ? (translatorConnectFlow.value?.state ?? ``) : (nativeConnectFlow.value?.state ?? ``)));
// This attempt's own handshake, for a paste-back code that carries it after a `#` (Anthropic's page shows `code#state`).
const pasteHandshake = computed(() =>
    kind === `native` && nativeConnectFlow.value?.provider === provider && nativeConnectFlow.value.flow === `paste`
        ? nativeConnectFlow.value.handshake
        : ``,
);

// Whatever this attempt can recognise as its own grant (grantShape.ts), which is then taken without a press.
const isOurGrant = (text: string): boolean => (redirectFlow.value ? isOurRedirect(text, redirectState.value) : isOurCode(text, pasteHandshake.value));

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
// arrival path (field, window, clipboard) shares one rule, firing only once it carries this handshake's own state. A
// reader who pasted Claude's code and then left the "Finish" button unpressed thought the paste was the end of it, and
// it is now.
watch(pasted, (value) => {
    if (awaitingPaste.value && isOurGrant(value.trim())) {
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
// above it, and put "it arrives on its own" over a field demanding otherwise. The press that started the sign-in
// usually made the trip already (signInTab.ts), so the panel mostly opens on the second turn.
const broughtBack = computed(() => connectSent.value || pasted.value.trim().length > 0);

// Opening the provider is what turns this from our step into theirs; also arms the clipboard read on return.
const openedProvider = (): void => {
    wentToProvider.value = true;
    connectSent.value = true;
};
// The trip made by the press that started it arms the same read: the reader is on the provider's page by now.
watch(
    connectSent,
    (sent) => {
        if (sent) {
            wentToProvider.value = true;
        }
    },
    { immediate: true },
);

// A device sign-in's code goes with the press that opens its page, which asks for it: a reader who had to come back
// for it pressed Open three times and copied it by hand. Written inside the press, the gesture a clipboard write
// needs; the code stays on screen and copies on a press of its own for a browser that refuses.
// Each press acknowledges itself for a moment: the held note below was already up after Open, so a press on the code
// changed nothing on screen, and a reader pressed it four times over.
const { copied: justCopied, copy: copyText } = useCopied();
// Held, not flashed: the note says the code is on the clipboard for as long as the flow waits on it. The trip the
// starting press made may have carried it there already (connectCodeCopied).
const codeCopied = ref(false);
watch(
    connectCodeCopied,
    (copied) => {
        if (copied) {
            codeCopied.value = true;
        }
    },
    { immediate: true },
);
// The browser refused the write (no clipboard off a secure page, a press it would not count, a declined permission):
// said, and the code put in a field already selected, since text inside a button cannot be selected by hand everywhere.
const copyRefused = ref(false);
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
watch(
    broughtBack,
    (now) => {
        if (now) {
            void nextTick(() => pasteField.value?.focus());
        }
    },
    { immediate: true },
);

const onReturn = (): void => {
    if (!wentToProvider.value || !awaitingPaste.value || !onScreen.value || accountBusy.value !== undefined) {
        return;
    }
    wentToProvider.value = false;
    // Unread when permission is refused; a manual paste remains available.
    void readClipboard(pasteField.value).then((text) => {
        const value = (text ?? ``).trim();
        if (isOurGrant(value)) {
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
        return;
    }
    window.removeEventListener(`paste`, onWindowPaste);
    window.removeEventListener(`focus`, onReturn);
};
watch(awaitingPaste, arm, { immediate: true });
// The window coming back on screen, as onScreen says it: a Windows webview back from the tray never reported hidden.
watch(onScreen, () => {
    if (armed) {
        onReturn();
    }
});
onUnmounted(() => arm(false));

// Which of the panel's steps is on screen, read once so the heading row's button and the body cannot disagree.
// `watched`: a device of the owner's catches the landing, so going is the whole of it. `go`: step one of a paste sign-in,
// the trip, drawn only when the press that started it could not make the trip itself. `paste`: step two, the field.
const step = computed<`redeeming` | `device` | `watched` | `go` | `paste`>(() => {
    if (redeeming.value) {
        return `redeeming`;
    }
    if (deviceFlow.value) {
        return `device`;
    }
    if (watching.value && !pasteInstead.value && pasted.value.trim() === ``) {
        return `watched`;
    }
    return broughtBack.value ? `paste` : `go`;
});
const onOpen = (event: Event): void => (step.value === `device` ? openDevicePage(event) : openedProvider());
// Going is the step's one action only until the reader has gone; after that it is a way back to a page they closed.
const openIsTheStep = computed(() => step.value === `go` || ((step.value === `device` || step.value === `watched`) && !connectSent.value));
const openAgain = computed(() => step.value === `paste` || ((step.value === `device` || step.value === `watched`) && connectSent.value));

// Which of the three steps (Open, Sign in, Connect) the reader is on: going until they have gone, signing in while the
// provider's page has them or the field waits for what it gives back, connecting once that is being redeemed.
const stage = computed<0 | 1 | 2>(() => {
    if (step.value === `redeeming`) {
        return 2;
    }
    if (step.value === `paste`) {
        return 1;
    }
    return step.value !== `go` && connectSent.value ? 1 : 0;
});
watch(stage, (next) => emit(`stage`, next), { immediate: true });

// No tab came of the press that started this (a popup blocker): said, so the reader is not left looking for one, and the
// step's own Open is the way.
const blocked = computed(() => step.value === `go` && signInTabBlocked.value);

// A refused paste is said at the field, which shakes once for it, as a refused password does; a fresh refusal shakes again.
const shaking = ref(false);
watch(
    () => problem,
    (said) => {
        shaking.value = said !== undefined && said !== ``;
    },
);

// What to come back holding, said on both turns: before the trip, and on the field itself, since the press that started
// the sign-in usually made the trip already and this is the first thing the reader reads here.
const comeBackWith = computed(() => (token.value ? t(`sandbox.connectFlow.comeBackWithToken`) : t(`sandbox.connectFlow.comeBackWithCode`)));

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
        showDeadEnd.value = false;
    }
});
</script>

<template>
    <div v-if="flow" class="@container flex flex-col gap-3 text-xs">
        <!-- What is being redeemed is already spent: the exchange takes the whole block. -->
        <div v-if="step === `redeeming`" key="redeeming" class="ui-enter flex items-center gap-3" role="status">
            <SignInRing motion="turn"><ProviderLogo :provider="provider" /></SignInRing>
            <div class="flex min-w-0 flex-col gap-0.5">
                <p class="text-sm font-medium text-content">{{ submitNote }}</p>
                <p class="text-muted">{{ t(`sandbox.connectFlow.checkingAccount`) }}</p>
            </div>
        </div>

        <!-- Out-of-band sign-in: the page finishes it. What to do (or that the code is already copied), the code itself, then
             the wait with how long the code lasts. -->
        <div v-else-if="step === `device`" key="device" class="ui-enter flex flex-col gap-3">
            <p v-if="flow.code && copyRefused" class="text-sm font-medium text-warning">{{ t(`sandbox.connectFlow.copyRefused`) }}</p>
            <p v-else-if="flow.code && codeCopied" class="flex items-center gap-1.5 text-sm font-medium text-content">
                <Icon name="check" class="shrink-0 text-success" />{{ t(`sandbox.connectFlow.codeCopied`) }}
            </p>
            <p v-else-if="hint" class="text-sm font-medium text-content">{{ hint }}</p>
            <DeviceCode
                v-if="flow.code"
                :code="flow.code"
                :refused="copyRefused"
                :just-copied="justCopied"
                :presses="copyPresses"
                :announcement="copyAnnouncement"
                @copy="copyCode"
            />
            <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted">
                <Icon name="spinner" spin class="shrink-0" />{{ t(`sandbox.connectFlow.waitingApproval`) }}
                <template v-if="expiryWords && flow.code"
                    ><span aria-hidden="true">·</span
                    ><span :class="expiryNear ? `text-warning` : ``">{{ t(`sandbox.connectFlow.codeExpiresIn`, { time: expiryWords }) }}</span></template
                >
            </p>
            <div v-if="openIsTheStep || openAgain" class="flex flex-wrap items-center gap-2">
                <OpenProvider :url="flow.url" :provider="provider" :destination="destination" :again="!openIsTheStep" @open="onOpen" />
            </div>
        </div>

        <!-- Watched on the owner's own machine: sign in over there, and it finishes by itself; the paste is behind "elsewhere". -->
        <div v-else-if="step === `watched`" key="watched" class="ui-enter flex flex-col gap-3">
            <div class="flex items-center gap-3">
                <SignInRing motion="pulse"><Icon name="desktop" /></SignInRing>
                <div class="flex min-w-0 flex-col gap-0.5">
                    <p class="text-sm font-medium text-content">
                        {{ connectSent ? t(`sandbox.connectFlow.signInOnTab`, { destination }) : t(`sandbox.connectFlow.signInAt`, { destination }) }}
                    </p>
                    <p class="flex flex-wrap items-center gap-x-1.5 text-muted" :role="connectSent ? `status` : undefined">
                        <template v-if="connectSent"
                            >{{ t(`sandbox.connectFlow.waitingOn`, { where: watchedOn }) }}<template v-if="waited"
                                ><span aria-hidden="true">·</span><span class="tabular-nums" aria-hidden="true">{{ waited }}</span></template
                            ></template
                        >
                        <template v-else>{{ t(`sandbox.connectFlow.finishesOn`, { where: watchedOn }) }}</template>
                    </p>
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <OpenProvider v-if="openIsTheStep || openAgain" :url="flow.url" :provider="provider" :destination="destination" :again="!openIsTheStep" @open="onOpen" />
                <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="bringItBack">
                    <Icon name="link" />{{ t(`sandbox.connectFlow.notThere`) }}
                </button>
            </div>
            <p v-if="expiryNear && expiryWords" class="text-warning">{{ t(`sandbox.connectFlow.signInExpiresIn`, { time: expiryWords }) }}</p>
            <ConnectTripNote v-if="tripNote" :note="tripNote" @elsewhere="emit(`elsewhere`)" />
        </div>

        <!-- A paste sign-in, on either turn. Step one (the trip, when the press could not make it): what to come back with,
             said BEFORE the trip since afterwards two tabs stand between the reader and this sentence, and the Open. Step two:
             the field is the subject, with what the provider's last page will look like folded beside it. -->
        <div v-else :key="step" class="ui-enter flex flex-col gap-3">
            <p v-if="blocked" class="flex items-center gap-1.5 text-sm font-medium text-warning" role="alert">
                <Icon name="exclamation-triangle" class="shrink-0" />{{ t(`sandbox.connectFlow.tabBlocked`, { destination }) }}
            </p>
            <template v-if="step === `go`">
                <i18n-t v-if="redirectFlow" keypath="sandbox.connectFlow.comeBackWithAddress" tag="p" class="text-sm text-content" scope="global">
                    <template #wontLoad
                        ><span class="font-semibold">{{ t(`sandbox.connectFlow.wontLoad`) }}</span></template
                    >
                </i18n-t>
                <p v-else class="text-sm text-content">{{ comeBackWith }}</p>
                <div class="flex flex-wrap items-center gap-2">
                    <OpenProvider :url="flow.url" :provider="provider" :destination="destination" @open="onOpen" />
                    <!-- The way in for someone who already made the trip (a reopened panel, a second tab); without it the only way out of step one was Cancel. -->
                    <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="connectSent = true">
                        {{ t(`sandbox.connectFlow.alreadyPasteHere`) }}
                    </button>
                </div>
            </template>

            <template v-else>
                <p class="text-sm font-medium text-content">{{ redirectFlow ? pasteLabel : comeBackWith }}</p>
                <div class="flex max-w-xl flex-col gap-1.5">
                    <label :for="pasteFieldId" class="sr-only">{{ pasteLabel }}</label>
                    <div class="flex gap-2">
                        <input
                            :id="pasteFieldId"
                            ref="pasteField"
                            v-model="pasted"
                            name="connectCode"
                            :placeholder="pastePlaceholder"
                            :aria-invalid="problem ? true : undefined"
                            :class="[ui.input(`min-w-0 flex-1 font-mono`), problem ? `ui-field-error-box` : ``, shaking ? `ui-shake` : ``]"
                            @keydown.enter="finish"
                            @animationend="shaking = false"
                        />
                        <!-- Named for what it does: "Finish" (Polish "Zakończ", which reads as "end" or "quit") was left unpressed. -->
                        <Button
                            tier="accent"
                            :label="t(`ui.action.connect`)"
                            class="touch-target"
                            :disabled="pasted.trim().length === 0"
                            @click="finish"
                        />
                    </div>
                    <!-- A refused paste stays in the field and is said under it, where the eye already is. -->
                    <p v-if="problem" role="alert" class="ui-field-error text-danger">
                        <Icon name="exclamation-circle" class="shrink-0" />{{ problem }}
                    </p>
                    <i18n-t v-if="redirectFlow" keypath="sandbox.connectFlow.deadEndNote" tag="p" class="text-muted" scope="global">
                        <template #wontLoad
                            ><span class="font-semibold text-content">{{ t(`sandbox.connectFlow.wontLoad`) }}</span></template
                        >
                    </i18n-t>
                </div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <OpenProvider v-if="openAgain" :url="flow.url" :provider="provider" :destination="destination" again @open="onOpen" />
                    <!-- The dead-end page as reference rather than instruction: folded, and inert, so a press on it can't be swallowed by a picture. -->
                    <button v-if="redirectFlow" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="showDeadEnd = !showDeadEnd">
                        <Icon :name="showDeadEnd ? `chevron-down` : `chevron-right`" />{{ t(`sandbox.connectFlow.whatPageLooksLike`) }}
                    </button>
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
                            @keydown.ctrl.enter.prevent="finish()"
                            @keydown.meta.enter.prevent="finish()"
                        />
                    </template>
                    <!-- Still caught on the owner's machine while the field is out: either way finishes it. -->
                    <span v-if="watching" class="flex items-center gap-1.5 text-muted">
                        <span class="size-1.5 rounded-full bg-primary-500 motion-safe:animate-pulse"></span>{{
                            t(`sandbox.connectFlow.alsoWatching`, { where: watchedOn })
                        }}
                    </span>
                </div>
                <DeadEndPicture v-if="redirectFlow && showDeadEnd" :address="deadEndAddress" />
            </template>
            <p v-if="expiryNear && expiryWords" class="text-warning">{{ t(`sandbox.connectFlow.signInExpiresIn`, { time: expiryWords }) }}</p>
            <ConnectTripNote v-if="tripNote" :note="tripNote" @elsewhere="emit(`elsewhere`)" />
        </div>

        <!-- A refused step outside the field (a code the sandbox turned down while nothing was pasted here) is still said here. -->
        <p v-if="problem && step !== `paste`" role="alert" class="flex items-center gap-1.5 text-danger">
            <Icon name="exclamation-circle" class="shrink-0" />{{ problem }}
        </p>
    </div>
</template>
