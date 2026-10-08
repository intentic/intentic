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
import { Button, formatMoney, formatTokens, Icon, Notice, type NoticeModel, RowGroup, RowNote, timeAgo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useTemplateRef } from "vue";
import { accountsOutdated } from "../../chat/accounts/accountsOutdated";
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
import SandboxOutdatedNotice from "../overview/version/SandboxOutdatedNotice.vue";
import ConnectionRow from "../secrets/ConnectionRow.vue";
import EstatePicker from "../secrets/EstatePicker.vue";
import ConnectAttempt from "./ConnectAttempt.vue";

// ONE PROVIDER, opened from its tile in Sandbox ▸ Models' grid: everything about it in one card. Its accounts (who each
// one signs in as, what it is spending, what it needs, drop one), the one button that adds one, and the sign-in itself
// while it runs, under the accounts it is adding to. There is no other door to a provider's sign-in on the page: the
// grid picks the provider, this panel connects it.
//
// Empty, the card is the explanation and the Connect button, as an empty persona list is its own Add button; once it holds
// an account, adding another moves to the group's header, where every list in the app keeps its "add one".
//
// Two mechanisms draw the same: a provider's own account (Claude, Cursor, Grok's xAI, the minted ones) and a subscription
// held by the bundled translator (ChatGPT, Kimi, Google, Grok under Claude Code). Which one is behind a row is the
// sandbox's business, not the reader's.

const t = useT();

const {
    provider,
    attempt,
    finishing = false,
    otherLive,
    busy = false,
    landed,
    found = false,
    notice,
} = defineProps<{
    provider: AgentProvider;
    // This provider's sign-in, when one is starting, waiting on the reader, or just failed.
    attempt?: { readonly phase: `starting` | `live` | `failed`; readonly kind?: `native` | `routed`; readonly problem?: string };
    finishing?: boolean;
    // Another provider's sign-in still waiting: starting one here replaces it, which the panel says before the press.
    otherLive?: AgentProvider;
    // A sign-in is on its way to the sandbox: no second press until it answers.
    busy?: boolean;
    // What just connected here, in a sentence naming the sandbox it went to.
    landed?: string;
    // The desktop app found this provider signed in on this computer.
    found?: boolean;
    // Something an account write here was refused for (a disconnect).
    notice?: NoticeModel;
}>();
// The page owns every sign-in, so there is one at a time; this panel only says which kind it wants and, for a provider
// sold under several plans, which plan.
const emit = defineEmits<{
    connect: [request: { via: `native` | `routed`; variant?: string }];
    cancel: [];
    retry: [];
    dismiss: [];
    chat: [];
    show: [provider: AgentProvider];
    dismissNotice: [];
}>();

const spec = computed(() => providerSpec(provider));
const signingInHere = computed(() => attempt !== undefined && attempt.phase !== `failed`);

const attemptBlock = useTemplateRef<InstanceType<typeof ConnectAttempt>>(`attemptBlock`);
defineExpose({ reveal: () => attemptBlock.value?.reveal() });

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

// Collapses beyond COLLAPSE_THRESHOLD rows, so a provider holding thirty accounts does not push its own sign-in a
// screen down.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);
const rows = computed(() => [
    ...nativeViews.value.map((row) => ({ ...row, via: `native` as const })),
    ...routedViews.value.map((row) => ({ ...row, via: `routed` as const })),
]);
const shouldCollapse = computed(() => rows.value.length > COLLAPSE_THRESHOLD);
const shownRows = computed(() => (shouldCollapse.value && !expanded.value ? rows.value.slice(0, VISIBLE_WHEN_COLLAPSED) : rows.value));

const providerName = computed(() => spec.value?.accountLabel ?? provider);

// The ways in this provider offers. One for nearly all; Grok's two (its own xAI account, a SuperGrok subscription under
// Claude Code) each get a button named for what it connects, since "Connect" twice would ask the reader to guess.
const ROUTED_NAME = computed(
    () =>
        ({
            codex: t(`sandbox.aiAccountSection.chatgptSubscription`),
            grok: t(`sandbox.aiAccountSection.underClaudeCode`),
            kimi: t(`sandbox.aiAccountSection.kimiCodeSubscription`),
            gemini: t(`sandbox.aiAccountSection.googleAccount`),
        }) satisfies Record<KeyedProvider, string>,
);
const ways = computed(() => {
    const native =
        hasNative.value && canAddNative.value
            ? [{ via: `native` as const, name: t(`sandbox.aiAccountSection.account`, { managedLabel: providerName.value }) }]
            : [];
    const routedWay = keyed.value === undefined ? [] : [{ via: `routed` as const, name: ROUTED_NAME.value[keyed.value] }];
    const both = [...native, ...routedWay];
    const several = (hasNative.value ? 1 : 0) + (keyed.value === undefined ? 0 : 1) > 1;
    return both.map((way) => ({
        via: way.via,
        label: several
            ? t(`connect.providerPanel.connectWay`, { way: way.name })
            : rows.value.length === 0
              ? t(`ui.action.connect`)
              : t(`sandbox.aiAccountSection.addAnotherAccount`),
    }));
});

