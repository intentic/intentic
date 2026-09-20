<script setup lang="ts">
import {
    type AgentProvider,
    type KeyedProvider,
    mintedVariants,
    type NativeProvider,
    providerSpec,
    TRANSLATOR_PROVIDERS,
} from "@intentic/sandbox-contract";
import { Button, Icon, Page, PageHeader, SegmentedControl, ui } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { defaultModelFor, endpointProviders } from "../chat/accounts/providerCatalog";
import { refreshConnections } from "../chat/accounts/useChat-accounts";
import { accessKnown, accessStateFor, providerReady } from "../chat/session/access";
import { rememberPick } from "../chat/run/turnDefaults";
import { useChat } from "../chat/run/useChat";
import ConnectFlow from "../sandbox/secrets/ConnectFlow.vue";
import { localPrefetchStopped } from "./connectIntro";
import { type ConnectLaneKey, firstUnmetLane, laneOfProvider, laneProviders } from "./connectLanes";
import ConnectLane from "./ConnectLane.vue";
import LocalModelLane from "./LocalModelLane.vue";
import ProviderTile from "./ProviderTile.vue";
import { useLocalModelFit } from "./useLocalModelFit";
import { useT } from "@intentic/ui/i18n";

// The one place a first model is connected. Everything that used to offer a sign-in somewhere else — a strip over the
// composer, a link in the model picker, a settings page that auto-started a handshake on arrival — sends the reader
// here instead, because the decision (which of three ways in) was being made in surfaces built to report state, not to
// hold a choice.
//
// Three lanes, in cost order, one open at a time. The Agent tab keeps managing accounts; this view makes the first one.

const t = useT();
const route = useRoute();
const router = useRouter();

const {
    nativeConnectFlow,
    translatorConnectFlow,
    accountBusy,
    translatorKey,
    cancelConnect,
    cancelTranslatorConnect,
    setManagedProvider,
    startConnect,
    connectTranslator,
} = useChat();

const { fit, startPrefetch, stopPrefetch } = useLocalModelFit();

// A local model is a capability, not an account, so readiness is "is one installed", which the provider list already
// answers.
const localReady = computed(() => endpointProviders.value.some((endpoint) => endpoint.kind === `localmodel`));

// The weights that make the local lane instant, fetched while the reader is still reading the page — but only where
// they could be used at all, and only if nobody has already declined them. A gigabyte started on a machine that cannot
// serve it, or one whose owner pressed Stop last time, is bandwidth spent on nothing.
// Asked at most once per visit: the start's own answer lands back in `fit`, so a daemon that answers anything but
// "downloading" would otherwise have this watcher ask it again forever.
let prefetchAsked = false;
watch(
    fit,
    (measured) => {
        if (
            !prefetchAsked &&
            measured !== undefined &&
            measured.serverReady &&
            measured.instant !== undefined &&
            measured.prefetch.state === `idle` &&
            !localPrefetchStopped.value &&
            !localReady.value
        ) {
            prefetchAsked = true;
            void startPrefetch();
        }
    },
    { immediate: true },
);

// A stop is a decision, not a pause: remembered, so re-opening this view does not begin it again.
const stopFetching = (): void => {
    localPrefetchStopped.value = true;
    void stopPrefetch();
};

// Which lane is open. `undefined` before the connection lists land: opening a lane against an unread list would open
// the wrong one and then move under the reader.
const openLane = ref<ConnectLaneKey | undefined>(undefined);
const toggleLane = (key: ConnectLaneKey): void => {
    openLane.value = openLane.value === key ? undefined : key;
};

// `?provider=` continues a press made elsewhere (a picker row, a trial strip): open its lane and start its handshake.
// Anything else opens the first lane with nothing in it.
const settleLane = (): void => {
    if (!accessKnown.value || openLane.value !== undefined) {
        return;
    }
    const asked = String(route.query[`provider`] ?? ``);
    const lane = laneOfProvider(asked);
    // A broken credential is asked for the same way a missing one is: the reader pressed "reconnect", and making them
    // press a tile again would be asking twice. A provider that is simply already connected is a stale link, not a
    // request, so it opens its lane without starting anything.
    if (lane !== undefined) {
        openLane.value = lane;
        if (!providerReady(asked) || accessStateFor(asked).needsReauth) {
            void connect(asked as NativeProvider);
        }
        return;
    }
    openLane.value = firstUnmetLane(providerReady, localReady.value);
};

