import type { AccountState, AccountUsage, UsageWindow, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentLoop, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { loopsOf, PROVIDERS } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    bindingWindow,
    fleetCapacity,
    gatingWindows,
    SPENT_UTILIZATION,
    type ModelRef,
    type RefusalsOnFile,
    type ServiceFacts,
    serviceStates,
} from "@intentic/sandbox-contract/models/plan-pools";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { Services } from "../../composition.js";
import { accountFactsOf } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";
import { poolName, type RunOut } from "../../usage/run-outs.js";
import { runningOn } from "../run/turn/turn-pulse.js";
import { childCostOf, forecastBudget } from "../run/spend/budget-planner.js";
import { forecastWords } from "../run/spend/budget-words.js";

// What a parent may spend on a child right now: connected providers, their models' headroom, and how much. Reads happen
// once per provider, not per model, and every model is judged by the one rule the spawn gate, the role ladder and the
// picker read (plan-pools.ts fleetCapacity): servable with room measured, servable unmeasured (marked unmetered), or
// spent (left out, by name). The gate refuses a spawn the same rule calls spent (child-listing.ts, spentRung).

/** Remaining headroom in the pool gating this model, when the plan publishes one, and whose reading it is. */
export interface ModelHeadroom {
    // 0-100, from the account with the most room left. Rounded: the reading is only an estimate.
    readonly percentLeft: number;
    // What the plan calls this pool ("Weekly", "Opus", "five-hour"); absent for an undivided allowance. Named whenever
    // the account has another pool the model spends too, so the figure says which one it is.
    readonly pool?: string;
    // The account's other pools this model spends, with what each has left: "84% left" read as the five-hour window
    // when it was the weekly one, and the five-hour one fresh, is how a fan-out misjudges what one window holds.
    readonly others?: readonly { readonly pool: string; readonly percentLeft: number }[];
    // Whose figure it is: that account's label, since several accounts of one provider read differently.
    readonly account?: string;
    // When that reading was taken, epoch ms: a figure is only as current as its reading.
    readonly readAt?: number;
    // Present while re-reading that account keeps failing: the figure is its last good reading, and may be well past.
    readonly stale?: { readonly since: number; readonly reason: string };
    // How the provider's other accounts stand for this model, present only when some cannot serve it: a figure off the
    // best account says nothing of the rest. Gemini read "83% left" off one of three ready accounts while 22 others were
    // benched for a week, and a fan-out spent the three in twelve minutes (2026-10-17).
    readonly fleet?: AccountsStanding;
}

/** How many of a provider's accounts can serve a model, and when the first of the others is back. */
export interface AccountsStanding {
    readonly ready: number;
    readonly total: number;
    // Epoch seconds when the first account that cannot serve now is back, where any says; absent for none named.
    readonly backAt?: number;
}

export interface SpawnableModel {
    readonly id: string;
    readonly label: string;
    // Absent means nothing on file measures this model's allowance; not the same as no room.
    readonly headroom?: ModelHeadroom;
}

export interface SpawnableProvider {
    readonly id: AgentProvider;
    readonly label: string;
    // In the provider's own preference order, with spent models removed.
    readonly models: readonly SpawnableModel[];
    // How many models were left out because every connected account is at the cap for them.
    readonly spent: number;
    // Those same models by name, so a spawn naming one can be refused for the right reason rather than for being absent
    // from `models` (a catalog that failed to read also leaves it empty). Optional like `reopensAt`: `spent` is the
    // count every reader needs, this is the detail a refusal quotes.
    readonly spentModels?: readonly { readonly id: string; readonly label: string; readonly reopensAt?: number }[];
    // Epoch seconds when the soonest one reopens, where the provider said; meaningful only with `spent > 0`.
    readonly reopensAt?: number;
    // The loops a spawn may name as its harness, the default first; absent or one long means there is no choice.
    readonly loops?: readonly AgentLoop[];
    // This sandbox's agents running on the provider right now, by model; absent when none is. What a fan-out adds to.
    readonly running?: Readonly<Record<string, number>>;
    // When its allowance last ran out, and under how many of this sandbox's agents (usage/run-outs.ts): the rate beside
    // the level, so a parent can see how fast a fan-out on it spends a window.
    readonly lastRunOut?: RunOut;
    // The fan-out planner's projection for children of its heaviest model, in words (agent/run/spend/budget-words.ts): each
    // account's standing and how many more fit now. Absent for a provider whose accounts read no figure.
    readonly budget?: string;
}

