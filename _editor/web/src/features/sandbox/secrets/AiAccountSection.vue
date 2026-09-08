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
import { Button, formatTokens, Notice, type NoticeModel, Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { hasSignIn, providerReady } from "../../chat/session/access";
import { relativeTime } from "../../chat/models/catalog";
import { providerTabs } from "../../chat/accounts/providerCatalog";
import { useChat } from "../../chat/run/useChat";
import { refreshConnections, subscriptionOnly } from "../../chat/accounts/useChat-accounts";
import { isSpent, liveUsage, type PlanHeadroom, planHeadroom } from "../../chat/session/usageStatus";
import { useSandbox } from "../client/useSandbox";
import ConnectFlow from "./ConnectFlow.vue";
import ConnectionRow from "./ConnectionRow.vue";

// The Agent tab's AI-accounts section: where a credential is added or dropped, across five providers and two
// mechanisms (a provider's own account; a subscription via the bundled translator), sharing one shape:
//   - one provider switcher (dots show which AI is usable)
//   - one row anatomy per connection (ConnectionRow)
//   - one sign-in panel unfolding inside its row (ConnectFlow)
//   - one action per row, morphing through sign-in (Connect -> spinner -> Cancel)
// Two rules: nothing connects without an explicit click, and an unread state shows loading rather than a false
// "not connected" (`accountsLoaded`).

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
    chatError.value === null ? undefined : { tone: `danger`, title: `Couldn't reach your AI accounts.`, detail: chatError.value },
);

// Subscription rows served by the translator. Codex/Kimi/Gemini: the only connection. Grok: secondary rows under
// the native account. Claude: none, it is the harness.
const routedProvider = computed<KeyedProvider | undefined>(() =>
    providerSpec(managedProvider.value)?.auth.kind === `translator` ? (managedProvider.value as KeyedProvider) : undefined,
);
const ROUTED_ROW: Record<KeyedProvider, { title: string }> = {
    codex: { title: `ChatGPT subscription` },
    grok: { title: `Under Claude Code` },
    kimi: { title: `Kimi Code subscription` },
    gemini: { title: `Google account` },
};

/* Codex, Kimi and Gemini own no native account: the subscription row IS their connection. Read off the same
 * rules the composer's gate uses, so a provider is never offered an account row it has no store behind.
 *
 * TWO exclusions, not one, and the second is the one this asked by elimination. A provider with no sign-in at
 * all (an endpoint, an ACP agent: `hasSignIn`) is not a native provider either, and treating "not a
 * subscription" as "has native accounts" put a Connect button on the free trial's row for a handshake that does
 * not exist. */
const hasNativeAccounts = computed(() => hasSignIn(managedProvider.value) && !subscriptionOnly(managedProvider.value));
/* WHICH ESTATE TO SIGN IN TO, and the ONLY provider fact this card asks the user for before a sign-in starts.
 *
 * Z.ai sells one product through two entirely separate estates: an international plan signs in at z.ai and its
 * key works against api.z.ai, a mainland GLM Coding Plan signs in at bigmodel.cn and its key works against
 * open.bigmodel.cn, and each host refuses the other's credential. Nothing we can read tells us which one a
 * person holds, and guessing sends half of them through a sign-in that ends in a refusal about a key that is
 * perfectly good — so the choice is made HERE, before anything opens, rather than diagnosed afterwards.
 *
 * Shown only where there is genuinely a choice: a provider with one estate (Meta) renders no control at all,
 * and its `login/start` names no variant. */
const estates = computed(() => {
    const variants = mintedVariants(managedProvider.value) ?? [];
    return variants.length > 1 ? variants : [];
});
// Defaults to the list's first entry (the daemon's own default); reset on provider switch.
const estate = ref<string | undefined>(undefined);
watch(managedProvider, () => {
    estate.value = undefined;
});
const chosenEstate = computed<string>({
    get: () => estate.value ?? estates.value[0]?.id ?? ``,
    set: (value) => {
        estate.value = value;
    },
});
// Blank estate means no choice offered; the daemon reads blank as "take the default".
const connectHere = (): void => void startConnect(chosenEstate.value === `` ? undefined : chosenEstate.value);
// Grok holds a single account (OpenCode owns the xAI credential); hides "connect another" once linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// Whether a sign-in is live for this row; switching providers mid-sign-in hides the flow, not moves it.
const nativeFlowLive = computed(() => nativeConnectFlow.value?.provider === managedProvider.value);
const routedFlowLive = computed(() => routedProvider.value !== undefined && translatorConnectFlow.value?.provider === routedProvider.value);

// No two rows may read the same; distinguished in order:
//   1. identity the provider reports (shown beside the name)
//   2. the name, renamable in place
//   3. failing both, when it was connected
// Grok is exempt from renaming: OpenCode owns its one account, so there's nothing to rename or confuse it with.
const renamable = computed(() => managedProvider.value !== `grok`);

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

