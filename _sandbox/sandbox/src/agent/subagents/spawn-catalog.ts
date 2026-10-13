import {
    type AgentLoop,
    loopsOf,
    type AgentProvider,
    bindingWindow,
    type Model,
    type ModelRef,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type ProviderRefusal,
    type RefusalsOnFile,
    PROVIDERS,
    serviceStates,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { type FleetReading, fleetLimit, type TurnLimit } from "../../usage/serviceability/fleet-limit.js";
import { observedOwnLimit } from "../../usage/observed-accounts.js";
import { accountFactsOf } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";

// What a parent may spend on a child right now: connected providers, their models' headroom, and how much. Reads happen
// once per provider, not per model. Three states: measured with room, measured full (left out), or unmeasured (marked
// unmetered); this is advice, not a whitelist, nothing validates a spawn against it.

/** Remaining headroom in the pool gating this model, when the plan publishes one, and whose reading it is. */
export interface ModelHeadroom {
    // 0-100, from the account with the most room left. Rounded: the reading is only an estimate.
    readonly percentLeft: number;
    // What the plan calls this pool ("Weekly", "Opus"); absent for an undivided allowance.
    readonly pool?: string;
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
    return {
        percentLeft: Math.max(0, Math.round(best.room)),
        // Only a pool the plan scopes is worth naming; mirrors the rule in fleet-limit.ts.
        ...(pool === undefined || pool.gates === "all" || pool.label === undefined ? {} : { pool: pool.label }),
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
): Promise<SpawnableProvider> => {
    // A provider with readings is judged on them; one with none falls back to its own records, where it keeps any.
    const own = readings.length === 0 ? ownLimit : undefined;
    const judged = await Promise.all(
        catalog.models.map(async (model) => {
            const ref: ModelRef = { id: model.id, label: model.label };
            // allow(silent-catch): a failed own-record read leaves the model unmeasured, as it was before one was ever
            // kept; this listing is advice, and its whole point is that one provider's trouble never silences the rest.
            const mine = own === undefined ? undefined : await own(model.id).catch(() => undefined);
            return { model, ref, limit: mine ?? fleetLimit(readings, ref, refusals) };
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
    };
};

// What a child could be started on right now, connected providers only. Failure is per provider: a slow or dead
// model-catalog read reports that provider with no models rather than dropping the whole listing.
export const spawnableProviders = async (services: Services): Promise<readonly SpawnableProvider[]> => {
    // An unreadable refusal file leaves the readings to speak alone, as they did before one was ever written.
    const refusalsRead = async (): Promise<Record<string, readonly ProviderRefusal[]>> => services.providerRefusals.onFile();
    const [ready, readings, refusals] = await Promise.all([
        services.providerReadiness(),
        fleetReadings(services),
        refusalsRead().catch((): Record<string, readonly ProviderRefusal[]> => ({})),
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
            return spendable(provider, catalog, mine, refusals[provider], own);
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
// rather than passing for the plan's state now.
const modelText = (model: SpawnableModel, now: number): string => {
    const headroom = model.headroom;
    if (headroom === undefined) {
        return `${model.id} (not metered)`;
    }
    const pool = headroom.pool === undefined ? `` : `${headroom.pool} `;
    const whose = headroom.account === undefined ? `` : ` on ${headroom.account}`;
    const read = headroom.readAt === undefined ? `` : `, read ${agoWords(headroom.readAt, now)}`;
    const stale = headroom.stale === undefined ? `` : `, STALE: re-reading it has failed since ${agoWords(headroom.stale.since, now)} (${headroom.stale.reason})`;
    return `${model.id} (${pool}${headroom.percentLeft}% left${whose}${read}${stale})`;
};

// Named only where there is a choice: the harness values a spawn may pass, so an agent never has to guess one.
const loopsText = (loops: readonly AgentLoop[] | undefined): string =>
    loops === undefined || loops.length < 2 ? `` : `; harness: ${loops.map((loop, index) => (index === 0 ? `${loop} (default)` : loop)).join(`, `)}`;

const providerText = (provider: SpawnableProvider, now: number, named: number): string => {
    if (provider.models.length === 0) {
        const renews = provider.reopensAt === undefined ? `` : `, renews ${inWords(provider.reopensAt, now)}`;
        // Two different silences: nothing left to spend, versus nothing to list at all.
        const reason = provider.spent > 0 ? `every model is out of allowance${renews}` : `no models published`;
        return `${provider.id}: ${reason}`;
    }
    const held = provider.spent === 0 ? `` : ` — ${provider.spent} more out of allowance`;
    return `${provider.id}: ${modelsText(provider.models, now, named)}${held}${loopsText(provider.loops)}`;
};

// How many unmetered models are named before the rest are counted. A provider that publishes no allowance has every
// model in one undifferentiated list — Cursor alone prints 45 of them, each reading "(not metered)" — which a model
// reads before every fan-out for no information at all. The listing is in the provider's own preference order, so the
// ones named are the ones worth naming.
const UNMETERED_NAMED = 8;

// Metered models always print their figure; unmetered ones past the cap are counted instead of named.
const modelsText = (models: readonly SpawnableModel[], now: number, named: number): string => {
    const metered = models.filter((model) => model.headroom !== undefined);
    const plain = models.filter((model) => model.headroom === undefined);
    const shown = [...metered, ...plain.slice(0, named)].map((model) => modelText(model, now));
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