// Every connected account of a provider as the serviceability rule reads it (usage/serviceability.ts accountFactsOf):
// the same facts for every provider, Claude's seat marks, the translator's benches and a door's plain rows alike. An
// unreadable list leaves the provider with nothing on file, read as unmetered rather than empty. The fan-out budget
// reads the same (fan-out-budget.ts).
export const factsOf = async (services: Services, provider: AgentProvider): Promise<readonly ServiceFacts[]> =>
    // allow(silent-catch): the listing is advice, and one provider's trouble must not silence the rest.
    accountFactsOf(services, provider).catch(() => []);

// The pool a figure is about, by the name a person uses: always where the account has another pool the model spends,
// else only one the plan scopes to some models (an undivided allowance is just "the allowance").
const namedPool = (pool: UsageWindow, amongOthers: boolean): string | undefined =>
    amongOthers ? poolName(pool) : pool.gates === "all" || pool.label === undefined ? undefined : pool.label;

// Every other pool on the account this model spends, roomiest last, each named and with what it has left.
const otherPools = (usage: AccountUsage | undefined, model: ModelRef, binding: UsageWindow | undefined): { readonly pool: string; readonly percentLeft: number }[] =>
    gatingWindows(usage, model)
        .filter((window) => window !== binding)
        .toSorted((left, right) => right.utilization - left.utilization)
        .flatMap((window) => {
            const pool = poolName(window);
            return pool === undefined ? [] : [{ pool, percentLeft: Math.max(0, Math.round(SPENT_UTILIZATION - window.utilization)) }];
        });

type Roomy = { readonly reading: ServiceFacts; readonly room: number };
const roomiest = (rows: readonly Roomy[]): Roomy | undefined =>
    rows.reduce<Roomy | undefined>((most, next) => (most === undefined || next.room > most.room ? next : most), undefined);

// Most room any one account the rule calls ready has left for this model, judged with the provider's standing refusal;
// undefined if none has proven room. A reading that can still be re-read wins over one that cannot, whatever it says:
// a stale figure is quoted only when it is all there is, and then marked stale.
const bestHeadroom = (readings: readonly ServiceFacts[], model: ModelRef, refusals: RefusalsOnFile): ModelHeadroom | undefined => {
    const states = serviceStates(readings, refusals, model);
    const ready = readings.flatMap((reading) => {
        const state = states.get(reading.account);
        return state?.kind === "ready" ? [{ reading, room: state.room }] : [];
    });
    const best = roomiest(ready.filter((row) => row.reading.usage?.unread === undefined)) ?? roomiest(ready);
    if (best === undefined) {
        return undefined;
    }
    const fleet = standingOf(readings, states, ready.length);
    const pool = bindingWindow(best.reading.usage, model);
    const unread = best.reading.usage?.unread;
    const others = otherPools(best.reading.usage, model, pool);
    return {
        percentLeft: Math.max(0, Math.round(best.room)),
        ...opt("pool", pool === undefined ? undefined : namedPool(pool, others.length > 0)),
        ...(others.length === 0 ? {} : { others }),
        account: best.reading.label ?? best.reading.account,
        ...opt("readAt", best.reading.usage?.measuredAt),
        ...opt("stale", unread === undefined ? undefined : { since: unread.since, reason: unread.reason }),
        ...opt("fleet", fleet),
    };
};

