<script setup lang="ts">
import {
    type AccountUsage,
    type AgentProvider,
    isFreeProvider,
    type KeyedProvider,
    mintedVariants,
    type OauthAccount,
    type TranslatorAccount,
    providerLabel,
    providerSpec,
} from "@intentic/sandbox-contract";
import { Button, formatTokens, Notice, type NoticeModel, Row, RowGroup } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { hasSignIn, providerReady } from "../../chat/session/access";
import { relativeTime } from "../../chat/models/catalog";
import { providerTabs } from "../../chat/accounts/providerCatalog";
import { useChat } from "../../chat/run/useChat";
import { refreshConnections, subscriptionOnly } from "../../chat/accounts/useChat-accounts";
import { blockedReason, isSpent, liveUsage, type PlanHeadroom, planHeadroom } from "../../chat/session/usageStatus";
import { useSandbox } from "../client/useSandbox";
import ConnectFlow from "./ConnectFlow.vue";
import EstatePicker from "./EstatePicker.vue";
import ConnectionRow from "./ConnectionRow.vue";
import { useT } from "@intentic/ui/i18n";

// The Agent tab's AI-accounts section: where a credential is added or dropped, across five providers and two
// mechanisms (a provider's own account; a subscription via the bundled translator), sharing one shape:
//   - one provider switcher (dots show which AI is usable)
//   - one row anatomy per connection (ConnectionRow)
//   - one sign-in panel unfolding inside its row (ConnectFlow)
//   - one action per row, morphing through sign-in (Connect -> spinner -> Cancel)
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
const ROUTED_ROW = computed((): Record<KeyedProvider, { title: string }> => ({
    codex: { title: t(`sandbox.aiAccountSection.chatgptSubscription`) },
    grok: { title: t(`sandbox.aiAccountSection.underClaudeCode`) },
    kimi: { title: t(`sandbox.aiAccountSection.kimiCodeSubscription`) },
    gemini: { title: t(`sandbox.aiAccountSection.googleAccount`) },
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

// The handshake is past the point of abandoning: what the user brought back is being redeemed, and cancelling
// would take the panel down over a connection that lands anyway. Held disabled rather than swapped away, so the
// row keeps its shape while the panel below reports the wait.
const nativeFinishing = computed(() => nativeFlowLive.value && accountBusy.value === managedProvider.value);
const routedFinishing = computed(
    () => routedFlowLive.value && routedProvider.value !== undefined && accountBusy.value === translatorKey(routedProvider.value),
);

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
// Drops any part equal to the name so an email isn't printed twice.
const identityNote = (account: OauthAccount): string | undefined => {
    const identity = [account.email, account.organization].filter((part) => part !== undefined && part !== account.label);
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguousLabels.value.has(account.label) ? `connected ${relativeTime(account.connectedAt)}` : undefined;
};

// Per-account usage summary, shown in the ring's card rather than permanently on the row. Always a line once
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

// Usage ring per row (plan-limit headroom), so the list shows who's spent without a Usage-tab trip. One decoration
// pass per row feeds both the ring and the row's dimming from the same object so they can't disagree; a ring's meaning
// lives in usageStatus.ts, shared with the composer.

// A row ready to render: the account, its headroom (ring + card), and whether it's effectively spent.
interface AccountRow<T> {
    account: T;
    headroom: PlanHeadroom | undefined;
    exhausted: boolean;
}

// Decorates and sorts active-before-spent in one pass; an account with no reading counts as active (unknown is
// not exhausted). Order within each group follows the daemon's.
const rowsOf = <T,>(provider: AgentProvider, accounts: readonly T[], keyOf: (account: T) => string): AccountRow<T>[] => {
    const active: AccountRow<T>[] = [];
    const spent: AccountRow<T>[] = [];
    for (const account of accounts) {
        // Shared live-usage map, seeded from these rows and kept current by turns and daemon pushes.
        const usage = liveUsage(provider, keyOf(account));
        const row = { account, headroom: planHeadroom(usage), exhausted: isSpent(usage) };
        (row.exhausted ? spent : active).push(row);
    }
    return [...active, ...spent];
};

const accountRows = computed<readonly AccountRow<OauthAccount>[]>(() =>
    rowsOf(managedProvider.value, managedAccounts.value, (account) => account.id),
);

// What to do about a benched credential, where there is anything to do: only Google's own onboarding can give an
// account the project its channel bills every turn to, so that one names the door. Any other bench is the proxy's own
// and says all it can in the reason.
const blockedFix = (provider: KeyedProvider, reason: string): string =>
    provider === `gemini`
        ? `${reason}. Disconnect it, open antigravity.google.com with that account to finish Google's setup, then connect it again.`
        : reason;

const translatorRows = computed(() =>
    routedProvider.value === undefined
        ? []
        : rowsOf(routedProvider.value, translatorAccounts.value[routedProvider.value], (account) => account.name).map((row) => ({
              ...row,
              // The translator's own verdict on the credential, which no reading of its pools can contradict: this is
              // the tab a reader is sent to when one can serve nothing, so it has to say which row that was.
              blocked: blockedReason({ needsReauth: false, seatRefusal: undefined, cooling: row.account.cooling }),
          })),
);

// Collapses beyond COLLAPSE_THRESHOLD total rows (native + routed combined, not either list alone) to keep the
// card from pushing the rest of the page off screen.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);

// Total of native and routed accounts; drives whether collapsing fires.
const totalAccountCount = computed(() => accountRows.value.length + translatorRows.value.length);
const shouldCollapse = computed(() => totalAccountCount.value > COLLAPSE_THRESHOLD);
const collapsedCount = computed(() => totalAccountCount.value - VISIBLE_WHEN_COLLAPSED);

// When collapsed, shows the first VISIBLE_WHEN_COLLAPSED native accounts, fewer if routed rows need room for at
// least one; all of them when expanded.
const visibleNativeAccounts = computed<readonly AccountRow<OauthAccount>[]>(() => {
    if (!shouldCollapse.value || expanded.value) {
        return accountRows.value;
    }
    return accountRows.value.slice(0, VISIBLE_WHEN_COLLAPSED);
});

// When collapsed, routed accounts fill whatever slots native accounts left.
const visibleRoutedLimit = computed(() => {
    if (!shouldCollapse.value || expanded.value) {
        return Infinity;
    }
    return Math.max(0, VISIBLE_WHEN_COLLAPSED - visibleNativeAccounts.value.length);
});

// Switcher's own label ("Kimi Code", not "Kimi") so the empty row matches the chip's wording.
const managedLabel = computed(() => providerTabs.find((tab) => tab.value === managedProvider.value)?.label ?? providerLabel(managedProvider.value));

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
                        :aria-label="!accountsLoaded ? `checking` : providerReady(tab.value) ? `connected` : t(`shared.notConnected`)"
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

        <!-- Nothing read yet: an offline sandbox says so and stops; otherwise skeletons in the real rows' shape hold the section's height until they land. -->
        <ConnectionRow
            v-if="!accountsLoaded && !reachable"
            :title="t(`sandbox.aiAccountSection.connectionsUnavailable`)"
            state="missing"
            :description="t(`sandbox.aiAccountSection.sandboxOfflineAccountsCant`)"
        />
        <template v-else-if="!accountsLoaded">
            <!-- Two skeleton lines: a connected row always has a name plus a usage line under it. -->
            <Row v-for="placeholder in 2" :key="`loading-${placeholder}`" aria-hidden="true">
                <template #title>
                    <span class="flex min-w-0 items-center gap-2.5">
                        <span class="flex w-[1.125rem] shrink-0 justify-center">
                            <span class="h-1.5 w-1.5 rounded-full bg-content/25" />
                        </span>
                        <span class="flex min-h-[1lh] items-center">
                            <span class="skeleton block h-3" :class="placeholder === 1 ? 'w-40' : 'w-28'" />
                        </span>
                    </span>
                </template>
                <template #description>
                    <span class="flex min-h-[1lh] items-center pl-7">
                        <span class="skeleton block h-2.5" :class="placeholder === 1 ? 'w-56' : 'w-44'" />
                    </span>
                </template>
                <template #control><span class="skeleton block h-7 w-24 rounded-md" /></template>
            </Row>
        </template>

        <!-- Native accounts and translator subscriptions render as one list of the same row shape, since both answer "what am I signed in with, can I drop it?". -->
        <template v-else>
            <!-- Native accounts: Claude and Grok only. Codex, Kimi and Gemini skip straight to the subscription row below. -->
            <template v-if="hasNativeAccounts">
                <ConnectionRow
                    v-for="{ account, headroom, exhausted } in visibleNativeAccounts"
                    :key="account.id"
                    :title="account.label"
                    :state="account.needsReauth || account.seatRefusal !== undefined ? `reauth` : `connected`"
                    :tone="account.needsReauth || account.seatRefusal !== undefined ? `warning` : `default`"
                    :note="identityNote(account)"
                    :description="account.needsReauth ? (account.detail ?? t(`sandbox.aiAccountSection.signedOutReconnectTo`)) : account.seatRefusal"
                    :activity="account.needsReauth || !usageLoaded ? undefined : usageLine(account.id)"
                    :rename="renameOf(account)"
                    :headroom="headroom"
                    :exhausted="exhausted"
                >
                    <template #control>
                        <Button
                            v-if="account.needsReauth && canConnectMore && !nativeFlowLive"
                            :label="t(`shared.reconnect`)"
                            size="small"
                            :loading="accountBusy === managedProvider"
                            @click="connectHere"
                        />
                        <Button
                            :label="t(`ui.action.disconnect`)"
                            size="small"
                            severity="danger"
                            :text="true"
                            :loading="accountBusy === account.id"
                            @click="disconnect(account.id)"
                        />
                    </template>
                </ConnectionRow>

                <!-- No account is still a row, same shape as a connected one, so it reads as a missing connection, not an apology. -->
                <ConnectionRow
                    v-if="accountRows.length === 0"
                    :title="t(`sandbox.aiAccountSection.account`, { managedLabel })"
                    state="missing"
                    :note="flowNote(nativeFlowLive) ?? t(`shared.notConnected`)"
                    :note-busy="nativeFlowLive && connectSent"
                >
                    <template #control>
                        <Button
                            v-if="nativeFlowLive"
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="nativeFinishing"
                            @click="cancelConnect"
                        />
                        <!-- Filled: with no account at all, this is the one action the group wants. -->
                        <Button v-else :label="t(`ui.action.connect`)" size="small" :loading="accountBusy === managedProvider" @click="connectHere">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <template v-if="nativeFlowLive || offersEstates" #below>
                        <!-- Estate chooser sits where the sign-in unfolds and is replaced by it, since choosing the estate is the connect's first step, not a separate setting. -->
                        <ConnectFlow v-if="nativeFlowLive" kind="native" :provider="managedProvider" />
                        <EstatePicker
                            v-else
                            v-model="estate"
                            :provider="managedProvider"
                            :label="t(`sandbox.aiAccountSection.plan`, { managedLabel })"
                        />
                    </template>
                </ConnectionRow>

                <!-- A second account is a different act from having none: its own quiet row where its sign-in also unfolds. -->
                <ConnectionRow
                    v-else-if="canConnectMore"
                    :title="t(`sandbox.aiAccountSection.addAnotherAccount`)"
                    state="add"
                    :note="flowNote(nativeFlowLive)"
                    :note-busy="nativeFlowLive && connectSent"
                    :interactive="!nativeFlowLive"
                    @click="!nativeFlowLive && connectHere()"
                >
                    <template v-if="nativeFlowLive" #control>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="nativeFinishing"
                            @click.stop="cancelConnect"
                        />
                    </template>
                    <template v-if="nativeFlowLive || offersEstates" #below>
                        <ConnectFlow v-if="nativeFlowLive" kind="native" :provider="managedProvider" />
                        <EstatePicker
                            v-else
                            v-model="estate"
                            :provider="managedProvider"
                            :label="t(`sandbox.aiAccountSection.plan`, { managedLabel })"
                        />
                    </template>
                </ConnectionRow>
            </template>

            <!-- Subscription rows (translator): the primary control for Codex/Kimi/Gemini, secondary under Grok's native account. -->
            <template v-if="routedProvider">
                <ConnectionRow
                    v-for="{ account, headroom, exhausted, blocked } in translatorRows.slice(0, visibleRoutedLimit)"
                    :key="account.name"
                    :title="ROUTED_ROW[routedProvider].title"
                    :state="blocked === undefined ? `connected` : `reauth`"
                    :tone="blocked === undefined ? `default` : `warning`"
                    :note="account.label"
                    :description="blocked === undefined ? undefined : blockedFix(routedProvider, blocked)"
                    :headroom="headroom"
                    :exhausted="exhausted"
                >
                    <template #control>
                        <Button
                            :label="t(`ui.action.disconnect`)"
                            size="small"
                            severity="danger"
                            :text="true"
                            :loading="accountBusy === translatorKey(routedProvider, account.name)"
                            @click="disconnectTranslator(routedProvider, account.name)"
                        />
                    </template>
                </ConnectionRow>

                <!-- No subscription: states what's missing with the one fix. -->
                <ConnectionRow
                    v-if="translatorAccounts[routedProvider].length === 0"
                    :key="`connect-${routedProvider}`"
                    :title="ROUTED_ROW[routedProvider].title"
                    state="missing"
                    :note="flowNote(routedFlowLive) ?? t(`shared.notConnected`)"
                    :note-busy="routedFlowLive && connectSent"
                >
                    <template #control>
                        <Button
                            v-if="routedFlowLive"
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="routedFinishing"
                            @click="cancelTranslatorConnect"
                        />
                        <!-- Filled only when this is the group's one connection; under Grok it stays secondary to the native row above. -->
                        <Button
                            v-else
                            :label="t(`ui.action.connect`)"
                            size="small"
                            :severity="routedProvider === `grok` ? `secondary` : undefined"
                            :loading="accountBusy === translatorKey(routedProvider)"
                            @click="connectTranslator(routedProvider)"
                        >
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <template v-if="routedFlowLive" #below><ConnectFlow kind="routed" :provider="routedProvider" /></template>
                </ConnectionRow>
                <ConnectionRow
                    v-else
                    :key="`add-${routedProvider}`"
                    :title="t(`sandbox.aiAccountSection.addAnotherAccount`)"
                    state="add"
                    :note="flowNote(routedFlowLive)"
                    :note-busy="routedFlowLive && connectSent"
                    :interactive="!routedFlowLive"
                    @click="!routedFlowLive && connectTranslator(routedProvider)"
                >
                    <template v-if="routedFlowLive" #control>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            size="small"
                            severity="secondary"
                            :text="true"
                            :disabled="routedFinishing"
                            @click.stop="cancelTranslatorConnect"
                        />
                    </template>
                    <template v-if="routedFlowLive" #below><ConnectFlow kind="routed" :provider="routedProvider" /></template>
                </ConnectionRow>
            </template>

            <!-- Collapse toggle sits at the truncation seam, styled as a quiet link row so it aligns with the rows above it. -->
            <Row v-if="shouldCollapse" interactive @click="expanded = !expanded">
                <template #title>
                    <span class="flex items-center gap-2 text-2xs font-medium text-link">
                        <span class="flex w-[1.125rem] shrink-0 justify-center">
                            <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        </span>
                        {{ expanded ? t(`shared.showLess`) : t(`sandbox.aiAccountSection.showMoreAccounts`, { collapsedCount }) }}
                    </span>
                </template>
            </Row>
        </template>
    </RowGroup>
</template>
