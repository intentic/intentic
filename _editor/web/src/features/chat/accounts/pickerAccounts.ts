import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { accountServesLoop, reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { type ModelRef, offPlanVerdict } from "@intentic/sandbox-contract/models/plan-pools";
import { compareModelIds, familyOf, releaseOf } from "@intentic/sandbox-contract/models/model-order";
import { keyBeside } from "@intentic/sandbox-contract/models/key-providers";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { computed, type Ref } from "vue";
import { offeredLoops, selectedLoop } from "../../../models/providers/offeredLoops";
import { defaultModelFor, keyedBeside, keysBeside, modelLabelFor, modelOptionsFor } from "../../../models/providers/providerCatalog";
import { translatorAccounts } from "../../../models/providers/providerAccounts";
import {
    accountFacts,
    accountFixLabel,
    accountState,
    formatReset,
    lastRefusalOf,
    PLAN_LIMIT_BANDS,
    type PlanLimitBand,
    planLimitBand,
    planLimitBandLabel,
    planLimitBandTone,
    refusalFor,
    routedAccountFacts,
} from "../../../models/providers/usageStatus";
import { accountHeadroom } from "../../../models/providers/capacity/heardRunOut";
import { accountsOf, refreshConnections, subscriptionOnly } from "../../../models/conversations/accounts/useChat-accounts";
import { useOperation } from "../../../workbench/operations/operations";
import { mayRunOn, providerWithheld } from "../../../models/providers/aiReach";
import { t } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui/format";

// Which credential and runtime serve the turn: shared by the composer's and shell's model pickers. A
// composable, not a component body, since both callers need to know whether there's anything to show
// before drawing their own footer. Reads module state (accounts, refusals, usage) narrowed by the
// given provider; nothing here belongs to a conversation.

// Row count past which a list folds into a summary; five is where a column stops being scannable at a glance.
export const ACCOUNT_LIST_LIMIT = 5;

// What a folded list says in place of its rows: counts by band, the same unit the Usage tab's
// capacity bar uses. Banded off the rows' own rings, so summary and list can't disagree. The accounts whose plan does not
// include the model are no fullness of its: counted last, apart, in no colour.
export interface CapacityCount {
    readonly band: PlanLimitBand | `offPlan`;
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
    const offPlan = rows.filter((row) => offPlanVerdict(row.state)).length;
    for (const row of rows.filter((entry) => !offPlanVerdict(entry.state))) {
        const band = planLimitBand({ state: row.state, readable });
        counts.set(band, (counts.get(band) ?? 0) + 1);
    }
    // Worst first; `none` is dropped, since unpublished limits aren't a fullness reading.
    const bands = PLAN_LIMIT_BANDS.flatMap((band) => {
        const count = counts.get(band) ?? 0;
        return count === 0 || band === `none` ? [] : [{ band, count, label: planLimitBandLabel(band), tone: planLimitBandTone(band) }];
    });
    return offPlan === 0 ? bands : [...bands, { band: `offPlan`, count: offPlan, label: accountFixLabel(`plan`), tone: `text-subtle` }];
};

// Where a row stands in the list: the accounts that can take a turn, then the ones waiting on a clock (a spent pool, a
// bench that lifts by itself), then the ones a person has to fix (a sign-in, a seat), and last the ones whose plan does
// not include the model at all. Tiers rather than a sort by room, so rows don't trade places as readings stream in under
// the pointer; within a tier the provider's own order stands. Display only: which account a turn runs on is read off the
// provider's order (servingAccount), never this one.
const PICKER_TIER = { room: 0, tight: 0, unread: 0, none: 0, spent: 1, blocked: 2 } as const satisfies Record<PlanLimitBand, number>;
const OFF_PLAN_TIER = 3;

export const pickerOrder = <T extends { readonly state: AccountState }>(provider: AgentProvider, rows: readonly T[]): T[] => {
    const readable = reportsPlanLimits(provider);
    const tier = (row: T): number => (offPlanVerdict(row.state) ? OFF_PLAN_TIER : PICKER_TIER[planLimitBand({ state: row.state, readable })]);
    return rows.toSorted((left, right) => tier(left) - tier(right));
};

// Why a spent row is dimmed, and until when: a dimmed name with nothing beside it reads as broken, not as waiting. A pool
// one model meters apart (Claude's Fable slice) is named: "Allowance used up" there read as the whole account spent
// while its weekly allowance for every other model still had room.
const spentLine = (state: AccountState): string | undefined => {
    if (state.kind !== `spent`) {
        return undefined;
    }
    const { pool, reopensAt } = state;
    if (pool !== undefined) {
        return reopensAt === undefined
            ? t(`chat.pickerAccounts.poolUsedUp`, { pool })
            : t(`chat.pickerAccounts.poolUsedUpReopens`, { pool, when: formatReset(reopensAt) });
    }
    return reopensAt === undefined
        ? t(`chat.pickerAccounts.allowanceUsedUp`)
        : t(`chat.pickerAccounts.allowanceUsedUpReopens`, { when: formatReset(reopensAt) });
};

// When a credential the translator is resting comes back. Its reason is the hover's: the row's line is when, not why.
const benchLine = (state: AccountState): string | undefined =>
    state.kind === `blocked` && state.fix === `wait` && state.until !== undefined ? t(`chat.modelPicker.backAt`, { at: formatReset(state.until) }) : undefined;

/* HOW A ROW SITS, read off its verdict the same way in both lists. An account whose plan does not include the model is
   set apart rather than flagged: it is not broken and nobody can fix it, it just runs other models, so it carries no
   meter (its room is for those) and no warning, only a quiet "not on plan" naming the model on hover. Without it, two
   ChatGPT Free sign-ins read 100% left under Sol, which only a spent Team account runs, and nothing said why every Sol
   turn was refused (2026-11-19). */
interface RowStanding {
    readonly offPlan: boolean;
    // A spent pool's reopening, or a bench's: the line under a row waiting on a clock.
    readonly waiting: string | undefined;
    // Can take no turn on this model now. Dimmed, never disabled, since picking one is an attempt on it.
    readonly demoted: boolean;
}

const rowStanding = (state: AccountState, readable: boolean): RowStanding => {
    const offPlan = offPlanVerdict(state);
    const band = planLimitBand({ state, readable });
    return { offPlan, waiting: spentLine(state) ?? benchLine(state), demoted: offPlan || band === `spent` || band === `blocked` };
};

// A personal organization is named after its owner ("ada@acme.dev's Organization"): beside that address it says nothing
// the row doesn't, and it was most of every such row's words. Only an address counts as the owner's name, so a plan's
// name inside a team's ("Max" in "Max Labs") never hides the team.
const namedAfterOwner = (entry: OauthAccount): boolean => {
    const org = entry.organization;
    return org !== undefined && [entry.email, entry.label].some((name) => name?.includes(`@`) === true && org !== name && org.includes(name));
};

// What a row says of who it is, beside its name: the parts of its identity the name doesn't already carry, or, for a name
// two accounts share and nothing else tells apart, when it was connected.
const subtitleOf = (entry: OauthAccount, ambiguous: boolean): string | undefined => {
    const identity = [entry.email, namedAfterOwner(entry) ? undefined : entry.organization].filter((part) => part !== undefined && part !== entry.label);
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguous ? t(`chat.pickerAccounts.connectedAgo`, { age: timeAgo(entry.connectedAt, { days: true }) }) : undefined;
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

// The forced re-read a person presses, in the picker's header or on the capacity rail: past the daemon's minute-long
// cache, over every connection rather than one provider's. Held across both and across their closing, since the read
// goes on with the popover that pressed it shut, and its numbers land in the shared readings whoever is open then.
export const useRemeasure = () => {
    const measure = useOperation(() => `chat/accounts/remeasure`);
    const remeasure = async (): Promise<void> => {
        await measure.run({
            what: t(`chat.pickerAccounts.measuringPlanLimits`),
            failed: t(`chat.pickerAccounts.measureFailed`),
            // A read: what it finds shows on every ring, and a reading it could not take is said on its own row.
            quiet: true,
            task: () => refreshConnections(true),
        });
    };
    return { measuring: measure.busy, remeasure };
};

// The provider's own accounts that can serve the loop the chip names (a CLI loop's sign-ins, Grok Build's or Kimi CLI's,
// on that loop alone, the provider's other credential everywhere else), and of those the ones the person may run on
// (aiReach.ts), so a picker never offers a row the daemon would refuse a turn on.
const servingAccounts = (provider: AgentProvider, harness: AgentHarness): readonly OauthAccount[] =>
    accountsOf(provider).filter((entry) => accountServesLoop(provider, selectedLoop(offeredLoops(provider), harness), entry) && mayRunOn(provider, entry.id));

// The model a switch between a sign-in and its vendor's key lands on: the same id where the other lists it, else the same
// model under that one's own id (a key's dated `claude-opus-5-20260201` for a sign-in's `claude-opus-5`), else the newest
// of its family there, else that one's default. The list that row then draws is the target's own catalog (ModelPicker).
export const sameModelOn = (target: AgentProvider, model: string | undefined): string => {
    const options = modelOptionsFor(target).filter((option) => option.helperOnly === undefined);
    if (model === undefined || model === ``) {
        return defaultModelFor(target);
    }
    if (options.some((option) => option.value === model)) {
        return model;
    }
    const version = releaseOf(model).version.join(`.`);
    const kin = options.filter((option) => familyOf(option.value) === familyOf(model)).toSorted((left, right) => compareModelIds(left.value, right.value));
    return (kin.find((option) => releaseOf(option.value).version.join(`.`) === version) ?? kin[0])?.value ?? defaultModelFor(target);
};

// A vendor's API key filed under a sign-in (an Anthropic key under Claude), as a row beside its accounts: one more way to
// pay for the same models, picked as an account is. Keys the reader may not run on are not offered.
const keyRowsOf = (family: AgentProvider): readonly { readonly provider: AgentProvider; readonly label: string; readonly subtitle: string | undefined }[] => {
    const keys = keysBeside(family).filter((key) => !providerWithheld(key.id));
    const vendor = keyBeside(family)?.label;
    return keys.map((key) => ({
        provider: key.id,
        label: t(`chat.pickerAccounts.apiKey`),
        // Who bills it, and its own name only where two keys would otherwise read alike.
        subtitle: [vendor === undefined ? undefined : t(`chat.pickerAccounts.billedPerToken`, { vendor }), keys.length > 1 ? key.label : undefined]
            .filter((part) => part !== undefined)
            .join(` · `) || undefined,
    }));
};

// A routed provider's credentials as rows, judged for the model and drawn in pickerOrder: nobody picks between them, so
// their order is all the reading there is. `family` is whose turn it is (a key's sign-in), `routed` whose credentials.
const routedRowsOf = (family: AgentProvider, routed: KeyedProvider, model: ModelRef | undefined) => {
    const readable = reportsPlanLimits(routed);
    const rows = translatorAccounts.value[routed].filter((entry) => mayRunOn(family, entry.name)).map((entry) => {
        // Whether it can take this model's turn: a bench the proxy holds it on outranks any reading of its pools.
        const state = accountState(family, routedAccountFacts(entry), model);
        const standing = rowStanding(state, readable);
        return {
            name: entry.name,
            label: entry.label,
            headroom: standing.offPlan ? undefined : accountHeadroom(family, entry.name, { attached: entry.usage, model }),
            state,
            ...standing,
            // Why it takes no turn where no clock answers it (a sign-in, a seat, a bench with no instant), and why it rests.
            refused: state.kind === `blocked` && !standing.offPlan && standing.waiting === undefined ? state.reason : undefined,
            rests: state.kind === `blocked` && state.fix === `wait` ? state.reason : undefined,
        };
    });
    return pickerOrder(routed, rows);
};

export const usePickerAccounts = (provider: Ref<AgentProvider>, harness: Ref<AgentHarness>, model?: Ref<string | undefined>) => {
    // The sign-in whose accounts and keys these rows are: the provider itself, or the one the picked key is filed under.
    // On a key, the accounts are read against their own default loop, the one a pick of one lands on.
    const family = computed(() => keyedBeside(provider.value) ?? provider.value);
    const onKey = computed(() => family.value !== provider.value);
    const accounts = computed(() => servingAccounts(family.value, onKey.value ? `native` : harness.value));
    const keyRows = computed(() => keyRowsOf(family.value));
    // The model the rings measure against; with none given, the ring falls back to the account's tightest pool.
    const modelRef = computed<ModelRef | undefined>(() => (model?.value === undefined || model.value === `` ? undefined : { id: model.value }));

    // The read-only subscriptions this selection runs on instead, for providers with no account of their own.
    const routedProvider = computed<KeyedProvider | undefined>(() => {
        const target = family.value;
        if (subscriptionOnly(target)) {
            return target;
        }
        // Grok and Kimi are served both ways; which one shows follows the loop chip below. On a key the chip is the key's,
        // and the provider's own sign-ins stand for it.
        const keyed = KeyedProviderSchema.safeParse(target);
        return keyed.success &&
            providerSpec(target)?.auth.kind === `translator` &&
            !onKey.value &&
            selectedLoop(offeredLoops(target), harness.value) === `claude-code`
            ? keyed.data
            : undefined;
    });

    const routedRows = computed(() => (routedProvider.value === undefined ? [] : routedRowsOf(family.value, routedProvider.value, modelRef.value)));

    // The model's own name, for the hover on a row whose plan does not include it.
    const modelName = computed(() => (model?.value === undefined || model.value === `` ? undefined : modelLabelFor(family.value, model.value)));

    // When this provider last refused a turn, the observed half of "can I run" beside the polled rings.
    const providerRefusalNote = computed(() => refusalFor(provider.value));

    // Same refusal when no row can carry it: a single account, or a routed refusal naming none.
    const unplacedRefusal = computed(() => {
        const note = providerRefusalNote.value;
        const refused = lastRefusalOf(provider.value)?.account;
        if (note?.current !== true) {
            return undefined;
        }
        const onARow = accounts.value.length > 1 && accounts.value.some((entry) => entry.id === refused);
        return onARow ? undefined : note;
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
        const refusal = lastRefusalOf(family.value);
        const note = refusalFor(family.value);
        const readable = reportsPlanLimits(family.value);
        return accounts.value.map((entry) => {
            const subtitle = subtitleOf(entry, ambiguousLabels.value.has(entry.label));
            const state = accountState(family.value, accountFacts(entry), modelRef.value);
            const standing = rowStanding(state, readable);
            return Object.assign({}, entry, standing, {
                subtitle,
                // Its own reading beside the streamed map (liveUsage): the row's is usually the newer of the two.
                headroom: standing.offPlan ? undefined : accountHeadroom(family.value, entry.id, { attached: entry.usage, model: modelRef.value }),
                state,
                // Why no turn runs on it (a lost seat outlives the turn it refused), unless the row's "Reconnect needed" already
                // says so; any other refusal shows only while it stands, on the account it names.
                refused:
                    state.kind === `blocked` && !standing.offPlan && entry.needsReauth !== true
                        ? state.reason
                        : note?.current === true && refusal?.account === entry.id
                          ? note.line
                          : undefined,
            });
        });
    });

    // Banded summary a folded list wears, derived from the same rows so summary and rows can't disagree.
    const accountCapacity = computed(() => capacityCounts(family.value, accountRows.value));
    const routedCapacity = computed(() => capacityCounts(routedProvider.value ?? family.value, routedRows.value));

    // Whether the choosable rows draw: a single credential isn't a list, and a key beside a subscription is a choice of two.
    const choosable = computed(() => accountRows.value.length + keyRows.value.length > 1 || (keyRows.value.length > 0 && routedRows.value.length > 0));
    // Whether the account rows draw at all. What the footer says (a refusal, a live turn) is PickerStatus's line, and the
    // harness is the toolbar's (PickerRunBar).
    const hasContent = computed(() => choosable.value || routedRows.value.length > 0);

    return {
        family,
        onKey,
        accounts,
        accountRows,
        accountCapacity,
        keyRows,
        choosable,
        routedRows,
        routedCapacity,
        modelName,
        unplacedRefusal,
        hasContent,
    };
};
