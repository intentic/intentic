import type { AccountState, AgentProvider } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { CONNECT_LANES } from "./connectLanes";

// EVERYTHING THIS SANDBOX CAN RUN A MODEL ON, one row per source: a provider's accounts (its own sign-ins and its
// subscriptions together), a model on this machine, an endpoint, the free trial. The overview the old AI-account card
// never gave: there, eight chips each showed one provider's rows, so "what do I have, and is any of it broken" took
// eight presses to answer. Pure: the view judges each account (usageStatus) and hands the verdicts in.

export type ModelSourceKind = `account` | `local` | `endpoint` | `trial`;

// Who has to act, if anyone. Drives the dot and the order: what needs the reader comes first, since a broken account is
// the usual reason somebody opens this page after their first visit.
//   attention: a person here can fix it (sign in again, verify on the provider's page)
//   blocked:   only somebody this sandbox cannot reach can (an organisation's admin)
//   ready:     at least one account serves
//   waiting:   nothing serves until an allowance reopens or a bench lifts, by itself
export type ModelSourceStanding = `attention` | `blocked` | `ready` | `waiting`;

export interface AccountReading {
    readonly label: string;
    readonly state: AccountState;
}

export type ModelSourceInput =
    | { readonly kind: `account`; readonly provider: AgentProvider; readonly label: string; readonly accounts: readonly AccountReading[] }
    | { readonly kind: `local` | `endpoint`; readonly provider: AgentProvider; readonly label: string }
    | { readonly kind: `trial`; readonly provider: AgentProvider; readonly label: string; readonly remaining: number };

export interface ModelSource {
    readonly provider: AgentProvider;
    readonly kind: ModelSourceKind;
    readonly label: string;
    // Beside the name: who it signs in as, how many accounts, or what kind of source it is.
    readonly summary: string;
    // Under the name, only when there is something to say: what needs doing, or what it is waiting on.
    readonly line: string | undefined;
    readonly standing: ModelSourceStanding;
    // Where a source this page does not manage itself is managed: its capability card.
    readonly manage: string | undefined;
}

// How a reset instant reads on a row; handed in so this module stays a projection, not a clock.
export type WhenWords = (epochSeconds: number) => string;

const blockedFix = (state: AccountState): string | undefined => (state.kind === `blocked` ? state.fix : undefined);
const waits = (state: AccountState): boolean => state.kind === `spent` || blockedFix(state) === `wait`;

// What one account's standing asks of a person, in the row's words.
const fixLine = (account: AccountReading): string | undefined => {
    switch (blockedFix(account.state)) {
        case `reconnect`:
            return t(`connect.modelSources.signInAgain`, { account: account.label });
        case `verify`:
            return t(`connect.modelSources.verify`, { account: account.label });
        case `admin`:
            return t(`connect.modelSources.admin`, { account: account.label });
        default:
            return undefined;
    }
};

// The soonest any waiting account serves again, in epoch seconds, where the provider said.
const soonest = (accounts: readonly AccountReading[]): number | undefined => {
    const instants = accounts
        .map(({ state }) => (state.kind === `spent` ? state.reopensAt : state.kind === `blocked` ? state.until : undefined))
        .filter((instant): instant is number => instant !== undefined);
    return instants.length === 0 ? undefined : Math.min(...instants);
};

const accountSource = (provider: AgentProvider, label: string, accounts: readonly AccountReading[], when: WhenWords): ModelSource => {
    const summary = accounts.length === 1 ? accounts[0]!.label : t(`connect.modelSources.accounts`, { count: accounts.length }, accounts.length);
    const base = { provider, kind: `account` as const, label, summary, manage: undefined };
    const personal = accounts.filter((account) => blockedFix(account.state) === `reconnect` || blockedFix(account.state) === `verify`);
    if (personal.length > 0) {
        return {
            ...base,
            standing: `attention`,
            line: personal.length === 1 ? fixLine(personal[0]!) : t(`connect.modelSources.manyNeedYou`, { count: personal.length }, personal.length),
        };
    }
    const admin = accounts.filter((account) => blockedFix(account.state) === `admin`);
    const serving = accounts.filter((account) => blockedFix(account.state) === undefined && !waits(account.state));
    if (admin.length > 0 && serving.length === 0) {
        return { ...base, standing: `blocked`, line: admin.length === 1 ? fixLine(admin[0]!) : t(`connect.modelSources.manyNeedAdmin`) };
    }
    const waiting = accounts.filter((account) => waits(account.state));
    if (serving.length === 0 && waiting.length > 0) {
        const reopens = soonest(waiting);
        return {
            ...base,
            standing: `waiting`,
            line: reopens === undefined ? t(`connect.modelSources.allWaiting`) : t(`connect.modelSources.allWaitingUntil`, { when: when(reopens) }),
        };
    }
    // Serving, with some of it resting: worth a word, since the rest is why turns may land on a different account.
    return {
        ...base,
        standing: `ready`,
        line: waiting.length === 0 ? undefined : t(`connect.modelSources.someWaiting`, { count: waiting.length, total: accounts.length }),
    };
};

const sourceOf = (input: ModelSourceInput, when: WhenWords): ModelSource => {
    switch (input.kind) {
        case `account`:
            return accountSource(input.provider, input.label, input.accounts, when);
        case `local`:
            return {
                provider: input.provider,
                kind: `local`,
                label: input.label,
                summary: t(`connect.modelSources.local`),
                line: undefined,
                standing: `ready`,
                manage: `/capabilities/localmodel`,
            };
        case `endpoint`:
            return {
                provider: input.provider,
                kind: `endpoint`,
                label: input.label,
                summary: t(`connect.modelSources.endpoint`),
                line: undefined,
                standing: `ready`,
                manage: `/capabilities/endpoint`,
            };
        case `trial`:
            return {
                provider: input.provider,
                kind: `trial`,
                label: input.label,
                summary: t(`connect.modelSources.trialLeft`, { count: input.remaining }, input.remaining),
                line: input.remaining > 0 ? undefined : t(`connect.modelSources.trialSpent`),
                standing: input.remaining > 0 ? `ready` : `waiting`,
                manage: undefined,
            };
    }
};

const STANDING_ORDER = { attention: 0, blocked: 1, ready: 2, waiting: 3 } as const satisfies Record<ModelSourceStanding, number>;
const KIND_ORDER = { account: 0, local: 1, endpoint: 2, trial: 3 } as const satisfies Record<ModelSourceKind, number>;
// Providers in the order the ways in offer them (cost first), so the list and the lanes under it agree.
const LANE_ORDER: readonly string[] = CONNECT_LANES.flatMap((lane) => lane.providers);
const laneRank = (provider: AgentProvider): number => {
    const at = LANE_ORDER.indexOf(provider);
    return at === -1 ? LANE_ORDER.length : at;
};

/** Every source, what needs a person first; an account provider with no accounts is not a source and is left out. */
export const modelSources = (inputs: readonly ModelSourceInput[], when: WhenWords): readonly ModelSource[] =>
    inputs
        .filter((input) => input.kind !== `account` || input.accounts.length > 0)
        .map((input) => sourceOf(input, when))
        .sort(
            (a, b) =>
                STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] ||
                KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
                laneRank(a.provider) - laneRank(b.provider) ||
                a.label.localeCompare(b.label),
        );

/** How many sources need a person, for the count on the section's row in the hub's index. */
export const sourcesNeedingSomeone = (sources: readonly ModelSource[]): number =>
    sources.filter((source) => source.standing === `attention` || source.standing === `blocked`).length;
