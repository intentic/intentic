import { type InventoryEntry, inventoryContract } from "@intentic/sandbox-contract";
import { readManagedRegion, writeManagedRegion } from "@intentic/scaffold";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createConfigStore } from "./config-store.js";

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region and
// commit it (mirroring an agent edit) and return the full list. Deploy-target hosts self-register out-of-band via
// the daemon's plain /enroll route (the connect-host script), not through these routes.
export const createInventoryRoutes = (services: Services) => {
    const i = implement(inventoryContract).$context<OrpcContext>();
    const config = createConfigStore(services);

    return {
        list: i.list.handler(async () => ({ entries: readManagedRegion(await config.read()) })),
        add: i.add.handler(async ({ input }) => {
            const content = await config.read();
            // Upsert by name: a re-added capability replaces the old declaration.
            const next: InventoryEntry[] = [...readManagedRegion(content).filter((entry) => entry.name !== input.name), input];
            const label = input.kind === "backend" ? input.provider : input.kind === "service" ? input.service : "app";
            await config.write(writeManagedRegion(content, next), `chore(intentic): add ${label} "${input.name}"`);
            return { entries: next };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const content = await config.read();
            const entries = readManagedRegion(content);
            const next = entries.filter((entry) => entry.name !== input.name);
            if (next.length !== entries.length) {
                await config.write(writeManagedRegion(content, next), `chore(intentic): remove "${input.name}"`);
            }
            return { entries: next };
        }),
    };
};
