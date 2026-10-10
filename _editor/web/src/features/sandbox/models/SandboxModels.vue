<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import {
    type AgentProvider,
    endpointProvider,
    type KeyedProvider,
    type NativeProvider,
    type ProviderKey,
    ProviderKeysAppliedSchema,
    ProviderKeysSchema,
    providerSpec,
} from "@intentic/sandbox-contract";
import { Button, Icon, Notice, type NoticeModel, Row, RowGroup } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { sandboxJson } from "../../../client/sandbox/sandboxClient";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { foundToOffer } from "../../../lib/foundOnComputer";
import { defaultModelFor, endpointProviders, trialStatus } from "../../chat/accounts/providerCatalog";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { refreshConnections } from "../../chat/accounts/useChat-accounts";
import { rememberPick } from "../../chat/run/turnDefaults";
import { useChat } from "../../chat/run/useChat";
import { accessKnown, providerReady } from "../../chat/session/access";
import LocalModelsPanel from "./LocalModelsPanel.vue";
import { localPrefetchStopped } from "./localPrefetch";
import type { ModelSource, ModelSourceStanding } from "./modelSources";
import ProviderPanel from "./ProviderPanel.vue";
import {
    arrivalTile,
    foundSignIns,
    isProviderTile,
    KEY_SOURCE_LABELS,
    landedLine,
    linkArrival,
    LOCAL_TILE,
    MODEL_TILES,
    offeredKeys,
    type TileKey,
    tileCount,
    tileLine,
    tileOf,
} from "./providerGrid";
import ProviderTile from "./ProviderTile.vue";
import { useLocalModelFit } from "./useLocalModelFit";
import { useModelSources } from "./useModelSources";

// SANDBOX ▸ MODELS: every way this sandbox can run a model, as a grid of peers, and one panel for whichever is open.
//
// A tile per provider and one for Local models, always the same tiles in the same places (providerGrid.ts), each saying
// what it holds ("3 accounts", a dot for how they are) or why it is worth a look ("Free"). Pressing one opens its panel
// below the grid, as a persona's tile opens its editor: the provider's accounts, the one button that adds one, and the
// sign-in itself while it runs (ProviderPanel); or this machine's models and the servers it is pointed at
// (LocalModelsPanel). That panel is the only door to a sign-in on the page, so there is never a second way to do one
// thing, and no provider is promoted over another by where it sits.
//
// It replaced a list of what was connected stacked over three "ways in" lanes, and before that a page of its own at
// /connect plus an AI-account card in Agent ▸ Models. Every link that offers a sign-in elsewhere (the chat's strip, the
// model picker, setup's landing, a job whose model is not connected) lands here (lib/routes/modelsPath.ts), and the page
// opens the tile it is about.
//
// One sign-in at a time: starting one replaces whichever was waiting, and every other panel says so before the press.

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
    loadUsage,
} = useChat();
const { reachable, active: activeSandbox } = useSandbox();

// What each tile holds, judged the way the Models row in the sandbox's menu judges it.
const sources = useModelSources();

const { fit, startPrefetch, stopPrefetch } = useLocalModelFit();

// A local model is a capability, not an account.
const localModel = computed(() => endpointProviders.value.find((endpoint) => endpoint.kind === `localmodel`));

// The weights that make the local offer instant, fetched while the reader is still reading the page — but only where
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

// THE GRID AND WHICH TILE IS OPEN.
// The open tile lives in the address (`?open=<tile>`), so a reload or a shared link lands on it again.
const tileNamed = (value: unknown): TileKey | undefined => MODEL_TILES.find((tile) => tile === value);
const remembered = tileNamed(route.query[`open`]);
const selected = ref<TileKey | undefined>(remembered);
// Query writes run one after another, each spreading the address the previous one left: two replaces issued in one tick
// (the arrival dropping `?provider=`, the tile it opened) would otherwise each spread the stale query and undo the other.
// A write that throws (a guard's error; an aborted one resolves) is said and leaves the chain open for the next.
let writing: Promise<unknown> = Promise.resolve();
const patchQuery = (patch: Record<string, string | undefined>): void => {
    writing = writing
        .then(() => router.replace({ query: { ...route.query, ...patch } }))
        .catch((failure) => {
            console.warn(`models: could not write the open tile into the address`, failure);
        });
};
// Replaced, not pushed: picking a tile is not a visit.
watch(selected, (tile) => {
    if (tile !== tileNamed(route.query[`open`])) {
        patchQuery({ open: tile });
    }
});
const panelId = useId();
const select = (tile: TileKey): void => {
    selected.value = selected.value === tile ? undefined : tile;
};

