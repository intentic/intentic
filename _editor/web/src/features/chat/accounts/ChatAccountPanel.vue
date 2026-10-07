<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { PROVIDER_VENDOR } from "@intentic/sandbox-contract";
import { accessKnown, trialExhausted } from "../session/access";
import { providerDisplayLabel } from "./providerCatalog";
import { turnDefaults } from "../run/turnDefaults";
import { useChat } from "../run/useChat";
import { usePaneView } from "../panel/useChat-view";
import ChatChooseModelButton from "../models/ChatChooseModelButton.vue";
import { useT } from "@intentic/ui/i18n";

// The one line above the composer when this chat has nothing to send with. It sits beside a composer that stands
// whatever it says — it never replaced the box and never pitches a subscription unasked. Silent until `accessKnown`
// (both accounts and endpoints): a spinner over a usable composer is noise, and "not connected" is not a claim an
// unanswered read can make. Stands down for a spent trial, which is connected but metered out.
//
// It does NOT host a sign-in. A handshake is two steps with a trip to another tab between them, and eighty pixels over
// a composer is not where that belongs; /connect owns it, and this strip's job is to point at it — including when a
// sign-in started there is still waiting to be finished, or ended without connecting anything. Either way it can be put
// down from here: a reader who changed their mind should not have to go to /connect only to press Cancel.

const t = useT();

const view = usePaneView();
const { connected, provider } = view;
// Cannot-send from a spent trial is not a missing connection; not this strip's to report.
const trialSpent = computed(() => trialExhausted(provider.value));
const { liveSignIn: live, cancelSignIn, signInFailure: failure, dismissSignInFailure } = useChat();

// The way back to a sign-in that ended badly starts it again: /connect starts a provider's sign-in when a link names
// one that is not connected yet (linkArrival).
const retryTo = computed(() => (failure.value === undefined ? `/connect` : `/connect?provider=${encodeURIComponent(failure.value.provider)}`));

// Whether a vendor may be named at all: only a provider the owner actually chose. With nothing stored this chat is
// sitting on a floor the app picked (turnDefaults.ts), and naming it would tell a first-run reader that some
// particular vendor is missing from a sandbox where they never asked for one — the app is not any vendor's.
const chosen = computed(() => turnDefaults.provider.value === provider.value);
const providerName = computed(() => PROVIDER_VENDOR[provider.value as keyof typeof PROVIDER_VENDOR] ?? providerDisplayLabel(provider.value));
</script>

<template>
    <!-- A sign-in already under way, wherever it was started: back to where it can be finished, or put down from here. -->
    <div
        v-if="accessKnown && live"
        role="status"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted"
    >
        <!-- Not a spinner: nothing is loading, the next move is the reader's. -->
        <Icon name="clock" class="shrink-0 text-link" />
        <span class="min-w-0 flex-1 text-left">{{
            t(`chat.chatAccountPanel.signInWaiting`, { provider: providerDisplayLabel(live.provider) })
        }}</span>
        <span class="flex shrink-0 items-center gap-3">
            <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="cancelSignIn">
                {{ t(`ui.action.cancel`) }}
            </button>
            <RouterLink to="/connect" :class="ui.linkButton(`text-2xs font-semibold`)">
                {{ t(`chat.chatAccountPanel.finishSignIn`) }}
            </RouterLink>
        </span>
    </div>

    <!-- A sign-in that ended without connecting anything says so once, here as on /connect, until tried again or put away. -->
    <div
        v-else-if="accessKnown && failure"
        role="alert"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted"
    >
        <Icon name="exclamation-circle" class="shrink-0 text-danger" />
        <!-- Named first: the daemon's own sentence after it does not always say which provider it was about. -->
        <span class="min-w-0 flex-1 text-left"
            ><span class="font-medium text-content">{{
                t(`chat.chatAccountPanel.didntConnect`, { provider: providerDisplayLabel(failure.provider) })
            }}</span>
            {{ failure.message }}</span
        >
        <span class="flex shrink-0 items-center gap-3">
            <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="dismissSignInFailure">
                {{ t(`ui.action.dismiss`) }}
            </button>
            <RouterLink :to="retryTo" :class="ui.linkButton(`text-2xs font-semibold`)">
                {{ t(`ui.action.tryAgain`) }}
            </RouterLink>
        </span>
    </div>

    <!-- The model list leads (free to look at, holds every option, costs nothing to open); connecting one follows it. -->
    <div
        v-else-if="accessKnown && !connected && !trialSpent"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted"
    >
        <Icon name="th-large" class="shrink-0 text-subtle" />
        <span class="min-w-0 flex-1 text-left">{{
            chosen ? t(`chat.chatAccountPanel.isntConnectedInSandbox`, { providerName }) : t(`chat.chatAccountPanel.noModelYet`)
        }}</span>
        <ChatChooseModelButton />
        <RouterLink to="/connect" :class="ui.linkButton(`shrink-0 text-2xs text-subtle hover:text-content hover:no-underline`)">
            {{ t(`chat.words.connectAModel`) }}
        </RouterLink>
    </div>
</template>
