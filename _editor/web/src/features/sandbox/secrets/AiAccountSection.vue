<script setup lang="ts">
import {
    type AgentProvider,
    isFreeProvider,
    type AccountState,
    type KeyedProvider,
    mintedVariants,
    type OauthAccount,
    providerLabel,
    providerSpec,
} from "@intentic/sandbox-contract";
import { Button, formatTokens, Notice, type NoticeModel, RowGroup, RowNote, SkeletonSnapshot, vSkeletonSource } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { hasSignIn, providerReady } from "../../chat/session/access";
import { relativeTime } from "../../chat/models/catalog";
import { providerTabs } from "../../chat/accounts/providerCatalog";
import { useChat } from "../../chat/run/useChat";
import { refreshConnections, subscriptionOnly } from "../../chat/accounts/useChat-accounts";
import {
    type AccountFacts,
    accountFacts,
    accountState,
    formatReset,
    liveUsage,
    type PlanHeadroom,
    planHeadroom,
    routedAccountFacts,
} from "../../chat/session/usageStatus";
import { useSandbox } from "../client/useSandbox";
import ConnectFlow from "./ConnectFlow.vue";
import EstatePicker from "./EstatePicker.vue";
import ConnectionRow from "./ConnectionRow.vue";
import SandboxOutdatedNotice from "../overview/version/SandboxOutdatedNotice.vue";
import { accountsOutdated } from "../../chat/accounts/accountsOutdated";
import { useT } from "@intentic/ui/i18n";

// The Agent tab's AI-accounts section: where a credential is added or dropped, across every provider and two
// mechanisms (a provider's own account; a subscription via the bundled translator). Which mechanism is behind a row is
// the sandbox's business, not the reader's, so both draw the same:
//   - one provider switcher (dots show which AI is usable)
//   - one row per account (ConnectionRow), named by the account itself: its own name, which is the email it signs in
//     with until somebody renames it, then a dimmed note with only what that name does not already say
//   - one status line under it and one set of actions, judged from the account's verdict whatever served it
//   - one empty/add row per mechanism, where its sign-in unfolds (ConnectFlow)
// Two rules: nothing connects without an explicit click, and an unread state shows loading rather than a false
// "not connected" (`accountsLoaded`).

const t = useT();

const { reachable } = useSandbox();
const {
    managedProvider,
    setManagedProvider,
    managedAccounts,
    accountUsage,
    usageLoaded,
    accountsLoaded,
    accountBusy,
    error: chatError,
    showActiveProvider,
    loadUsage,
    startConnect,
    cancelConnect,
    nativeConnectFlow,
    connectSent,
    renameAccount,
    disconnect,
    translatorAccounts,
    translatorConnectFlow,
    translatorKey,
    connectTranslator,
    cancelTranslatorConnect,
    disconnectTranslator,
} = useChat();
// Wraps the store's bare error as a notice: the app's sentence leads, the daemon's message is the evidence detail.
const chatNotice = computed<NoticeModel | undefined>(() =>
    chatError.value === null ? undefined : { tone: `danger`, title: t(`sandbox.aiAccountSection.couldntReachAiAccounts`), detail: chatError.value },
);

// Subscription rows served by the translator. Codex/Kimi/Gemini: the only connection. Grok: secondary rows under
// the native account. Claude: none, it is the harness.
const routedProvider = computed<KeyedProvider | undefined>(() =>
    providerSpec(managedProvider.value)?.auth.kind === `translator` ? (managedProvider.value as KeyedProvider) : undefined,
);
// What the empty subscription row is called, before there is an account to name it.
const ROUTED_EMPTY = computed((): Record<KeyedProvider, string> => ({
    codex: t(`sandbox.aiAccountSection.chatgptSubscription`),
    grok: t(`sandbox.aiAccountSection.underClaudeCode`),
    kimi: t(`sandbox.aiAccountSection.kimiCodeSubscription`),
    gemini: t(`sandbox.aiAccountSection.googleAccount`),
}));