// What each tile says, from the sources that live under it: a provider's own, or every model this sandbox serves or is
// pointed at for Local models. The worst standing among them colours its dot.
const STANDING_RANK = { attention: 0, blocked: 1, ready: 2, waiting: 3 } as const satisfies Record<ModelSourceStanding, number>;
const sourcesOf = (tile: TileKey): readonly ModelSource[] =>
    sources.value.filter((source) => source.kind !== `trial` && tileOf(source.provider) === tile);
const tileFacts = computed(() =>
    Object.fromEntries(
        MODEL_TILES.map((tile) => {
            const under = sourcesOf(tile);
            const standing = under.reduce<ModelSourceStanding | undefined>(
                (worst, source) => (worst === undefined || STANDING_RANK[source.standing] < STANDING_RANK[worst] ? source.standing : worst),
                undefined,
            );
            const facts = {
                count: under.reduce((sum, source) => sum + source.count, 0),
                standing,
                signingIn: starting.value === tile || live.value?.provider === tile,
                failed: signInFailure.value?.provider === tile,
                found: foundRows.value.some((provider) => provider === tile),
            };
            // Before the lists land a count would read as zero, which is a claim: nothing is said until they do.
            return [
                tile,
                {
                    line: accessKnown.value ? tileLine(tile, facts) : undefined,
                    count: accessKnown.value ? tileCount(facts) : undefined,
                    standing: accessKnown.value ? standing : undefined,
                },
            ];
        }),
    ),
);

// ARRIVAL: `?provider=` continues a press made elsewhere (a picker row, a trial strip, the chat's "Try again"): open its
// tile, and start its sign-in when nothing of it is connected yet (linkArrival). Without one, the tile whose turn it is:
// the sign-in waiting on the reader, the one that just failed, else whatever needs a person (arrivalTile). Otherwise
// nothing opens: the grid says what is here, and an open panel nobody asked for is a pitch.
let arrived = false;
const settleArrival = (): void => {
    if (!accessKnown.value) {
        return;
    }
    const asked = String(route.query[`provider`] ?? ``);
    const arrival = asked === `` ? undefined : linkArrival(asked, providerReady);
    if (arrival !== undefined) {
        selected.value = arrival.tile;
        if (arrival.signIn && live.value?.provider !== asked && isProviderTile(asked)) {
            void connect(asked);
        }
        // Acted on once: a reload or a step back to this address must not start the sign-in a second time.
        patchQuery({ provider: undefined });
        arrived = true;
        return;
    }
    if (arrived) {
        return;
    }
    arrived = true;
    // A tile the address remembers is the reader's own pick, and outranks the page's guess.
    if (remembered !== undefined) {
        return;
    }
    selected.value = arrivalTile({
        live: live.value?.provider,
        failed: signInFailure.value?.provider,
        needing: sources.value.find((source) => source.standing === `attention` || source.standing === `blocked`)?.provider,
    });
};

// THE ONE SIGN-IN.
// Which estate to sign in to is the panel's to ask; the provider whose sign-in is on its way to the sandbox is the page's,
// so its tile and panel say so from the press rather than from whenever the sandbox answers.
const starting = ref<NativeProvider | undefined>(undefined);
// The variant the last sign-in asked for, so Try again asks for the same one.
let lastVariant: string | undefined;
const panel = useTemplateRef<InstanceType<typeof ProviderPanel>>(`panel`);

// The translator holds the subscription OAuth, a stored account serves everything else, as the daemon splits them.
const routedByDefault = (provider: NativeProvider): boolean => providerSpec(provider)?.auth.kind === `translator`;

// `via` picks the mechanism where a provider has two (Grok's own xAI account, or its subscription under Claude Code);
// left out, the provider's own auth kind decides.
const connect = async (provider: NativeProvider, { variant, via }: { variant?: string; via?: `native` | `routed` } = {}): Promise<void> => {
    if (starting.value !== undefined) {
        return;
    }
    // A new attempt is the thing happening now; the last one's banner is over.
    landed.value = undefined;
    selected.value = provider;
    starting.value = provider;
    lastVariant = variant;
    setManagedProvider(provider);
    await nextTick();
    void panel.value?.reveal();
    try {
        const routed = via === undefined ? routedByDefault(provider) : via === `routed`;
        // SAFETY: only a translator-held provider is asked for its subscription, by its own panel's button.
        await (routed ? connectTranslator(provider as KeyedProvider) : startConnect(variant));
    } finally {
        starting.value = undefined;
    }
};

