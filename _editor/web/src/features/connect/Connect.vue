<script setup lang="ts">
import {
    type AgentProvider,
    endpointProvider,
    type KeyedProvider,
    mintedVariants,
    type NativeProvider,
    type ProviderKey,
    ProviderKeysAppliedSchema,
    ProviderKeysSchema,
    providerSpec,
} from "@intentic/sandbox-contract";
import { Button, Icon, Notice, Page, PageHeader, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { defaultModelFor, endpointProviders } from "../chat/accounts/providerCatalog";
import { refreshConnections } from "../chat/accounts/useChat-accounts";
import { accessKnown, accessStateFor, providerReady } from "../chat/session/access";
import { rememberPick } from "../chat/run/turnDefaults";
import { useChat } from "../chat/run/useChat";
import ProviderLogo from "../chat/accounts/ProviderLogo.vue";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { useSandbox } from "../sandbox/client/useSandbox";
import { useRole } from "../sandbox/secrets/useRole";
import { foundToOffer } from "../../lib/foundOnComputer";
import ConnectFlow from "../sandbox/secrets/ConnectFlow.vue";
import EstatePicker from "../sandbox/secrets/EstatePicker.vue";
import { localPrefetchStopped } from "./localPrefetch";
import {
    arrivalLane,
    connectLane,
    type ConnectLaneKey,
    foundSignIns,
    justLanded,
    KEY_SOURCE_LABELS,
    landedLine,
    laneOfProvider,
    laneProviders,
    linkArrival,
    offeredKeys,
    type PickedStanding,
} from "./connectLanes";
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

// A local model is a capability, not an account: the local lane holds whichever one is installed.
const localModel = computed(() => endpointProviders.value.find((endpoint) => endpoint.kind === `localmodel`));

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
            localModel.value === undefined
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
// Anything else opens the free lane, and only for a reader who has connected nothing (arrivalLane).
const settleLane = (): void => {
    if (!accessKnown.value || openLane.value !== undefined) {
        return;
    }
    const asked = String(route.query[`provider`] ?? ``);
    // Only a provider with nothing connected starts its sign-in here (linkArrival); a connected one waits for its tile.
    const arrival = linkArrival(asked, providerReady);
    if (arrival !== undefined) {
        openLane.value = arrival.lane;
        if (arrival.signIn) {
            void connect(asked as NativeProvider);
        }
        return;
    }
    // What this computer is already signed in to is the thing to do here: nothing below opens over it.
    openLane.value = foundRows.value.length > 0 ? undefined : arrivalLane((key) => laneHolds(key) !== undefined);
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

// Which estate to sign in to (a vendor can sell one product through estates whose keys are not interchangeable).
const estate = ref<string | undefined>(undefined);
const chosen = ref<NativeProvider | undefined>(undefined);
const offersEstates = computed(() => (mintedVariants(chosen.value ?? ``)?.length ?? 0) > 1);

// The translator holds the subscription OAuth, a stored account serves everything else, as the daemon splits them.
const routed = (provider: NativeProvider): provider is KeyedProvider => providerSpec(provider)?.auth.kind === `translator`;

const startNative = (): Promise<void> => startConnect(estate.value);

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
// Named with the sandbox it went to: a connection lives in that sandbox alone (landedLine).
const { active: activeSandbox } = useSandbox();
// An endpoint made from a found key is named for its provider ("OpenRouter"); any other as the picker names it.
const keyEndpointLabels = new Map<AgentProvider, string>();
const landedLabel = (provider: AgentProvider): string =>
    providerSpec(provider)?.accountLabel ??
    keyEndpointLabels.get(provider) ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    provider;
const landedText = computed(() => (landed.value === undefined ? `` : landedLine(landedLabel(landed.value), activeSandbox.value?.name)));

// FOUND ON THIS COMPUTER (`?found=`, lib/foundOnComputer.ts): the providers the desktop app found signed in here, each one
// press. The press is the tile's own: its sign-in opens in the provider's lane below, where every sign-in on this view
// runs, and the browser that is already signed in answers it.
// What the address names, else what the desktop app said on an earlier address (a folder's own sandbox opens with no
// setup page in its way, and the reader may arrive here later, from the chat).
const found = computed(() => foundToOffer(route.query[`found`]));
const foundRows = computed(() => foundSignIns(found.value, providerReady));
const connectFound = (provider: NativeProvider): void => {
    openLane.value = laneOfProvider(provider);
    void connect(provider);
};

// And the API keys the owner's devices hold (the daemon's GET /arrivals/keys, migrations/provider-keys.ts): copied,
// unlike a sign-in, since a key is not bound to the install that holds it. Read once on open, and only by a tier that
// may connect things; a device asleep, or none at all, is an empty list.
const { canShip } = useRole();
const keys = ref<readonly ProviderKey[]>([]);
const addedHere = ref<ReadonlySet<string>>(new Set());
const keyRows = computed(() => offeredKeys(keys.value, addedHere.value));
const readKeys = async (): Promise<void> => {
    // allow(silent-catch): a list that could not be read offers nothing, which is what the section shows for none.
    keys.value = ProviderKeysSchema.parse(await sandboxJson(`/arrivals/keys`).catch(() => ({ keys: [] }))).keys;
};
const adding = ref<string | undefined>(undefined);
const { notice: keyNotice, run: runAddKey } = useAsyncAction();
const addKey = (key: ProviderKey): Promise<void> =>
    runAddKey(async () => {
        adding.value = key.id;
        try {
            const applied = ProviderKeysAppliedSchema.parse(
                await sandboxJson(`/arrivals/keys/apply`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ ids: [key.id] }),
                }),
            );
            const failure = applied.failed[0];
            if (failure !== undefined) {
                throw new Error(failure.error);
            }
            addedHere.value = new Set([...addedHere.value, key.id]);
            keys.value = keys.value.map((entry) => (entry.id === key.id ? { ...entry, added: true } : entry));
            // The picker reads endpoints off the connection list, which has never heard of this one.
            await refreshConnections();
            const capability = applied.added[0]?.capability;
            if (capability !== undefined) {
                keyEndpointLabels.set(endpointProvider(capability), key.label);
                landed.value = endpointProvider(capability);
            }
        } finally {
            adding.value = undefined;
        }
    }, t(`connect.connect.foundKeyFailed`));

