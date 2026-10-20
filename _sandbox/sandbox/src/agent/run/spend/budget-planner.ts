import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { gatingWindows, type ServiceFacts, serviceStates, windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import { poolName, type RunOut } from "../../../usage/run-outs.js";
import { runningOn, turnPulseOf } from "../turn/turn-pulse.js";
import { type BudgetAccount, type BudgetWindow, capacity, type ChildCost, choose, leastShort, type Projection } from "./budget.js";
import { turnRate } from "./token-meter.js";

/* THE FAN-OUT PLANNER: where a child goes, and whether it goes now, read off what the accounts can carry.

   The projection is budget.ts's; this gathers what it projects from. The accounts the serviceability rule calls ready
   with room, each window the model spends with what one of its points costs (learned per account, burn-rates.ts, else
   a prior); what runs on each account now (every turn of this sandbox's, read off its pulse, at the rate the meter
   measured once it ran long enough to have one, else its model's pace), and the children this planner placed whose
   turns have not begun yet; and what one more child of the model costs.

   Claude is the provider whose account the sandbox picks for a turn that names none, so a Claude child is PLACED: the
   account rides on its spec, and its conversation keeps it. A routed provider balances its own credentials (the
   translator), so its ready accounts are judged as one pool, and a child is only admitted or held.

   Claims are made one at a time per provider: a fan-out of ten spawns in a few seconds, and each must see the ones
   before it, or ten reads of the same figure send ten children to the same account, which is the failure this is for. */

// What a turn spends an hour where nothing was learned of its model: an Opus child at extra-high effort, its helpers
// included, measured at 6M-13M on 2026-10-20 (agent/run/spend/burn-weight.ts's unit), 9M on average.
const PRIOR_TOKENS_PER_AGENT_HOUR = 9_000_000;
// Points of a five-hour window one such agent spends an hour where nothing was learned of the account: 84 points went in
// 62 minutes under about 10.5 of them (2026-10-20). A longer window spends fewer of its points an hour: the same agents
// moved the weekly one about one point an hour, which the exponent fits.
const PRIOR_FIVE_HOUR_POINTS = 8;
const PERIOD_EXPONENT = 0.6;
// A model whose name says it is a small one is priced at a share of that, until its own pace is learned.
const SMALL_MODEL = /haiku|flash|mini|nano|luna|lite/iu;
const MID_MODEL = /sonnet|terra|medium/iu;
// How long a child is expected to run where nothing was learned of its model: those children ran about an hour and a half.
const PRIOR_CHILD_HOURS = 1.5;
const CHILD_HOURS_BOUNDS = { least: 0.25, most: 4 };
// Below this, a running turn's measured rate is a burst (its opening cache write), and its model's pace stands in.
const MEASURED_AFTER_MS = 10 * 60_000;
// A placed child counts on its account until its turn's pulse appears, at most this long.
const COMMITTED_FOR_MS = 15 * 60_000;
// A pulse stamped this much before its claim is still the claimed turn's: the two clocks are read a moment apart.
const CLOCK_SLACK_MS = 1_000;

const priorPointsPerAgentHour = (window: Pick<UsageWindow, "kind" | "label">): number => {
    const period = windowPeriod(window);
    return period === undefined ? 1 : PRIOR_FIVE_HOUR_POINTS * (5 / Math.max(1 / 60, period.seconds / 3_600)) ** PERIOD_EXPONENT;
};

// The rate the provider's last run-out shows for this window, where it named the window and when it opened: 100 points
// under its agents in the hours it lasted. Bounded by the generic prior's quarter and four times it, since the count of
// agents is only this sandbox's, at the moment it ran out.
const runOutPointsPerAgentHour = (window: UsageWindow, runOut: RunOut | undefined): number | undefined => {
    const agents = runOut === undefined ? 0 : Object.values(runOut.models).reduce((sum, count) => sum + count, 0);
    if (runOut?.openedAt === undefined || agents === 0 || runOut.pool === undefined || runOut.pool !== poolName(window)) {
        return undefined;
    }
    const hours = Math.max(0.1, (runOut.at - runOut.openedAt) / 3_600_000);
    const generic = priorPointsPerAgentHour(window);
    return Math.min(generic * 4, Math.max(generic / 4, 100 / (agents * hours)));
};

const modelShare = (model: string | undefined): number => (model === undefined ? 1 : SMALL_MODEL.test(model) ? 0.3 : MID_MODEL.test(model) ? 0.6 : 1);

export type PlannerDeps = Pick<Services, "burnRates" | "providerRefusals" | "runOuts"> & { readonly sandboxSettings: Pick<Services["sandboxSettings"], "get"> };

/** What a plan is asked about: a provider, the model its child runs, and its accounts as the serviceability rule reads them. */
export interface PlanInput {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly readings: readonly ServiceFacts[];
}

interface Committed {
    readonly provider: string;
    readonly account: string | undefined;
    readonly tokensPerHour: number;
    readonly at: number;
}

// The children placed whose turns have not begun yet, by child id.
const committed = new Map<string, Committed>();
// One claim at a time per provider.
const chains = new Map<string, Promise<unknown>>();

const serialized = <T>(provider: string, run: () => Promise<T>): Promise<T> => {
    const before = chains.get(provider) ?? Promise.resolve();
    const next = before.then(run, run);
    // allow(silent-catch): the caller is handed `next` itself and hears its failure; the chain only orders the next claim.
    chains.set(provider, next.catch(() => undefined));
    return next;
};

/** What a child of this model is expected to spend an hour, and for how long. */
export const childCostOf = (deps: Pick<PlannerDeps, "burnRates">, provider: string, model: string | undefined): ChildCost => {
    const pace = model === undefined ? undefined : deps.burnRates.modelPace(provider, model);
    const hours = pace?.childHours ?? PRIOR_CHILD_HOURS;
    return {
        tokensPerHour: pace?.tokensPerHour ?? PRIOR_TOKENS_PER_AGENT_HOUR * modelShare(model),
        hours: Math.min(CHILD_HOURS_BOUNDS.most, Math.max(CHILD_HOURS_BOUNDS.least, hours)),
    };
};

// What every turn running on the provider spends an hour, by account (undefined: one not known), placed children included.
const loadByAccount = (deps: Pick<PlannerDeps, "burnRates">, provider: string, now: number): Map<string | undefined, { tokensPerHour: number; agents: number }> => {
    const load = new Map<string | undefined, { tokensPerHour: number; agents: number }>();
    const add = (account: string | undefined, tokensPerHour: number): void => {
        const kept = load.get(account) ?? { tokensPerHour: 0, agents: 0 };
        load.set(account, { tokensPerHour: kept.tokensPerHour + tokensPerHour, agents: kept.agents + 1 });
    };
    const running = runningOn(provider);
    const pulsing = new Set(running.map((pulse) => pulse.conversationId));
    for (const pulse of running) {
        const measured = turnRate(pulse.conversationId, now);
        add(pulse.account, measured !== undefined && measured.observedMs >= MEASURED_AFTER_MS ? measured.tokensPerHour : childCostOf(deps, provider, pulse.model).tokensPerHour);
    }
    for (const [childId, child] of committed) {
        // Its turn began (and is counted above while it runs), or it never did in time: the claim has done its work.
        const began = (turnPulseOf(childId)?.startedAt ?? Number.NEGATIVE_INFINITY) >= child.at - CLOCK_SLACK_MS;
        if (began || now - child.at > COMMITTED_FOR_MS) {
            committed.delete(childId);
        } else if (child.provider === provider && !pulsing.has(childId)) {
            add(child.account, child.tokensPerHour);
        }
    }
    return load;
};

// One window as the projection reads it: a window whose reset has passed has reopened, whatever its last reading said.
const budgetWindow = (deps: Pick<PlannerDeps, "burnRates">, input: { provider: string; account: string | undefined; runOut: RunOut | undefined }, window: UsageWindow, now: number): BudgetWindow => {
    const learned = input.account === undefined ? undefined : deps.burnRates.tokensPerPoint(input.provider, input.account, window.kind);
    const pointsPerAgentHour = runOutPointsPerAgentHour(window, input.runOut) ?? priorPointsPerAgentHour(window);
    const resetsInHours = window.resetsAt === undefined ? undefined : (window.resetsAt * 1000 - now) / 3_600_000;
    const reopened = resetsInHours !== undefined && resetsInHours <= 0;
    const period = windowPeriod(window);
    return {
        kind: window.kind,
        ...opt("pool", poolName(window)),
        leftPoints: reopened ? 100 : Math.max(0, 100 - window.utilization),
        ...opt("resetsInHours", reopened ? (period === undefined ? undefined : period.seconds / 3_600) : resetsInHours),
        tokensPerPoint: learned ?? PRIOR_TOKENS_PER_AGENT_HOUR / pointsPerAgentHour,
    };
};

/** The provider's accounts as the projection reads them, and whether a child on it is placed on one. */
export interface PlanAccounts {
    readonly accounts: readonly BudgetAccount[];
    // Claude's: the sandbox picks the account, so a child is placed on one. A routed provider's ready accounts are one pool.
    readonly placed: boolean;
    readonly child: ChildCost;
    readonly reserve: number;
}

const planAccounts = async (deps: PlannerDeps, input: PlanInput, now: number = Date.now()): Promise<PlanAccounts> => {
    await deps.burnRates.ready();
    const [refusals, runOuts, settings] = await Promise.all([
        // allow(silent-catch): an unreadable refusal file leaves the readings to speak alone, as in the listing.
        deps.providerRefusals.onFile().catch((): Record<string, readonly ProviderRefusal[]> => ({})),
        // allow(silent-catch): an unreadable run-out record only costs the planner a prior; the generic one stands.
        deps.runOuts.read().catch((): Record<string, RunOut> => ({})),
        deps.sandboxSettings.get(),
    ]);
    const model = { id: input.model };
    const states = serviceStates(input.readings, refusals[input.provider], model, now);
    const ready = input.readings.filter((reading) => {
        const state = states.get(reading.account);
        return state?.kind === "ready" && state.room > 0;
    });
    const load = loadByAccount(deps, input.provider, now);
    const child = childCostOf(deps, input.provider, input.model);
    const runOut = runOuts[input.provider];
    const placed = input.provider === "claude";
    const reserve = settings.subagentReservePercent;
    if (placed) {
        const accounts = ready.map((reading): BudgetAccount => {
            const here = load.get(reading.account) ?? { tokensPerHour: 0, agents: 0 };
            return {
                id: reading.account,
                ...opt("label", reading.label),
                windows: gatingWindows(reading.usage, model).map((window) => budgetWindow(deps, { provider: input.provider, account: reading.account, runOut }, window, now)),
                loadTokensPerHour: here.tokensPerHour,
                agents: here.agents,
            };
        });
        return { accounts, placed, child, reserve };
    }
    return { accounts: ready.length === 0 ? [] : [pooled(deps, input, ready, load, runOut, now)], placed, child, reserve };
};

// A routed provider's ready accounts as one: each window's points summed across them, its reset the latest of theirs.
const pooled = (
    deps: Pick<PlannerDeps, "burnRates">,
    input: PlanInput,
    ready: readonly ServiceFacts[],
    load: ReadonlyMap<string | undefined, { tokensPerHour: number; agents: number }>,
    runOut: RunOut | undefined,
    now: number,
): BudgetAccount => {
    const byKind = new Map<string, BudgetWindow>();
    for (const reading of ready) {
        for (const window of gatingWindows(reading.usage, { id: input.model })) {
            const one = budgetWindow(deps, { provider: input.provider, account: undefined, runOut }, window, now);
            const kept = byKind.get(window.kind);
            byKind.set(
                window.kind,
                kept === undefined
                    ? one
                    : {
                          ...kept,
                          leftPoints: kept.leftPoints + one.leftPoints,
                          ...opt("resetsInHours", Math.max(kept.resetsInHours ?? 0, one.resetsInHours ?? 0) || undefined),
                      },
            );
        }
    }
    const all = [...load.values()].reduce((sum, here) => ({ tokensPerHour: sum.tokensPerHour + here.tokensPerHour, agents: sum.agents + here.agents }), { tokensPerHour: 0, agents: 0 });
    return { id: input.provider, windows: [...byKind.values()], loadTokensPerHour: all.tokensPerHour, agents: all.agents };
};

/** What a claim answers: the child goes (on this account, where it is placed), or waits, with why and when to ask again. */
export type BudgetClaim =
    | { readonly go: true; readonly account?: string; readonly projection?: Projection; readonly short?: true }
    | { readonly go: false; readonly projections: readonly Projection[]; readonly retryAt?: number };

// The soonest a window that decided a refusal reopens, epoch ms: when a held start is worth asking about again.
const soonestReopening = (projections: readonly Projection[], now: number): number | undefined => {
    const hours = projections.flatMap((projection) => projection.windows.filter((window) => !window.fits).flatMap((window) => (window.window.resetsInHours === undefined ? [] : [window.window.resetsInHours])));
    return hours.length === 0 ? undefined : now + Math.max(0, Math.min(...hours)) * 3_600_000 + 60_000;
};

export interface ClaimInput extends PlanInput {
    readonly childId: string;
    // How many of this sandbox's children already run on the provider: none, and the child goes whatever the figures
    // say, since a projection that holds the only child back holds the work back for an estimate.
    readonly childrenRunning: number;
}

/**
 * Whether a child may start now, and where. A child that goes is counted on its account from this moment, so the next
 * claim on the provider sees it; `drop` takes it back when its start fails.
 */
export const claimBudget = (deps: PlannerDeps, input: ClaimInput, now: () => number = Date.now): Promise<BudgetClaim> =>
    serialized(input.provider, async () => {
        const at = now();
        const plan = await planAccounts(deps, input, at);
        const settings = await deps.sandboxSettings.get();
        if (plan.accounts.length === 0) {
            // Nothing ready reads a figure: the old path decides (the spent gate, the credential's own pick).
            return { go: true };
        }
        const best = choose(plan.accounts, plan.child, plan.reserve);
        const pick = best ?? (settings.subagentBudget === false || input.childrenRunning === 0 ? leastShort(plan.accounts, plan.child, plan.reserve) : undefined);
        if (pick === undefined) {
            const projections = plan.accounts.map((account) => leastShort([account], plan.child, plan.reserve)).filter((projection) => projection !== undefined);
            return { go: false, projections, ...opt("retryAt", soonestReopening(projections, at)) };
        }
        const account = plan.placed ? pick.account.id : undefined;
        committed.set(input.childId, { provider: input.provider, account, tokensPerHour: plan.child.tokensPerHour, at });
        return { go: true, ...opt("account", account), projection: pick, ...opt("short", best === undefined ? (true as const) : undefined) };
    });

/** A claimed child that did not start after all: it no longer counts on its account. */
export const dropClaim = (childId: string): void => {
    committed.delete(childId);
};

/** What the provider carries for children of this model: each account's standing, and how many more fit between them. */
export interface BudgetForecast {
    readonly plan: PlanAccounts;
    readonly projections: readonly Projection[];
    readonly more: number;
}

export const forecastBudget = async (deps: PlannerDeps, input: PlanInput, now: number = Date.now()): Promise<BudgetForecast | undefined> => {
    const plan = await planAccounts(deps, input, now);
    if (plan.accounts.length === 0) {
        return undefined;
    }
    const projections = plan.accounts.map((account) => leastShort([account], plan.child, plan.reserve)).filter((projection) => projection !== undefined);
    return { plan, projections, more: capacity(plan.accounts, plan.child, plan.reserve) };
};

/** The account a turn moved off a spent one should land on: the one that carries it best, never `refused`. */
export const pickAccount = async (deps: PlannerDeps, input: PlanInput & { readonly refused: string | undefined }): Promise<string | undefined> => {
    const plan = await planAccounts(deps, { ...input, readings: input.readings.filter((reading) => reading.account !== input.refused) });
    if (!plan.placed) {
        return undefined;
    }
    return (choose(plan.accounts, plan.child, plan.reserve) ?? leastShort(plan.accounts, plan.child, plan.reserve))?.account.id;
};

/** Every claim forgotten: a suite's clean slate. */
export const resetBudgetPlanner = (): void => {
    committed.clear();
    chains.clear();
};