// What the open panel's sign-in block shows, if anything: the press on its way, the reader's turn, or how it ended.
const attemptFor = (
    provider: NativeProvider,
): { phase: `starting` | `live` | `failed`; kind?: `native` | `routed`; problem?: string } | undefined => {
    if (starting.value === provider) {
        return { phase: `starting` };
    }
    if (live.value?.provider === provider) {
        // The store's one error line, while a sign-in is live, is about it: every start clears it.
        return { phase: `live`, kind: live.value.kind, problem: error.value ?? undefined };
    }
    if (signInFailure.value?.provider === provider) {
        return { phase: `failed`, problem: signInFailure.value.message };
    }
    return undefined;
};

// What was brought back is being redeemed: there is nothing left to abandon.
const finishing = computed(
    () => live.value !== undefined && accountBusy.value === (live.value.kind === `native` ? live.value.provider : translatorKey(live.value.provider)),
);

// The open panel's own press: its Connect, its Add another account, a row's Reconnect.
const connectSelected = (request: { via: `native` | `routed`; variant?: string }): void => {
    const tile = selected.value;
    if (tile !== undefined && isProviderTile(tile)) {
        void connect(tile, request);
    }
};

const retry = (): void => {
    const provider = signInFailure.value?.provider;
    if (provider !== undefined && isProviderTile(provider)) {
        void connect(provider, { variant: lastVariant });
    }
};

// What went wrong that is not a sign-in's own (a refused disconnect): shown in the open panel, where the press was.
const accountsNotice = computed<NoticeModel | undefined>(() =>
    error.value === null || live.value !== undefined || signInFailure.value !== undefined
        ? undefined
        : { tone: `danger`, title: t(`sandbox.aiAccountSection.couldntReachAiAccounts`), detail: error.value },
);
const dismissAccountsNotice = (): void => {
    error.value = null;
};

// LANDING: a state, not a redirect. The panel of what connected says so, naming the sandbox it went to (landedLine), with
// the one next move.
const landed = ref<AgentProvider | undefined>(undefined);
// An endpoint made from a found key is named for its provider ("OpenRouter"); any other as the picker names it.
const keyEndpointLabels = new Map<AgentProvider, string>();
const landedLabel = (provider: AgentProvider): string =>
    providerSpec(provider)?.accountLabel ??
    keyEndpointLabels.get(provider) ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    provider;
const landedFor = (tile: TileKey): string | undefined =>
    landed.value === undefined || tileOf(landed.value) !== tile ? undefined : landedLine(landedLabel(landed.value), activeSandbox.value?.name);

// A sign-in that connected an account while this view was open, as the store saw it land: said whether or not the
// provider was connected before, since a second account lands without its readiness changing at all.
watch(signInLanded, (now) => {
    if (now !== undefined) {
        landed.value = now.provider;
        selected.value = tileOf(now.provider) ?? selected.value;
    }
});

// Fires when the model is actually serving, not when its manifest entry was written: the picker reads endpoints from
// the connection list fetched on arrival, which has never heard of this one.
const onLocalReady = (provider: string): void => {
    landed.value = provider;
    void refreshConnections();
};

// Points the next conversation at what was just connected and goes there: the errand ends in a chat, not on a settings
// page.
const startChatting = (): void => {
    const provider = landed.value;
    if (provider !== undefined) {
        rememberPick({ provider, value: defaultModelFor(provider) });
    }
    void router.push(`/chat`);
};

// FOUND ON THIS COMPUTER (`?found=`, lib/foundOnComputer.ts): the providers the desktop app found signed in here, each one
// press that opens the provider's panel with its sign-in started, which the browser already signed in answers. What the
// address names, else what the desktop app said on an earlier address.
const found = computed(() => foundToOffer(route.query[`found`]));
const foundRows = computed(() => foundSignIns(found.value, providerReady));

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
                selected.value = LOCAL_TILE;
            }
        } finally {
            adding.value = undefined;
        }
    }, t(`connect.connect.foundKeyFailed`));

// The platform's free trial is not something to connect, so it has no tile; while it is on offer it is worth one line,
// since it is what a chat runs on until something here is connected.
const trialLine = computed(() =>
    trialStatus.value.available
        ? t(`connect.modelSources.trialLeft`, { count: trialStatus.value.remaining }, trialStatus.value.remaining)
        : undefined,
);

const otherLiveFor = (tile: TileKey): AgentProvider | undefined => {
    const other = live.value?.provider ?? starting.value;
    return other !== undefined && other !== tile ? other : undefined;
};

