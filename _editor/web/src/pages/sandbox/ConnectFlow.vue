<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, ui, CopyButton } from "@intentic/ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { useChat } from "../../composables/chat/useChat";
import ProviderLogo from "../../chat/ProviderLogo.vue";

/* THE sign-in panel: one component for all five providers and both mechanisms (a provider's own account and a
 * translator subscription), because a user signing in does the same three things every time: go to the
 * provider, deal with the one thing it hands back, come back. There were two of these, and they had quietly
 * drifted apart (one waited with a spinner, the other didn't; one could name the account, the other couldn't;
 * the same "Cancel" sat in two different places), which is exactly the drift a user reads as "these providers
 * work differently" when the only real difference is the shape of the token.
 *
 * That real difference is the ONE branch here: a device flow means the provider polls itself and the panel is
 * read-only; a redirect flow hands the user something to paste back (Anthropic's authorization code or the
 * address Google dead-ends on).
 *
 * ONE SIZE, since there is one kind of place this stands: inside the row or the strip that started the
 * sign-in. It used to have a `prominent` variant for the first screen of a fresh sandbox, back when that screen
 * was a sign-in card taking the middle of the agents board. That card is gone (a new user lands on a chat that
 * can already send, and the free channel is discovered in the model picker), and with it the only caller that
 * ever asked for the big version.
 *
 * Cancel deliberately does NOT live here: it belongs in the single action slot of whatever started this
 * sign-in: see AiAccountSection's row and ChatAccountPanel's strip. useChat is a module singleton, so this
 * reads the live handshake with nothing threaded through props but which row it is unfolding under. */

const { kind, provider } = defineProps<{ kind: `native` | `routed` | `keyed`; provider: AgentProvider }>();

const { nativeConnectFlow, translatorConnectFlow, accountBusy, translatorKey, connectLabel, completeConnect, completeTranslator, connectKey } =
    useChat();

// This flow's own key in the account-write ledger: the two mechanisms of one provider (Grok's xAI account and
// its SuperGrok subscription) are separate connections, so "Finish" must spin for one and not the other.
const busyKey = computed(() => (kind === `native` ? provider : translatorKey(provider)));

// The live handshake belonging to THIS row, or nothing: the flows carry their provider, so a sign-in started
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

// Where the sign-in actually happens, the destination, not the provider's product name: a user about to leave
// this page wants to recognize the site they land on. The provider's own spec row says which
// (ProviderSpec.destination), so a provider added to the contract cannot end up with a button reading "Open
// zai" — which is what the fallback below is, and it should only ever be reached by an id that names no
// provider at all.
const destination = computed(() => providerSpec(provider)?.destination ?? provider);

/* Whether this is a NO-PASTE sign-in: the provider (or the daemon) finishes it out of band and this panel is
 * read-only, as against one that hands the user something to bring back.
 *
 * Three ways to know, because there are three shapes of handshake. A routed flow says so outright. A native one
 * with a code is Grok's, pre-filled at x.ai. And a native one with a HANDSHAKE id is Cursor's, which has
 * neither a code nor anything to paste: the page it opens is already addressed to the attempt, and the daemon
 * holds the half that redeems it. That last case is why this cannot simply read `code !== ""` any more — an
 * empty code used to mean "paste-back", and for Cursor it means the opposite. */
const deviceFlow = computed(() => {
    const live = flow.value;
    if (live === undefined) {
        return false;
    }
    if (`flow` in live) {
        return live.flow === `device`;
    }
    return live.code !== `` || live.handshake !== undefined;
});

// Only the mechanics a user cannot infer from the button they just pressed and the field in front of them.
// Anthropic's flow says everything it needs to in "Open Anthropic" + "Paste code…", so it gets no line at all.
const hint = computed<string | undefined>(() => {
    if (deviceFlow.value) {
        if (kind === `native`) {
            // Two native no-paste flows, and the reassurance each needs is different: Grok's is "the code is
            // already in the page", Cursor's is "there is no code, and nothing comes back here".
            return provider === `cursor`
                ? `Sign in on the page that opens: this sandbox finishes the rest and the account appears here.`
                : `Already filled in at x.ai: approve on any device.`;
        }
        return flow.value?.code ? `Sign in and approve: enter this code if the page asks for it.` : `Approve the sign-in on the page that opens.`;
    }
    return undefined;
});

