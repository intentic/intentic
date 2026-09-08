import {
    type AccountUsage,
    type AgentProvider,
    bindingWindow,
    type Model,
    type ModelRef,
    NATIVE_PROVIDERS,
    type NativeProvider,
    PROVIDERS,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { type FleetReading, fleetLimit, type TurnLimit } from "../../usage/fleet-limit.js";
import { harnessReadyProviders } from "../providers/harness-credentials.js";

// What a parent may spend on a child right now: connected providers, their models' headroom, and how much. Reads happen
// once per provider, not per model. Three states: measured with room, measured full (left out), or unmeasured (marked
// unmetered); this is advice, not a whitelist, nothing validates a spawn against it.

/** Remaining headroom in the pool gating this model, when the plan publishes one. */
export interface ModelHeadroom {
    // 0-100, from the account with the most room left. Rounded: the reading is only an estimate.
    readonly percentLeft: number;
    // What the plan calls this pool ("Weekly", "Opus"); absent for an undivided allowance.
    readonly pool?: string;
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

// Every connected account's headroom, per provider, in as few round trips as there are providers. A provider absent
// from the map means nothing on file measures it, read as unmetered rather than empty.
const fleetReadings = async (services: Services): Promise<Map<AgentProvider, readonly FleetReading[]>> => {
    const readings = new Map<AgentProvider, readonly FleetReading[]>();
    const [connected, usage, routed] = await Promise.all([
        services.claudeStore.list().catch(() => []),
        services.accountUsage.read().catch((): Record<string, AccountUsage> => ({})),
        // The translator's four providers in one management call, not one call per provider.
        services.cliProxy.accounts().catch(() => undefined),
    ]);
    if (connected.length > 0) {
        readings.set(
            "claude",
            connected.map((account) => ({ account: account.id, usage: usage[account.id] })),
        );
    }
    for (const [provider, accounts] of Object.entries(routed ?? {})) {
        if (accounts.length > 0) {
            readings.set(
                provider as AgentProvider,
                accounts.map((account) => ({
                    account: account.name,
                    usage: account.usage,
                    ...(account.cooling === undefined ? {} : { cooling: account.cooling }),
                })),
            );
        }
    }
    return readings;
};

// Most room any one account has left for this model; undefined if no account publishes a gating pool. A cooling account
// is skipped: the translator is routing around it regardless of its last quota reading.
const bestHeadroom = (readings: readonly FleetReading[], model: ModelRef): ModelHeadroom | undefined => {
    const windows = readings.flatMap((reading) => {
        if (reading.cooling !== undefined) {
            return [];
        }
        const window = bindingWindow(reading.usage, model);
        return window === undefined ? [] : [window];
    });
    const best = windows.reduce<(typeof windows)[number] | undefined>(
        (room, window) => (room === undefined || window.utilization < room.utilization ? window : room),
        undefined,
    );
    if (best === undefined) {
        return undefined;
    }
    return {
        percentLeft: Math.max(0, Math.round(100 - best.utilization)),
        // Only a pool the plan scopes is worth naming; mirrors the rule in fleet-limit.ts.
        ...(best.gates === "all" || best.label === undefined ? {} : { pool: best.label }),
    };
};

// `spent` and `reopensAt` describe what was left out: a provider fully at the cap still reports via a renewal instant
// instead of vanishing from the listing.
// Both counts at zero means nothing was measured, not that it is exhausted.
const exhausted = (limit: TurnLimit): boolean => limit.spent > 0 && limit.withHeadroom === 0;

// Earliest instant among those given, ignoring undefineds; any one pool reopening makes the provider spendable again.
const soonest = (instants: readonly (number | undefined)[]): number | undefined =>
    instants.reduce<number | undefined>((best, at) => (at !== undefined && (best === undefined || at < best) ? at : best), undefined);

const spendable = (provider: NativeProvider, catalog: { models: Model[] }, readings: readonly FleetReading[]): SpawnableProvider => {
    const judged = catalog.models.map((model) => {
        const ref: ModelRef = { id: model.id, label: model.label };
        return { model, ref, limit: fleetLimit(readings, ref) };
    });
    const out = judged.filter((row) => exhausted(row.limit));
    const rows = judged
        .filter((row) => !exhausted(row.limit))
        .map((row) => {
            const headroom = bestHeadroom(readings, row.ref);
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
    const [ready, readings] = await Promise.all([harnessReadyProviders(services), fleetReadings(services)]);
    const rows = await Promise.all(
        NATIVE_PROVIDERS.filter((provider) => ready[provider]).map(async (provider) => {
            const catalog = await services.providerCatalogs[provider].models().catch(() => ({ models: [] }));
            return spendable(provider, catalog, readings.get(provider) ?? []);
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

const modelText = (model: SpawnableModel): string => {
    if (model.headroom === undefined) {
        return `${model.id} (not metered)`;
    }
    const pool = model.headroom.pool === undefined ? `` : `${model.headroom.pool} `;
    return `${model.id} (${pool}${model.headroom.percentLeft}% left)`;
};

const providerText = (provider: SpawnableProvider, now: number): string => {
    if (provider.models.length === 0) {
        const renews = provider.reopensAt === undefined ? `` : `, renews ${inWords(provider.reopensAt, now)}`;
        // Two different silences: nothing left to spend, versus nothing to list at all.
        const reason = provider.spent > 0 ? `every model is out of allowance${renews}` : `no models published`;
        return `${provider.id}: ${reason}`;
    }
    const held = provider.spent === 0 ? `` : ` — ${provider.spent} more out of allowance`;
    return `${provider.id}: ${provider.models.map(modelText).join(`, `)}${held}`;
};

// The listing as the agent reads it, written once and shared by the `agents providers` CLI verb, the `providers` MCP
// tool, and the refusal for a spawn missing its provider or model.
export const spawnCatalogText = (providers: readonly SpawnableProvider[], now: number = Date.now()): string => {
    if (providers.length === 0) {
        return `No AI provider is connected to this sandbox, so no child agent can be started. Connect one in Sandbox ▸ Agent ▸ Accounts.`;
    }
    return providers.map((provider) => providerText(provider, now)).join(`\n`);
};