// The fleet's standing beside the best figure; undefined while every account can serve.
const standingOf = (readings: readonly ServiceFacts[], states: ReadonlyMap<string, AccountState>, ready: number): AccountsStanding | undefined => {
    if (ready === readings.length) {
        return undefined;
    }
    const back = readings.flatMap((reading) => {
        const state = states.get(reading.account);
        const at = state?.kind === "blocked" ? state.until : state?.kind === "spent" ? state.reopensAt : undefined;
        return at === undefined ? [] : [at];
    });
    return { ready, total: readings.length, ...opt("backAt", back.length === 0 ? undefined : Math.min(...back)) };
};


// Earliest instant among those given, ignoring undefineds; any one pool reopening makes the provider spendable again.
const soonest = (instants: readonly (number | undefined)[]): number | undefined =>
    instants.reduce<number | undefined>((best, at) => (at !== undefined && (best === undefined || at < best) ? at : best), undefined);

// `refusals` are the provider's refusals on file, read beside the readings: a plan that just said no ("usage limit, try
// again at 3:38 PM") is spent in the very next listing, whatever its usage endpoint still reports, and a Cursor model it
// refused is spent though Cursor publishes no reading at all (2026-10-13: listed as "not metered" through seven refused
// spawns, when only the role ladder read its refusals).
const spendable = (
    provider: NativeProvider,
    catalog: { models: Model[] },
    readings: readonly ServiceFacts[],
    refusals: RefusalsOnFile,
    load: { readonly running?: Readonly<Record<string, number>> | undefined; readonly lastRunOut?: RunOut | undefined } = {},
): SpawnableProvider => {
    const judged = catalog.models.map((model) => {
        const ref: ModelRef = { id: model.id, label: model.label };
        return { model, ref, capacity: fleetCapacity(readings, refusals, ref) };
    });
    const out = judged.flatMap((row) => (row.capacity.kind === "spent" ? [{ ...row, capacity: row.capacity }] : []));
    const rows = judged
        .filter((row) => row.capacity.kind !== "spent")
        .map((row) => {
            const headroom = bestHeadroom(readings, row.ref, refusals);
            return { id: row.model.id, label: row.model.label, ...(headroom === undefined ? {} : { headroom }) };
        });
    const reopensAt = soonest(out.map((row) => row.capacity.reopensAt));
    return {
        id: provider,
        label: PROVIDERS.find((row) => row.value === provider)?.label ?? provider,
        models: rows,
        spent: out.length,
        // What was left out, by name: a spawn onto one of them is refused naming it, not merely counted (children.ts).
        spentModels: out.map((row) => ({ id: row.model.id, label: row.model.label, ...opt("reopensAt", row.capacity.reopensAt) })),
        ...(reopensAt === undefined ? {} : { reopensAt }),
        loops: loopsOf(provider),
        ...opt("running", load.running),
        ...opt("lastRunOut", load.lastRunOut),
    };
};

// This sandbox's agents running on a provider right now, by model; undefined when none is.
const runningByModel = (provider: string): Readonly<Record<string, number>> | undefined => {
    const running = runningOn(provider);
    if (running.length === 0) {
        return undefined;
    }
    const byModel: Record<string, number> = {};
    for (const pulse of running) {
        const model = pulse.model ?? "default";
        byModel[model] = (byModel[model] ?? 0) + 1;
    }
    return byModel;
};

// What a child could be started on right now, connected providers only. Failure is per provider: a slow or dead
// model-catalog read reports that provider with no models rather than dropping the whole listing.
export const spawnableProviders = async (services: Services): Promise<readonly SpawnableProvider[]> => {
    // An unreadable refusal file leaves the readings to speak alone, as they did before one was ever written.
    const refusalsRead = async (): Promise<Record<string, readonly ProviderRefusal[]>> => services.providerRefusals.onFile();
    // allow(silent-catch): a run-out record that cannot be read only costs the listing its rate, never its levels.
    const runOutsRead = async (): Promise<Record<string, RunOut>> => services.runOuts.read();
    const [ready, refusals, runOuts] = await Promise.all([
        services.providerReadiness(),
        refusalsRead().catch((): Record<string, readonly ProviderRefusal[]> => ({})),
        runOutsRead().catch((): Record<string, RunOut> => ({})),
    ]);
    return Promise.all(
        NATIVE_PROVIDERS.filter((provider) => ready[provider]).map(async (provider) => {
            const [catalog, readings] = await Promise.all([services.providerCatalogs[provider].models().catch(() => ({ models: [] })), factsOf(services, provider)]);
            const row = spendable(provider, catalog, readings, refusals[provider] ?? [], { running: runningByModel(provider), lastRunOut: runOuts[provider] });
            const budget = readings.length === 0 ? undefined : await budgetLine(services, row, readings);
            return budget === undefined ? row : { ...row, budget };
        }),
    );
};

