import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { gatesModel, uncoveredModels, windowLive } from "@intentic/sandbox-contract/models/plan-pools";
import type { Logger } from "pino";
import type { AccountUsageStore } from "../account-usage.js";
import type { HeadroomTarget } from "../headroom.js";

// What a new reading of an account makes of the one it replaces. Upstream answers change shape without notice, and a
// reading that silently loses a pool reads exactly like one whose pool was never there: this is where such a loss stays
// visible instead.

// Pools the previous reading named that this one does not, still inside their window: what a provider stopped reporting.
export const missingPools = (previous: AccountUsage | undefined, next: AccountUsage, now: number = Date.now()): UsageWindow[] => {
    const named = new Set(next.windows.map((window) => window.kind));
    return (previous?.windows ?? []).filter(
        (window) => !named.has(window.kind) && window.lapsedAt === undefined && windowLive(window, previous?.measuredAt ?? 0, now),
    );
};

// A reading whose source vouches that it names every pool (`whole`) carries forward each pool the previous one named and
// it does not, stamped with when it went missing: its last figure stays a valid floor until its window closes, and
// currentWindows drops it then. A partial reading (a turn's stream, a pushed snapshot) replaces as it always did, and
// only keeps the models the last whole reading found no pool for, less any its own pools now cover.
export const continueReading = (previous: AccountUsage | undefined, next: AccountUsage, whole: boolean, now: number = Date.now()): AccountUsage => {
    const carried = whole
        ? missingPools(previous, next, now).map((window): UsageWindow => ({ ...window, missingSince: window.missingSince ?? Math.floor(next.measuredAt / 1000) }))
        : [];
    const windows = [...next.windows, ...carried];
    const uncovered = (whole ? next.uncovered : (next.uncovered ?? previous?.uncovered))?.filter(
        (id) => !windows.some((window) => gatesModel(window.gates, { id })),
    );
    const { uncovered: _stated, ...rest } = next;
    return uncovered === undefined || uncovered.length === 0 ? { ...rest, windows } : { ...rest, windows, uncovered };
};

// A swept reading, checked against the models its account serves and against the reading it replaces. A model no pool
// gates is said (`uncovered`) rather than read as covered by whatever pools there are, and both gaps are logged once
// when they change rather than on every sweep: either is how an upstream answer that changed shape looks from here.
export const sweptReadings = (deps: {
    readonly store: Pick<AccountUsageStore, "read">;
    readonly logger: Logger;
}): ((target: HeadroomTarget, windows: readonly UsageWindow[]) => Promise<AccountUsage>) => {
    const said = new Map<string, string>();
    const sayUncovered = (target: HeadroomTarget, uncovered: readonly string[]): void => {
        if ((said.get(target.key) ?? "") === uncovered.join(", ")) {
            return;
        }
        said.set(target.key, uncovered.join(", "));
        if (uncovered.length > 0) {
            deps.logger.warn(
                { account: target.key, provider: target.provider, uncovered },
                "headroom: this account serves models no pool in its reading covers, so their allowance is unknown; the provider may have stopped reporting it",
            );
        }
    };
    return async (target, windows) => {
        const usage: AccountUsage = { windows: [...windows], measuredAt: Date.now() };
        const uncovered = uncoveredModels(windows, await servedModels(target, deps.logger));
        sayUncovered(target, uncovered);
        // Only a pool newly gone: one already marked missing was said when it went.
        const gone = target.whole === true ? missingPools((await deps.store.read())[target.key], usage) : [];
        for (const pool of gone.filter((window) => window.missingSince === undefined)) {
            deps.logger.warn(
                { account: target.key, provider: target.provider, pool: pool.kind, label: pool.label, lastUtilization: pool.utilization },
                "headroom: the provider stopped reporting a pool it reported before; its last reading stands until its window closes",
            );
        }
        return uncovered.length === 0 ? usage : { ...usage, uncovered };
    };
};

// A model list that cannot be read costs the check, never the reading.
const servedModels = async (target: HeadroomTarget, logger: Logger): Promise<readonly { readonly id: string }[]> => {
    try {
        return (await target.served?.()) ?? [];
    } catch (error) {
        logger.warn({ err: error, account: target.key }, "headroom: this account's models could not be listed, its reading is not checked for coverage");
        return [];
    }
};
