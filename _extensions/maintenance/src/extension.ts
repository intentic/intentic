import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { maintenanceBadge, startMaintenanceAttention } from "./attention.js";
import { choresReportQuery, choresRunsQuery } from "./choresQuery.js";
import { bindHost } from "./host.js";

// Binds the host, starts the badge poll, then registers two views: one rail tile, workspace-wide, and one per-repo
// surface. The tile activates on any repository, not on evidence of a problem, so the empty state stays reachable; seat
// placement (column vs More) is decided elsewhere (core-views/registry.ts).
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Started before registration, so the tile can badge on its first render.
    context.subscriptions.push(startMaintenanceAttention());
    context.subscriptions.push(
        api.views.register({
            id: `maintenance`,
            label: `Maintenance`,
            surface: `rail`,
            // `wrench`: kept running. Not `list-check` (Acceptance's), a warning triangle, or `cog` (means Settings).
            detect: (repos) => (repos.length === 0 ? [] : [{ key: `maintenance`, title: `Maintenance`, icon: `wrench` }]),
            badge: maintenanceBadge,
            // Warms both reads ahead of the click: arrival here is the whole interaction (the tile just lit up).
            warm: () => [choresReportQuery(), choresRunsQuery()],
            view: async () => (await import(`./MaintenanceView.vue`)).default,
        }),
    );

    // Per-repo view of the same list, opened from the Workspace tree; `repo` is bound by the host. Auxiliary (adds a
    // surface, doesn't claim the repo) and unbadged: the rail's badge already covers the whole workspace.
    context.subscriptions.push(
        api.views.register({
            id: `maintenance-repo`,
            label: `Maintenance`,
            surface: `directory`,
            auxiliary: true,
            detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: `Maintenance`, icon: `wrench`, repo: repo.repo })),
            view: async () => (await import(`./MaintenanceView.vue`)).default,
        }),
    );
};
