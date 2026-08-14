<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed } from "vue";
import { offerOnBoard } from "../composables/chat/connectOffer";
import { chatWide } from "../composables/chat/chatSurface";
import { useChat, usePaneView } from "../composables/chat/useChat";
import ConnectOffer from "./ConnectOffer.vue";

/* The connect gate above the composer: shown when THIS pane's conversation has a provider+harness selection
 * with nothing to send with. What it offers is the shared card (ConnectOffer), the same one the empty board
 * puts on its first screen — the gate and the screen a user just came from must make the identical offer.
 *
 * IT STANDS DOWN FOR THE BOARD. On a fresh workspace the empty board IS the offer, docked chat and all, so the
 * gate here would be the second copy of it on one screen — see connectOffer.ts. Only for the DOCKED panel on
 * desktop: a popped-out chat is its own window with no board in it, full-screen chat covers the board outright,
 * and mobile puts the two on separate screens — in all three the chat has to carry the offer itself. */

const view = usePaneView();
const { connected } = view;
// Whether the daemon has answered about connections AT ALL is the sandbox's fact, not this conversation's.
const { accountsLoaded, nativeConnectFlow, translatorConnectFlow } = useChat();
const { mobile } = useDevice();

const deferred = computed(() => offerOnBoard.value && !chatWide.value && !mobile.value);
// Whether the offer the board is showing has been taken and is mid-handshake — the one thing this panel can
// say about a card it deliberately isn't repeating.
const signingIn = computed(() => nativeConnectFlow.value !== undefined || translatorConnectFlow.value !== undefined);
</script>

<template>
    <!-- STANDING DOWN IS NOT THE SAME AS SAYING NOTHING, and it used to be. With the board carrying the offer,
         this panel rendered empty — and the composer below it is behind `connected` too, so the whole bottom
         half of a brand-new sandbox's chat was blank space under an empty transcript, with no word anywhere in
         the column about why there was nothing to type into. One quiet line, no pitch and no button: the offer
         is one column over and stays there, this only says what the column is waiting for. -->
    <p v-if="deferred && accountsLoaded && !connected" class="flex items-center justify-center gap-2 px-4 py-3 text-center text-2xs text-subtle">
        <Icon :name="signingIn ? `spinner` : `sparkles`" :spin="signingIn" class="shrink-0" />
        {{ signingIn ? `Finishing your sign-in — this chat comes alive as soon as it lands.` : `Waiting on an AI account — connect one to start.` }}
    </p>
    <template v-if="!deferred">
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
        <div v-else-if="!connected" class="rounded-2xl border border-line bg-overlay/40 px-4 py-7">
            <ConnectOffer :view="view" />
        </div>
    </template>
</template>