const pastePlaceholder = computed(() => (kind === `routed` ? `Paste the address you landed on…` : `Paste code…`));

// Whether this panel is waiting on something the user has to bring back: the state both helpers below arm on,
// and the only one in which a window listener or a clipboard read is any of our business.
const awaitingPaste = computed(() => flow.value !== undefined && !deviceFlow.value);

/* --- The dead end, and getting past it without the user having to think ----------------------------------
 * Google's sign-in ends on a loopback address only the sandbox container binds, so the page NEVER loads for the
 * user. That is not a failure, but it looks exactly like one, and it is the single step of this whole flow that
 * people abandon on. Two things answer it, and they are different kinds of answer:
 *
 *   · the picture in the template, which spends the one moment BEFORE they go showing them the page they are
 *     about to meet, with the part that matters ringed. A sentence saying "the page won't load" is read,
 *     believed, and forgotten by the time the browser is actually showing it;
 *   · this, which means most people never have to act on the picture at all. The grant is in the address they
 *     copied, so the moment they come back with it we take it: from a paste anywhere on the panel, or off the
 *     clipboard by ourselves when the browser lets us read it. */

// The pending handshake's `state`, for the routed flow that has one. Read off the translator flow rather than
// off `flow` because the two shapes differ: a native handshake keeps its state inside `pkce`, and only the
// redirect this guards is ever matched against it.
const redirectState = computed(() => (kind === `routed` ? (translatorConnectFlow.value?.state ?? ``) : ``));

// Whether a string is the address THIS handshake is waiting for. `code=` is the grant; the state is what makes
// it ours: the translator matches it to the pending session, so anything else that happens to be in the
// clipboard (a link, a snippet, another sandbox's sign-in) fails this and is left alone.
const isOurRedirect = (text: string): boolean => text.includes(`code=`) && (redirectState.value === `` || text.includes(redirectState.value));

// The one field the paste flows share: an authorization code or redirect URL, the panel takes
// the string and hands it to whichever half of the handshake is live.
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

/* THE FIELD FILLING IS THE WHOLE INTERACTION: there is no second press. Watching the value rather than the
 * paste event catches every way it can arrive (a paste into the field, a paste anywhere on the window, the
 * clipboard read below) with one rule instead of three, and it can only fire on an address carrying this
 * handshake's own state, so a half-typed or wrong-tab string just sits there to be looked at. */
watch(pasted, (value) => {
    if (kind === `routed` && awaitingPaste.value && isOurRedirect(value.trim())) {
        void finish();
    }
});

/* A paste ANYWHERE while this panel is waiting, because "click the field first" is a step that exists only to
 * serve the form. Window-level, so it catches someone who came back to the tab and pressed Ctrl+V at whatever
 * the browser happened to have focused, but never a paste aimed at a field, which includes our own (v-model
 * has that one) and every other input on a settings page this panel may be sitting in. */
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

/* ONE clipboard read, on the first return after they actually left for the provider, and the narrowness is the
 * design, not caution. Reading on every focus would re-ask Chrome for permission each time the user clicked
 * back into the window, which is a prompt storm in exchange for a convenience; reading once, at the only moment
 * the answer could possibly be the address, costs a single prompt at the moment it makes sense of itself.
 *
 * Best-effort throughout: Firefox refuses page script the clipboard outright, Safari wants a gesture, Chrome
 * may ask and be told no. Every one of those is a silent no-op, because this is an optimization ON TOP of the
 * paste path, never a replacement for it. */
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

// Armed only while there is a handshake to finish: a panel sitting idle in a settings list has no business
// watching the window's pastes or anybody's clipboard.
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

// The display name is a rename, not a step: the daemon derives one from the sign-in identity when it's blank.
// Leading the flow with that field made every connect look like a form to fill in before anything would happen,
// so it stays folded away until asked for, and re-folds with the handshake, never carrying a stale open state
// into the next one. Native only: a translator subscription is named by the account it signs in as.
const namingAccount = ref(false);
watch(flow, (live) => {
    if (live === undefined) {
        namingAccount.value = false;
        pasted.value = ``;
        wentToProvider.value = false;
    }
});

