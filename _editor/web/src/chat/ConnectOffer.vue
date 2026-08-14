<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { connectPitch, freeOffer, providerReadyOn } from "../composables/chat/access";
import { providerTabs } from "../composables/chat/providerCatalog";
import { useChat, type ConversationView } from "../composables/chat/useChat";
import ConnectFlow from "../pages/sandbox/ConnectFlow.vue";
import ProviderLogo from "./ProviderLogo.vue";

/* THE WAY IN, as one card — what a user with nothing connected is offered, wherever they meet it. Two surfaces
 * show it and they must show the identical thing: the connect gate above the composer (ChatAccountPanel), and
 * the empty board's first screen, which is where a fresh workspace actually lands. A second copy of this
 * argument would drift from the first the day either one is edited.
 *
 * IT LEADS WITH THE FREE CHANNEL, and that ordering is the card's main job rather than a decoration. It used to
 * answer for whichever provider the pane happened to be pointed at — in practice a paid one — with the single
 * channel that costs nothing sitting fifth in a row of five identical buttons. The honest reading of that
 * screen is "this product needs a subscription", which is false. So the free offer is the headline and the
 * primary button, and the subscriptions become a quiet second row that still says exactly what it said before
 * once one is picked.
 *
 * AND THE SIGN-IN HAPPENS HERE. Pressing the button used to push the router at the Agent settings tab, carrying
 * the picked provider in the query — which meant the one action a brand-new sandbox exists to offer answered by
 * throwing the user into a page of a dozen settings they had not asked for, ringing one row to point at itself,
 * and asking them to press a SECOND button for the thing they had already asked for. It then left them there:
 * nothing brought them back, so a sign-in that worked ended on a settings page with no sign of the board they
 * came from. The handshake unfolds in this card instead (ConnectFlow, the same panel that settings row uses),
 * and finishing it simply makes this card stop being true — the board behind it goes back to asking for a task
 * and the chat one column over comes alive. There is no "back" to press because nothing went anywhere.
 *
 * `prominent` is the board's copy: this is the whole screen there, and a small card politely offering the only
 * thing that can happen next reads as an aside. In the docked gate it stays the size of the panel it sits in.
 *
 * The conversation it acts on is handed in rather than injected: above a composer that is the pane's own chat,
 * and on the board it is the focused one — the chat the user will type into the moment this card is answered. */

const { view, prominent = false } = defineProps<{
    view: Pick<ConversationView, "provider" | "harness" | "selectProvider">;
    prominent?: boolean;
}>();

const provider = computed(() => view.provider.value);
const harness = computed(() => view.harness.value);

const router = useRouter();
const {
    setManagedProvider,
    startConnect,
    connectTranslator,
    nativeConnectFlow,
    translatorConnectFlow,
    cancelConnect,
    cancelTranslatorConnect,
    accountBusy,
    translatorKey,
} = useChat();

const pitch = computed(() => connectPitch(provider.value, harness.value));
const free = computed(() => freeOffer());

/* The sign-in this card is currently showing, whichever mechanism it runs on — and it reads the store rather
 * than remembering what was pressed, so a handshake started on the settings tab and then navigated away from
 * is still THIS card's to finish rather than a second one the user has to go back for. One at a time is the
 * store's own rule (a new connect supersedes a prior one), so there is never a choice to make here. */
const live = computed<{ kind: `native` | `routed`; provider: AgentProvider } | undefined>(() => {
    if (nativeConnectFlow.value !== undefined) {
        return { kind: `native`, provider: nativeConnectFlow.value.provider };
    }
    if (translatorConnectFlow.value !== undefined) {
        return { kind: `routed`, provider: translatorConnectFlow.value.provider };
    }
    return undefined;
});
const liveLabel = computed(() => providerTabs.find((tab) => tab.value === live.value?.provider)?.label ?? live.value?.provider);
const abandon = (): void => (live.value?.kind === `native` ? cancelConnect() : cancelTranslatorConnect());

/* The second row is everything the headline isn't, each chip carrying the two things its press turns on:
 * whether THIS chat could already send on that subscription, and the sentence saying what pressing will do.
 * Derived from the same tab list rather than a second literal, so it keeps the tabs' order and inherits a
 * provider added there.
 *
 * `ready` is asked of the provider AND the harness, not of the provider alone, because they disagree for Grok —
 * a SuperGrok subscription runs it under Claude Code and not natively. A chip promising a subscription is
 * connected, pressed, and leaving this gate exactly as it was is worse than no chip at all. */
const subscriptions = computed(() =>
    providerTabs
        .filter((tab) => tab.value !== free.value?.provider)
        .map(({ value, label }) => {
            const ready = providerReadyOn(value, harness.value);
            return {
                value,
                label,
                ready,
                hint: ready ? `Connected — switch this chat to ${label}` : (connectPitch(value, harness.value)?.action ?? `Connect`),
            };
        }),
);

/* Point the chat at a provider AND start its sign-in, right here. The provider is set on the account card too
 * (setManagedProvider), because that card is where the connection will show up afterwards and the two must not
 * disagree about which provider was just connected. Which mechanism runs is the daemon's own split, mirrored:
 * ChatGPT, Kimi and Google authenticate through the bundled translator, everything else through a
 * daemon-stored account of the provider's own. */
