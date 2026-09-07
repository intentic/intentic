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

/* WHAT A PARENT MAY SPEND ON A CHILD, RIGHT NOW: which providers this sandbox can actually reach, which of
 * their models still have allowance left, and how much.
 *
 * THIS EXISTS BECAUSE THE SPAWN DOOR STOPPED GUESSING. A child used to be startable with no provider and no
 * model: the daemon filled the blank from a `child-agent` model role, and behind that from a hardcoded
 * "claude". Both were the sandbox choosing whose allowance a delegated workstream spends without the delegating
 * agent ever saying so, which is the one decision a fan-out most needs to be deliberate about — one parent can
 * start twenty children, and twenty is where a wrong default stops being a rounding error. So `provider` and
 * `model` are required (children.ts), and a requirement is only fair if the answer is discoverable: this is the
 * answer, served to the `agents providers` CLI verb, to the `providers` MCP tool, and inline in the refusal a
 * spawn missing either flag comes back with.
 *
 * ONE FLEET READ PER PROVIDER, NEVER ONE PER MODEL, and that shape is the whole reason this is a module rather
 * than a loop over the existing `spentRung`. That helper answers for ONE (provider, model) pair and re-reads the
 * whole fleet to do it — `claudeStore.list()` + the usage store for Claude, `listFiles()` + the usage store
 * through the translator for a routed provider. Asked per model across six providers with a dozen models each
 * that is something like seventy round trips to render one listing. The readings are per ACCOUNT and the
 * per-model part is pure arithmetic over them (which pools gate this model, how full the fullest is), so the
 * reads happen once, up here, and every model is then judged in memory.
 *
 * IT REPORTS WHAT IS ON FILE AND NEVER GUESSES. Three states, kept distinct because they call for different
 * things next: a measured pool with room (a percentage and the pool's name), a measured pool that is FULL (the
 * model is left out of the listing entirely — the owner asked to see only what can still be spent — with the
 * provider's own renewal instant kept so the row can say when it comes back), and NOTHING MEASURED, which is
 * the honest answer for Cursor, for a user's own endpoint, and for any account that has never been polled. An
 * unmeasured model is listed and marked unmetered rather than dropped: "we have no reading" is not "it is
 * spent", and dropping it would hide a working provider behind a gap in our own bookkeeping.
 *
 * THE LISTING IS ADVICE, NOT A WHITELIST. Nothing downstream validates a spawn against it: an installed ACP
 * agent and a configured endpoint are both legitimate providers that publish no catalog here, and refusing them
 * because this file cannot enumerate them would make a discovery aid into a gate. What the door requires is
 * that the parent SAY where the work runs, not that it pick from this list. */

/** How much of the pool that gates this model is still free, where the plan publishes one. */
export interface ModelHeadroom {
    // 0–100, of the account with the most room left. Rounded: the reading is a snapshot of the provider's own
    // estimate, and a decimal would overclaim it.
    readonly percentLeft: number;
    // What the plan calls that pool ("Weekly", "Opus"), where it scopes it. Absent for an undivided allowance,
    // since "the allowance allowance" tells a reader nothing.
    readonly pool?: string;
}

export interface SpawnableModel {
    readonly id: string;
    readonly label: string;
    // Absent ⇒ nothing on file measures this model's allowance. Not the same as "no room".
    readonly headroom?: ModelHeadroom;
}

export interface SpawnableProvider {
    readonly id: AgentProvider;
    readonly label: string;
    // In the provider's own preference order, spent models removed.
    readonly models: readonly SpawnableModel[];
    // How many of its models were left out because every connected account is at the cap for them.
    readonly spent: number;
    // When the soonest of those comes back (epoch seconds), where the provider said. Only meaningful with
    // `spent > 0`.
    readonly reopensAt?: number;
}

/* Every connected account's headroom, per provider, taken in as few round trips as there are providers to ask.
 * A provider absent from the map is one nothing on file measures, which the caller reads as unmetered rather
 * than as empty. */
const fleetReadings = async (services: Services): Promise<Map<AgentProvider, readonly FleetReading[]>> => {
    const readings = new Map<AgentProvider, readonly FleetReading[]>();
    const [connected, usage, routed] = await Promise.all([
        services.claudeStore.list().catch(() => []),
        services.accountUsage.read().catch((): Record<string, AccountUsage> => ({})),
        // The translator's four providers in ONE management call: it is the read this whole module is shaped
        // around, and asking it per provider was the regression the shared-reads memo exists to prevent.
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

/* The most room any one account has left for this model, since a single account with headroom is enough to run
 * the turn. Undefined ⇒ no account publishes a pool that gates it.
 *
 * A COOLING account is skipped outright: the translator is routing around that credential right now whatever
 * its last quota reading says, so counting its headroom would advertise room on an account nothing can reach. */
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
        // Only a pool the plan SCOPES is worth naming, the same rule fleet-limit.ts applies to a refusal.
        ...(best.gates === "all" || best.label === undefined ? {} : { pool: best.label }),
    };
};

/* One provider's spendable rows. `spent` and `reopensAt` describe what was left out, so a provider whose whole
 * catalog is at the cap can still say so with a renewal instant instead of silently vanishing from the listing —
 * "codex is out until 3pm" and "codex is not connected" are opposite things for a parent to do next. */
// Every connected account is at the cap for this model. The same predicate the one-shot helper walk steps a rung
// over on (role-model-quota.ts), and the reason both counts being zero does NOT qualify: that is nothing
// measured, which is a gap in our bookkeeping rather than a fact about the allowance.
const exhausted = (limit: TurnLimit): boolean => limit.spent > 0 && limit.withHeadroom === 0;

// The earliest instant among those given, ignoring the ones that named none. Any single pool reopening is
// enough to make the provider spendable again, so the soonest is the one worth reporting.
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

/* WHAT A CHILD COULD BE STARTED ON RIGHT NOW. Connected providers only: readiness is the cheap fact that says
 * whether a credential exists at all, and a provider nobody has connected is not a choice, it is a mistake
 * waiting to be made.
 *
 * Failure is PER PROVIDER, never per listing. A model catalog is a live read of a vendor's own endpoint, so one
 * of them being slow or down must not take the whole answer away — the provider is simply reported with no
 * models, which is true and leaves the other five usable. */
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

// How long until a pool comes back, in words: the daemon cannot know the reader's timezone, and an absolute
// instant formatted in the container's would be wrong for most of them. Deliberately vague at every scale,
// because the number is a snapshot of the provider's own estimate.
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
        // Two different silences, said as two: nothing left to spend, or nothing to list in the first place.
        const reason = provider.spent > 0 ? `every model is out of allowance${renews}` : `no models published`;
        return `${provider.id}: ${reason}`;
    }
    const held = provider.spent === 0 ? `` : ` — ${provider.spent} more out of allowance`;
    return `${provider.id}: ${provider.models.map(modelText).join(`, `)}${held}`;
};

/* THE LISTING AS THE AGENT READS IT, written ONCE and used by all three doors: the `agents providers` CLI verb,
 * the `providers` MCP tool, and the refusal a spawn missing its provider or model comes back with. Three
 * renderings of one fact set is how they come to disagree, and the refusal is the one that matters most — it is
 * read at the moment the model is deciding what to type next. */
export const spawnCatalogText = (providers: readonly SpawnableProvider[], now: number = Date.now()): string => {
    if (providers.length === 0) {
        return `No AI provider is connected to this sandbox, so no child agent can be started. Connect one in Sandbox ▸ Agent ▸ Accounts.`;
    }
    return providers.map((provider) => providerText(provider, now)).join(`\n`);
};