const translatorRows = computed<readonly AccountRow<TranslatorAccount>[]>(() =>
    routedProvider.value === undefined ? [] : rowsOf(routedProvider.value, translatorAccounts.value[routedProvider.value], (account) => account.name),
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

// `?connect=<provider>` opens that provider's rows, flashes them, and starts its sign-in, continuing a click
// already made elsewhere (unlike the switcher, which never auto-connects). Driven by a watch, not just onMounted, since
// a query-only navigation doesn't remount this component.
const route = useRoute();
const ringing = ref(false);
let ringTimer: ReturnType<typeof setTimeout> | undefined;

// Starts the deep-linked sign-in via whichever mechanism the provider uses; never a second one (a live flow
// already answers) nor for an already-connected provider (a stale link isn't a new request).
const connectRequested = (target: AgentProvider): void => {
    if (nativeConnectFlow.value !== undefined || translatorConnectFlow.value !== undefined || providerReady(target)) {
        return;
    }
    if (target === `codex` || target === `kimi` || target === `gemini`) {
        void connectTranslator(target);
        return;
    }
    connectHere();
};

const focusConnect = (): void => {
    const requested = providerTabs.find((tab) => tab.value === route.query[`connect`]);
    if (requested === undefined) {
        return;
    }
    setManagedProvider(requested.value);
    // Clears any prior timer so a repeat jump doesn't cut the flash short.
    ringing.value = true;
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => (ringing.value = false), 2500);
    // Let the card render, then bring it into view.
    setTimeout(() => document.getElementById(`ai-account`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    connectRequested(requested.value);
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
// No teardown here: leaving the tab must not cancel a sign-in happening elsewhere (see useChat.cancelConnect).
onUnmounted(() => clearTimeout(ringTimer));
</script>

<template>
    <!--
        RowGroup, not Card: wrapping an already-grouped list in a card added a bordered surface for no gain, the group
        label already carries the heading.
    -->
    <!--
        Deep-link flash rings the whole group; `-m-1 p-1` reserves room for the ring outside the surface so the section
        doesn't grow and shove the page for 2.5s.
    -->
    <RowGroup id="ai-account" label="AI account" :class="ringing ? '-m-1 rounded-xl p-1 ring-2 ring-info' : ''">
        <!--
            Each chip's dot has three states (checking / connected / not-connected), not two, since a grey dot before the
            read lands would falsely claim every provider is disconnected.
        -->
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
                        :aria-label="!accountsLoaded ? `checking` : providerReady(tab.value) ? `connected` : `not connected`"
                    />
                    {{ tab.label }}
                    <!--
                        "Free" shown on the chip itself, not only after opening it, so comparing providers doesn't require opening
                        each one. Dropped once connected (accessBadge's rule: a connected provider reads as the default, not an ad).
                    -->
                    <span
                        v-if="accountsLoaded && isFreeProvider(tab.value) && !providerReady(tab.value)"
                        class="shrink-0 rounded-sm bg-success/15 px-1 font-semibold text-success"
                    >
                        Free
                    </span>
                </button>
            </div>
        </template>

        <Notice v-if="chatNotice" :of="chatNotice" class="m-3" />

        <!--
            Nothing read yet: an offline sandbox says so and stops; otherwise skeletons in the real rows' shape hold the
            section's height until they land.
        -->
        <ConnectionRow
            v-if="!accountsLoaded && !reachable"
            title="Connections unavailable"
            state="missing"
            description="Your sandbox is offline: its accounts can't be read or changed from here."
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

        <!--
            Native accounts and translator subscriptions render as one list of the same row shape, since both answer "what
            am I signed in with, can I drop it?". A live sign-in opens in its own row's #below, not a detached panel.
        -->
        <template v-else>
            <!-- Native accounts: Claude and Grok only. Codex, Kimi and Gemini skip straight to the subscription row below. -->
            <template v-if="hasNativeAccounts">
                <ConnectionRow
                    v-for="{ account, headroom, exhausted } in visibleNativeAccounts"
                    :key="account.id"
                    :title="account.label"
                    :state="account.needsReauth ? `reauth` : `connected`"
                    :tone="account.needsReauth ? `warning` : `default`"
                    :note="identityNote(account)"
                    :description="account.needsReauth ? (account.detail ?? `Signed out, reconnect to keep using it.`) : undefined"
                    :activity="account.needsReauth || !usageLoaded ? undefined : usageLine(account.id)"
                    :renamable="renamable"
                    :headroom="headroom"
                    :exhausted="exhausted"
                    @rename="(label: string) => renameAccount(account.id, label)"
                >
                    <template #control>
                        <Button
                            v-if="account.needsReauth && canConnectMore && !nativeFlowLive"
                            label="Reconnect"
                            size="small"
                            :loading="accountBusy === managedProvider"
                            @click="connectHere"
                        />
                        <Button
                            label="Disconnect"
                            size="small"
                            severity="danger"
                            :text="true"
                            :loading="accountBusy === account.id"
                            @click="disconnect(account.id)"
                        />
                    </template>
                </ConnectionRow>

                <!--
                    No account is still a row, same shape as a connected one, so it reads as a missing connection, not an apology.
                    Its action morphs Connect -> spinner -> Cancel as sign-in runs, never swapping in an unrequested control.
                -->
                <ConnectionRow
                    v-if="accountRows.length === 0"
                    :title="`${managedLabel} account`"
                    state="missing"
                    :note="nativeFlowLive ? `signing in…` : `not connected`"
                    :note-busy="nativeFlowLive"
                >
                    <template #control>
                        <Button v-if="nativeFlowLive" label="Cancel" size="small" severity="secondary" :text="true" @click="cancelConnect" />
                        <!-- Filled: with no account at all, this is the one action the group wants. -->
                        <Button v-else label="Connect" size="small" :loading="accountBusy === managedProvider" @click="connectHere">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <template v-if="nativeFlowLive || estates.length > 0" #below>
                        <!--
                            Estate chooser sits where the sign-in unfolds and is replaced by it, since choosing the estate is the connect's
                            first step, not a separate setting.
                        -->
                        <ConnectFlow v-if="nativeFlowLive" kind="native" :provider="managedProvider" />
                        <SegmentedControl
                            v-else
                            v-model="chosenEstate"
                            size="xs"
                            wrap
                            :options="estates.map((variant) => ({ label: variant.label, value: variant.id }))"
                            :aria-label="`Which ${managedLabel} plan`"
                        />
                    </template>
                </ConnectionRow>

                <!-- A second account is a different act from having none: its own quiet row where its sign-in also unfolds. -->
                <ConnectionRow
                    v-else-if="canConnectMore"
                    title="Add another account"
                    state="add"
                    :note="nativeFlowLive ? `signing in…` : undefined"
                    :note-busy="nativeFlowLive"
                    :interactive="!nativeFlowLive"
                    @click="!nativeFlowLive && connectHere()"
                >
                    <template v-if="nativeFlowLive" #control>
                        <Button label="Cancel" size="small" severity="secondary" :text="true" @click.stop="cancelConnect" />
                    </template>
                    <template v-if="nativeFlowLive || estates.length > 0" #below>
                        <ConnectFlow v-if="nativeFlowLive" kind="native" :provider="managedProvider" />
                        <SegmentedControl
                            v-else
                            v-model="chosenEstate"
                            size="xs"
                            wrap
                            :options="estates.map((variant) => ({ label: variant.label, value: variant.id }))"
                            :aria-label="`Which ${managedLabel} plan`"
                        />
                    </template>
                </ConnectionRow>
            </template>

            <!--
                Subscription rows (translator): the primary control for Codex/Kimi/Gemini, secondary under Grok's native
                account. Several can coexist (the translator balances turns across them), each with its own Disconnect; Codex/Grok/Kimi mint a
                one-time code, Google redirects instead.
            -->
            <template v-if="routedProvider">
                <ConnectionRow
                    v-for="{ account, headroom, exhausted } in translatorRows.slice(0, visibleRoutedLimit)"
                    :key="account.name"
                    :title="ROUTED_ROW[routedProvider].title"
                    state="connected"
                    :note="account.label"
                    :headroom="headroom"
                    :exhausted="exhausted"
                >
                    <template #control>
                        <Button
                            label="Disconnect"
                            size="small"
                            severity="danger"
                            :text="true"
                            :loading="accountBusy === translatorKey(routedProvider, account.name)"
                            @click="disconnectTranslator(routedProvider, account.name)"
                        />
                    </template>
                </ConnectionRow>

                <!--
                    No subscription: states what's missing with the one fix. Once connected, the same slot becomes a quiet "Add
                    another account" row, mirroring the native list.
                -->
                <ConnectionRow
                    v-if="translatorAccounts[routedProvider].length === 0"
                    :key="`connect-${routedProvider}`"
                    :title="ROUTED_ROW[routedProvider].title"
                    state="missing"
                    :note="routedFlowLive ? `signing in…` : `not connected`"
                    :note-busy="routedFlowLive"
                >
                    <template #control>
                        <Button
                            v-if="routedFlowLive"
                            label="Cancel"
                            size="small"
                            severity="secondary"
                            :text="true"
                            @click="cancelTranslatorConnect"
                        />
                        <!-- Filled only when this is the group's one connection; under Grok it stays secondary to the native row above. -->
                        <Button
                            v-else
                            label="Connect"
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
                    title="Add another account"
                    state="add"
                    :note="routedFlowLive ? `signing in…` : undefined"
                    :note-busy="routedFlowLive"
                    :interactive="!routedFlowLive"
                    @click="!routedFlowLive && connectTranslator(routedProvider)"
                >
                    <template v-if="routedFlowLive" #control>
                        <Button label="Cancel" size="small" severity="secondary" :text="true" @click.stop="cancelTranslatorConnect" />
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
                        {{ expanded ? `Show less` : `Show ${collapsedCount} more accounts` }}
                    </span>
                </template>
            </Row>
        </template>
    </RowGroup>
</template>