/* Codex, Kimi and Gemini own no native account: the subscription row IS their connection. */
const hasNativeAccounts = computed(() => hasSignIn(managedProvider.value) && !subscriptionOnly(managedProvider.value));
// Which estate to sign in to, the only provider fact asked before a sign-in starts; reset on provider switch.
const estate = ref<string | undefined>(undefined);
watch(managedProvider, () => {
    estate.value = undefined;
});
const offersEstates = computed(() => (mintedVariants(managedProvider.value)?.length ?? 0) > 1);
const connectHere = (): void => void startConnect(estate.value);
// Grok holds a single account (OpenCode owns the xAI credential); hides "connect another" once linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// Whether a sign-in is live for this row; switching providers mid-sign-in hides the flow, not moves it.
const nativeFlowLive = computed(() => nativeConnectFlow.value?.provider === managedProvider.value);
const routedFlowLive = computed(() => routedProvider.value !== undefined && translatorConnectFlow.value?.provider === routedProvider.value);

// Whose turn the live handshake is on. "Signing in" is only true once the reader has actually been handed to the
// provider; before that the panel below is asking them to go, and a spinner over it claims work nobody started.
const flowNote = (live: boolean): string | undefined => (live ? (connectSent.value ? `signing in…` : `waiting for you`) : undefined);

// No two rows may read the same; distinguished in order:
//   1. identity the provider reports (shown beside the name)
//   2. the name, renamable in place
//   3. failing both, when it was connected
// Grok is exempt from renaming: OpenCode owns its one account, so there's nothing to rename or confuse it with.
// Handing the row no writer is how that is said; a row with one renames itself in place.
const renameOf = (account: OauthAccount): ((label: string) => Promise<void>) | undefined =>
    managedProvider.value === `grok` ? undefined : (label: string) => renameAccount(account.id, label);

