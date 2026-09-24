import { type InventoryEntry, inventoryContract } from "@intentic/sandbox-contract";
import { ManagedRegionError, readManagedRegion, writeManagedRegion } from "@intentic/scaffold";
import { implement, ORPCError } from "@orpc/server";

import type { OrpcContext } from "../app-env.js";
import { type ConfigStoreDeps, createConfigStore } from "./config-store.js";

export type InventoryRoutesDeps = ConfigStoreDeps;

// A region that cannot be written as asked is the owner's to fix: a CONFLICT that says why.
const rewritten = (content: string, entries: readonly InventoryEntry[]): string => {
    try {
        return writeManagedRegion(content, entries);
    } catch (error) {
        if (error instanceof ManagedRegionError) {
            throw new ORPCError("CONFLICT", { message: error.message });
        }
        throw error;
    }
};

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region and
// commit it (mirroring an agent edit) and return the full list. Deploy-target hosts self-register out-of-band via
// the daemon's plain /enroll route (the connect-host script), not through these routes.
export const createInventoryRoutes = (services: InventoryRoutesDeps) => {
    const i = implement(inventoryContract).$context<OrpcContext>();
    const config = createConfigStore(services);

    return {
        list: i.list.handler(async () => ({ entries: readManagedRegion(await config.read()) })),
        add: i.add.handler(async ({ input }) => {
            const content = await config.read();
            // Upsert by name: a re-added capability replaces the old declaration.
            const next: InventoryEntry[] = [...readManagedRegion(content).filter((entry) => entry.name !== input.name), input];
            const label = input.kind === "backend" ? input.provider : input.kind === "service" ? input.service : "app";
            await config.write(rewritten(content, next), `chore(intentic): add ${label} "${input.name}"`);
            return { entries: next };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const content = await config.read();
            const entries = readManagedRegion(content);
            const next = entries.filter((entry) => entry.name !== input.name);
            if (next.length !== entries.length) {
                await config.write(rewritten(content, next), `chore(intentic): remove "${input.name}"`);
            }
            return { entries: next };
        }),
    };
};