/* ---- the third mechanism: a key you already hold ----------------------------------------------------------
 *
 * No handshake, so none of the machinery above applies: nothing to open and come back from, nothing to poll,
 * no clipboard to watch. The panel is a field and a button, plus a link to the one page that issues the key,
 * because "paste your API key" is only actionable if you know which of a vendor's consoles mints it.
 *
 * The field is a PASSWORD field. Not because the DOM makes it safer — the value is in memory either way — but
 * because this is the one connect flow where the credential is on screen in full, in a settings page somebody
 * may well be sharing, and the other two never put one there at all. It is cleared on success, and nothing here
 * ever reads a key back: the account rows the daemon answers with have no field one could arrive in. */
const keyValue = ref(``);
const keyLabel = ref(``);
const namingKey = ref(false);
const keyConsole = computed(() => {
    const auth = providerSpec(provider)?.auth;
    return auth?.kind === `key` ? auth.console : undefined;
});
const saveKey = async (): Promise<void> => {
    if (keyValue.value.trim() === ``) {
        return;
    }
    if (await connectKey(provider, keyValue.value, keyLabel.value)) {
        keyValue.value = ``;
        keyLabel.value = ``;
        namingKey.value = false;
    }
};
</script>

<template>
    <!-- THE KEYED PANEL IS ALWAYS OPEN, unlike the two below it, and that is the mechanism showing through
         rather than an inconsistency: those unfold under a handshake the user started and fold away when it
         ends, while here there is nothing to start. The row asked for a key; the field is the row. -->
    <div v-if="kind === `keyed`" class="flex flex-col gap-2.5">
        <div class="flex gap-2">
            <input
                v-model="keyValue"
                type="password"
                name="providerApiKey"
                autocomplete="off"
                :placeholder="`Paste your ${destination} API key…`"
                :class="ui.inputSm(`min-w-0 flex-1`)"
                @keydown.enter="saveKey"
            />
            <Button label="Connect" size="small" :disabled="keyValue.trim().length === 0" :loading="accountBusy === provider" @click="saveKey" />
        </div>
        <div class="flex items-center gap-3">
            <a v-if="keyConsole" :class="ui.textAction(`text-2xs text-subtle`)" :href="keyConsole" target="_blank" rel="noopener">
                Get a key from {{ destination }}<Icon name="external-link" class="ml-1" />
            </a>
            <!-- Same fold as the native flows': a name is a rename, not a step, and leading with it would make
                 every connect look like a form to fill in before anything happens. It matters more here, though
                 — a pasted key carries no identity at all, so two of them are indistinguishable without one. -->
            <button v-if="!namingKey" type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="namingKey = true">Name this key…</button>
        </div>
        <input v-if="namingKey" v-model="keyLabel" name="keyLabel" placeholder="Key name" :class="ui.inputSm(`min-w-0`)" />
    </div>
    <div v-else-if="flow" class="flex flex-col gap-2.5">
        <!-- `self-start`: in a column the button would stretch edge to edge, which reads as a banner rather than
             as the first step of three. -->
        <Button as="a" class="self-start" size="small" :href="flow.url" target="_blank" rel="noopener" @click="wentToProvider = true">
            <ProviderLogo :provider="provider" />Open {{ destination }}<Icon name="external-link" />
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
        <template v-else>
            <!-- THE PAGE THEY ARE ABOUT TO MEET, drawn before they meet it. This is the step people abandon on:
                 the provider finishes on an address only the sandbox can serve, so the browser shows a plain
                 error and every instinct says the sign-in broke. A picture rather than a sentence because the
                 sentence is on the screen they are LEAVING: by the time it matters they are two tabs away
                 looking at the real thing, and what they need then is to RECOGNIZE it. Only for the redirect
                 that actually dead-ends; Anthropic's paste-back lands on a real page and needs none of this. -->
            <template v-if="kind === `routed`">
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
                            <span class="truncate font-mono text-[0.6rem] text-content">localhost:8317/?code=4/0AX4…</span>
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
        <template v-if="kind === `native`">
            <button v-if="!namingAccount" type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="namingAccount = true">
                Name this account…
            </button>
            <input v-else v-model="connectLabel" name="accountLabel" placeholder="Account name" :class="ui.inputSm(`min-w-0`)" />
        </template>
    </div>
</template>
