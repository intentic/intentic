<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { KeyedProvider } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { type NativeProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { Button, Icon, InfoHint, Notice, type NoticeModel, Section } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { lessMotion } from "@intentic/ui/motion";
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, useId, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useTier } from "../../../client/sandbox/useTier";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { foundToOffer } from "../../../lib/foundOnComputer";
import { SANDBOX_SELF_ACCESS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { HOME_VIEW_HOST } from "../../../lib/routes/homeDetour";
import { endpointProviders, keyedBeside, runnableReadFailure } from "../../../models/providers/providerCatalog";
import { refreshConnections } from "../../../models/conversations/accounts/useChat-accounts";
import { holdSignInTab } from "../../../models/conversations/run/signInTab";
import { holdModelsView, type SignInFailureKind } from "../../../models/conversations/run/signInOutcome";
import { loadProviderModels } from "../../../models/conversations/accounts/useChat-catalog";
import { rememberedModelFor, rememberPick } from "../../../models/conversations/run/turnDefaults";
import { useChat } from "../../../models/conversations/run/useChat";
import { accessKnown, providerReady } from "../../../models/providers/access";
import LocalModelsPanel from "./LocalModelsPanel.vue";
import type { ModelSource, ModelSourceStanding } from "./modelSources";
import ProviderPanel from "./ProviderPanel.vue";
import {
    arrivalTile,
    foundSignIns,
    isProviderTile,
    KEY_FILES_READ,
    keysFoundFor,
    keyTile,
    type LandedCard,
    landedLine,
    linkArrival,
    LOCAL_TILE,
    MODEL_TILES,
    type TileKey,
    tileCount,
    tileLine,
    tileOf,
} from "./providerGrid";
import ProviderTile from "./ProviderTile.vue";
import { useLocalModelFit } from "./useLocalModelFit";
import { FOUND_KEYS, useFoundKeys } from "./useFoundKeys";
import { useModelSources } from "./useModelSources";
import { here, page } from "../../../lib/routes/links";

// Stable peer tiles for each provider and Local models open the sole accounts/sign-in or local/server panel below the grid.
// All sign-in links use modelsPath.ts to land here and open the relevant tile; never expose competing sign-in doors.
// Starting a sign-in replaces the previous pending one, with other panels explaining that before the press.

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
// What the reader may do here. Full access runs the whole page; someone given AI accounts of their own (sandbox-contract
// members.ts `ownAccounts`) reaches it too, to sign in with accounts of theirs, so every press below that would only be
// refused them is left out rather than drawn: a translator's subscription, the found keys, the other sandboxes' accounts,
// and Local models, where everything adds or changes a connection.
const { canShip } = useTier();
const { can } = useAccess();

// What each tile holds, judged the way the Models row in the sandbox's menu judges it.
const sources = useModelSources();

// No model's weights are fetched by visiting this page: a download of a gigabyte or more is the reader's own press on
// a rung (LocalModelLane). Opening the page used to start the quick model's (2026-11-04: taken out, since nobody asked
// for it). A transfer still running from that, or started by an older editor, keeps its progress line and its stop.
const { fit, stopPrefetch } = useLocalModelFit();
const stopFetching = (): void => {
    void stopPrefetch();
};

// THE GRID AND WHICH TILE IS OPEN.
// The open tile lives in the address (`?open=<tile>`), so a reload or a shared link lands on it again. A provider's tile is
// named by the provider itself, so a chat's "Connect Claude" opens Claude's tile (opened, not signed in: `?provider=` is that).
// Local models only for a reader who may add to them: every press under that tile writes a connection.
const localOpen = computed(() => canShip.value || can(`capabilities.add`));
const tiles = computed(() => MODEL_TILES.filter((tile) => tile !== LOCAL_TILE || localOpen.value));
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
const panelEl = useTemplateRef<HTMLElement>(`panelEl`);
// A press on a tile whose panel opens below the fold (a phone, where the grid alone fills the screen) brings the panel up to
// meet it: otherwise the press changed only the tile's own highlight, and the card it opened sat a screen further down.
const PANEL_FOLD_SHARE = 0.6;
const select = (tile: TileKey): void => {
    selected.value = selected.value === tile ? undefined : tile;
    if (selected.value === undefined) {
        return;
    }
    void nextTick(() => {
        const panelBox = panelEl.value;
        if (panelBox != null && panelBox.getBoundingClientRect().top > window.innerHeight * PANEL_FOLD_SHARE) {
            panelBox.scrollIntoView({ block: `start`, behavior: lessMotion() ? `auto` : `smooth` });
        }
    });
};

// What each tile says, from the sources that live under it: a provider's own accounts and its vendor's API keys, or
// every other model this sandbox serves or is pointed at for Local models. The worst standing among them colours its dot.
const STANDING_RANK = { attention: 0, blocked: 1, ready: 2, waiting: 3 } as const satisfies Record<ModelSourceStanding, number>;
const sourcesOf = (tile: TileKey): readonly ModelSource[] =>
    sources.value.filter((source) => source.kind !== `trial` && tileOf(source.provider, keyedBeside) === tile);
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
                    found: accessKnown.value && facts.found && facts.count === 0,
                    keyFound: keysFoundFor(keyRows.value, tile).length > 0,
                },
            ];
        }),
    ),
);