// The live handshake, wherever it was started: read from the store so a sign-in begun here and finished after a reload
// still lands.
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
// What was brought back is being redeemed: there is nothing left to abandon.
const finishing = computed(
    () => live.value !== undefined && accountBusy.value === (live.value.kind === `native` ? live.value.provider : translatorKey(live.value.provider)),
);

// WHICH ESTATE, the only provider fact asked before a sign-in starts (a vendor can sell one product through separate
// estates whose keys are not interchangeable). Reset whenever the chosen provider changes.
const estate = ref<string | undefined>(undefined);
const chosen = ref<NativeProvider | undefined>(undefined);
const estates = computed(() => (chosen.value === undefined ? [] : (mintedVariants(chosen.value) ?? [])));
const chosenEstate = computed<string>({
    get: () => estate.value ?? estates.value[0]?.id ?? ``,
    set: (value) => {
        estate.value = value;
    },
});

// Which mechanism runs mirrors the daemon's own split: the translator holds a subscription OAuth for ChatGPT/Kimi/
// Google, a stored account serves everything else. Read off the provider table's own `auth.kind`, never a name list.
const routed = (provider: NativeProvider): provider is KeyedProvider => (TRANSLATOR_PROVIDERS as readonly string[]).includes(provider);

// `estate` is blank where no choice is offered, and the daemon reads blank as "take the default".
const startNative = (): Promise<void> => startConnect(chosenEstate.value === `` ? undefined : chosenEstate.value);

const connect = async (provider: NativeProvider): Promise<void> => {
    chosen.value = provider;
    estate.value = undefined;
    setManagedProvider(provider);
    await (routed(provider) ? connectTranslator(provider) : startNative());
};

// Restarting a sign-in for a provider whose estate was just changed; the panel above is replaced by the new handshake.
const connectChosen = (): void => {
    const provider = chosen.value;
    if (provider !== undefined) {
        void (routed(provider) ? connectTranslator(provider) : startNative());
    }
};

// Landing on a connection is a state, not a redirect: the lane says who it signed in as and offers the one next move.
const landed = ref<AgentProvider | undefined>(undefined);
// A provider that became ready while this view was open is the thing that just happened, whichever lane did it.
watch(
    () => (chosen.value === undefined ? false : providerReady(chosen.value)),
    (ready) => {
        if (ready && chosen.value !== undefined) {
            landed.value = chosen.value;
        }
    },
);
const onLocalAdded = (provider: string): void => {
    landed.value = provider;
};

// Points the next conversation at what was just connected and goes there: the whole errand ends in a chat, not on a
// settings page.
const startChatting = (): void => {
    const provider = landed.value;
    if (provider !== undefined) {
        rememberPick({ provider, value: defaultModelFor(provider) });
    }
    void router.push(`/chat`);
};

// Spelled out rather than built from the lane key: a composed `t()` path is invisible to the catalog check, and a
// missing one renders as its own dotted path in front of a reader.
const LANES = computed(() => [
    { key: `free` as const, icon: `sparkles` as const, title: t(`connect.connect.freeTitle`), subtitle: t(`connect.connect.freeSubtitle`), free: true },
    { key: `local` as const, icon: `cpu` as const, title: t(`connect.connect.localTitle`), subtitle: t(`connect.connect.localSubtitle`), free: true },
    {
        key: `subscription` as const,
        icon: `key` as const,
        title: t(`connect.connect.subscriptionTitle`),
        subtitle: t(`connect.connect.subscriptionSubtitle`),
        free: false,
    },
]);

// What a shut lane is already holding, named rather than ticked: a green check over "A subscription you already pay
// for" says something is connected and not which, which is the one thing a reader of a closed lane wants.
const laneHolds = (key: ConnectLaneKey): string | undefined => {
    if (key === `local`) {
        const model = endpointProviders.value.find((endpoint) => endpoint.kind === `localmodel`);
        return model?.label;
    }
    const ready = laneProviders(key, providerReady).filter((provider) => providerReady(provider));
    return ready.length === 0 ? undefined : ready.map((provider) => providerSpec(provider)?.accountLabel ?? provider).join(`, `);
};

