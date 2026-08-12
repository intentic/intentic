<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { connectPitch, freeOffer, providerReadyOn } from "../composables/chat/access";
import { providerTabs } from "../composables/chat/providerCatalog";
import { useChat, usePaneView } from "../composables/chat/useChat";

/* The connect gate above the composer: shown when THIS pane's conversation has a provider+harness selection
 * with nothing to send with. What it asks for comes from the shared access table (access.ts / PROVIDER_ACCESS),
 * the same one the model picker's locks and chips read — the gate and the lock a user just clicked past must
 * name the SAME credential, and they drifted when each surface carried its own copy. The "Connect" button
 * deep-links to the Sandbox ▸ Agent tab, where the handshake lives; the picked provider rides along as
 * `?connect=<provider>` so that tab opens on its card and flashes it into view.
 *
 * IT LEADS WITH THE FREE CHANNEL, and that ordering is the panel's main job rather than a decoration. This gate
 * is the first thing a user with no AI subscription meets, and it used to answer for whichever provider the pane
 * happened to be pointed at — in practice a paid one — with the single channel that costs nothing sitting fifth
 * in a row of five identical buttons. The honest reading of that screen is "this product needs a subscription",
 * which is false. So the free offer is the headline and the primary button, and the subscriptions become a
 * quiet second row that still says exactly what it said before once one is picked. */

const { connected, provider, harness, selectProvider } = usePaneView();
// Whether the daemon has answered about connections AT ALL is the sandbox's fact, not this conversation's.
const { accountsLoaded } = useChat();
const router = useRouter();

const pitch = computed(() => connectPitch(provider.value, harness.value));
const free = computed(() => freeOffer());

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

/* Point the chat at a provider AND open its card — the free headline's button, and every chip that isn't
 * connected yet. */
const connect = (target: AgentProvider) => {
    selectProvider(target);
    router.push({ path: `/sandbox/agent`, query: { connect: target } });
};

/* ONE PRESS, whichever kind of chip it is. A subscription you already hold only needs selecting — the gate then
 * disappears on its own, which is the fastest path there is — and one you don't hold goes straight to where it
 * gets connected. It used to take two: the chip selected, and a separate button underneath then repeated the
 * provider you had just pressed and did the actual work. Nothing announced that the chip was step one, so the
 * row read as a set of buttons that do nothing.
 *
 * Which of the two a press will do is not left to be discovered: the connected chips carry a dot, and every
 * chip says it outright on hover and to a screen reader. */
const pick = (target: AgentProvider, ready: boolean) => (ready ? selectProvider(target) : connect(target));
</script>

<template>
    <!-- "Nothing is connected" is a claim, and until the daemon has answered it is one we can't make: this gate
         used to go up on every page load, in front of a user with a perfectly good subscription, for as long as
         the liveness probe and the tunnel round-trip took. While the connections are still being read the panel
         says only that — one quiet line, no pitch, no button to press on a question that isn't settled. -->
    <div
        v-if="!accountsLoaded"
        class="flex items-center justify-center gap-2 rounded-2xl border border-line bg-overlay/40 px-4 py-5 text-center text-xs text-muted"
    >
        <Icon name="spinner" spin />Checking your AI accounts…
    </div>
    <div v-else-if="!connected" class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-7 text-center">
        <!-- THE HEADLINE: the one way in that costs nothing. Absent only when there is no free channel left to
             offer, and then the panel is exactly what it always was — the selected provider's own pitch.
             ONE SPARKLE, and it sits on the button. There was a second one floating above the headline, two
             lines from the identical glyph inside the primary action — decoration that reads as a state marker
             at a glance and then turns out to mean nothing. The one on the button is the one that earns its
             place: it marks the ACTION as the free way in, which is the single thing this panel is arguing. -->
        <template v-if="free">
            <p class="text-sm font-medium text-body">{{ free.headline }}</p>
            <p class="text-xs text-muted">{{ free.copy }}</p>
            <Button :label="free.action" size="small" @click="connect(free.provider)">
                <template #icon><Icon name="sparkles" /></template>
            </Button>
        </template>
        <!-- An ACP agent carries its own credentials, so it never reaches this gate and has no pitch to show. -->
        <p v-else-if="pitch" class="text-xs text-muted">{{ pitch.copy }}</p>

        <!-- The subscriptions, demoted but never hidden: a user who already pays for one must not have to read
             past a free pitch to find it, and picking one here re-points this chat immediately — which is the
             whole answer when that provider is already connected. -->
        <div class="flex w-full flex-col items-center gap-1.5 border-t border-line pt-3">
            <p v-if="free" class="text-2xs text-muted">Have a subscription?</p>
            <!-- Wraps rather than overflowing: the gate sits in a narrow side panel, where five tabs never fit on one row.
                 THE DOT IS THE ROW'S WHOLE POINT once the chips also connect: four identical names read as
                 "pick one to go and buy", when one of them may be a subscription the user already holds and one
                 press from clearing this gate. It marks the chips that only need selecting — so a dotless chip
                 is the one that will take you off to connect it, which is what its hover and its accessible
                 name say in words for anyone the colour and the 6px circle don't reach. -->
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
                    <span v-if="tab.ready" class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"></span>{{ tab.label }}
                </button>
            </div>
        </div>
    </div>
</template>
