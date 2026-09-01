<script setup lang="ts">
import {
    type AccountUsage,
    type AgentProvider,
    isFreeProvider,
    type KeyedProvider,
    type OauthAccount,
    type TranslatorAccount,
    providerLabel,
} from "@intentic/sandbox-contract";
import { Button, formatTokens, InfoHint, Notice, type NoticeModel, Row, RowGroup } from "@intentic/ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { providerReady } from "../../composables/chat/access";
import { relativeTime } from "../../composables/chat/catalog";
import { providerRefusals } from "../../composables/chat/providerAccounts";
import { providerTabs } from "../../composables/chat/providerCatalog";
import { refreshConnections, useChat } from "../../composables/chat/useChat";
import { isSpent, liveUsage, type PlanHeadroom, planHeadroom, refusalFor } from "../../composables/chat/usageStatus";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import ConnectFlow from "./ConnectFlow.vue";
import ConnectionRow from "./ConnectionRow.vue";

/* The AI accounts the sandbox's agent signs in as: the Agent tab's first section, and the one place in the
 * product where a credential is added or dropped. Five providers, two mechanisms (a provider's own account, a
 * subscription served by the bundled translator), ONE way of looking and behaving:
 *
 *   · a provider switcher whose dots answer "which AI can my agent use?" without a click each
 *   · one row per connection, all in the same anatomy (ConnectionRow)
 *   · one sign-in panel, unfolding inside the row that started it (ConnectFlow)
 *   · one action per row, which MORPHS through the sign-in (Connect → spinner → Cancel) rather than being
 *     replaced by controls that appear from somewhere else
 *
 * Two rules hold the whole thing together, and both exist because this card broke them:
 *
 * NOTHING HAPPENS THAT WASN'T ASKED FOR. Switching provider used to fire a connect handshake by itself for
 * three of the five tabs, so a look at a tab painted a Connect button, silently minted a one-time device code,
 * and then swapped the button for that code: a flicker with a 15-minute poll attached. Browsing is now just
 * browsing (useChat.setManagedProvider); every sign-in starts from a button.
 *
 * AN UNREAD STATE IS NOT AN EMPTY ONE. Connections live on the daemon and are read when it answers, which can
 * be a probe and a tunnel round-trip away. Until then this section shows that it is loading rather than
 * claiming "not connected" and taking it back: see `accountsLoaded`. */

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
/* The chat store reports a bare message; this section knows the user is here to connect an account.
 *
 * The store's message lands in `detail` on the noticeFrom convention: the app's sentence leads, the caught one
 * is evidence, and that is the slot the DAEMON's sentence arrives in for a failed sign-in. Which is why this
 * card was useless for so long: oRPC replaced every message the translator routes threw with "Internal server
 * error" (fixed at the source in translator.routes.ts), so the evidence line named no cause and the headline
 * was all the reader got. The pairing is right; the wire was dropping half of it. */
const chatNotice = computed<NoticeModel | undefined>(() =>
    chatError.value === null ? undefined : { tone: `danger`, title: `Couldn't reach your AI accounts.`, detail: chatError.value },
);

// The subscription connections, served by the sandbox's translator (CLIProxyAPI). For ChatGPT, Kimi Code and
// Google they are the only connections. For Grok they're secondary rows beneath the native account
// (the account runs Grok's own harness; a subscription runs Grok models UNDER the Claude Code harness). Claude
// has no row: it IS the Claude Code harness. A provider can hold several subscription accounts, the translator
// balances turns across them, so each renders as a row of its own.
const routedProvider = computed<KeyedProvider | undefined>(() =>
    managedProvider.value === `codex` || managedProvider.value === `grok` || managedProvider.value === `kimi` || managedProvider.value === `gemini`
        ? managedProvider.value
        : undefined,
);
// The full mechanic is parked behind the row's (i) rather than printed on screen.
const ROUTED_ROW: Record<KeyedProvider, { title: string; about: string }> = {
    codex: {
        title: `ChatGPT subscription`,
        about: `Runs Codex on your ChatGPT subscription, everywhere: on its own and under the Claude Code harness.`,
    },
    grok: {
        title: `Under Claude Code`,
        about: `Runs Grok models under the Claude Code harness on your SuperGrok / X Premium subscription, a separate sign-in from the Grok account above.`,
    },
    kimi: {
        title: `Kimi Code subscription`,
        about: `Runs Kimi models under the Claude Code harness on your Kimi Code subscription, no API key or metered API balance required.`,
    },
    gemini: {
        title: `Google account`,
        about: `Runs Gemini, Claude and GPT-OSS models under the Claude Code harness on your Google account, free, and the one connection this provider needs.`,
    },
};