const laneDone = (key: ConnectLaneKey): boolean =>
    key === `local` ? localReady.value : laneProviders(key, providerReady).some((provider) => providerReady(provider));

onMounted(() => {
    // Fetched on open rather than waiting for the reachable seam, which lags a probe plus a tunnel round-trip.
    void refreshConnections();
    settleLane();
});
watch([accessKnown, () => route.query[`provider`]], settleLane);
</script>

<template>
    <Page width="content">
        <PageHeader :title="t(`connect.connect.title`)" :description="t(`connect.connect.description`)" />

        <!-- The one thing that just happened, above the lanes that are still offering to do it again. -->
        <div v-if="landed" class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3">
            <Icon name="check" class="shrink-0 text-success" />
            <span class="min-w-0 flex-1 text-sm text-content">{{ t(`connect.connect.landed`) }}</span>
            <Button :label="t(`connect.connect.startChatting`)" @click="startChatting" />
        </div>

        <div class="flex flex-col gap-3">
            <ConnectLane
                v-for="lane in LANES"
                :key="lane.key"
                :icon="lane.icon"
                :title="lane.title"
                :subtitle="lane.subtitle"
                :open="openLane === lane.key"
                :done="laneDone(lane.key)"
                @toggle="toggleLane(lane.key)"
            >
                <template #badge>
                    <!-- What is in it wins over what it costs: a lane already holding something is past the price. -->
                    <span v-if="laneHolds(lane.key)" class="shrink-0 truncate text-2xs text-success">{{ laneHolds(lane.key) }}</span>
                    <span
                        v-else-if="lane.free"
                        class="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-success"
                        >{{ t(`connect.connect.free`) }}</span
                    >
                </template>

                <LocalModelLane v-if="lane.key === `local`" :fit="fit" @added="onLocalAdded" @stop-prefetch="stopFetching" />

                <div v-else class="flex flex-col gap-3">
                    <!-- The sign-in takes the whole lane once running: while it is the reader's turn, nothing else here is. -->
                    <template v-if="live && laneOfProvider(live.provider) === lane.key">
                        <div class="flex items-center gap-2">
                            <span class="min-w-0 flex-1 text-sm font-medium text-content">{{
                                t(`connect.connect.connecting`, { provider: providerSpec(live.provider)?.accountLabel })
                            }}</span>
                            <button
                                type="button"
                                :disabled="finishing"
                                :class="ui.linkButton(`shrink-0 text-xs text-subtle hover:text-content hover:no-underline`)"
                                @click="abandon"
                            >
                                {{ t(`ui.action.cancel`) }}
                            </button>
                        </div>
                        <ConnectFlow :kind="live.kind" :provider="live.provider" roomy />
                    </template>

                    <template v-else>
                        <ProviderTile
                            v-for="provider in laneProviders(lane.key, providerReady)"
                            :key="provider"
                            :provider="provider"
                            :selected="chosen === provider"
                            @click="connect(provider)"
                        />
                        <!-- Estate is the sign-in's own first step, so it stands where the sign-in will unfold, not in a settings page. -->
                        <div v-if="estates.length > 1" class="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-3">
                            <span class="text-xs text-muted">{{ t(`connect.connect.whichPlan`) }}</span>
                            <SegmentedControl
                                v-model="chosenEstate"
                                size="xs"
                                wrap
                                :options="estates.map((variant) => ({ label: variant.label, value: variant.id }))"
                                :aria-label="t(`connect.connect.whichPlan`)"
                            />
                            <Button class="self-start" size="small" :label="t(`ui.action.connect`)" @click="connectChosen" />
                        </div>
                    </template>
                </div>
            </ConnectLane>
        </div>

        <!-- The power path, named once and sent sideways: somebody already running a server does not need a tour. -->
        <RouterLink to="/capabilities/endpoint" :class="ui.linkButton(`mt-4 text-xs`)">
            {{ t(`connect.connect.ownServer`) }}<Icon name="arrow-right" class="text-2xs" />
        </RouterLink>

        <!-- Managing what is already here is a different job from making the first connection, and keeps its own page. -->
        <RouterLink to="/sandbox/agent" :class="ui.textAction(`mt-1 text-xs`)">
            {{ t(`connect.connect.allAccounts`) }}
        </RouterLink>
    </Page>
</template>