const ask = (via: `native` | `routed`): void => emit(`connect`, via === `native` && offersEstates.value ? { via, variant: estate.value } : { via });
const otherName = computed(() => (otherLive === undefined ? `` : (providerSpec(otherLive)?.accountLabel ?? otherLive)));
</script>

<template>
    <RowGroup :label="providerName">
        <!-- Adding one more is the list's own action, where every list keeps it; with nothing in the list, the card says it. -->
        <template v-if="rows.length > 0 && !signingInHere" #actions>
            <Button v-for="way in ways" :key="way.via" size="small" tier="boring" :label="way.label" :disabled="busy" @click="ask(way.via)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <!-- The one thing that just happened here, with the one next move. -->
        <RowNote v-if="landed" variant="block">
            <div class="flex flex-wrap items-center gap-3">
                <Icon name="check" class="shrink-0 text-success" />
                <span class="min-w-0 flex-1 text-sm text-content">{{ landed }}</span>
                <Button size="small" :label="t(`connect.connect.startChatting`)" @click="emit(`chat`)" />
            </div>
        </RowNote>

        <RowNote v-if="notice" variant="block">
            <Notice :of="notice" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismissNotice`)" />
        </RowNote>

        <!-- A sandbox too old to judge its accounts: every row reads unknown, and this says why and how to update. -->
        <RowNote v-if="accountsOutdated && rows.length > 0" variant="block">
            <SandboxOutdatedNotice :missing="t(`sandbox.aiAccountSection.outdatedMissing`)" />
        </RowNote>

        <ConnectionRow
            v-for="row in shownRows"
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
                    v-else-if="row.reconnect && !signingInHere"
                    :label="t(`ui.action.reconnect`)"
                    size="small"
                    :disabled="busy"
                    @click="ask(row.via)"
                />
                <Button
                    :label="t(`ui.action.disconnect`)"
                    size="small"
                    tier="quiet"
                    tone="danger"
                    :loading="accountBusy === row.busy"
                    @click="row.disconnect()"
                />
            </template>
        </ConnectionRow>

        <RowNote
            v-if="shouldCollapse"
            variant="action"
            :icon="expanded ? `chevron-up` : `chevron-down`"
            :label="
                expanded
                    ? t(`ui.action.showLess`)
                    : t(`sandbox.aiAccountSection.showMoreAccounts`, { collapsedCount: rows.length - VISIBLE_WHEN_COLLAPSED })
            "
            @click="expanded = !expanded"
        />

        <!-- Nothing here yet: what connecting needs, and the button that does it. -->
        <RowNote v-if="rows.length === 0 && attempt === undefined" variant="block">
            <div class="flex flex-col items-start gap-3">
                <p class="text-xs text-muted">
                    {{ found ? t(`connect.connect.foundSignedIn`) : t(`connect.providerPanel.empty`) }}
                </p>
                <!-- The plan is the sign-in's own first step, so it is asked beside the button, before anything starts. -->
                <EstatePicker v-if="offersEstates" v-model="estate" :provider="provider" :label="t(`connect.connect.whichPlan`)" />
                <div class="flex flex-wrap gap-2">
                    <Button v-for="way in ways" :key="way.via" size="small" :label="way.label" :disabled="busy" @click="ask(way.via)">
                        <template #icon><Icon name="sign-in" /></template>
                    </Button>
                </div>
            </div>
        </RowNote>

        <!-- With accounts already here, a provider sold under several plans asks which one the next account is on. -->
        <RowNote v-else-if="offersEstates && !signingInHere && attempt === undefined" variant="block">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span class="text-xs text-muted">{{ t(`connect.connect.whichPlan`) }}</span>
                <EstatePicker v-model="estate" :provider="provider" :label="t(`connect.connect.whichPlan`)" />
            </div>
        </RowNote>

        <!-- The sign-in, under the accounts it is adding to. -->
        <RowNote v-if="attempt" variant="block">
            <ConnectAttempt
                ref="attemptBlock"
                :provider="provider"
                :phase="attempt.phase"
                :kind="attempt.kind"
                :problem="attempt.problem"
                :finishing="finishing"
                @cancel="emit(`cancel`)"
                @retry="emit(`retry`)"
                @dismiss="emit(`dismiss`)"
            />
        </RowNote>

        <!-- One sign-in at a time: said before the press that would end the other one, with the way back to it. -->
        <RowNote v-else-if="otherLive" variant="note" icon="info-circle">
            <span>{{ t(`connect.providerPanel.otherLive`, { other: otherName, provider: providerName }) }}</span>
            <button type="button" :class="ui.textButton(`ml-2`)" @click="emit(`show`, otherLive)">
                {{ t(`connect.providerPanel.showOther`, { other: otherName }) }}
            </button>
        </RowNote>
    </RowGroup>
</template>
