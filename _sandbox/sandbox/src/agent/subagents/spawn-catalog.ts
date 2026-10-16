import type { AccountUsage, UsageWindow, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentLoop, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { loopsOf, PROVIDERS } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    bindingWindow,
    gatingWindows,
    SPENT_UTILIZATION,
    type ModelRef,
    type RefusalsOnFile,
    serviceStates,
} from "@intentic/sandbox-contract/models/plan-pools";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { Services } from "../../composition.js";
import { askableLimit, type FleetReading, type TurnLimit } from "../../usage/serviceability/fleet-limit.js";
import { observedOwnLimit } from "../../usage/observed-accounts.js";
import { accountFactsOf } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";
import { poolName, type RunOut } from "../../usage/run-outs.js";
import { runningOn } from "../run/turn/turn-pulse.js";

// What a parent may spend on a child right now: connected providers, their models' headroom, and how much. Reads happen
// once per provider, not per model. Three states: measured with room, measured full (left out), or unmeasured (marked
// unmetered); this is advice, not a whitelist, nothing validates a spawn against it.

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
}

// Every connected account as the serviceability rule reads it, per provider, in as few round trips as there are
// providers: Claude's with its seat marks and revokes (usage/serviceability.ts), the translator's four with their benches
// in one management call. A provider absent from the map has nothing on file, read as unmetered rather than empty.
const fleetReadings = async (services: Services): Promise<Map<AgentProvider, readonly FleetReading[]>> => {
    const readings = new Map<AgentProvider, readonly FleetReading[]>();
    const [claude, routed] = await Promise.all([accountFactsOf(services, "claude").catch(() => []), services.cliProxy.accounts().catch(() => undefined)]);
    if (claude.length > 0) {
        readings.set("claude", claude);
    }
    for (const [provider, accounts] of Object.entries(routed ?? {})) {
        if (accounts.length > 0) {
            readings.set(
                provider as AgentProvider,
                accounts.map((account) => ({ account: account.name, label: account.label, usage: account.usage, cooling: account.cooling })),
            );
        }
    }
    return readings;
};

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

type Roomy = { readonly reading: FleetReading; readonly room: number };
const roomiest = (rows: readonly Roomy[]): Roomy | undefined =>
    rows.reduce<Roomy | undefined>((most, next) => (most === undefined || next.room > most.room ? next : most), undefined);

// Most room any one account the rule calls ready has left for this model, judged with the provider's standing refusal;
// undefined if none has proven room. A reading that can still be re-read wins over one that cannot, whatever it says:
// a stale figure is quoted only when it is all there is, and then marked stale.
const bestHeadroom = (readings: readonly FleetReading[], model: ModelRef, refusals: RefusalsOnFile): ModelHeadroom | undefined => {
    const states = serviceStates(readings, refusals, model);
    const ready = readings.flatMap((reading) => {
        const state = states.get(reading.account);
        return state?.kind === "ready" ? [{ reading, room: state.room }] : [];
    });
    const best = roomiest(ready.filter((row) => row.reading.usage?.unread === undefined)) ?? roomiest(ready);
    if (best === undefined) {
        return undefined;
    }
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
    };
};

// `spent` and `reopensAt` describe what was left out: a provider fully at the cap still reports via a renewal instant
// instead of vanishing from the listing.
// Both counts at zero means nothing was measured, not that it is exhausted.
const exhausted = (limit: TurnLimit): boolean => limit.spent > 0 && limit.withHeadroom === 0;

// Earliest instant among those given, ignoring undefineds; any one pool reopening makes the provider spendable again.
const soonest = (instants: readonly (number | undefined)[]): number | undefined =>
    instants.reduce<number | undefined>((best, at) => (at !== undefined && (best === undefined || at < best) ? at : best), undefined);

/**
 * What a provider's OWN records say of one model, for a provider whose accounts these readings never cover.
 * `fleetReadings` is fed by Claude's store and the translator's accounts, so a native provider authenticating on its own
 * (Cursor, Devin) reads as unmeasured however spent it is — which is how a spent Cursor model stayed listed as "not
 * metered" through seven refused spawns (2026-10-13). A provider module's own `turnLimit` is the seam for it, the same
 * one the role ladder reads.
 */
