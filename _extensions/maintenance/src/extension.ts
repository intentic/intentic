import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { maintenanceBadge, startMaintenanceAttention } from "./attention.js";
import { bindHost } from "./host.js";

/* ext-maintenance activation: bind the host handle, start the badge's background poll, then register the one
 * surface maintenance legitimately has.
 *
 * ONE RAIL TILE, WORKSPACE-WIDE, ALWAYS PRESENT. Three decisions, each of which could have gone the other way:
 *
 * Workspace-wide rather than per repo, because the question this surface answers is "what is this workspace
 * owed", and the answer is read across repos — the same shape, and for the same reason, as Acceptance and
 * Documentation. A tile per repo would fragment one list into five that each need visiting.
 *
 * An AREA rather than an event tile. Drafts and Browsers appear when there is something in them and vanish when
 * there is not, which is right for a queue. This is not a queue: the chore book, the run history, the evidence
 * behind every clear chore and the snooze controls all exist whether or not anything is due, and a surface that
 * only exists while something is wrong cannot be visited to check that nothing is. The badge carries the signal;
 * the tile carries the place.
 *
 * It activates on ANY repository, and deliberately not on evidence of a problem. Gating it on something being due
 * would mean the first time an owner ever sees this surface is the first time it has bad news — and would make
 * the empty state, which is the state we most want to be reachable, the one state you cannot navigate to. "There
 * is code here that will need maintaining" is the honest evidence for offering the area. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so the tile can badge on its first render rather than ten minutes later.
    context.subscriptions.push(startMaintenanceAttention());
    context.subscriptions.push(
        api.views.register({
            id: `maintenance`,
            label: `Maintenance`,
            surface: `rail`,
            /* `wrench` — machinery being kept running, which is what this is. Not `list-check`: that is Acceptance's,
             * and two tiles sharing a glyph in a column read at a glance is worse than either being slightly less
             * apt. Not a warning triangle either — the two chores that are genuinely urgent say so with the
             * badge's tone, and an icon that shouts permanently says nothing. And no longer `cog`: a gear means
             * Settings everywhere else in this app (the account popover's row, the mobile menu's), so the one
             * glyph a reader already has a fixed meaning for is the one it must not borrow. */
            detect: (repos) => (repos.length === 0 ? [] : [{ key: `maintenance`, title: `Maintenance`, icon: `wrench` }]),
            badge: maintenanceBadge,
            view: async () => (await import(`./MaintenanceView.vue`)).default,
        }),
    );
};