// The model a budget line is said for: the one this sandbox runs most on the provider now, else the heaviest it lists,
// since a line said for the lightest would promise room the usual child does not get.
const budgetModel = (services: Services, row: SpawnableProvider): string | undefined => {
    const busiest = Object.entries(row.running ?? {}).toSorted((left, right) => right[1] - left[1])[0]?.[0];
    if (busiest !== undefined && row.models.some((model) => model.id === busiest)) {
        return busiest;
    }
    return row.models.reduce<{ readonly id: string; readonly rate: number } | undefined>((heaviest, model) => {
        const rate = childCostOf(services, row.id, model.id).tokensPerHour;
        return heaviest === undefined || rate > heaviest.rate ? { id: model.id, rate } : heaviest;
    }, undefined)?.id;
};

// The provider's budget line, where its accounts read a figure.
const budgetLine = async (services: Services, row: SpawnableProvider, readings: readonly ServiceFacts[]): Promise<string | undefined> => {
    const model = budgetModel(services, row);
    if (model === undefined) {
        return undefined;
    }
    // allow(silent-catch): the budget line is advice beside the figures; a projection that cannot be read leaves them alone.
    const forecast = await forecastBudget(services, { provider: row.id, model, readings }).catch(() => undefined);
    return forecast === undefined ? undefined : forecastWords(forecast, model);
};

// Reopen time in words rather than an absolute instant, since the daemon does not know the reader's timezone.
// Deliberately coarse: the number is only the provider's own estimate.
const inWords = (reopensAt: number, now: number): string => {
    const seconds = reopensAt - Math.floor(now / 1000);
    if (seconds <= 60) {
        return `any moment`;
    }
    if (seconds < 3_600) {
        return `in about ${Math.round(seconds / 60)} min`;
    }
    if (seconds < 36 * 3_600) {
        return `in about ${Math.round(seconds / 3_600)}h`;
    }
    return `in about ${Math.round(seconds / 86_400)} days`;
};

// How long ago an instant was, in words as coarse as the reading it dates.
const agoWords = (at: number, now: number): string => {
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 2) {
        return `just now`;
    }
    if (minutes < 90) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 36 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
};

// A figure with whose it is and how old: a reading hours old, or one that can no longer be re-read, is said as such
// rather than passing for the plan's state now. The account's other pools ride beside it, so "84% left" says it is the
// weekly figure, with the five-hour window fresh beside it.
const headroomText = (headroom: ModelHeadroom, now: number): string => {
    const pool = headroom.pool === undefined ? `` : `${headroom.pool} `;
    const whose = headroom.account === undefined ? `` : ` on ${headroom.account}`;
    const others = (headroom.others ?? []).map((other) => `${other.pool} ${other.percentLeft}%`);
    const beside = others.length === 0 ? `` : ` (${others.join(`, `)} left)`;
    const read = headroom.readAt === undefined ? `` : `, read ${agoWords(headroom.readAt, now)}`;
    const stale =
        headroom.stale === undefined
            ? ``
            : `, STALE: re-reading it has failed since ${agoWords(headroom.stale.since, now)} (${headroom.stale.reason})`;
    return `${pool}${headroom.percentLeft}% left${whose}${beside}${read}${stale}${fleetText(headroom.fleet, now)}`;
};

// "; 3 of 25 accounts ready, the next back in about 7 days": the figure is the best account's, and the rest are out.
const fleetText = (fleet: AccountsStanding | undefined, now: number): string => {
    if (fleet === undefined) {
        return ``;
    }
    const back = fleet.backAt === undefined ? `` : `, the next back ${inWords(fleet.backAt, now)}`;
    return `; ${String(fleet.ready)} of ${String(fleet.total)} accounts ready${back}`;
};