// ARRIVAL: `?provider=` continues a press made elsewhere (a picker row, a trial strip, the chat's "Try again"): open its
// tile, and start its sign-in when nothing of it is connected yet (linkArrival). Without one, the tile whose turn it is:
// the sign-in waiting on the reader, the one that just failed, else whatever needs a person, else the first connected
// provider, else the grid's first tile (arrivalTile): the page always arrives with a tile open, as roles does.
let arrived = false;
const settleArrival = (): void => {
    if (!accessKnown.value) {
        return;
    }
    const asked = String(route.query[`provider`] ?? ``);
    const arrival = asked === `` ? undefined : linkArrival(asked, providerReady, keyedBeside);
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
    const tile = arrivalTile(
        {
            live: live.value?.provider,
            failed: signInFailure.value?.provider,
            needing: sources.value.find((source) => source.standing === `attention` || source.standing === `blocked`)?.provider,
            // Only when the desktop app's own address named them: an offer remembered from an earlier one is a badge, and
            // does not pull every later visit away from what is connected.
            found: route.query[`found`] === undefined ? undefined : foundRows.value[0],
            connected: sources.value.find((source) => source.kind !== `trial` && source.standing === `ready`)?.provider,
        },
        keyedBeside,
    );
    selected.value = tiles.value.includes(tile) ? tile : tiles.value[0];
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

// Whether the reader may start this sign-in: a provider's own, or with Full access a translator's subscription too.
const mayConnect = (provider: NativeProvider, via?: `native` | `routed`): boolean => {
    const routed = via === undefined ? routedByDefault(provider) : via === `routed`;
    return canShip.value || can(routed ? `translator.connect` : `accounts.start`, { provider });
};

// `via` picks the mechanism where a provider has two (Grok's own xAI account, or its subscription under Claude Code);
// left out, the provider's own auth kind decides.
const connect = async (provider: NativeProvider, { variant, via }: { variant?: string; via?: `native` | `routed` } = {}): Promise<void> => {
    if (starting.value !== undefined || !mayConnect(provider, via)) {
        return;
    }
    // The press that asked is the one moment a tab may open, so it is held now, before anything is awaited, and the
    // provider's page goes there once the sandbox names it: one press from Add to the page (signInTab.ts).
    const tab = holdSignInTab(providerSpec(provider)?.destination ?? provider, providerSpec(provider)?.brand);
    // A new attempt is the thing happening now; the last one's banner is over.
    landed.value = undefined;
    selected.value = provider;
    starting.value = provider;
    lastVariant = variant;
    setManagedProvider(provider);
    try {
        await nextTick();
        void panel.value?.reveal();
        const routed = via === undefined ? routedByDefault(provider) : via === `routed`;
        // SAFETY: only a translator-held provider is asked for its subscription, by its own panel's button.
        await (routed ? connectTranslator(provider as KeyedProvider, tab) : startConnect(variant, tab));
    } finally {
        // A start that failed, or never ran, sent nothing there: the held tab closes rather than sitting blank.
        tab?.release();
        starting.value = undefined;
    }
};

// What the open panel's sign-in block shows, if anything: the press on its way, the reader's turn, or how it ended.
const attemptFor = (
    provider: NativeProvider,
): { phase: `starting` | `live` | `failed`; kind?: `native` | `routed`; problem?: string; failure?: SignInFailureKind } | undefined => {
    if (starting.value === provider) {
        return { phase: `starting` };
    }
    if (live.value?.provider === provider) {
        // The store's one error line, while a sign-in is live, is about it: every start clears it.
        return { phase: `live`, kind: live.value.kind, problem: error.value ?? undefined };
    }
    if (signInFailure.value?.provider === provider) {
        return { phase: `failed`, problem: signInFailure.value.message, failure: signInFailure.value.kind };
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
// An endpoint made from a key is named as one ("Anthropic API key"); any other as the picker names it.
const keyEndpointLabels = new Map<AgentProvider, string>();
const landedLabel = (provider: AgentProvider): string =>
    providerSpec(provider)?.accountLabel ??
    keyEndpointLabels.get(provider) ??
    endpointProviders.value.find((endpoint) => endpoint.id === provider)?.label ??
    provider;
const landedFor = (tile: TileKey): string | undefined =>
    landed.value === undefined || tileOf(landed.value, keyedBeside) !== tile ? undefined : landedLine(landedLabel(landed.value), activeSandbox.value?.name);
// What a sign-in's landing said about itself (who, replaced or new, a tab opened for it); none for a key or a local model.
const arrival = ref<{ readonly who?: string; readonly refreshed: boolean; readonly tab: boolean } | undefined>(undefined);
// The provider card's own arrival (ConnectLanded.vue): what connected, where, who, and which tab is now free to close.
const landedCardFor = (tile: TileKey): LandedCard | undefined => {
    const provider = landed.value;
    if (provider === undefined || tileOf(provider, keyedBeside) !== tile) {
        return undefined;
    }
    const facts = arrival.value;
    return {
        label: landedLabel(provider),
        sandbox: activeSandbox.value?.name,
        who: facts?.who,
        refreshed: facts?.refreshed,
        tab: facts?.tab === true ? providerSpec(provider)?.destination : undefined,
    };
};

// A sign-in that connected an account while this view was open, as the store saw it land: said whether or not the
// provider was connected before, since a second account lands without its readiness changing at all. An account a person
// connects is always theirs to run on, which the sandbox's answer about them now names, so that answer is read again.
watch(signInLanded, (now) => {
    if (now !== undefined) {
        landed.value = now.provider;
        arrival.value = now.who === undefined ? { refreshed: now.refreshed, tab: now.tab } : { who: now.who, refreshed: now.refreshed, tab: now.tab };
        selected.value = tileOf(now.provider) ?? selected.value;
        void queryClient.invalidateQueries({ queryKey: SANDBOX_SELF_ACCESS.of() });
    }
});

// Fires when the model is actually serving, not when its manifest entry was written: the picker reads endpoints from
// the connection list fetched on arrival, which has never heard of this one.
const onLocalReady = (provider: string): void => {
    landed.value = provider;
    arrival.value = undefined;
    void refreshConnections();
};

// Points the next conversation at what was just connected and goes there: the errand ends in a chat, not on a settings
// page. Shown on Home in its chat's place (lib/routes/homeDetour.ts), that chat is the one it was opened from: back to it,
// pointed at what just connected if it had nothing to send with, its draft still in the box.
const homeView = inject(HOME_VIEW_HOST, undefined);
const chatLabel = computed(() => (homeView === undefined ? undefined : t(`home.view.continueInChat`)));
// The model is read after this provider's catalog has answered with the new sign-in: the list read before it (or none
// at all, on a new sandbox) defaults to the compile-time floor's head, and stored here as the reader's pick that put
// every chat on Claude Opus 5 from the first one on. The reader's own remembered family wins over the daemon default.
const startChatting = async (): Promise<void> => {
    const provider = landed.value;
    if (provider !== undefined) {
        await loadProviderModels(provider);
    }
    const pick = provider === undefined ? undefined : { provider, value: rememberedModelFor(provider) };
    if (pick !== undefined) {
        rememberPick(pick);
    }
    if (homeView !== undefined) {
        homeView.back(pick);
        return;
    }
    void router.push(here(page.chat()));
};

// FOUND ON THIS COMPUTER (`?found=`, lib/foundOnComputer.ts): the providers the desktop app found signed in here, each a
// badge on its tile and, on the desktop app's own landing, the tile open on arrival, where its panel's Connect is one
// press the browser already signed in answers. What the address names, else what the desktop app said on an earlier one.
// (2026-11-26) They were rows of a section above the grid, which stood there with only the key search in it on most visits.
const found = computed(() => foundToOffer(route.query[`found`]));
const foundRows = computed(() => foundSignIns(found.value, providerReady).filter((provider) => mayConnect(provider)));

// And the API keys the owner's devices hold, read only when the owner presses Find API keys (useFoundKeys.ts): a tool in
// the grid's header, its files named in the grid's (i), each key it finds a badge on its tile and a row in that tile's
// panel (keys/FoundKeyRows.vue). A copied key's endpoint is opened and offered there, in the card of the sign-in a vendor's
// key is the alternative to, else under Local models.
const foundKeys = useFoundKeys((key, endpoint) => {
    if (endpoint !== undefined) {
        keyEndpointLabels.set(endpoint, t(`connect.connect.foundKeyTitle`, { provider: key.label }));
        landed.value = endpoint;
        arrival.value = undefined;
        // The card the press was made in, where the key's own row now stands.
        selected.value = keyTile(key);
    }
});
provide(FOUND_KEYS, foundKeys);
const { keyRows, keyLook, readKeys, keyNotice, failedKey } = foundKeys;
// What the last look came to, beside its button: said only once there was a look.
const keysFoundLine = computed(() =>
    keyLook.value !== `looked` ? undefined : keyRows.value.length === 0 ? t(`connect.connect.foundKeysNone`) : t(`connect.connect.foundKeysCount`, { count: keyRows.value.length }, keyRows.value.length),
);
// A failed copy is said at its key's row; one whose row is not listed (the look was on an earlier visit) under the grid.
const keyNoticeUnplaced = computed(() => (keyNotice.value !== undefined && !keyRows.value.some((key) => key.id === failedKey.value) ? keyNotice.value : undefined));

// A key pasted beside a provider's sign-in (keys/ApiKeyOption.vue) lands as a row of the card it was pasted in, said there
// once the connection list names it (landedFor).
const keyAdded = (endpoint: AgentProvider, vendor: string): void => {
    keyEndpointLabels.set(endpoint, t(`connect.apiKey.title`, { vendor }));
    landed.value = endpoint;
    arrival.value = undefined;
};

const otherLiveFor = (tile: TileKey): AgentProvider | undefined => {
    const other = live.value?.provider ?? starting.value;
    return other !== undefined && other !== tile ? other : undefined;
};

// While this page is on screen it owns every sign-in: landings are said in its panels, not as a toast, and the chat's strip
// stands down beside it (signInOutcome.ts).
const releaseView = holdModelsView();
onUnmounted(releaseView);

onMounted(() => {
    // Fetched on open rather than waiting for the reachable seam, which lags a probe plus a tunnel round-trip.
    void refreshConnections();
    // Each account's spend, for the meter's card on its row; the rows draw without it until it lands. Full access's reading.
    if (canShip.value || can(`system.usage`)) {
        void loadUsage();
    }
    settleArrival();
});
watch([accessKnown, () => route.query[`provider`]], settleArrival);
</script>

<template>
    <!-- `@container`: the docked chat can leave this pane a third of the window, and the grid reflows against it. -->
    <div class="@container flex flex-col gap-6">
        <Notice
            v-if="!accessKnown && !reachable"
            :of="{
                tone: `warning`,
                title: t(`sandbox.aiAccountSection.connectionsUnavailable`),
                detail: t(`sandbox.aiAccountSection.sandboxOfflineAccountsCant`),
            }"
        />
        <!-- Reachable, but its list of what can run was refused: the panels wait on that list, so say why they are missing. -->
        <Notice
            v-else-if="!accessKnown && runnableReadFailure !== undefined"
            :of="{ tone: `danger`, title: t(`sandbox.aiAccountSection.couldntListProviders`), detail: runnableReadFailure }"
        />

        <!-- The grid: every way in, always the same tiles in the same places; fluid columns, so a scrollbar never reflows it.
             How it works and where what you connect is kept sit behind its (i). -->
        <Section :label="t(`shared.allProviders`)">
            <template #info>
                <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`shared.allProviders`) })">
                    <span class="block text-xs text-content">{{ t(`connect.providerGrid.intro`) }}</span>
                    <span v-if="canShip" class="mt-2 block text-xs text-muted">{{ t(`connect.connect.foundKeysReads`, { files: KEY_FILES_READ }) }}</span>
                </InfoHint>
                <!-- Getting started's mark for connecting a model: this page is where that step is done. -->
                <TourMark step="models" place="models" :priority="3" side="bottom" />
            </template>
            <!-- The owner's own press: credential files on their computers are read for it, never because the page opened.
                 A tool used when the reader chooses, so boring; what it finds is badged on the tiles below. -->
            <template v-if="canShip" #actions>
                <span v-if="keysFoundLine" class="text-xs text-muted" role="status">{{ keysFoundLine }}</span>
                <Button
                    tier="boring"
                    size="small"
                    :label="keyLook === `looked` ? t(`connect.connect.foundKeysLookAgain`) : t(`connect.connect.foundKeysLook`)"
                    :loading="keyLook === `looking`"
                    :disabled="keyLook === `looking`"
                    @click="readKeys"
                >
                    <template #icon><Icon name="search" /></template>
                </Button>
            </template>
            <div role="group" :aria-label="t(`shared.models`)" class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1">
                <ProviderTile
                    v-for="tile in tiles"
                    :key="tile"
                    :tile="tile"
                    :selected="selected === tile"
                    :line="tileFacts[tile]?.line"
                    :standing="tileFacts[tile]?.standing"
                    :found="tileFacts[tile]?.found ?? false"
                    :key-found="tileFacts[tile]?.keyFound ?? false"
                    :controls="panelId"
                    @select="select(tile)"
                />
            </div>
        </Section>
        <Notice v-if="keyNoticeUnplaced" :of="keyNoticeUnplaced" />

        <!-- The open tile's panel. Nothing until the lists land: an empty provider would claim "not connected". -->
        <div :id="panelId" ref="panelEl" class="scroll-mt-4">
            <template v-if="selected !== undefined && accessKnown && tiles.includes(selected)">
                <LocalModelsPanel
                    v-if="selected === LOCAL_TILE"
                    :fit="fit"
                    :landed="landedFor(LOCAL_TILE)"
                    :chat-label="chatLabel"
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
                    :landed="landedCardFor(selected)"
                    :chat-label="chatLabel"
                    :found="foundRows.some((provider) => provider === selected)"
                    :notice="accountsNotice"
                    @connect="connectSelected"
                    @key-added="keyAdded"
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