// A provider that became ready while this view was open is the thing that just happened, whichever lane did it; one
// picked while already connected is a sign-in starting, and "Connected" above it would contradict it (justLanded).
watch(
    (): PickedStanding | undefined =>
        chosen.value === undefined ? undefined : { provider: chosen.value, settled: providerReady(chosen.value) && !accessStateFor(chosen.value).needsReauth },
    (now, before) => {
        const provider = justLanded(now, before);
        if (provider !== undefined) {
            landed.value = provider;
        }
    },
);
// Fires when the model is actually serving, not when its manifest entry was written: the picker reads endpoints from
// the connection list fetched on arrival, which has never heard of this one.
const onLocalReady = (provider: string): void => {
    landed.value = provider;
    void refreshConnections();
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
        return localModel.value?.label;
    }
    const ready = connectLane(key).providers.filter((provider) => providerReady(provider));
    return ready.length === 0 ? undefined : ready.map((provider) => providerSpec(provider)?.accountLabel ?? provider).join(`, `);
};

onMounted(() => {
    // Fetched on open rather than waiting for the reachable seam, which lags a probe plus a tunnel round-trip.
    void refreshConnections();
    settleLane();
    if (canShip.value) {
        void readKeys();
    }
});
watch([accessKnown, () => route.query[`provider`]], settleLane);
</script>

<template>
    <Page width="content">
        <PageHeader :title="t(`connect.connect.title`)" :description="t(`connect.connect.description`)" />

        <!-- The one thing that just happened, above the lanes that are still offering to do it again. -->
        <div v-if="landed" class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3">
            <Icon name="check" class="shrink-0 text-success" />
            <span class="min-w-0 flex-1 text-sm text-content">{{ landedText }}</span>
            <Button :label="t(`connect.connect.startChatting`)" @click="startChatting" />
        </div>

        <!-- What this computer already holds, above the ways in: the first thing to do when there is any of it. -->
        <section v-if="foundRows.length > 0 || keyRows.length > 0" class="ui-card mb-3 flex flex-col gap-3 p-4 sm:p-5">
            <h2 class="font-medium leading-tight">{{ t(`connect.connect.foundTitle`) }}</h2>
            <div v-for="provider in foundRows" :key="provider" class="flex items-center gap-3 rounded-xl border border-line bg-card p-3">
                <ProviderLogo :provider="provider" class="shrink-0 text-base text-muted" />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-sm font-medium text-content">{{ providerSpec(provider)?.accountLabel }}</span>
                    <span class="text-2xs text-muted">{{ t(`connect.connect.foundSignedIn`) }}</span>
                </span>
                <Button
                    size="small"
                    class="shrink-0"
                    :label="t(`ui.action.connect`)"
                    :loading="live?.provider === provider"
                    :disabled="live !== undefined"
                    @click="connectFound(provider)"
                />
            </div>
            <div v-for="key in keyRows" :key="key.id" class="flex items-center gap-3 rounded-xl border border-line bg-card p-3">
                <Icon name="key" class="shrink-0 text-base text-muted" />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-sm font-medium text-content">{{ t(`connect.connect.foundKeyTitle`, { provider: key.label }) }}</span>
                    <span class="text-2xs text-muted">{{ t(`connect.connect.foundKeyFrom`, { source: KEY_SOURCE_LABELS[key.source], hint: key.hint }) }}</span>
                </span>
                <span v-if="key.added" class="flex shrink-0 items-center gap-1 text-2xs text-success">
                    <Icon name="check" class="text-2xs" />{{ t(`connect.connect.foundKeyAdded`) }}
                </span>
                <Button
                    v-else
                    size="small"
                    class="shrink-0"
                    :label="t(`ui.action.add`)"
                    :loading="adding === key.id"
                    :disabled="adding !== undefined"
                    @click="addKey(key)"
                />
            </div>
            <Notice v-if="keyNotice" :of="keyNotice" />
        </section>

        <div class="flex flex-col gap-3">
            <ConnectLane
                v-for="lane in LANES"
                :key="lane.key"
                :icon="lane.icon"
                :title="lane.title"
                :subtitle="lane.subtitle"
                :open="openLane === lane.key"
                :done="laneHolds(lane.key) !== undefined"
                @toggle="toggleLane(lane.key)"
            >
                <template #badge>
                    <!-- What is in it wins over what it costs: a lane already holding something is past the price. -->
                    <span v-if="laneHolds(lane.key)" class="min-w-0 max-w-[40%] truncate text-2xs text-success">{{ laneHolds(lane.key) }}</span>
                    <span
                        v-else-if="lane.free"
                        class="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-success"
                        >{{ t(`connect.connect.free`) }}</span
                    >
                </template>

                <LocalModelLane v-if="lane.key === `local`" :fit="fit" @ready="onLocalReady" @stop-prefetch="stopFetching" />

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
                        <div v-if="chosen && offersEstates" class="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-3">
                            <span class="text-xs text-muted">{{ t(`connect.connect.whichPlan`) }}</span>
                            <EstatePicker v-model="estate" :provider="chosen" :label="t(`connect.connect.whichPlan`)" />
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