const NOT_METERED = `not metered`;

// Named only where there is a choice: the harness values a spawn may pass, so an agent never has to guess one.
const loopsText = (loops: readonly AgentLoop[] | undefined): string =>
    loops === undefined || loops.length < 2 ? `` : `; harness: ${loops.map((loop, index) => (index === 0 ? `${loop} (default)` : loop)).join(`, `)}`;

// "gpt-6.1-sol ×3, gpt-6-sol": how many agents on each model, the busiest first.
const modelCounts = (models: Readonly<Record<string, number>>): string =>
    Object.entries(models)
        .toSorted((left, right) => right[1] - left[1])
        .map(([model, count]) => (count === 1 ? model : `${model} ×${String(count)}`))
        .join(`, `);

const agentCount = (models: Readonly<Record<string, number>>): number => Object.values(models).reduce((sum, count) => sum + count, 0);

const agentsWord = (count: number): string => (count === 1 ? `1 agent` : `${String(count)} agents`);

// How long a window lasted, as coarsely as its reading dates it.
const spanWords = (ms: number): string => {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 90) {
        return `${String(minutes)} min`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))} days`;
};

// What a fan-out adds to: this sandbox's agents on the provider now. Said only when there are some.
const runningText = (running: Readonly<Record<string, number>> | undefined): string =>
    running === undefined || agentCount(running) === 0 ? `` : `; ${agentsWord(agentCount(running))} of this sandbox running on it now (${modelCounts(running)})`;

// The rate beside the level: when the allowance last ran out, how far into its window, and under how many agents.
const runOutText = (runOut: RunOut | undefined, now: number): string => {
    if (runOut === undefined) {
        return ``;
    }
    const into = runOut.openedAt === undefined || runOut.openedAt > runOut.at ? `` : `, ${spanWords(runOut.at - runOut.openedAt)} into its ${runOut.pool ?? `allowance`} window`;
    const agents = agentCount(runOut.models);
    const under = agents === 0 ? `` : `, with ${agentsWord(agents)} of this sandbox on it (${modelCounts(runOut.models)})`;
    return `; last ran out ${agoWords(runOut.at, now)}${into}${under}`;
};

const providerText = (provider: SpawnableProvider, now: number, named: number): string => {
    const load = `${runningText(provider.running)}${runOutText(provider.lastRunOut, now)}${provider.budget === undefined ? `` : `; ${provider.budget}`}`;
    if (provider.models.length === 0) {
        const renews = provider.reopensAt === undefined ? `` : `, renews ${inWords(provider.reopensAt, now)}`;
        // Two different silences: nothing left to spend, versus nothing to list at all.
        const reason = provider.spent > 0 ? `every model is out of allowance${renews}` : `no models published`;
        return `${provider.id}: ${reason}${load}`;
    }
    const held = provider.spent === 0 ? `` : ` — ${provider.spent} more out of allowance`;
    return `${provider.id}: ${modelsText(provider.models, now, named)}${held}${load}${loopsText(provider.loops)}`;
};

// How many unmetered models are named before the rest are counted. A provider that publishes no allowance has every
// model in one undifferentiated list — Cursor alone prints 45 of them, each reading "(not metered)" — which a model
// reads before every fan-out for no information at all. The listing is in the provider's own preference order, so the
// ones named are the ones worth naming.
const UNMETERED_NAMED = 8;

// Models that read alike are listed once, under the one figure they share: Claude's fourteen models on one account
// printed one figure fourteen times, which is noise a reader skims past to the number that mattered.
const grouped = (rows: readonly { readonly id: string; readonly text: string }[]): string[] => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
        groups.set(row.text, [...(groups.get(row.text) ?? []), row.id]);
    }
    return [...groups.entries()].map(([text, ids]) => `${ids.join(`, `)} (${text})`);
};

// Metered models always print their figure; unmetered ones past the cap are counted instead of named.
const modelsText = (models: readonly SpawnableModel[], now: number, named: number): string => {
    const metered = models.flatMap((model) => (model.headroom === undefined ? [] : [{ id: model.id, text: headroomText(model.headroom, now) }]));
    const plain = models.filter((model) => model.headroom === undefined);
    const shown = [...grouped(metered), ...grouped(plain.slice(0, named).map((model) => ({ id: model.id, text: NOT_METERED })))];
    const rest = plain.length - Math.min(plain.length, named);
    // Said as what it is: more models this provider serves, none of them metered, nameable on request.
    return rest === 0 ? shown.join(`, `) : `${shown.join(`, `)}, and ${String(rest)} more not metered (\`agents providers --all\`)`;
};

