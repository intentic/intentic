<script setup lang="ts">
import {
    type AccountState,
    type AgentProvider,
    type KeyedProvider,
    KeyedProviderSchema,
    mintedVariants,
    type OauthAccount,
    providerSpec,
} from "@intentic/sandbox-contract";
import { Button, formatMoney, formatTokens, timeAgo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { translatorAccounts } from "../../chat/accounts/providerAccounts";
import { accountsOf, subscriptionOnly } from "../../chat/accounts/useChat-accounts";
import { useChat } from "../../chat/run/useChat";
import { hasSignIn } from "../../chat/session/access";
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
import ConnectionRow from "../secrets/ConnectionRow.vue";
import EstatePicker from "../secrets/EstatePicker.vue";

// One provider's accounts, opened from its row in Sandbox ▸ Models: who each one signs in as, what it is spending, what
// it needs, and the way to add another or drop one. The AI-account card's rows, kept whole; what went is its eight-chip
// switcher (the overview above lists every provider at once) and its in-row sign-in (every sign-in on the page runs in
// the card at its top, so "Add another account" and "Reconnect" ask the page for one instead of unfolding it here).
//
// Two mechanisms draw the same: a provider's own account (Claude, Cursor, Grok's xAI, the minted ones) and a subscription
// held by the bundled translator (ChatGPT, Kimi, Google, Grok under Claude Code). Which one is behind a row is the
// sandbox's business, not the reader's.

const t = useT();

const { provider, live = false } = defineProps<{
    provider: AgentProvider;
    // A sign-in for this provider is in flight, in the page's card: the add row says so rather than offering another.
    live?: boolean;
}>();
// The page owns every sign-in; this list only says which kind it wants and, for a provider sold under several plans,
// which plan.
const emit = defineEmits<{ connect: [request: { via: `native` | `routed`; variant?: string }] }>();

const { accountBusy, accountUsage, usageLoaded, renameAccount, disconnect, disconnectTranslator, translatorKey } = useChat();

// The provider as the translator keys it, where it holds subscriptions there at all; parsed once, so every routed read
// below names a provider the translator knows rather than asserting one.
const keyed = computed<KeyedProvider | undefined>(() => {
    const parsed = KeyedProviderSchema.safeParse(provider);
    return parsed.success && providerSpec(provider)?.auth.kind === `translator` ? parsed.data : undefined;
});
const routed = computed(() => keyed.value !== undefined);
/* Codex, Kimi and Gemini own no native account: the subscription row IS their connection. */
const hasNative = computed(() => hasSignIn(provider) && !subscriptionOnly(provider));
const nativeAccounts = computed(() => (hasNative.value ? accountsOf(provider) : []));
const routedAccounts = computed(() => (keyed.value === undefined ? [] : (translatorAccounts.value[keyed.value] ?? [])));

// Which plan to sign in to, for a provider sold under several whose keys are not interchangeable (Z.ai, BigModel).
const estate = ref<string | undefined>(undefined);
const offersEstates = computed(() => (mintedVariants(provider)?.length ?? 0) > 1);
// Grok holds a single native account (OpenCode owns the xAI credential); "add another" goes once it is linked.
const canAddNative = computed(() => provider !== `grok` || nativeAccounts.value.length === 0);

// No two rows may read the same; distinguished in order: the identity the provider reports, the name (renamable in
// place), and failing both, when it was connected. Grok is exempt from renaming: OpenCode owns its one account.
const renameOf = (account: OauthAccount): ((label: string) => Promise<void>) | undefined =>
    provider === `grok` ? undefined : (label: string) => renameAccount(account.id, label, provider);

const ambiguousLabels = computed(() => {
    const seen = new Map<string, number>();
    for (const account of nativeAccounts.value) {
        seen.set(account.label, (seen.get(account.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
});

// Beside the name: who the account signs in as, or (if unknown and the name is ambiguous) when it connected. Drops
// repeated names and the provider's email-based personal organisation name.
const identityNote = (account: OauthAccount): string | undefined => {
    const personalOrganization =
        account.email !== undefined && account.organization?.trim().toLowerCase() === `${account.email.trim()}'s organization`.toLowerCase();
    const identity = [account.email, personalOrganization ? undefined : account.organization].filter(
        (part) => part !== undefined && part !== account.label,
    );
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguousLabels.value.has(account.label)
        ? t(`sandbox.aiAccountSection.connectedAgo`, { ago: timeAgo(account.connectedAt, { days: true }) })
        : undefined;
};

// Per-account spend, shown in the meter's card rather than on the row. Always a line once usage has loaded (even a
// zero-turn account); withheld entirely until then.
const usageLine = (id: string): string => {
    const usage = accountUsage.value[id];
    if (usage === undefined || usage.turns === 0) {
        return t(`sandbox.aiAccountSection.noTurnsYet`);
    }
    const cost = usage.costUsd > 0 ? ` · ${formatMoney(usage.costUsd)}` : ``;
    // Cache rate: cacheReadTokens / (cacheReadTokens + inputTokens), the share of prompt input served from cache.
    const cacheDenom = usage.cacheReadTokens + usage.inputTokens;
    const cache =
        usage.cacheReadTokens > 0 && cacheDenom > 0
            ? ` · ${t(`sandbox.aiAccountSection.cachedShare`, { tokens: formatTokens(usage.cacheReadTokens), pct: Math.round((100 * usage.cacheReadTokens) / cacheDenom) })}`
            : ``;
    return `${t(
        `sandbox.aiAccountSection.turnsInOut`,
        { count: usage.turns, input: formatTokens(usage.inputTokens), output: formatTokens(usage.outputTokens) },
        usage.turns,
    )}${cache}${cost}`;
};

interface AccountRow<T> {
    account: T;
    headroom: PlanHeadroom | undefined;
    state: AccountState;
    exhausted: boolean;
}

// Decorates and sorts in one pass: rows a person has to act on first (they are why a reader opens this), then active,
// then spent; an account with no reading counts as active (unknown is not exhausted). Order within each group is the
// daemon's.
const rowsOf = <T,>(accounts: readonly T[], factsOf: (account: T) => AccountFacts): AccountRow<T>[] => {
    const attention: AccountRow<T>[] = [];
    const active: AccountRow<T>[] = [];
    const spent: AccountRow<T>[] = [];
    for (const account of accounts) {
        const facts = factsOf(account);
        const state = accountState(provider, facts);
        const waiting = state.kind === `spent` || (state.kind === `blocked` && state.fix === `wait`);
        const row = { account, headroom: planHeadroom(liveUsage(provider, facts.account)), state, exhausted: waiting };
        (row.exhausted ? spent : state.kind === `blocked` ? attention : active).push(row);
    }
    return [...attention, ...active, ...spent];
};

// Why a dimmed row is dimmed: a spent allowance and when it reopens, or a bench that lifts by itself and when.
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
// before it serves again. A Google account with no project needs Google's own onboarding, so that one names the door.
const stateLine = (state: AccountState, label: string, signedOut: boolean): string | undefined => {
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
        ? t(`sandbox.aiAccountSection.geminiFinishSetup`, { reason: state.reason })
        : state.reason;
};

// The row's dot by who can fix it: the person here (`reauth`), or somebody this sandbox cannot reach (`blocked`).
const connectionState = (state: AccountState): `connected` | `reauth` | `blocked` =>
    state.kind !== `blocked` || state.fix === `wait` ? `connected` : state.fix === `admin` ? `blocked` : `reauth`;

const verifyUrl = (state: AccountState): string | undefined => (state.kind === `blocked` && state.fix === `verify` ? state.url : undefined);

// Opened in a new tab: the person signs in there as that account, and this tab keeps its place.
const openVerify = (url: string): void => {
    window.open(url, `_blank`, `noopener,noreferrer`);
};

const needsReconnect = (state: AccountState): boolean => state.kind === `blocked` && state.fix === `reconnect`;

interface AccountView {
    readonly key: string;
    readonly title: string;
    readonly note: string | undefined;
    readonly description: string | undefined;
    readonly state: AccountState;
    readonly headroom: PlanHeadroom | undefined;
    readonly exhausted: boolean;
    readonly activity: string | undefined;
    readonly rename: ((label: string) => Promise<void>) | undefined;
    readonly verify: string | undefined;
    // Signing in again replaces this credential in place; only the native sign-in can.
    readonly reconnect: boolean;
    readonly busy: string;
    readonly disconnect: () => void;
}

const nativeViews = computed<readonly AccountView[]>(() =>
    rowsOf(nativeAccounts.value, accountFacts).map(({ account, headroom, exhausted, state }) => ({
        key: account.id,
        title: account.label,
        note: identityNote(account),
        description: stateLine(state, account.label, account.needsReauth === true && account.detail === undefined),
        state,
        headroom,
        exhausted,
        activity: needsReconnect(state) || !usageLoaded.value ? undefined : usageLine(account.id),
        rename: renameOf(account),
        verify: verifyUrl(state),
        reconnect: needsReconnect(state) && canAddNative.value,
        busy: account.id,
        disconnect: () => void disconnect(account.id, provider),
    })),
);

// A subscription is named by whoever signs in to it (the translator's label is that email). Only Grok, which can hold
// both kinds side by side, says which kind this is.
const routedViews = computed<readonly AccountView[]>(() =>
    rowsOf(routedAccounts.value, routedAccountFacts).map(({ account, headroom, exhausted, state }) => ({
        key: `${provider}:${account.name}`,
        title: account.label,
        note: provider === `grok` ? t(`sandbox.aiAccountSection.viaClaudeCode`) : undefined,
        description: stateLine(state, account.label, false),
        state,
        headroom,
        exhausted,
        activity: undefined,
        rename: undefined,
        verify: verifyUrl(state),
        reconnect: false,
        busy: translatorKey(provider, account.name),
        disconnect: () => {
            if (keyed.value !== undefined) {
                void disconnectTranslator(keyed.value, account.name);
            }
        },
    })),
);

// Collapses beyond COLLAPSE_THRESHOLD rows (both mechanisms together), so one provider cannot push the rest of the list
// off screen.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);
const total = computed(() => nativeViews.value.length + routedViews.value.length);
const shouldCollapse = computed(() => total.value > COLLAPSE_THRESHOLD);

// What an empty mechanism is called, before there is an account to name it. Only drawn beside the other mechanism's
// rows: a provider with no account at all is offered under "Add a model", not here.
const ROUTED_EMPTY = computed(
    () =>
        ({
            codex: t(`sandbox.aiAccountSection.chatgptSubscription`),
            grok: t(`sandbox.aiAccountSection.underClaudeCode`),
            kimi: t(`sandbox.aiAccountSection.kimiCodeSubscription`),
            gemini: t(`sandbox.aiAccountSection.googleAccount`),
        }) satisfies Record<KeyedProvider, string>,
);
const providerName = computed(() => providerSpec(provider)?.accountLabel ?? provider);

interface AccountGroup {
    readonly key: string;
    readonly via: `native` | `routed`;
    readonly rows: readonly AccountView[];
    readonly empty: boolean;
    readonly emptyTitle: string;
    readonly canAdd: boolean;
    // Filled only where it is the provider's second way in; under Grok the subscription stays the quieter one.
    readonly secondary: boolean;
}

const groups = computed<readonly AccountGroup[]>(() => {
    const collapsed = shouldCollapse.value && !expanded.value;
    // Collapsed, native rows take the first slots and routed rows fill whatever they left.
    const nativeShown = collapsed ? nativeViews.value.slice(0, VISIBLE_WHEN_COLLAPSED) : nativeViews.value;
    const routedShown = collapsed ? routedViews.value.slice(0, Math.max(0, VISIBLE_WHEN_COLLAPSED - nativeShown.length)) : routedViews.value;
    const shown: AccountGroup[] = [];
    if (hasNative.value) {
        shown.push({
            key: `native`,
            via: `native`,
            rows: nativeShown,
            empty: nativeViews.value.length === 0,
            emptyTitle: t(`sandbox.aiAccountSection.account`, { managedLabel: providerName.value }),
            canAdd: canAddNative.value,
            secondary: false,
        });
    }
    if (keyed.value !== undefined) {
        shown.push({
            key: `routed`,
            via: `routed`,
            rows: routedShown,
            empty: routedViews.value.length === 0,
            emptyTitle: ROUTED_EMPTY.value[keyed.value],
            canAdd: true,
            secondary: provider === `grok`,
        });
    }
    return shown;
});

const ask = (via: `native` | `routed`): void => emit(`connect`, via === `native` && offersEstates.value ? { via, variant: estate.value } : { via });
</script>

<template>
    <div class="divide-y divide-line-subtle">
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
                    <Button
                        v-if="row.verify !== undefined"
                        :label="t(`sandbox.aiAccountSection.verify`)"
                        size="small"
                        @click="openVerify(row.verify)"
                    >
                        <template #icon><Icon name="external-link" /></template>
                    </Button>
                    <Button v-else-if="row.reconnect && !live" :label="t(`ui.action.reconnect`)" size="small" @click="ask(group.via)" />
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

            <!-- A mechanism with nothing in it, beside the other's rows (Grok's two ways in): a missing connection, not an apology. -->
            <ConnectionRow
                v-if="group.empty"
                :key="`${group.key}-empty`"
                :title="group.emptyTitle"
                state="missing"
                :note="live ? t(`connect.providerTile.signingIn`) : t(`sandbox.words.notConnected`)"
            >
                <template v-if="!live" #control>
                    <Button
                        :label="t(`ui.action.connect`)"
                        size="small"
                        :severity="group.secondary ? `secondary` : undefined"
                        @click="ask(group.via)"
                    >
                        <template #icon><Icon name="link" /></template>
                    </Button>
                </template>
            </ConnectionRow>

            <!-- A second account is a different act from having none: its own quiet row. Its sign-in runs in the card at the top. -->
            <ConnectionRow
                v-else-if="group.canAdd"
                :key="`${group.key}-add`"
                :title="t(`sandbox.aiAccountSection.addAnotherAccount`)"
                state="action"
                icon="plus"
                :note="live ? t(`connect.providerTile.signingIn`) : undefined"
                :interactive="!live"
                @click="!live && ask(group.via)"
            >
                <!-- The plan is the sign-in's own first step, so it is asked where the press is made, before anything starts. -->
                <template v-if="group.via === `native` && offersEstates && !live" #below>
                    <!-- `.stop`: a press on the plan must not also count as the row's press, which starts the sign-in. -->
                    <div @click.stop>
                        <EstatePicker
                            v-model="estate"
                            :provider="provider"
                            :label="t(`sandbox.aiAccountSection.plan`, { managedLabel: providerName })"
                        />
                    </div>
                </template>
            </ConnectionRow>
        </template>

        <ConnectionRow
            v-if="shouldCollapse"
            :title="
                expanded
                    ? t(`ui.action.showLess`)
                    : t(`sandbox.aiAccountSection.showMoreAccounts`, { collapsedCount: total - VISIBLE_WHEN_COLLAPSED })
            "
            state="action"
            :icon="expanded ? `chevron-up` : `chevron-down`"
            interactive
            @click="expanded = !expanded"
        />
    </div>
</template>
