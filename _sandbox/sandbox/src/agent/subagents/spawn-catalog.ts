import {
    type AgentProvider,
    bindingWindow,
    type Model,
    type ModelRef,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type ProviderRefusal,
    PROVIDERS,
    serviceStates,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { type FleetReading, fleetLimit, type TurnLimit } from "../../usage/serviceability/fleet-limit.js";
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
    // Epoch seconds when the soonest one reopens, where the provider said; meaningful only with `spent > 0`.
    readonly reopensAt?: number;
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
const bestHeadroom = (readings: readonly FleetReading[], model: ModelRef, refusal: ProviderRefusal | undefined): ModelHeadroom | undefined => {
    const states = serviceStates(readings, refusal, model);
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

// `refusal` is the provider's last refusal, read beside the readings: a plan that just said no ("usage limit, try again at
// 3:38 PM") is spent in the very next listing, whatever its usage endpoint still reports.
const spendable = (
    provider: NativeProvider,
    catalog: { models: Model[] },
    readings: readonly FleetReading[],
    refusal: ProviderRefusal | undefined,
): SpawnableProvider => {
    const judged = catalog.models.map((model) => {
        const ref: ModelRef = { id: model.id, label: model.label };
        return { model, ref, limit: fleetLimit(readings, ref, refusal) };
    });
    const out = judged.filter((row) => exhausted(row.limit));
    const rows = judged
        .filter((row) => !exhausted(row.limit))
        .map((row) => {
            const headroom = bestHeadroom(readings, row.ref, refusal);
            return { id: row.model.id, label: row.model.label, ...(headroom === undefined ? {} : { headroom }) };
        });
    const reopensAt = soonest(out.map((row) => row.limit.reopensAt));
    return {
        id: provider,
        label: PROVIDERS.find((row) => row.value === provider)?.label ?? provider,
        models: rows,
        spent: out.length,
        ...(reopensAt === undefined ? {} : { reopensAt }),
    };
};

// What a child could be started on right now, connected providers only. Failure is per provider: a slow or dead
// model-catalog read reports that provider with no models rather than dropping the whole listing.
export const spawnableProviders = async (services: Services): Promise<readonly SpawnableProvider[]> => {
    // An unreadable refusal file leaves the readings to speak alone, as they did before one was ever written.
    const refusalsRead = async (): Promise<Record<string, ProviderRefusal>> => services.providerRefusals.read();
    const [ready, readings, refusals] = await Promise.all([services.providerReadiness(), fleetReadings(services), refusalsRead().catch((): Record<string, ProviderRefusal> => ({}))]);
    const rows = await Promise.all(
        NATIVE_PROVIDERS.filter((provider) => ready[provider]).map(async (provider) => {
            const catalog = await services.providerCatalogs[provider].models().catch(() => ({ models: [] }));
            return spendable(provider, catalog, readings.get(provider) ?? [], refusals[provider]);
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

const providerText = (provider: SpawnableProvider, now: number): string => {
    if (provider.models.length === 0) {
        const renews = provider.reopensAt === undefined ? `` : `, renews ${inWords(provider.reopensAt, now)}`;
        // Two different silences: nothing left to spend, versus nothing to list at all.
        const reason = provider.spent > 0 ? `every model is out of allowance${renews}` : `no models published`;
        return `${provider.id}: ${reason}`;
    }
    const held = provider.spent === 0 ? `` : ` — ${provider.spent} more out of allowance`;
    return `${provider.id}: ${provider.models.map((model) => modelText(model, now)).join(`, `)}${held}`;
};

// The listing as the agent reads it, written once and shared by the `agents providers` CLI verb, the `providers` MCP
// tool, and the refusal for a spawn missing its provider or model.
export const spawnCatalogText = (providers: readonly SpawnableProvider[], now: number = Date.now()): string => {
    if (providers.length === 0) {
        return `No AI provider is connected to this sandbox, so no subagent can be started. Connect one in Sandbox ▸ Agent ▸ Accounts.`;
    }
    return providers.map((provider) => providerText(provider, now)).join(`\n`);
};
