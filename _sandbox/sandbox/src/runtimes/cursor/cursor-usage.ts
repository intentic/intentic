import type { AgentProvider, ModelRef } from "@intentic/sandbox-contract";
import type { HeadroomService, HeadroomSource } from "../../usage/headroom.js";
import {
    type ModelLabels,
    type ObservedLimitStore,
    type ObservedReading,
    observedWindows,
    observedTurnLimit,
    pickObservedAccount,
} from "../../usage/observed-limits.js";
import type { TurnLimit } from "../../usage/fleet-limit.js";
import type { CursorCatalog } from "./cursor-catalog.js";
import { type CursorStore, liveCursorAccounts, type StoredCursorAccount } from "./cursor-credentials.js";

// Cursor's half of headroom, the counterpart to claude-usage.ts — except that nothing is fetched. Cursor's API answers
// /me, /models, /agents and /repositories and has no allowance surface at all, so the reading is the ledger of what it
// has already refused (usage/observed-limits.ts), projected into the same windows every other provider fills.

export const CURSOR: AgentProvider = "cursor";

export interface CursorUsageDeps {
    readonly cursorStore: CursorStore;
    readonly cursorModels: CursorCatalog;
    readonly observedLimits: ObservedLimitStore;
}

// Display names for the ids the ledger files, so a pool reads as "Composer 2.5" and not "composer-2.5". A catalog that
// cannot be read costs the pool its name, never the reading.
export const cursorModelLabels = async (catalog: CursorCatalog): Promise<ModelLabels> => {
    const catalogued = await catalog.models().catch(() => undefined);
    const byId = new Map((catalogued?.models ?? []).map((model) => [model.id, model.label] as const));
    return (model) => byId.get(model);
};

// Every live account's ledger, the basis of both readers below.
const cursorReadings = async (deps: CursorUsageDeps): Promise<readonly (ObservedReading & { stored: StoredCursorAccount })[]> => {
    const accounts = await liveCursorAccounts(deps.cursorStore);
    return Promise.all(accounts.map(async (stored) => ({ account: stored.id, stored, spent: await deps.observedLimits.spent(CURSOR, stored.id) })));
};

// A local projection, not a fetch: it reports `empty` so a ledger whose last entry has aged out takes its own reading
// back, which a source that can only ever add would leave standing for good.
export const cursorHeadroomSource = (deps: CursorUsageDeps): HeadroomSource => ({
    targets: async () =>
        (await liveCursorAccounts(deps.cursorStore)).map((account) => ({
            key: account.id,
            provider: CURSOR,
            read: async () => {
                const spent = await deps.observedLimits.spent(CURSOR, account.id);
                // Catalog read only once something needs naming: every sweep of every provider reaches this, and
                // almost every one of them finds an account with nothing on file.
                if (Object.keys(spent).length === 0) {
                    return { windows: [], empty: true };
                }
                return { windows: observedWindows(spent, await cursorModelLabels(deps.cursorModels)) };
            },
        })),
});

/** Everything filing a refusal needs: the ledger it lands in, and the re-read that puts it on screen. */
export type CursorLimitDeps = CursorUsageDeps & { readonly headroom: Pick<HeadroomService, "refresh"> };

// Files what Cursor just refused against the account that was serving, then re-reads that account so an open picker
// moves within the same beat rather than at the next sweep. The only way a Cursor ring ever gets a number.
export const fileCursorLimit = async (deps: CursorLimitDeps, account: string, model: string, message: string): Promise<void> => {
    await deps.observedLimits.record(CURSOR, account, model, { at: Date.now(), message });
    await deps.headroom.refresh({ scope: { providers: [CURSOR], account }, maxAgeMs: 0 });
};

// What the ladder reads instead of asking and being refused (agent/models/role-model-quota.ts).
export const cursorTurnLimit = async (deps: CursorUsageDeps, model: string): Promise<TurnLimit | undefined> => {
    const readings = await cursorReadings(deps);
    if (readings.length === 0) {
        return undefined;
    }
    // Names are wanted only for the pool a spent rung is reported by; an untouched fleet costs no catalog read.
    const spent = readings.some((reading) => Object.keys(reading.spent).length > 0);
    return observedTurnLimit(readings, { id: model }, spent ? await cursorModelLabels(deps.cursorModels) : undefined);
};

// Which connection a turn runs on. A named account is honoured as asked — the picker's whole point is that the choice
// is the user's — and only an unnamed one is placed, on the account that still has the model the turn names.
export const cursorAccountForTurn = async (
    deps: CursorUsageDeps,
    requested: string | undefined,
    model: string | undefined,
): Promise<StoredCursorAccount | undefined> => {
    const live = await liveCursorAccounts(deps.cursorStore);
    if (requested !== undefined && requested !== "") {
        return live.find((account) => account.id === requested);
    }
    // One account is not a choice, and an unnamed model has no pool to weigh; both keep first-connected-is-default.
    if (live.length < 2 || model === undefined || model === "") {
        return live[0];
    }
    // Unnamed: the ledger files ids, and a pool matches against the id being asked for, so no catalog is read here.
    const ref: ModelRef = { id: model };
    return pickObservedAccount(await cursorReadings(deps), ref)?.stored;
};