// Codex, Kimi and Gemini own no native account: the subscription row IS their connection.
const hasNativeAccounts = computed(() => managedProvider.value !== `codex` && managedProvider.value !== `kimi` && managedProvider.value !== `gemini`);
// Grok holds a single account (OpenCode owns the xAI credential), so hide "connect another" once it's linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// Whether a sign-in is unfolding under this provider's native / routed row right now. Both flows carry the
// provider they belong to, so browsing the switcher mid-sign-in hides the flow rather than moving it.
const nativeFlowLive = computed(() => nativeConnectFlow.value?.provider === managedProvider.value);
const routedFlowLive = computed(() => routedProvider.value !== undefined && translatorConnectFlow.value?.provider === routedProvider.value);

/* NO TWO ROWS MAY READ THE SAME. A list whose every entry says "Claude" answers none of the questions the list
 * exists for, which account is this, is it the one my last turn ran on, which one am I about to disconnect:
 * and that is what these three pieces fix, in order of how much they actually tell you:
 *
 *   1. the identity the provider itself reports (Claude returns the email + organization with the token), shown
 *      beside the name because the NAME is the user's to change and can be anything;
 *   2. the name, renamable in place: the answer when the derived identity isn't what the user calls an account;
 *   3. failing both, when two rows still read alike, when each was connected: a weak difference, but a real one,
 *      and infinitely better than none.
 *
 * Grok is the exception to (2): OpenCode owns that credential and holds exactly one, so there is nothing to
 * rename and nothing it could be confused with. */
const renamable = computed(() => managedProvider.value !== `grok`);

