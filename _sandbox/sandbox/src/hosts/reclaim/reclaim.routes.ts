import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";

// POST /system/memory/reclaim: the composer's "Free memory" while the computer under this sandbox is what is short of
// memory (runners/fleet-advice.ts `reclaim`). The press itself is the background reclaim's own (host-reclaim.ts), so the
// two never run at once; the contract keeps it to the owner.
export const createReclaimRoutes = (services: Pick<Services, "hostReclaim">) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        reclaimMemory: i.reclaimMemory.handler(async () => await services.hostReclaim.press()),
    };
};