const connect = (target: AgentProvider): void => {
    view.selectProvider(target);
    setManagedProvider(target);
    if (target === `codex` || target === `kimi` || target === `gemini`) {
        void connectTranslator(target);
        return;
    }
    void startConnect();
};

// Whether a press on this provider has been made and not yet answered — the button acknowledges in place
// rather than by something appearing a round-trip later. Both keys, because which one a provider's sign-in
// spins under is exactly the split `connect` just made.
const starting = (target: AgentProvider): boolean => accountBusy.value === target || accountBusy.value === translatorKey(target);

/* ONE PRESS, whichever kind of chip it is. A subscription you already hold only needs selecting — the gate then
 * disappears on its own, which is the fastest path there is — and one you don't hold starts its sign-in here.
 * It used to take two: the chip selected, and a separate button underneath then repeated the provider you had
 * just pressed and did the actual work. Nothing announced that the chip was step one, so the row read as a set
 * of buttons that do nothing.
 *
 * Which of the two a press will do is not left to be discovered: the connected chips carry a dot, and every
 * chip says it outright on hover and to a screen reader. */
const pick = (target: AgentProvider, ready: boolean) => (ready ? view.selectProvider(target) : connect(target));
</script>

<template>
    <!-- THE SIGN-IN, once one is running: it takes the whole card, because a card still arguing "try free with
         Google" over a live Google handshake is arguing with its own state. Abandoning it puts the offer back —
         the only reason this needs a control of its own, and why it is the quiet tier. -->
    <div v-if="live" class="flex flex-col gap-3" :class="prominent ? `` : `text-left`">
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="live.provider" class="shrink-0 text-link" />
            <span class="min-w-0 flex-1 truncate text-left font-medium text-body" :class="prominent ? `text-sm` : `text-xs`">
                Connecting {{ liveLabel }}
            </span>
            <button type="button" :class="cmp.linkButton(`shrink-0 text-2xs text-subtle hover:text-content hover:no-underline`)" @click="abandon">
                Cancel
            </button>
        </div>
        <ConnectFlow :kind="live.kind" :provider="live.provider" :prominent="prominent" />
    </div>

    <div v-else class="flex flex-col items-center gap-3 text-center">
        <!-- THE HEADLINE: the one way in that costs nothing. Absent only when there is no free channel left to
             offer, and then the card is exactly what it always was — the selected provider's own pitch.
             THE MARK GOES ON THE BUTTON, and it is the provider's own rather than a sparkle: this button leaves
             for Google, and the thing a user checks before following a sign-in anywhere is whose sign-in it is.
             Full width and full height when this card IS the screen — the action a first-time user has to find
             should not be the smallest thing on it, which is what a `small` button among two starter chips
             was. -->
        <template v-if="free">
            <p class="font-medium text-body" :class="prominent ? `text-base font-semibold text-content` : `text-sm`">{{ free.headline }}</p>
            <p class="text-muted" :class="prominent ? `text-xs` : `text-xs`">{{ free.copy }}</p>
            <Button
                :class="prominent ? `w-full` : ``"
                :size="prominent ? undefined : `small`"
                :loading="starting(free.provider)"
                @click="connect(free.provider)"
            >
                <ProviderLogo :provider="free.provider" />{{ free.action }}
            </Button>
        </template>
        <!-- An ACP agent carries its own credentials, so it never reaches this card and has no pitch to show. -->
        <p v-else-if="pitch" class="text-xs text-muted">{{ pitch.copy }}</p>

        <!-- The subscriptions, demoted but never hidden: a user who already pays for one must not have to read
             past a free pitch to find it, and picking one here re-points the chat immediately — which is the
             whole answer when that provider is already connected. -->
        <div class="flex w-full flex-col items-center gap-1.5 border-t border-line pt-3">
            <p v-if="free" class="text-2xs text-muted">Have a subscription?</p>
            <!-- Wraps rather than overflowing: this card also sits in a narrow side panel, where five tabs never fit on one row.
                 THE DOT IS THE ROW'S WHOLE POINT once the chips also connect: four identical names read as
                 "pick one to go and buy", when one of them may be a subscription the user already holds and one
                 press from clearing this gate. It marks the chips that only need selecting — so a dotless chip
                 is the one that will start a sign-in, which is what its hover and its accessible name say in
                 words for anyone the colour and the 6px circle don't reach. -->
            <div class="flex flex-wrap items-center justify-center gap-1">
                <button
                    v-for="tab in subscriptions"
                    :key="tab.value"
                    type="button"
                    class="composer-ghost h-7 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-2xs font-medium"
                    :class="{ 'composer-active': provider === tab.value }"
                    @click="pick(tab.value, tab.ready)"
                    :aria-pressed="provider === tab.value"
                    :aria-label="`${tab.label} — ${tab.hint}`"
                    v-tooltip.top="tab.hint"
                >
                    <Icon v-if="starting(tab.value)" name="spinner" spin class="shrink-0" />
                    <span v-else-if="tab.ready" class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"></span>{{ tab.label }}
                </button>
            </div>
            <!-- The door to everything this card deliberately doesn't carry — a second account, an account to
                 drop, the mechanics behind each row. It is a link rather than a button because it is a place,
                 and quiet because nobody arriving here for the first time needs it. -->
            <button type="button" :class="cmp.linkButton(`mt-1 text-2xs text-subtle hover:text-content`)" @click="router.push(`/sandbox/agent`)">
                All AI accounts
            </button>
        </div>
    </div>
</template>