// Labels shared by more than one account: rows that cannot be told apart by name alone.
const ambiguousLabels = computed(() => {
    const seen = new Map<string, number>();
    for (const account of managedAccounts.value) {
        seen.set(account.label, (seen.get(account.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
});

// Line beside the name: who the account signs in as, or (if unknown and the name is ambiguous) when it connected.
// Drops repeated names and the provider's email-based personal organisation name.
const identityNote = (account: OauthAccount): string | undefined => {
    const personalOrganization =
        account.email !== undefined && account.organization?.trim().toLowerCase() === `${account.email.trim()}'s organization`.toLowerCase();
    const identity = [account.email, personalOrganization ? undefined : account.organization].filter(
        (part) => part !== undefined && part !== account.label,
    );
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguousLabels.value.has(account.label) ? `connected ${relativeTime(account.connectedAt)}` : undefined;
};

// Per-account usage summary, shown in the meter's card rather than permanently on the row. Always a line once
// usage has loaded (even a zero-turn account); withheld entirely until then.
const usageLine = (id: string): string => {
    const usage = accountUsage.value[id];
    if (usage === undefined || usage.turns === 0) {
        return `No turns on this account yet.`;
    }
    const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ``;
    // Cache rate: cacheReadTokens / (cacheReadTokens + inputTokens), the share of prompt input served from cache.
    const cacheDenom = usage.cacheReadTokens + usage.inputTokens;
    const cache =
        usage.cacheReadTokens > 0 && cacheDenom > 0
            ? ` · ${formatTokens(usage.cacheReadTokens)} cached (${Math.round((100 * usage.cacheReadTokens) / cacheDenom)}%)`
            : ``;
    return `${usage.turns} turns · ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out${cache}${cost}`;
};

// Usage meter per row (plan-limit headroom), so the list shows who's spent without a Usage-tab trip. One decoration
// pass per row feeds both the meter and the row's dimming from the same object so they can't disagree; a meter's
// meaning lives in usageStatus.ts, shared with the composer.

// A row ready to render: the account, its headroom (meter + card), its serviceability verdict, and whether that verdict
// is one waiting fixes (spent, or a bench that lifts by itself).
interface AccountRow<T> {
    account: T;
    headroom: PlanHeadroom | undefined;
    state: AccountState;
    exhausted: boolean;
}

// Decorates and sorts in one pass: rows a person has to act on first (they are why a reader is sent here, and a
// collapsed list must not hide them), then active, then spent; an account with no reading counts as active (unknown
// is not exhausted). Order within each group follows the daemon's.
const rowsOf = <T,>(provider: AgentProvider, accounts: readonly T[], factsOf: (account: T) => AccountFacts): AccountRow<T>[] => {
    const attention: AccountRow<T>[] = [];
    const active: AccountRow<T>[] = [];
    const spent: AccountRow<T>[] = [];
    for (const account of accounts) {
        const facts = factsOf(account);
        // Shared live-usage map, seeded from these rows and kept current by turns and daemon pushes.
        const state = accountState(provider, facts);
        const waiting = state.kind === `spent` || (state.kind === `blocked` && state.fix === `wait`);
        const row = { account, headroom: planHeadroom(liveUsage(provider, facts.account)), state, exhausted: waiting };
        (row.exhausted ? spent : state.kind === `blocked` ? attention : active).push(row);
    }
    return [...attention, ...active, ...spent];
};

// Why a dimmed row is dimmed: a spent allowance and when it reopens, or a bench that lifts by itself and when. Said on
// the row, since a dimmed name with nothing beside it reads as broken, not as waiting.
const waitingLine = (state: AccountState): string | undefined => {
    if (state.kind === `spent`) {
        return state.reopensAt === undefined
            ? t(`sandbox.aiAccountSection.allowanceUsedUp`)
            : t(`sandbox.aiAccountSection.allowanceUsedUpReopens`, { when: formatReset(state.reopensAt) });
    }
    if (state.kind === `blocked` && state.fix === `wait`) {
        // The sentence's own stop is the template's to put, so a provider's full stop never doubles it.
        const reason = state.reason.replace(/[.!\s]+$/, ``);
        return state.until === undefined
            ? t(`sandbox.aiAccountSection.restingFor`, { reason })
            : t(`sandbox.aiAccountSection.restingUntil`, { reason, when: formatReset(state.until) });
    }
    return undefined;
};

// The status line under the name, one judgement for both mechanisms: what waiting will fix, or what a person has to do
// before it serves again. This is the tab a reader is sent to when an account can serve nothing, so it has to say which
// row that was. A verification is the account owner's, on the provider's page (the row's Verify button). An expired
// sign-in that gave no reason says what to do instead. A Google account with no project needs Google's own onboarding,
// the one thing that gives it the project its channel bills every turn to, so that one names the door. Any other bench
// says all it can in the provider's reason.
const stateLine = (provider: AgentProvider, state: AccountState, label: string, signedOut: boolean): string | undefined => {
    if (state.kind !== `blocked` || state.fix === `wait`) {
        return waitingLine(state);
    }
    if (state.fix === `verify`) {
        return t(`sandbox.aiAccountSection.verifyThisAccount`, { label });
    }
    if (signedOut) {
        return t(`sandbox.aiAccountSection.signedOutReconnectTo`);
    }
    return provider === `gemini` && state.fix === `reconnect`
        ? `${state.reason}. Disconnect it, open antigravity.google.com with that account to finish Google's setup, then connect it again.`
        : state.reason;
};

// The row's dot by who can fix it: the person here (`reauth`: signing in again, or verifying the account on the
// provider's page), or somebody this sandbox cannot reach (`blocked`: an organisation's admin handing a seat back).
// Never a seat refusal drawn as a reconnect.
const connectionState = (state: AccountState): `connected` | `reauth` | `blocked` =>
    state.kind !== `blocked` || state.fix === `wait` ? `connected` : state.fix === `admin` ? `blocked` : `reauth`;

// The provider's page where the account's owner lifts a verification bench.
const verifyUrl = (state: AccountState): string | undefined => (state.kind === `blocked` && state.fix === `verify` ? state.url : undefined);

// Opened in a new tab: the person signs in there as that account, and this tab keeps its place.
const openVerify = (url: string): void => {
    window.open(url, `_blank`, `noopener,noreferrer`);
};

const needsReconnect = (state: AccountState): boolean => state.kind === `blocked` && state.fix === `reconnect`;

// One connected account, native or routed, in the one shape every row draws from.
interface AccountView {
    readonly key: string;
    readonly title: string;
    readonly note: string | undefined;
    readonly description: string | undefined;
    readonly state: AccountState;
    readonly headroom: PlanHeadroom | undefined;
    readonly exhausted: boolean;
    // Own spend, for the meter's card; only a native account knows which turns it served.
    readonly activity: string | undefined;
    readonly rename: ((label: string) => Promise<void>) | undefined;
    // Where the account's owner confirms it, when that is what it waits on.
    readonly verify: string | undefined;
    // Signing in again replaces this credential in place; only the native sign-in can.
    readonly reconnect: boolean;
    // The `accountBusy` key its disconnect holds while it runs.
    readonly busy: string;
    readonly disconnect: () => void;
}

const nativeViews = computed<readonly AccountView[]>(() =>
    hasNativeAccounts.value
        ? rowsOf(managedProvider.value, managedAccounts.value, accountFacts).map(({ account, headroom, exhausted, state }) => ({
              key: account.id,
              title: account.label,
              note: identityNote(account),
              description: stateLine(managedProvider.value, state, account.label, account.needsReauth === true && account.detail === undefined),
              state,
              headroom,
              exhausted,
              activity: needsReconnect(state) || !usageLoaded.value ? undefined : usageLine(account.id),
              rename: renameOf(account),
              verify: verifyUrl(state),
              reconnect: needsReconnect(state) && canConnectMore.value,
              busy: account.id,
              disconnect: () => void disconnect(account.id),
          }))
        : [],
);

// A subscription is named by whoever signs in to it (the translator's label is that email), the same as a native
// account that was never renamed, so a ChatGPT row reads like a Claude one. Only Grok, which can have both kinds side
// by side, says which kind this is.
const routedViews = computed<readonly AccountView[]>(() => {
    const provider = routedProvider.value;
    if (provider === undefined) {
        return [];
    }
    return rowsOf(provider, translatorAccounts.value[provider], routedAccountFacts).map(({ account, headroom, exhausted, state }) => ({
        key: `${provider}:${account.name}`,
        title: account.label,
        note: provider === `grok` ? t(`sandbox.aiAccountSection.viaClaudeCode`) : undefined,
        description: stateLine(provider, state, account.label, false),
        state,
        headroom,
        exhausted,
        activity: undefined,
        rename: undefined,
        verify: verifyUrl(state),
        reconnect: false,
        busy: translatorKey(provider, account.name),
        disconnect: () => void disconnectTranslator(provider, account.name),
    }));
});

// Collapses beyond COLLAPSE_THRESHOLD total rows (native + routed combined, not either list alone) to keep the
// card from pushing the rest of the page off screen.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);

const totalAccountCount = computed(() => nativeViews.value.length + routedViews.value.length);
const shouldCollapse = computed(() => totalAccountCount.value > COLLAPSE_THRESHOLD);
const collapsedCount = computed(() => totalAccountCount.value - VISIBLE_WHEN_COLLAPSED);

// Switcher's own label ("Kimi Code", not "Kimi") so the empty row matches the chip's wording.
const managedLabel = computed(() => providerTabs.find((tab) => tab.value === managedProvider.value)?.label ?? providerLabel(managedProvider.value));

// One mechanism's block: its accounts, then the row that connects one (empty) or another (add). Native and routed
// are the same block fed different handlers, so the two can never drift into two designs again.
interface AccountGroup {
    readonly key: string;
    readonly kind: `native` | `routed`;
    readonly provider: AgentProvider;
    readonly rows: readonly AccountView[];
    readonly empty: boolean;
    readonly emptyTitle: string;
    readonly canAdd: boolean;
    readonly live: boolean;
    // Past the point of abandoning: what the user brought back is being redeemed, and cancelling would take the panel
    // down over a connection that lands anyway. Held disabled rather than swapped away, so the row keeps its shape.
    readonly finishing: boolean;
    readonly connecting: boolean;
    // Filled only when this is the group's one connection; under Grok the subscription stays secondary to the native row.
    readonly secondary: boolean;
    readonly estates: boolean;
    readonly connect: () => void;
    readonly cancel: () => void;
}

const groups = computed<readonly AccountGroup[]>(() => {
    const collapsed = shouldCollapse.value && !expanded.value;
    // Collapsed, native rows take the first slots and routed rows fill whatever they left.
    const nativeShown = collapsed ? nativeViews.value.slice(0, VISIBLE_WHEN_COLLAPSED) : nativeViews.value;
    const routedShown = collapsed ? routedViews.value.slice(0, Math.max(0, VISIBLE_WHEN_COLLAPSED - nativeShown.length)) : routedViews.value;
    const shown: AccountGroup[] = [];
    if (hasNativeAccounts.value) {
        shown.push({
            key: `native-${managedProvider.value}`,
            kind: `native`,
            provider: managedProvider.value,
            rows: nativeShown,
            empty: nativeViews.value.length === 0,
            emptyTitle: t(`sandbox.aiAccountSection.account`, { managedLabel: managedLabel.value }),
            canAdd: canConnectMore.value,
            live: nativeFlowLive.value,
            finishing: nativeFlowLive.value && accountBusy.value === managedProvider.value,
            connecting: accountBusy.value === managedProvider.value,
            secondary: false,
            estates: offersEstates.value,
            connect: connectHere,
            cancel: cancelConnect,
        });
    }
    const provider = routedProvider.value;
    if (provider !== undefined) {
        shown.push({
            key: `routed-${provider}`,
            kind: `routed`,
            provider,
            rows: routedShown,
            empty: routedViews.value.length === 0,
            emptyTitle: ROUTED_EMPTY.value[provider],
            canAdd: true,
            live: routedFlowLive.value,
            finishing: routedFlowLive.value && accountBusy.value === translatorKey(provider),
            connecting: accountBusy.value === translatorKey(provider),
            secondary: provider === `grok`,
            estates: false,
            connect: () => void connectTranslator(provider),
            cancel: cancelTranslatorConnect,
        });
    }
    return shown;
});

// `?connect=<provider>` used to open that provider's rows here AND start its sign-in. Starting one is /connect's job
// now — a handshake is a trip to another tab and back, which a settings page reached by deep link is the wrong host
// for — so the old link is forwarded there rather than broken. This card keeps what it is good at: what is connected,
// under which identity, spending what, and how to drop it.
const route = useRoute();
const router = useRouter();

const focusConnect = (): void => {
    const requested = providerTabs.find((tab) => tab.value === route.query[`connect`]);
    if (requested === undefined) {
        return;
    }
    void router.replace({ path: `/connect`, query: { provider: requested.value } });
};

onMounted(() => {
    // Fetches on open rather than waiting for the reachable seam (which lags a probe plus a tunnel round-trip) or
    // trusting a possibly stale read; the skeletons cover the wait.
    void refreshConnections();
    void loadUsage();
    showActiveProvider();
    focusConnect();
});
watch(() => route.query[`connect`], focusConnect);
</script>

<template>
    <!-- RowGroup, not Card: wrapping an already-grouped list in a card added a bordered surface for no gain, the group label already carries the heading. -->
    <RowGroup id="ai-account" :label="t(`sandbox.aiAccountSection.aiAccount`)">
        <!-- Each chip's dot has three states (checking / connected / not-connected), not two. -->
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-1">
                <button
                    v-for="tab in providerTabs"
                    :key="tab.value"
                    type="button"
                    class="composer-ghost h-6 gap-1.5 px-2 text-2xs font-medium"
                    :class="{ 'composer-active': managedProvider === tab.value }"
                    @click="setManagedProvider(tab.value)"
                    :aria-pressed="managedProvider === tab.value"
                >
                    <span
                        class="h-1.5 w-1.5 shrink-0 rounded-full"
                        :class="!accountsLoaded ? 'bg-content/25' : providerReady(tab.value) ? 'bg-success' : 'bg-content/25'"
                        :aria-label="!accountsLoaded ? `checking` : providerReady(tab.value) ? `connected` : t(`sandbox.words.notConnected`)"
                    />
                    {{ tab.label }}
                    <!-- "Free" shown on the chip itself, not only after opening it, so comparing providers doesn't require opening each one. -->
                    <span
                        v-if="accountsLoaded && isFreeProvider(tab.value) && !providerReady(tab.value)"
                        class="shrink-0 rounded-sm bg-success/15 px-1 font-semibold text-success"
                    >
                        {{ t(`sandbox.aiAccountSection.free`) }}
                    </span>
                </button>
            </div>
        </template>

        <Notice v-if="chatNotice" :of="chatNotice" class="m-3" />

        <!-- Nothing read yet: an offline sandbox says so and stops; otherwise the rows as they last looked for this provider
             (outlines in their shape before there is such a look) hold the section's height until they land. -->
        <ConnectionRow
            v-if="!accountsLoaded && !reachable"
            :title="t(`sandbox.aiAccountSection.connectionsUnavailable`)"
            state="missing"
            :description="t(`sandbox.aiAccountSection.sandboxOfflineAccountsCant`)"
        />
        <SkeletonSnapshot v-else-if="!accountsLoaded" :of="`sandbox.ai-accounts:${managedProvider}`">
            <ConnectionRow v-for="placeholder in 2" :key="`loading-${placeholder}`" state="unknown" pending aria-hidden="true">
                <template #control><span class="skeleton block h-7 w-24 rounded-md" /></template>
            </ConnectionRow>
        </SkeletonSnapshot>

        <!-- The rows alone, not the group: the provider switcher above stays live through the wait. A box of their own to
             imprint, so it carries the group's hairlines itself. -->
        <div v-else v-skeleton-source="`sandbox.ai-accounts:${managedProvider}`" class="divide-y divide-line-subtle">
            <!-- A sandbox too old to judge its accounts: every row reads unknown, and this says why and how to update. -->
            <RowNote v-if="accountsOutdated && totalAccountCount > 0" variant="block">
                <SandboxOutdatedNotice :missing="t(`sandbox.aiAccountSection.outdatedMissing`)" />
            </RowNote>

            <!-- Native accounts (Claude, Grok, Cursor and the minted providers), then subscriptions (Codex, Kimi, Gemini,
                 and Grok under Claude Code): one block each, drawn by the same template. -->
            <template v-for="group in groups" :key="group.key">
                <ConnectionRow
                    v-for="row in group.rows"
                    :key="row.key"
                    :title="row.title"
                    :state="connectionState(row.state)"
                    :tone="row.state.kind === `blocked` && row.state.fix !== `wait` ? `warning` : `default`"
                    :note="row.note"
                    :description="row.description"
                    :activity="row.activity"
                    :rename="row.rename"
                    :headroom="row.headroom"
                    :exhausted="row.exhausted"
                >
                    <template #control>
                        <!-- The fix is the account owner's, on the provider's page: the one action this row wants. -->
                        <Button v-if="row.verify !== undefined" :label="t(`sandbox.aiAccountSection.verify`)" size="small" @click="openVerify(row.verify)">
                            <template #icon><Icon name="external-link" /></template>
                        </Button>
                        <Button
                            v-else-if="row.reconnect && !group.live"
                            :label="t(`ui.action.reconnect`)"
                            size="small"
                            :loading="group.connecting"
                            @click="group.connect()"
                        />
                        <Button
                            :label="t(`ui.action.disconnect`)"
                            size="small"
                            severity="danger"
                            :text="true"
                            :loading="accountBusy === row.busy"
                            @click="row.disconnect()"
                        />
                    </template>
                </ConnectionRow>

                <!-- No account is still a row, same shape as a connected one, so it reads as a missing connection, not an apology. -->
                <ConnectionRow
                    v-if="group.empty"
                    :key="`${group.key}-empty`"
                    :title="group.emptyTitle"
                    state="missing"
                    :note="flowNote(group.live) ?? t(`sandbox.words.notConnected`)"
                    :note-busy="group.live && connectSent"
                >
                    <template #control>
                        <Button
                            v-if="group.live"
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="group.finishing"
                            @click="group.cancel()"
                        />
                        <Button
                            v-else
                            :label="t(`ui.action.connect`)"
                            size="small"
                            :severity="group.secondary ? `secondary` : undefined"
                            :loading="group.connecting"
                            @click="group.connect()"
                        >
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <!-- Estate chooser sits where the sign-in unfolds and is replaced by it, since choosing the estate is the connect's first step, not a separate setting. -->
                    <template v-if="group.live || group.estates" #below>
                        <ConnectFlow v-if="group.live" :kind="group.kind" :provider="group.provider" />
                        <EstatePicker v-else v-model="estate" :provider="group.provider" :label="t(`sandbox.aiAccountSection.plan`, { managedLabel })" />
                    </template>
                </ConnectionRow>

                <!-- A second account is a different act from having none: its own quiet row where its sign-in also unfolds. -->
                <ConnectionRow
                    v-else-if="group.canAdd"
                    :key="`${group.key}-add`"
                    :title="t(`sandbox.aiAccountSection.addAnotherAccount`)"
                    state="action"
                    icon="plus"
                    :note="flowNote(group.live)"
                    :note-busy="group.live && connectSent"
                    :interactive="!group.live"
                    @click="!group.live && group.connect()"
                >
                    <template v-if="group.live" #control>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="group.finishing"
                            @click="group.cancel()"
                        />
                    </template>
                    <template v-if="group.live || group.estates" #below>
                        <ConnectFlow v-if="group.live" :kind="group.kind" :provider="group.provider" />
                        <EstatePicker v-else v-model="estate" :provider="group.provider" :label="t(`sandbox.aiAccountSection.plan`, { managedLabel })" />
                    </template>
                </ConnectionRow>
            </template>

            <!-- Collapse toggle sits at the truncation seam, drawn as the same quiet action row as "Add another account". -->
            <ConnectionRow
                v-if="shouldCollapse"
                :title="expanded ? t(`ui.action.showLess`) : t(`sandbox.aiAccountSection.showMoreAccounts`, { collapsedCount })"
                state="action"
                :icon="expanded ? `chevron-up` : `chevron-down`"
                interactive
                @click="expanded = !expanded"
            />
        </div>
    </RowGroup>
</template>
