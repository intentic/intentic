import type { HostQuery } from "@intentic/extension-api";
import { registeredViews } from "../../../core-views/registry";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

// Collects every registered view's warm() wishes (ViewRegistration.warm to HostQuery) into the plan, so
// what's warmed is exactly what the view's own useQuery observes. Always the `rail` band: a contribution
// can't claim how close the user is, so these queue behind board cards and review diffs.

export const extensionsWarmSource = (): readonly WarmTask[] =>
    registeredViews().flatMap((entry) => {
        const { warm } = entry.registration;
        if (warm === undefined) {
            return [];
        }
        // Isolated per view: one bad warm() must not drop every other extension's wishes for the beat.
        let wishes: readonly HostQuery[] = [];
        try {
            wishes = warm();
        } catch (error) {
            console.error(`extension ${entry.owner}/${entry.registration.id}: warm() failed`, error);
            return [];
        }
        // Keyed by the query alone: two views wanting the same read become one wish, using the cache's own key.
        return wishes.map((query) => warmQuery(`ext:${JSON.stringify(query.queryKey)}`, `rail`, query));
    });
