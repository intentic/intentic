<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { computed, inject, ref } from "vue";
import { RouterLink } from "vue-router";
import { PROVIDER_VENDOR } from "@intentic/sandbox-contract/models/agent-catalog";
import { accessKnown, anyProviderReady, hasSignIn, trialExhausted } from "../../../models/providers/access";
import { providerWithheld } from "../../../models/providers/aiReach";
import AccessAsk from "../../../components/access/AccessAsk.vue";
import { providerDisplayLabel } from "../../../models/providers/providerCatalog";
import { turnDefaults } from "../../../models/conversations/run/turnDefaults";
import { useChat } from "../../../models/conversations/run/useChat";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import ChatChooseModelButton from "../models/ChatChooseModelButton.vue";
import { useRole } from "../../../client/sandbox/useRole";
import { MODELS_PATH, modelsHref } from "../../../lib/routes/modelsPath";
import { useT } from "@intentic/ui/i18n";
import { ACCOUNT_NUDGE } from "./accountNudge";

// The one line above the composer when this chat has nothing to send with. It sits beside a composer that stands
// whatever it says — it never replaced the box and never pitches a subscription unasked. Silent until `accessKnown`
// (both accounts and endpoints): a spinner over a usable composer is noise, and "not connected" is not a claim an
// unanswered read can make. Stands down for a spent trial, which is connected but metered out.
//
// ONE WAY ON, AND IT IS THIS LINE'S PRESS (2026-10-25). It used to lead with "Choose a model" beside a "Connect a model"
// link, while the composer's pill read "Choose a model" and Send opened the same list: four doors, three to a list whose
// every row was locked. A reader with nothing connected cannot choose anything until something is connected, so that is
// the press: "Connect a model", or "Connect Claude" for a provider somebody picked. Only where something else here can
// run is another model the way on, and then the list leads and connecting this one follows. Send is disabled meanwhile
// and its Enter shakes this press (accountNudge.ts); the pill only states what the chat is on.
//
// It does NOT host a sign-in. A handshake is two steps with a trip to another tab between them, and eighty pixels over
// a composer is not where that belongs; Sandbox ▸ Models owns it, and this strip's job is to point at it — including when a
// sign-in started there is still waiting to be finished, or ended without connecting anything. Either way it can be put
// down from here: a reader who changed their mind should not have to go to Sandbox ▸ Models only to press Cancel.

const t = useT();

const view = usePaneView();
const { connected, provider } = view;
// Cannot-send from a spent trial is not a missing connection; not this strip's to report.
const trialSpent = computed(() => trialExhausted(provider.value));
const { liveSignIn: live, cancelSignIn, signInFailure: failure, dismissSignInFailure } = useChat();

// The way back to a sign-in that ended badly starts it again: Sandbox ▸ Models starts a provider's sign-in when a link
// names one that is not connected yet (linkArrival).
const retryTo = computed(() => modelsHref({ provider: failure.value?.provider }));

// Connecting is a maintainer's: the daemon refuses anyone else's sign-in, and the hub withholds the section that holds
// it. Below that tier the strip says who can, rather than offering a door that opens on nothing.
const { canShip } = useRole();

// Whether a vendor may be named at all: only a provider the owner actually chose. With nothing stored this chat is
// sitting on a floor the app picked (turnDefaults.ts), and naming it would tell a first-run reader that some
// particular vendor is missing from a sandbox where they never asked for one — the app is not any vendor's.
const chosen = computed(() => turnDefaults.provider.value === provider.value);
const providerName = computed(() => PROVIDER_VENDOR[provider.value as keyof typeof PROVIDER_VENDOR] ?? providerDisplayLabel(provider.value));

// Whether something else in this sandbox can run: then this chat's provider is named (it is a started chat's, or the
// reader's own pick; a fresh one on the app's floor would already have been moved onto what runs, useChat-accounts.ts)
// and another model is the way on.
const others = computed(() => anyProviderReady());
const named = computed(() => chosen.value || others.value);
// A named provider with a sign-in of its own is connected by name, on its own tile; anything else (nothing named, an
// endpoint like the trial) opens the page on the reader's choice.
const byName = computed(() => named.value && hasSignIn(provider.value));
const connectTo = computed(() => (byName.value ? modelsHref({ open: provider.value }) : MODELS_PATH));
const connectLabel = computed(() =>
    byName.value ? t(`chat.chatAccountPanel.connectProvider`, { providerName: providerName.value }) : t(`chat.words.connectAModel`),
);

