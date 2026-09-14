import type { Deployment, InventoryEntry, ResourceView } from "@intentic/api-contract";

/* The apps the user wants, for the Infra "What you want" list, the union of three sources, keyed by app name. */

export type WantedAppStatus = `declared` | `planned` | `live`;

export interface WantedApp {
    readonly name: string;
    readonly status: WantedAppStatus;
    readonly domain?: string;
}

// "shop.production" → "shop"; a bare name stays itself.
const appName = (nodeId: string): string => nodeId.split(`.`)[0] ?? nodeId;

const RANK: Record<WantedAppStatus, number> = { declared: 0, planned: 1, live: 2 };

export const wantedApps = (
    inventory: readonly InventoryEntry[],
    resources: readonly ResourceView[],
    deployments: readonly Deployment[],
): WantedApp[] => {
    const status = new Map<string, WantedAppStatus>();
    const domains = new Map<string, string>();
    const upgrade = (name: string, next: WantedAppStatus): void => {
        const current = status.get(name);
        if (current === undefined || RANK[current] < RANK[next]) {
            status.set(name, next);
        }
    };

    for (const entry of inventory) {
        if (entry.kind === `app`) {
            upgrade(entry.name, `declared`);
            const domain = entry.values[`domain`];
            if (typeof domain === `string`) {
                domains.set(entry.name, domain);
            }
        }
    }
    for (const resource of resources) {
        if (resource.type === `deployment`) {
            upgrade(appName(resource.id), `planned`);
        }
    }
    for (const deployment of deployments) {
        const name = appName(deployment.name);
        upgrade(name, deployment.live ? `live` : `planned`);
        if (deployment.domain !== undefined && !domains.has(name)) {
            domains.set(name, deployment.domain);
        }
    }

    return [...status].map(([name, stage]) => ({ name, status: stage, domain: domains.get(name) }));
};
