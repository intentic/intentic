import {
    type AccountState,
    type AgentHarness,
    type AgentProvider,
    harnessChoosable as contractHarnessChoosable,
    type KeyedProvider,
    type ModelRef,
    reportsPlanLimits,
} from "@intentic/sandbox-contract";
import { computed, type Ref, ref } from "vue";
import { providerDisplayLabel } from "./providerCatalog";
import { providerRefusals, translatorAccounts } from "./providerAccounts";
import {
    accountFacts,
    accountState,
    formatAge,
    formatReset,
    liveUsage,
    oldestMovableReading,
    PLAN_LIMIT_BANDS,
    planHeadroom,
    type PlanLimitBand,
    planLimitBand,
    planLimitBandLabel,
    planLimitBandTone,
    refusalFor,
    routedAccountFacts,
} from "../session/usageStatus";
import { accountsOf, refreshConnections, subscriptionOnly } from "./useChat-accounts";
import { t } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui/format";

// Which credential and runtime serve the turn: shared by the composer's and shell's model pickers. A
// composable, not a component body, since both callers need to know whether there's anything to show
// before drawing their own footer. Reads module state (accounts, refusals, usage) narrowed by the
// given provider; nothing here belongs to a conversation.

// Row count past which a list folds into a summary; five is where a column stops being scannable at a glance.
export const ACCOUNT_LIST_LIMIT = 5;

// What a folded list says in place of its rows: counts by band, the same unit the Usage tab's
// capacity bar uses. Banded off the rows' own rings, so summary and list can't disagree.
export interface CapacityCount {
    readonly band: PlanLimitBand;
    readonly count: number;
    readonly label: string;
    readonly tone: string;
}

export const capacityCounts = (
    provider: AgentProvider,
    // The row's verdict (accountState), so an account nothing can run on is never counted as a degree of fullness.
    rows: readonly { readonly state: AccountState }[],
): readonly CapacityCount[] => {
    const readable = reportsPlanLimits(provider);
    const counts = new Map<PlanLimitBand, number>();
    for (const row of rows) {
        const band = planLimitBand({ state: row.state, readable });
        counts.set(band, (counts.get(band) ?? 0) + 1);
    }
    // Worst first; `none` is dropped, since unpublished limits aren't a fullness reading.
    return PLAN_LIMIT_BANDS.flatMap((band) => {
        const count = counts.get(band) ?? 0;
        return count === 0 || band === `none` ? [] : [{ band, count, label: planLimitBandLabel(band), tone: planLimitBandTone(band) }];
    });
};

// Where a row stands in the list: the accounts that can take a turn, then the ones waiting on a clock (a spent pool, a
// bench that lifts by itself), then the ones a person has to fix (a sign-in, a seat). Three tiers rather than a sort by
// room, so rows don't trade places as readings stream in under the pointer; within a tier the provider's own order
// stands. Display only: which account a turn runs on is read off the provider's order (servingAccount), never this one.
const PICKER_TIER = { room: 0, tight: 0, unread: 0, none: 0, spent: 1, blocked: 2 } as const satisfies Record<PlanLimitBand, number>;

export const pickerOrder = <T extends { readonly state: AccountState }>(provider: AgentProvider, rows: readonly T[]): T[] => {
    const readable = reportsPlanLimits(provider);
    const tier = (row: T): number => PICKER_TIER[planLimitBand({ state: row.state, readable })];
    return rows.toSorted((left, right) => tier(left) - tier(right));
};

// Why a spent row is dimmed, and until when: a dimmed name with nothing beside it reads as broken, not as waiting.
const spentLine = (state: AccountState): string | undefined => {
    if (state.kind !== `spent`) {
        return undefined;
    }
    return state.reopensAt === undefined
        ? t(`chat.pickerAccounts.allowanceUsedUp`)
        : t(`chat.pickerAccounts.allowanceUsedUpReopens`, { when: formatReset(state.reopensAt) });
};

// Filters a folded list against everything a row shows (label and subtitle), since a pool of
// near-identical addresses is looked up by whichever part the reader remembers.
export const matchAccounts = <T extends { readonly label: string; readonly subtitle?: string | undefined }>(
    rows: readonly T[],
    query: string,
): readonly T[] => {
    const needle = query.trim().toLowerCase();
    return needle === `` ? rows : rows.filter((row) => `${row.label} ${row.subtitle ?? ``}`.toLowerCase().includes(needle));
};