// This chat sits on a provider the reader may not run (Access ▸ People): somebody else started it there, or the owner
// narrowed their AI accounts since. Connected, so "isn't connected" would be false and Connect no way on; the provider
// is named as the picker's lane names it, beside the one press that changes it: another model of theirs, or, with none,
// asking the owner.
const withheld = computed(() => providerWithheld(provider.value));

// Each press on a composer that cannot send shakes the way on, keyed so a second press shakes it again.
const nudge = inject(ACCOUNT_NUDGE, ref(0));
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
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="cancelSignIn">
                {{ t(`ui.action.cancel`) }}
            </button>
            <RouterLink :to="MODELS_PATH" :class="ui.textButton({ size: `xs` }, `font-semibold`)">
                {{ t(`chat.chatAccountPanel.finishSignIn`) }}
            </RouterLink>
        </span>
    </div>

    <!-- A sign-in that ended without connecting anything says so once, here as in Sandbox ▸ Models, until tried again or put away. -->
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
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="dismissSignInFailure">
                {{ t(`ui.action.dismiss`) }}
            </button>
            <RouterLink :to="retryTo" :class="ui.textButton({ size: `xs` }, `font-semibold`)">
                {{ t(`ui.action.tryAgain`) }}
            </RouterLink>
        </span>
    </div>

    <!-- On a model that isn't the reader's: another of theirs where they have one, else asking the owner for one. -->
    <div
        v-else-if="accessKnown && withheld"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted"
        data-account-gate
        data-account-withheld
    >
        <Icon name="lock" class="shrink-0 text-subtle" />
        <!-- Named as the chat's own provider where somebody chose it or a started chat sits on it; a first chat on the app's floor names no vendor. -->
        <span class="min-w-[12rem] flex-1 text-left">{{
            named ? t(`chat.chatAccountPanel.notShared`, { provider: providerDisplayLabel(provider) }) : t(`chat.modelPicker.nothingShared`)
        }}</span>
        <span class="flex shrink-0 items-center gap-3">
            <ChatChooseModelButton
                v-if="others"
                :key="`choose-${nudge}`"
                :label="t(`chat.chatAccountPanel.chooseAnother`)"
                tier="accent"
                :class="{ 'ui-shake': nudge > 0 }"
            />
            <span v-else :key="`ask-${nudge}`" class="inline-flex items-center gap-2" :class="{ 'ui-shake': nudge > 0 }">
                <AccessAsk :reason="{ kind: `ai-accounts` }" :place="t(`shared.chat`)" tier="accent" small />
            </span>
        </span>
    </div>

    <!-- Nothing to send with: the one press that changes that. Another model where something else runs; else connecting one. -->
    <div
        v-else-if="accessKnown && !connected && !trialSpent"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted"
        data-account-gate
    >
        <Icon name="th-large" class="shrink-0 text-subtle" />
        <span class="min-w-[12rem] flex-1 text-left">{{
            named ? t(`chat.chatAccountPanel.isntConnectedInSandbox`, { providerName }) : t(`chat.chatAccountPanel.noModelYet`)
        }}</span>
        <span class="flex shrink-0 items-center gap-3">
            <template v-if="others">
                <RouterLink v-if="canShip && byName" :to="connectTo" :class="ui.textButton({ size: `xs`, tone: `subtle` })">
                    {{ connectLabel }}
                </RouterLink>
                <ChatChooseModelButton
                    :key="`choose-${nudge}`"
                    :label="t(`chat.chatAccountPanel.chooseAnother`)"
                    tier="accent"
                    :class="{ 'ui-shake': nudge > 0 }"
                />
            </template>
            <!-- A real link, so hover shows where it goes and Ctrl/Cmd-click opens it elsewhere. On Home it opens in the chat's place (lib/routes/homeDetour.ts). -->
            <Button
                v-else-if="canShip"
                :key="`connect-${nudge}`"
                :as="RouterLink"
                :to="connectTo"
                size="small"
                tier="accent"
                :class="{ 'ui-shake': nudge > 0 }"
            >
                {{ connectLabel }}
            </Button>
            <span v-else class="text-2xs text-subtle">{{ t(`chat.chatAccountPanel.maintainerConnects`) }}</span>
        </span>
    </div>
</template>
