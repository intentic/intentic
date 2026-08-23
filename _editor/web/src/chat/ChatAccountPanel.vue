<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { type AgentProvider, PROVIDER_VENDOR } from "@intentic/sandbox-contract";
import { accessKnown, connectPitch, trialExhausted } from "../composables/chat/access";
import { providerDisplayLabel } from "../composables/chat/providerCatalog";
import { useChat, usePaneView } from "../composables/chat/useChat";
import ConnectFlow from "../pages/sandbox/ConnectFlow.vue";
import ChatChooseModelButton from "./ChatChooseModelButton.vue";
import ProviderLogo from "./ProviderLogo.vue";

/* THE ONE STRIP ABOVE THE COMPOSER WHEN THIS CHAT HAS NOTHING TO SEND WITH, and what it deliberately is not.
 *
 * IT USED TO BE A PITCH. This slot held a card headlined "Try free with Google", with the four subscriptions as
 * a second row and a door to the accounts page under them, and the empty agents board showed the identical card
 * at twice the size, with an arbitration flag between the two so they were never argued at once. A new user's
 * first screen was therefore a sign-in wall, immediately after they had signed in WITH GOOGLE, which reads as
 * either a failed sign-in or a product that needs a subscription. Both are false: the platform serves a free
 * trial, and the chat can answer a question before anything at all is connected.
 *
 * Worse, it was often a wall over nothing. The account reads land a beat before the endpoint reads, and the old
 * gate voted on the account half alone, so the wall was painted in the gap and taken back when the trial
 * arrived. `accessKnown` is that gap closed: both halves in, or this panel says only that it is still reading.
 *
 * SO THE OFFER MOVED TO WHERE THE CHOICE IS MADE. The model picker lists every provider with what each costs,
 * the cheapest access leading the locked band (modelPicker.pickerSections), which puts the free Google channel
 * at the top of the list a user opens when they want a different model, rather than in front of everyone who
 * ever signs in. This strip's job is only to say that this chat cannot send and to open that list.
 *
 * IT STILL CARRIES THE HANDSHAKE. Picking a locked model points the chat there, so the sign-in has to be
 * finishable from the chat it was started for, in place, rather than on a settings page the user has to find
 * their way back from. That is the ConnectFlow branch, and it takes the whole strip while it runs: a line
 * saying "not connected" over a live sign-in argues with its own state.
 *
 * AND IT DOES NOT SPEAK FOR THE SPENT TRIAL. "Cannot send" has two causes and this strip may only name one of
 * them. A trial whose daily allowance is used up IS connected, it is metered, and saying it isn't left the user
 * reading two strips that contradicted each other: "Free trial isn't connected in this sandbox" stacked on top
 * of "Free trial used up for today", one of which is a lie and the other of which is the answer. So the strip
 * stands down for that one state and the trial strip below (ChatPaneNotices) owns it alone, carrying this
 * strip's own door to the list along with the sign-in that has no daily cap. */

const view = usePaneView();
const { connected, provider, harness } = view;
// The one flavour of "cannot send" that is NOT a missing connection, so not this strip's to report.
const trialSpent = computed(() => trialExhausted(provider.value));
const { nativeConnectFlow, translatorConnectFlow, cancelConnect, cancelTranslatorConnect, setManagedProvider, startConnect, connectTranslator } =
    useChat();

/* The sign-in this strip is showing, whichever mechanism it runs on, read from the store rather than remembered
 * from what was pressed: a handshake started on the settings tab and then navigated away from is still this
 * chat's to finish. One at a time is the store's own rule, so there is never a choice to make here. */
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

/* What this chat is pointed at, named as the thing a person CONNECTS rather than as the runtime it drives. The
 * two differ for every native provider and the runtime is the wrong one in this sentence: "Claude Code isn't
 * connected" names a harness, while what is missing is a Claude account, and for Google it is worse still, the
 * runtime is Claude Code there too. An endpoint and an ACP agent have no vendor because they have no account to
 * connect, so their own display name is the only name they have.
 *
 * `pitch` is absent for exactly those two, for the same reason: they carry their own credentials, so there is
 * nothing to connect and no second control to draw. */
const providerName = computed(() => PROVIDER_VENDOR[provider.value as keyof typeof PROVIDER_VENDOR] ?? providerDisplayLabel(provider.value));
const pitch = computed(() => connectPitch(provider.value, harness.value));

/* Start the selected provider's sign-in, here. The provider is set on the account card too, because that card
 * is where the connection shows up afterwards and the two must not disagree about what was just connected.
 * Which mechanism runs is the daemon's own split, mirrored: ChatGPT, Kimi and Google authenticate through the
 * bundled translator, everything else through a daemon-stored account of the provider's own. */
const connect = async (): Promise<void> => {
    const target = provider.value;
    setManagedProvider(target);
    // Awaited so the button holds while the flow is being opened, rather than looking untouched.
    await (target === `codex` || target === `kimi` || target === `gemini` ? connectTranslator(target) : startConnect());
};
</script>

<template>
    <!-- STILL READING. "You have nothing connected" is a claim, and until both halves of the picture have
         landed it is one this panel may not make: it used to go up on every page load, in front of a user with
         a perfectly good subscription, for as long as the liveness probe and the tunnel round-trip took. One
         quiet line, no button to press on a question that isn't settled. -->
    <p v-if="!accessKnown" class="flex items-center justify-center gap-2 px-4 py-3 text-center text-2xs text-subtle">
        <Icon name="spinner" spin class="shrink-0" />Checking your AI accounts…
    </p>

    <!-- THE SIGN-IN, once one is running: it takes the whole strip, and Cancel is the only other control,
         because abandoning it is what puts the line below back. -->
    <div v-else-if="live" class="flex flex-col gap-2 rounded-2xl border border-line bg-overlay/40 px-4 py-3">
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="live.provider" class="shrink-0 text-link" />
            <span class="min-w-0 flex-1 truncate text-left text-xs font-medium text-body">Connecting {{ providerDisplayLabel(live.provider) }}</span>
            <button type="button" :class="ui.linkButton(`shrink-0 text-2xs text-subtle hover:text-content hover:no-underline`)" @click="abandon">
                Cancel
            </button>
        </div>
        <ConnectFlow :kind="live.kind" :provider="live.provider" />
    </div>

    <!-- NOTHING TO SEND WITH: one sentence naming what this chat is pointed at, and the list. The list leads
         because it is the answer that costs nothing to look at and holds every free option; the selected
         provider's own sign-in follows it, for the user who pointed the chat here on purpose. -->
    <div
        v-else-if="!connected && !trialSpent"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl border border-line bg-overlay/40 px-4 py-3 text-2xs text-muted"
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
