import type { HostQuery } from "@intentic/extension-api";
import { registeredViews } from "../../../core-views/registry";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

/* WHAT THE EXTENSIONS WANT IN HAND, every registered view's own wish list, collected into the plan.
 *
 * MOST OF THE RAIL IS EXTENSIONS. Maintenance, Acceptance, Pipelines, Deployments, Workflows, Automations,
 * Documentation, Infrastructure, eight of the rail's fourteen tiles are contributions, and until this source
 * existed not one of them was warmed. The core's own list next door (railWarm) covers the shell's furniture and
 * says, correctly, that a table of other people's queries kept in the core is the list nobody remembers to
 * extend, so it pointed at a registry for extensions to declare into. That registry was never reachable from
 * the extension API, which made the note advice nobody could take: every rail tile the product ships as an
 * extension opened on a skeleton, by construction, and the tiles most likely to be clicked BECAUSE they lit up
 * were exactly the cold ones.
 *
 * A view declares queries, not fetches (ViewRegistration.warm → HostQuery), so the entry warmed here is the
 * entry the view's own `useQuery` observes. There is no second way for the two to disagree.
 *
 * THE `rail` BAND, always, and not negotiable per view. This is the one place in the plan where the wish is
 * written by somebody other than the app, and a band is a claim about how close the USER is, which is not a
 * claim a contribution is in any position to make about itself. Every one of these is "somewhere they might
 * go", so they queue behind the board's cards and the review's diffs, and on a workspace with no room to spare
 * they are simply not read. */

export const extensionsWarmSource = (): readonly WarmTask[] =>
    registeredViews().flatMap((entry) => {
        const { warm } = entry.registration;
        if (warm === undefined) {
            return [];
        }
        /* Contained per VIEW, not per source: warmPlan already drops a source that throws, but that source is
         * this one, a single extension with a bad `warm` would take every other extension's list down with it
         * for that beat. Same reasoning as the registry's safeDetect. */
        let wishes: readonly HostQuery[] = [];
        try {
            wishes = warm();
        } catch (error) {
            console.error(`extension ${entry.owner}/${entry.registration.id}: warm() failed`, error);
            return [];
        }
        // Keyed by the query alone, so two views wanting the same read are one wish rather than two, the query
        // key is already the app's identity for a cached read, and it carries the sandbox id with it.
        return wishes.map((query) => warmQuery(`ext:${JSON.stringify(query.queryKey)}`, `rail`, query));
    });