export type OwnLimit = (model: string) => Promise<TurnLimit | undefined>;

// `refusals` are the provider's refusals on file, read beside the readings: a plan that just said no ("usage limit, try
// again at 3:38 PM") is spent in the very next listing, whatever its usage endpoint still reports.
const spendable = async (
    provider: NativeProvider,
    catalog: { models: Model[] },
    readings: readonly FleetReading[],
    refusals: RefusalsOnFile,
    ownLimit: OwnLimit | undefined,
    load: { readonly running?: Readonly<Record<string, number>> | undefined; readonly lastRunOut?: RunOut | undefined } = {},
): Promise<SpawnableProvider> => {
    // A provider with readings is judged on them; one with none falls back to its own records, where it keeps any.
    const own = readings.length === 0 ? ownLimit : undefined;
    const judged = await Promise.all(
        catalog.models.map(async (model) => {
            const ref: ModelRef = { id: model.id, label: model.label };
            // allow(silent-catch): a failed own-record read leaves the model unmeasured, as it was before one was ever
            // kept; this listing is advice, and its whole point is that one provider's trouble never silences the rest.
            const mine = own === undefined ? undefined : await own(model.id).catch(() => undefined);
            return { model, ref, limit: mine ?? askableLimit(readings, ref, refusals) };
        }),
    );
    const out = judged.filter((row) => exhausted(row.limit));
    const rows = judged
        .filter((row) => !exhausted(row.limit))
        .map((row) => {
            const headroom = bestHeadroom(readings, row.ref, refusals);
            return { id: row.model.id, label: row.model.label, ...(headroom === undefined ? {} : { headroom }) };
        });
    const reopensAt = soonest(out.map((row) => row.limit.reopensAt));
    return {
        id: provider,
        label: PROVIDERS.find((row) => row.value === provider)?.label ?? provider,
        models: rows,
        spent: out.length,
        // What was left out, by name: a spawn onto one of them is refused naming it, not merely counted (children.ts).
        spentModels: out.map((row) => ({ id: row.model.id, label: row.model.label, ...opt("reopensAt", row.limit.reopensAt) })),
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
    const [ready, readings, refusals, runOuts] = await Promise.all([
        services.providerReadiness(),
        fleetReadings(services),
        refusalsRead().catch((): Record<string, readonly ProviderRefusal[]> => ({})),
        runOutsRead().catch((): Record<string, RunOut> => ({})),
    ]);
    const rows = await Promise.all(
        NATIVE_PROVIDERS.filter((provider) => ready[provider]).map(async (provider) => {
            const mine = readings.get(provider) ?? [];
            const [catalog, own] = await Promise.all([
                services.providerCatalogs[provider].models().catch(() => ({ models: [] })),
                // Only for a provider these readings do not cover; its ledger is read once here, not once per model.
                // allow(silent-catch): an unreadable ledger leaves the provider unmeasured, which is how it read before
                // one was ever kept; this listing is advice, and one provider's trouble must not silence the rest.
                mine.length === 0 ? observedOwnLimit(services, provider).catch(() => undefined) : undefined,
            ]);
            return spendable(provider, catalog, mine, refusals[provider], own, { running: runningByModel(provider), lastRunOut: runOuts[provider] });
        }),
    );
    return rows;
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
    const stale = headroom.stale === undefined ? `` : `, STALE: re-reading it has failed since ${agoWords(headroom.stale.since, now)} (${headroom.stale.reason})`;
    return `${pool}${headroom.percentLeft}% left${whose}${beside}${read}${stale}`;
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
    const load = `${runningText(provider.running)}${runOutText(provider.lastRunOut, now)}`;
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
// Claude children were once started against an account reading "96% left" and all hit the wall together (2026-10-12).
const SHARED_POOL =
    "Each figure is one account's, and subagents you start together draw on it together: a fan-out of N spends roughly N times what one does, so a listing with room is not a promise that every child finishes.";

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