// Labels shared by more than one of this provider's accounts: the rows that cannot be told apart on name alone.
const ambiguousLabels = computed(() => {
    const seen = new Map<string, number>();
    for (const account of managedAccounts.value) {
        seen.set(account.label, (seen.get(account.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
});

// The line beside the name: who this account signs in as, or, when the provider told us nothing and the name
// is shared with another row, when it was connected. Parts equal to the name are dropped: an account named by
// its own email must not print that email twice.
const identityNote = (account: OauthAccount): string | undefined => {
    const identity = [account.email, account.organization].filter((part) => part !== undefined && part !== account.label);
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguousLabels.value.has(account.label) ? `connected ${relativeTime(account.connectedAt)}` : undefined;
};

/* A short usage summary line per account (from /system/usage), shown INSIDE the ring's card rather than under
 * the row (see ConnectionRow's `activity`).
 *
 * It used to be a permanent second line on every row, and that is what turned this list into a page of figures:
 * turns, tokens in, tokens out, cache rate and dollars, repeated per account, above the one question the list
 * exists to answer. None of it is status: it never changes what you would DO with the row. On the card it costs
 * nothing until asked for, and it lands beside the pools, where a reader comparing spend to allowance already is.
 *
 * ALWAYS A LINE, once the read has landed: an account with no turns yet says so rather than dropping it, so the
 * card never opens with a hole where a figure should be. Withheld entirely until the read lands, since the card
 * is opened deliberately and a half-built one is worse than one that grew. */
const usageLine = (id: string): string => {
    const usage = accountUsage.value[id];
    if (usage === undefined || usage.turns === 0) {
        return `No turns on this account yet.`;
    }
    const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ``;
    // Cache read = prompt tokens served from the provider's cache; the rate is the share of prompt input that
    // hit the cache (read / (read + uncached input)): how effective prefix caching is for this account.
    const cacheDenom = usage.cacheReadTokens + usage.inputTokens;
    const cache =
        usage.cacheReadTokens > 0 && cacheDenom > 0
            ? ` · ${formatTokens(usage.cacheReadTokens)} cached (${Math.round((100 * usage.cacheReadTokens) / cacheDenom)}%)`
            : ``;
    return `${usage.turns} turns · ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out${cache}${cost}`;
};

/* --- Usage ring per account ---------------------------------------------------------------------------------
 * Plan-limit utilization surfaced as a ring on the connection row, so this list answers at a glance which
 * accounts still have headroom and which are spent without a trip to the Usage tab.
 *
 * ONE path for every provider, because by the time a row reaches this component the difference between a native
 * account and a routed subscription is already gone: the daemon puts the same `usage` on both (see
 * AccountUsageSchema), whether it read it from a Claude turn's stream or pulled it from the translator. What a
 * ring MEANS lives in usageStatus.ts with the composer's: the threshold, the tone and the merge with a live
 * turn's frame are shared, not re-decided here.
 *
 * Rows are decorated ONCE rather than per binding: the row used to hand the ring three separate props off three
 * separate calls per render (plus a fourth for the dimming), and that duplication is exactly what let the ring
 * and the row's own dimming disagree about which accounts were spent. One projection, passed down whole. */

// A row ready to render: the account, its headroom (the ring and the card behind it), and whether it is
// effectively spent. The headroom also carries when the reading was taken, which the provider's refusal line
// needs to tell whether a reading has overtaken it (refusalIsCurrent): a question about the whole list rather
// than about any one row.
interface AccountRow<T> {
    account: T;
    headroom: PlanHeadroom | undefined;
    exhausted: boolean;
}

/* Decorate and sort in one pass. When a provider holds dozens of accounts the list is only useful if the ones
 * with headroom are at the top; an account with no reading counts as active, because unknown ≠ exhausted.
 * Within each group the daemon's order holds. */
const rowsOf = <T,>(
    provider: AgentProvider,
    accounts: readonly T[],
    keyOf: (account: T) => string,
    usageOf: (account: T) => AccountUsage | undefined,
): AccountRow<T>[] => {
    const active: AccountRow<T>[] = [];
    const spent: AccountRow<T>[] = [];
    for (const account of accounts) {
        const usage = liveUsage(provider, keyOf(account), usageOf(account));
        const row = { account, headroom: planHeadroom(usage), exhausted: isSpent(usage) };
        (row.exhausted ? spent : active).push(row);
    }
    return [...active, ...spent];
};

const accountRows = computed<readonly AccountRow<OauthAccount>[]>(() =>
    rowsOf(
        managedProvider.value,
        managedAccounts.value,
        (account) => account.id,
        (account) => account.usage,
    ),
);

const translatorRows = computed<readonly AccountRow<TranslatorAccount>[]>(() =>
    routedProvider.value === undefined
        ? []
        : rowsOf(
              routedProvider.value,
              translatorAccounts.value[routedProvider.value],
              (account) => account.name,
              (account) => account.usage,
          ),
);

/* --- The provider's last refusal --------------------------------------------------------------------------
 * ONE line for the whole section rather than one per row, because that is the resolution of the fact: a routed
 * turn is served by whichever auth file CLIProxyAPI picks, so a refusal belongs to the provider the switcher is
 * on. Repeating it down 31 Google rows would restate one event 31 times.
 *
 * It earns a place beside the rings because it answers what a ring cannot. A ring is polled: at turn end for
 * Claude, on a five-minute sweep for the routed subscriptions, and the pools are account-wide, so every other
 * client on the plan drains them without this sandbox hearing about it. The refusal is the moment the plan
 * actually said no. Together they are readable: a green ring under a fresh refusal says the ring is stale.
 *
 * This is the state that sent someone here to reconnect a Kimi account in perfect health: the chat said
 * "Failed to authenticate", because that is what the harness prints over a 403, and the Agent tab showed a
 * healthy green dot beside it with nothing to reconcile the two. */
// Loud only while nothing that happened since has answered it: see refusalNote, which also decides what a
// refusal SAYS in each of those two states. Judged over both lists, because the provider's accounts are one list
// to the reader whichever mechanism holds them, and asked of refusalFor rather than assembled here, so this line
// and the pool the rings beside it draw as spent can only ever come from the same verdict.
const refusal = computed(() => refusalFor(managedProvider.value));

/* --- Collapsing long lists -----------------------------------------------------------------------------------
 * Five accounts fit comfortably; beyond that the card becomes a scroll trap that pushes the rest of the Agent
 * page off screen. Show the first three and collapse the rest behind a toggle. The threshold is on TOTAL visible
 * rows (native + routed), not on either list alone, so a mix of two native + four routed collapses correctly. */
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);

// The count of ALL visible accounts, both native and routed: the metric that decides whether collapsing fires.
const totalAccountCount = computed(() => accountRows.value.length + translatorRows.value.length);
const shouldCollapse = computed(() => totalAccountCount.value > COLLAPSE_THRESHOLD);
const collapsedCount = computed(() => totalAccountCount.value - VISIBLE_WHEN_COLLAPSED);

// How many native accounts to show when collapsed: the first VISIBLE_WHEN_COLLAPSED, unless routed rows exist
// and would push the total above VISIBLE_WHEN_COLLAPSED: then native gets fewer to make room for at least one
// routed row. When expanded, all of them.
const visibleNativeAccounts = computed<readonly AccountRow<OauthAccount>[]>(() => {
    if (!shouldCollapse.value || expanded.value) {
        return accountRows.value;
    }
    return accountRows.value.slice(0, VISIBLE_WHEN_COLLAPSED);
});

// How many routed accounts to show when collapsed: fill the remaining slots after native accounts.
const visibleRoutedLimit = computed(() => {
    if (!shouldCollapse.value || expanded.value) {
        return Infinity;
    }
    return Math.max(0, VISIBLE_WHEN_COLLAPSED - visibleNativeAccounts.value.length);
});

// The switcher's own label for the managed provider ("Kimi Code", not "Kimi"), so the empty row names the
// provider with the words the chip the user just pressed used.
const managedLabel = computed(() => providerTabs.find((tab) => tab.value === managedProvider.value)?.label ?? providerLabel(managedProvider.value));

/* Arriving from a chat's "Connect account" gate carries `?connect=<provider>`: open that provider's rows, flash
 * them, and start the sign-in: the deep link IS the click, so finishing it here is continuing an action rather
 * than performing one uninvited (which is precisely why the provider SWITCHER no longer does this).
 * Driven by a watch, not just onMounted: the chat panel lives in the persistent shell, so the gate can deep-link
 * here while this tab is already open: a query-only navigation doesn't remount the component. */
const route = useRoute();
const ringing = ref(false);
let ringTimer: ReturnType<typeof setTimeout> | undefined;

// The sign-in the deep link asked for, through whichever mechanism the provider actually uses. Never a second
// one: a live flow already IS the answer, and re-arming would mint a fresh code that diverges from the sign-in
// tab the user has open. Nor one for a provider that is already connected: a stale link is not a request to
// add an account.
const connectRequested = (target: AgentProvider): void => {
    if (nativeConnectFlow.value !== undefined || translatorConnectFlow.value !== undefined || providerReady(target)) {
        return;
    }
    if (target === `codex` || target === `kimi` || target === `gemini`) {
        void connectTranslator(target);
        return;
    }
    void startConnect();
};

const focusConnect = (): void => {
    const requested = providerTabs.find((tab) => tab.value === route.query[`connect`]);
    if (requested === undefined) {
        return;
    }
    setManagedProvider(requested.value);
    // Re-arm the flash cleanly on a repeat jump so a prior timer can't cut the ring short.
    ringing.value = true;
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => (ringing.value = false), 2500);
    // Let the card render, then bring it into view.
    setTimeout(() => document.getElementById(`ai-account`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    connectRequested(requested.value);
};

onMounted(() => {
    /* Ask on open, rather than waiting for the reachable seam to have asked. That seam fires on the first
     * liveness success: a probe plus a tunnel round-trip away, so landing here inside that window used to mean
     * sitting in front of a card that had never asked the daemon anything. It is also simply out of date by now:
     * another device may have connected or dropped something since. Between them, that is why connected accounts
     * "took forever to show up"; now the wait is this request, and the skeletons say so while it runs. */
    void refreshConnections();
    void loadUsage();
    showActiveProvider();
    focusConnect();
});
watch(() => route.query[`connect`], focusConnect);
// No teardown on the way out: leaving the tab must not kill a sign-in the user is completing at x.ai (see
// useChat.cancelConnect for the list of things that legitimately end a handshake).
onUnmounted(() => clearTimeout(ringTimer));
</script>

<template>
    <!-- A RowGroup like every other section on this page, NOT a Card: the connections are a grouped list, and
         wrapping that list in a card put a bordered surface inside a bordered surface for no gain: the group
         label carries the heading. -->
    <!-- The deep-link flash rings the whole group (label included). `-m-1 p-1` holds the layout still while it
         does: the ring needs room to sit outside the surface, and growing the section for 2.5s would shove the
         page. -->
    <RowGroup id="ai-account" label="AI account" :class="ringing ? '-m-1 rounded-xl p-1 ring-2 ring-info' : ''">
        <template #info>
            <InfoHint label="About AI accounts">
                <span class="block text-xs text-content">
                    The accounts your agent signs in as. Every credential is stored inside your sandbox, never on the platform: connecting here signs
                    the sandbox in, not this browser.
                </span>
            </InfoHint>
        </template>
        <!-- The provider switcher rides the group label (where "Command output" carries its own trailing
             controls), and the dot per chip is the point: this group shows ONE provider at a time, so without it
             the question it exists to answer, which AI can my agent use?: costs a click each. The dot has
             THREE states, not two: while the connections are still being read it pulses, because a grey dot
             claiming "not connected" for every provider is exactly the answer this section keeps getting wrong. -->
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
                        :class="!accountsLoaded ? 'animate-pulse bg-content/25' : providerReady(tab.value) ? 'bg-success' : 'bg-content/25'"
                        :aria-label="!accountsLoaded ? `checking` : providerReady(tab.value) ? `connected` : `not connected`"
                    />
                    {{ tab.label }}
                    <!-- The one chip that costs nothing, said on the chip itself. The card behind it has always
                         led with "Free", but only after a click, so a user pricing up five identical-looking
                         chips had to open each one to find the answer that decides which they press. Dropped
                         once it IS connected: a connected provider should read as the plain default rather than
                         keep advertising, which is the same rule accessBadge follows. -->
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

        <!-- The provider's own words, the last time it refused a turn (see `refusal` above). An alert while it
             is the newest thing known about this provider; once something taken since has answered it, a quiet
             footnote saying so with those words on the hover: a stale alarm over a live meter is worse than no
             alarm at all. -->
        <Notice v-if="refusal !== undefined && refusal.current" tone="warning" class="m-3">{{ refusal.line }}</Notice>
        <p v-else-if="refusal !== undefined" class="mx-3 mt-3 text-2xs text-subtle" v-tooltip.top="refusal.detail">{{ refusal.line }}</p>

        <!-- Nothing has been read yet. An offline sandbox says so and stops (there is nothing to wait for);
             otherwise the rows that are coming stand in as skeletons, in their own shape, so the section keeps
             its height and its silhouette instead of popping into existence a moment later. -->
        <ConnectionRow
            v-if="!accountsLoaded && !reachable"
            title="Connections unavailable"
            state="missing"
            description="Your sandbox is offline: its accounts can't be read or changed from here."
        />
        <template v-else-if="!accountsLoaded">
            <!-- Two lines, because a connected row has two: the name and the usage line under it. An outline
                 that promises only the name is an outline the list outgrows the moment it lands. -->
            <Row v-for="placeholder in 2" :key="`loading-${placeholder}`" aria-hidden="true">
                <template #title>
                    <span class="flex min-w-0 items-center gap-2.5">
                        <span class="flex w-[1.125rem] shrink-0 justify-center">
                            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-content/25" />
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

        <!-- Every connection this provider has (native accounts and translator subscriptions alike) as rows of
             ONE list. They are different mechanisms but the same question ("what am I signed in with, and can I
             drop it?"), so they share a row shape: status dot, name, live state, one action. A sign-in in
             progress opens in the row's own #below, so it stays inside that row's hairline instead of spawning
             an inset panel detached from the thing it connects. -->
        <template v-else>
            <!-- Native accounts (Claude and Grok), each disconnectable on its own. Codex, Kimi and Gemini have
                 none: the subscription row below IS their connection, so they skip straight to it. -->
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
                            @click="startConnect"
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

                <!-- No account yet is a ROW, not a sentence floating above a button: same shape as a connected
                     one, so the empty state reads as the connection that is missing rather than as an apology,
                     and its action sits where every other row's action sits. That action is also the only thing
                     that changes as the sign-in runs: Connect, then Connect spinning, then Cancel, so the
                     handshake never arrives as a control the user didn't press anything to get. -->
                <ConnectionRow
                    v-if="accountRows.length === 0"
                    :title="`${managedLabel} account`"
                    state="missing"
                    :note="nativeFlowLive ? `signing in…` : `not connected`"
                    :note-busy="nativeFlowLive"
                >
                    <template #control>
                        <Button v-if="nativeFlowLive" label="Cancel" size="small" severity="secondary" :text="true" @click="cancelConnect" />
                        <!-- Filled: with no account at all, this is the one thing the group is asking for. -->
                        <Button v-else label="Connect" size="small" :loading="accountBusy === managedProvider" @click="startConnect">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <template v-if="nativeFlowLive" #below><ConnectFlow kind="native" :provider="managedProvider" /></template>
                </ConnectionRow>

                <!-- Adding a SECOND account is a different act from having none: its own quiet row at the end of
                     the list, which is also where the handshake it starts unfolds. -->
                <ConnectionRow
                    v-else-if="canConnectMore"
                    title="Add another account"
                    state="add"
                    :note="nativeFlowLive ? `signing in…` : undefined"
                    :note-busy="nativeFlowLive"
                    :interactive="!nativeFlowLive"
                    @click="!nativeFlowLive && startConnect()"
                >
                    <template v-if="nativeFlowLive" #control>
                        <Button label="Cancel" size="small" severity="secondary" :text="true" @click.stop="cancelConnect" />
                    </template>
                    <template v-if="nativeFlowLive" #below><ConnectFlow kind="native" :provider="managedProvider" /></template>
                </ConnectionRow>
            </template>

            <!-- The subscription connection (translator). ChatGPT/Codex, Kimi and Gemini: the ONE connection kind, so
                 it's the group's primary control. Grok: rows beneath the native account, for running Grok UNDER
                 the Claude Code harness. A provider can hold SEVERAL subscription accounts side by side: the
                 translator balances turns across them, so a second account is more headroom, and each renders
                 as its own row with its own Disconnect, mirroring the native list above. Codex/Grok/Kimi mint a
                 one-time code and the translator connects on its own; Google redirects instead, so that flow
                 asks for the landing URL back. Either way the shared poll lands the new account's row. -->
            <template v-if="routedProvider">
                <ConnectionRow
                    v-for="{ account, headroom, exhausted } in translatorRows.slice(0, visibleRoutedLimit)"
                    :key="account.name"
                    :title="ROUTED_ROW[routedProvider].title"
                    state="connected"
                    :note="account.label"
                    :about="ROUTED_ROW[routedProvider].about"
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

                <!-- No subscription yet: the row states what is missing and offers the one action that fixes it.
                     With one connected, the same slot quiets down to "Add another account": a different act
                     from having none, so it borrows the native list's quiet plus-row shape. Either way the
                     sign-in it starts unfolds below this row. -->
                <ConnectionRow
                    v-if="translatorAccounts[routedProvider].length === 0"
                    :key="`connect-${routedProvider}`"
                    :title="ROUTED_ROW[routedProvider].title"
                    state="missing"
                    :note="routedFlowLive ? `signing in…` : `not connected`"
                    :note-busy="routedFlowLive"
                    :about="ROUTED_ROW[routedProvider].about"
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
                        <!-- Filled accent only where this row IS the group's one connection (Codex/Gemini). Under
                             Grok it's the alternative to the native account right above it, and a filled accent
                             there makes the lesser path the loudest thing on the page. -->
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

            <!-- Collapse toggle: when more than COLLAPSE_THRESHOLD accounts, the list is truncated to keep the
                 page scannable. The toggle sits at the seam, styled as a quiet link inside its own row so it
                 aligns with the rows above and doesn't float between sections. -->
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