onMounted(() => {
    // Fetched on open rather than waiting for the reachable seam, which lags a probe plus a tunnel round-trip.
    void refreshConnections();
    // Each account's spend, for the meter's card on its row; the rows draw without it until it lands.
    void loadUsage();
    settleArrival();
    if (canShip.value) {
        void readKeys();
    }
});
watch([accessKnown, () => route.query[`provider`]], settleArrival);
</script>

<template>
    <!-- `@container`: the docked chat can leave this pane a third of the window, and the grid reflows against it. -->
    <div class="@container flex flex-col gap-6">
        <div class="flex flex-col gap-1">
            <p class="flex items-center gap-1.5 text-xs text-muted">
                <span class="min-w-0">{{ t(`connect.providerGrid.intro`) }}</span>
                <!-- Getting started's mark for connecting a model: this page is where that step is done. -->
                <TourMark step="models" place="models" :priority="3" side="bottom" />
            </p>
            <p v-if="trialLine" class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="gift" class="text-2xs" />{{ trialLine }}</p>
        </div>

        <Notice
            v-if="!accessKnown && !reachable"
            :of="{
                tone: `warning`,
                title: t(`sandbox.aiAccountSection.connectionsUnavailable`),
                detail: t(`sandbox.aiAccountSection.sandboxOfflineAccountsCant`),
            }"
        />

        <!-- What this computer already holds: the first thing to do when there is any of it, one press each. -->
        <RowGroup v-if="foundRows.length > 0 || keyRows.length > 0" :label="t(`connect.connect.foundTitle`)">
            <Row
                v-for="provider in foundRows"
                :key="provider"
                :title="providerSpec(provider)?.accountLabel"
                :description="t(`connect.connect.foundSignedIn`)"
            >
                <template #lead="{ mark }">
                    <span class="flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }"
                        ><ProviderLogo :provider="provider"
                    /></span>
                </template>
                <template #control>
                    <Button
                        size="small"
                        :label="t(`ui.action.connect`)"
                        :loading="starting === provider"
                        :disabled="starting !== undefined || live?.provider === provider"
                        @click="connect(provider)"
                    />
                </template>
            </Row>
            <Row
                v-for="key in keyRows"
                :key="key.id"
                icon="key"
                :title="t(`connect.connect.foundKeyTitle`, { provider: key.label })"
                :description="t(`connect.connect.foundKeyFrom`, { source: KEY_SOURCE_LABELS[key.source], hint: key.hint })"
            >
                <template #control>
                    <span v-if="key.added" class="flex items-center gap-1 text-2xs text-success"
                        ><Icon name="check" class="text-2xs" />{{ t(`connect.connect.foundKeyAdded`) }}</span
                    >
                    <Button
                        v-else
                        size="small"
                        :label="t(`ui.action.add`)"
                        :loading="adding === key.id"
                        :disabled="adding !== undefined"
                        @click="addKey(key)"
                    />
                </template>
            </Row>
        </RowGroup>
        <Notice v-if="keyNotice" :of="keyNotice" />

        <!-- The grid: every way in, always the same tiles in the same places. -->
        <div role="group" :aria-label="t(`shared.models`)" class="-mx-1.5 flex flex-wrap gap-1">
            <ProviderTile
                v-for="tile in MODEL_TILES"
                :key="tile"
                :tile="tile"
                :selected="selected === tile"
                :line="tileFacts[tile]?.line"
                :count="tileFacts[tile]?.count"
                :standing="tileFacts[tile]?.standing"
                :controls="panelId"
                @select="select(tile)"
            />
        </div>

        <!-- The open tile's panel. Nothing until the lists land: an empty provider would claim "not connected". -->
        <div :id="panelId">
            <template v-if="selected !== undefined && accessKnown">
                <LocalModelsPanel
                    v-if="selected === LOCAL_TILE"
                    :fit="fit"
                    :landed="landedFor(LOCAL_TILE)"
                    @ready="onLocalReady"
                    @stop-prefetch="stopFetching"
                    @chat="startChatting"
                />
                <ProviderPanel
                    v-else
                    ref="panel"
                    :key="selected"
                    :provider="selected"
                    :attempt="attemptFor(selected)"
                    :finishing="finishing"
                    :other-live="otherLiveFor(selected)"
                    :busy="starting !== undefined"
                    :landed="landedFor(selected)"
                    :found="foundRows.some((provider) => provider === selected)"
                    :notice="accountsNotice"
                    @connect="connectSelected"
                    @cancel="cancelSignIn"
                    @retry="retry"
                    @dismiss="dismissSignInFailure"
                    @chat="startChatting"
                    @show="(provider) => (selected = tileOf(provider) ?? selected)"
                    @dismiss-notice="dismissAccountsNotice"
                />
            </template>
        </div>
    </div>
</template>