export const usePickerAccounts = (provider: Ref<AgentProvider>, harness: Ref<AgentHarness>, model?: Ref<string | undefined>) => {
    const accounts = computed(() => accountsOf(provider.value));
    // The model the rings measure against; with none given, the ring falls back to the account's tightest pool.
    const modelRef = computed<ModelRef | undefined>(() => (model?.value === undefined || model.value === `` ? undefined : { id: model.value }));

    // Harness chips for codex/grok; each names the runtime it selects (e.g. "ChatGPT"), never "Default".
    const harnessOptions = computed<readonly { label: string; value: AgentHarness }[]>(() => [
        { label: providerDisplayLabel(provider.value), value: `native` },
        { label: t(`shared.claudeCode`), value: `claude-code` },
    ]);
    // Read from the contract: choosable only where the provider's two harnesses point at different runtimes.
    const harnessChoosable = computed(() => contractHarnessChoosable(provider.value));

    // The read-only subscriptions this selection runs on instead, for providers with no account of their own.
    const routedProvider = computed<KeyedProvider | undefined>(() => {
        const target = provider.value;
        if (subscriptionOnly(target)) {
            return target;
        }
        // Grok is served both ways; which one shows follows the harness chip below.
        return target === `grok` && harness.value === `claude-code` ? `grok` : undefined;
    });

    const routedRows = computed(() =>
        routedProvider.value === undefined
            ? []
            : translatorAccounts.value[routedProvider.value].map((entry) => ({
                  name: entry.name,
                  label: entry.label,
                  headroom: planHeadroom(liveUsage(provider.value, entry.name, entry.usage, modelRef.value), modelRef.value),
                  // Whether it can take this model's turn: a bench the proxy holds it on outranks any reading of its pools.
                  state: accountState(provider.value, routedAccountFacts(entry), modelRef.value),
              })),
    );

    // When this provider last refused a turn, the observed half of "can I run" beside the polled rings.
    const providerRefusalNote = computed(() => refusalFor(provider.value));

    // Same refusal when no row can carry it: a single account, or a routed refusal naming none.
    const unplacedRefusal = computed(() => {
        const note = providerRefusalNote.value;
        const refused = providerRefusals.value[provider.value]?.account;
        if (note?.current !== true) {
            return undefined;
        }
        const onARow = accounts.value.length > 1 && accounts.value.some((entry) => entry.id === refused);
        return onARow ? undefined : note.line;
    });

    // Names shared by more than one connected account, the rows a name alone cannot tell apart.
    const ambiguousLabels = computed(() => {
        const seen = new Map<string, number>();
        for (const entry of accounts.value) {
            seen.set(entry.label, (seen.get(entry.label) ?? 0) + 1);
        }
        return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
    });

    // Rows decorated with a subtitle (identity or connect date), ring headroom, and any refusal on that account. In the
    // provider's own order, which is what a turn's placement breaks ties by; the list draws them in pickerOrder.
    const accountRows = computed(() => {
        const refusal = providerRefusals.value[provider.value];
        const note = providerRefusalNote.value;
        const readable = reportsPlanLimits(provider.value);
        return accounts.value.map((entry) => {
            const identity = [entry.email, entry.organization].filter((part) => part !== undefined && part !== entry.label);
            const subtitle =
                identity.length > 0
                    ? identity.join(` · `)
                    : ambiguousLabels.value.has(entry.label)
                      ? t(`chat.pickerAccounts.connectedAgo`, { age: timeAgo(entry.connectedAt, { days: true }) })
                      : undefined;
            const state = accountState(provider.value, accountFacts(entry), modelRef.value);
            const band = planLimitBand({ state, readable });
            return Object.assign({}, entry, {
                subtitle,
                // liveUsage, not the streamed map alone: the row's own reading is usually the newer of the two.
                headroom: planHeadroom(liveUsage(provider.value, entry.id, entry.usage, modelRef.value), modelRef.value),
                state,
                // Why no turn runs on it (a lost seat outlives the turn it refused), unless the reconnect button already says
                // so; any other refusal shows only while it stands, on the account it names.
                refused:
                    state.kind === `blocked` && entry.needsReauth !== true
                        ? state.reason
                        : note?.current === true && refusal?.account === entry.id
                          ? note.line
                          : undefined,
                waiting: spentLine(state),
                // Can take no turn now: a spent pool, a bench, a sign-in or seat to give back. Dimmed, never disabled, since
                // picking one is an attempt on it; its reason stays legible, since that is what says why it is dimmed.
                demoted: band === `spent` || band === `blocked`,
            });
        });
    });

    // Banded summary a folded list wears, derived from the same rows so summary and rows can't disagree.
    const accountCapacity = computed(() => capacityCounts(provider.value, accountRows.value));
    const routedCapacity = computed(() => capacityCounts(routedProvider.value ?? provider.value, routedRows.value));

    // The oldest reading on screen a re-read can move; a header must not vouch for a fresher row than the stalest one
    // beneath it, nor be pinned by one whose re-read keeps failing (each row's ring says its own age and why).
    const measuredAt = computed<number | undefined>(() =>
        oldestMovableReading([...accountRows.value, ...routedRows.value].flatMap((row) => (row.headroom === undefined ? [] : [row.headroom]))),
    );

    // Forced, so it bypasses the daemon's minute-long cache; covers every connection, not just this
    // provider's.
    const measuring = ref(false);
    // Carries the age too, so a screen-reader user gets the same "worth pressing" signal as the visible label.
    const remeasureLabel = computed(() =>
        measuredAt.value === undefined
            ? t(`chat.pickerAccounts.measurePlanLimits`)
            : t(`chat.pickerAccounts.remeasurePlanLimits`, { age: formatAge(measuredAt.value) }),
    );
    const remeasure = async (): Promise<void> => {
        measuring.value = true;
        try {
            await refreshConnections(true);
        } finally {
            measuring.value = false;
        }
    };

    // Whether this block draws at all; a single account isn't a list, but a refusal earns it alone.
    const hasContent = computed(
        () => accounts.value.length > 1 || routedRows.value.length > 0 || harnessChoosable.value || unplacedRefusal.value !== undefined,
    );

    return {
        accounts,
        accountRows,
        accountCapacity,
        routedRows,
        routedCapacity,
        unplacedRefusal,
        harnessOptions,
        harnessChoosable,
        measuredAt,
        measuring,
        remeasureLabel,
        remeasure,
        hasContent,
    };
};
