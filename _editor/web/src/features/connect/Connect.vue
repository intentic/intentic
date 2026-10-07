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
import { Button, Icon, Notice, Page, PageHeader, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { defaultModelFor, endpointProviders } from "../chat/accounts/providerCatalog";
import { refreshConnections } from "../chat/accounts/useChat-accounts";
import { accessKnown, accessStateFor, providerReady } from "../chat/session/access";
import { rememberPick } from "../chat/run/turnDefaults";
import { useChat } from "../chat/run/useChat";
import ProviderLogo from "../chat/accounts/ProviderLogo.vue";
import { sandboxJson } from "../../client/sandbox/sandboxClient";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { foundToOffer } from "../../lib/foundOnComputer";
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
import ConnectAttempt from "./ConnectAttempt.vue";
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
//
// One sign-in at a time, and it has one place: the card at the top (ConnectAttempt), whichever lane or row started it.
// The lanes never give their tiles up to it, so trying a different provider is one press on its tile, which replaces
// the sign-in rather than queueing behind it. A reader sent back by the chat's "Finish sign-in" lands on that card, with
// the lane it came from open beneath it.

const t = useT();
const route = useRoute();
const router = useRouter();

const {
    liveSignIn: live,
    cancelSignIn,
    signInFailure,
    signInLanded,
    dismissSignInFailure,
    error,
    accountBusy,
    translatorKey,
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

// `?provider=` continues a press made elsewhere (a picker row, a trial strip, the chat's "Try again"): open its lane and
// start its handshake. A sign-in already under way, or one that just ended badly, is what any other visit is about: its
// lane opens under the card, so a different provider is one press away. Anything else opens the free lane, and only for
// a reader who has connected nothing (arrivalLane).
const settleLane = (): void => {
    if (!accessKnown.value || openLane.value !== undefined) {
        return;
    }
    const asked = String(route.query[`provider`] ?? ``);
    // Only a provider with nothing connected starts its sign-in here (linkArrival); a connected one waits for its tile.
    // One already signing in is not started over: the card above already holds it.
    const arrival = linkArrival(asked, providerReady);
    if (arrival !== undefined) {
        openLane.value = arrival.lane;
        if (arrival.signIn && live.value?.provider !== asked) {
            // SAFETY: linkArrival answers only for a provider some lane connects, and every lane's providers are native.
            void connect(asked as NativeProvider);
        }
        // Acted on once: a reload or a step back to this address must not start the sign-in a second time.
        void router.replace({ query: { ...route.query, provider: undefined } });
        return;
    }
    const current = live.value?.provider ?? signInFailure.value?.provider;
    const currentLane = current === undefined ? undefined : laneOfProvider(current);
    if (current !== undefined && currentLane !== undefined) {
        openLane.value = currentLane;
        // Picked, as far as this view is concerned: its landing is this visit's to announce.
        // SAFETY: laneOfProvider answered, so it is one of a lane's providers, which are all native.
        chosen.value ??= current as NativeProvider;
        return;
    }
    // What this computer is already signed in to is the thing to do here: nothing below opens over it.
    openLane.value = foundRows.value.length > 0 ? undefined : arrivalLane((key) => laneHolds(key) !== undefined);
};

// What was brought back is being redeemed: there is nothing left to abandon.
const finishing = computed(
    () => live.value !== undefined && accountBusy.value === (live.value.kind === `native` ? live.value.provider : translatorKey(live.value.provider)),
);

// Which estate to sign in to (a vendor can sell one product through estates whose keys are not interchangeable).
const estate = ref<string | undefined>(undefined);
const chosen = ref<NativeProvider | undefined>(undefined);
const offersEstates = computed(() => (mintedVariants(chosen.value ?? ``)?.length ?? 0) > 1);
// A provider sold through several estates asks which before its sign-in starts: started on the default and asked after,
// the question sat under a handshake already running against the wrong one.
const asksEstate = (provider: NativeProvider): boolean => (mintedVariants(provider)?.length ?? 0) > 1;

// The translator holds the subscription OAuth, a stored account serves everything else, as the daemon splits them.
const routed = (provider: NativeProvider): provider is KeyedProvider => providerSpec(provider)?.auth.kind === `translator`;

// The provider whose sign-in is on its way to the sandbox: the card says so from the press, rather than from whenever
// the sandbox answers.
const starting = ref<NativeProvider | undefined>(undefined);
const attemptCard = useTemplateRef<InstanceType<typeof ConnectAttempt>>(`attemptCard`);

const connect = async (provider: NativeProvider, variant?: string): Promise<void> => {
    if (starting.value !== undefined) {
        return;
    }
    chosen.value = provider;
    // A new attempt is the thing happening now; the last one's banner is over.
    landed.value = undefined;
    starting.value = provider;
    setManagedProvider(provider);
    await nextTick();
    void attemptCard.value?.reveal();
    try {
        await (routed(provider) ? connectTranslator(provider) : startConnect(variant));
    } finally {
        starting.value = undefined;
    }
};

// A tile's press: the sign-in already running for it is shown rather than started over; a provider with estates asks
// which first (below the tiles); any other starts, replacing whatever sign-in was running.
const pick = (provider: NativeProvider): void => {
    if (live.value?.provider === provider) {
        void attemptCard.value?.reveal();
        return;
    }
    if (asksEstate(provider)) {
        if (chosen.value !== provider) {
            estate.value = undefined;
        }
        chosen.value = provider;
        return;
    }
    void connect(provider);
};

// The estate is chosen: start the sign-in it names.
const connectChosen = (): void => {
    const provider = chosen.value;
    if (provider !== undefined) {
        void connect(provider, estate.value);
    }
};

// Again, as it was: the same estate when it was the one picked here.
const retry = (): void => {
    const provider = signInFailure.value?.provider;
    if (provider !== undefined) {
        // SAFETY: a failure is only ever recorded by a sign-in, and only native providers have one.
        void connect(provider as NativeProvider, provider === chosen.value ? estate.value : undefined);
    }
};

// What the card shows, if anything: the press on its way, the reader's turn, or how the last attempt ended.
const attempt = computed<{ provider: AgentProvider; phase: `starting` | `live` | `failed`; problem?: string } | undefined>(() => {
    if (starting.value !== undefined) {
        return { provider: starting.value, phase: `starting` };
    }
    if (live.value !== undefined) {
        // The store's one error line, while a sign-in is live, is about it: every start clears it.
        return { provider: live.value.provider, phase: `live`, problem: error.value ?? undefined };
    }
    if (signInFailure.value !== undefined) {
        return { provider: signInFailure.value.provider, phase: `failed`, problem: signInFailure.value.message };
    }
    return undefined;
});

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
// press. The press is the tile's own: its sign-in opens in the card at the top, where every sign-in on this view runs,
// with the provider's lane open below it, and the browser that is already signed in answers it.
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
// A sign-in that connected an account while this view was open, as the store saw it land. Said whether or not the
// provider was connected before: a second account lands without its readiness changing at all, and the card simply
// vanishing read as the attempt having been lost.
watch(signInLanded, (now) => {
    if (now !== undefined) {
        landed.value = now.provider;
    }
});

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

        <!-- The sign-in in flight, or how the last one ended: first on the page, since it is the reader's turn. -->
        <ConnectAttempt
            v-if="attempt"
            ref="attemptCard"
            class="mb-4"
            :provider="attempt.provider"
            :phase="attempt.phase"
            :kind="live?.kind"
            :problem="attempt.problem"
            :finishing="finishing"
            @cancel="cancelSignIn"
            @retry="retry"
            @dismiss="dismissSignInFailure"
        />

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
                    :loading="starting === provider"
                    :disabled="starting !== undefined || live?.provider === provider"
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
                    <StatusBadge v-else-if="lane.free" variant="success" size="xs" class="shrink-0" :label="t(`connect.connect.free`)" />
                </template>

                <LocalModelLane v-if="lane.key === `local`" :fit="fit" @ready="onLocalReady" @stop-prefetch="stopFetching" />

                <!-- The tiles stay while a sign-in runs (it is in the card above): another provider is one press, not a Cancel and a hunt. -->
                <div v-else class="flex flex-col gap-3">
                    <template v-for="provider in laneProviders(lane.key, providerReady)" :key="provider">
                        <ProviderTile
                            :provider="provider"
                            :signing-in="starting === provider || live?.provider === provider"
                            :selected="chosen === provider && asksEstate(provider) && live?.provider !== provider"
                            :disabled="starting !== undefined"
                            @click="pick(provider)"
                        />
                        <!-- Estate is the sign-in's own first step, asked under the tile that raised it and before anything starts. -->
                        <div
                            v-if="chosen === provider && offersEstates && live?.provider !== provider && starting !== provider"
                            class="-mt-1 flex flex-col gap-2 rounded-xl border border-line bg-canvas p-3"
                        >
                            <span class="text-xs text-muted">{{ t(`connect.connect.whichPlan`) }}</span>
                            <EstatePicker v-model="estate" :provider="provider" :label="t(`connect.connect.whichPlan`)" />
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