// What the figures above do NOT say: they are per account, and children started together spend the same one. Thirteen
// Claude children were once started against an account reading "96% left" and all hit the wall together (2026-10-12),
// and ten against "84% left" in 2026-10-20 after this sentence said so: the arithmetic is the sandbox's now, and the
// sentence says what it does with it.
const SHARED_POOL =
    "Each figure is one account's, and subagents started together spend together. The sandbox places each subagent on the account left with the most room after it, and one the accounts cannot carry through their windows waits as pending and starts by itself when room is back: spawn what the work needs, and read the budget line for how many start at once.";

/** Every unmetered model named rather than counted, for `agents providers --all`. */
export interface CatalogTextOptions {
    readonly now?: number;
    readonly all?: boolean;
}

// The listing as the agent reads it, written once and shared by the `agents providers` CLI verb, the `providers` MCP
// tool, and the refusal for a spawn missing its provider or model.
export const spawnCatalogText = (providers: readonly SpawnableProvider[], now: number = Date.now(), options: CatalogTextOptions = {}): string => {
    if (providers.length === 0) {
        return `No AI provider is connected to this sandbox, so no subagent can be started. Connect one in Sandbox ▸ Agent ▸ Accounts.`;
    }
    const named = options.all === true ? Number.POSITIVE_INFINITY : UNMETERED_NAMED;
    const listing = providers.map((provider) => providerText(provider, now, named)).join(`\n`);
    // Said only where a figure is on show: with nothing metered there is no number for a fan-out to misread, and the
    // sentence would be noise on the listing a reader checks most often.
    const metered = providers.some((provider) => provider.models.some((model) => model.headroom !== undefined));
    return metered ? `${listing}\n${SHARED_POOL}` : listing;
};

/**
 * Why this provider and model cannot be spawned on right now, or undefined to go ahead. Only a model the records
 * actually call spent is refused: an unmeasured one may well answer, and refusing it would ground every provider that
 * publishes no allowance. Read before a seat is taken (children.ts), since nothing validated a spawn against this
 * listing before — which is how five children went onto a spent Cursor model in 32 seconds (2026-10-11).
 */
export const spawnBlocked = (
    providers: readonly SpawnableProvider[],
    asked: { readonly provider: string; readonly model: string },
    now: number = Date.now(),
): string | undefined => {
    const row = providers.find((provider) => provider.id === asked.provider);
    if (row === undefined) {
        return undefined;
    }
    const spent = (row.spentModels ?? []).find((model) => model.id === asked.model);
    if (spent === undefined) {
        return undefined;
    }
    const renews = spent.reopensAt === undefined ? `` : `, which renews ${inWords(spent.reopensAt, now)}`;
    const room = row.models.length === 0 ? `` : ` With room on ${asked.provider} right now: ${row.models.map((model) => model.id).join(`, `)}.`;
    const elsewhere = providers
        .filter((provider) => provider.id !== asked.provider && provider.models.length > 0)
        .map((provider) => provider.id)
        .join(`, `);
    const others = elsewhere === `` ? `` : ` Other providers with room: ${elsewhere}.`;
    return `${asked.provider}/${asked.model} is out of allowance${renews}: the records say every connected ${asked.provider} account is at its cap for this model, so a subagent on it would be refused before doing any work.${room}${others}`;
};
