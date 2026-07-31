import { kimiContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Kimi Code authentication is translator-owned; this provider route only serves the proxy's model definitions
// in the same catalog shape as the other provider pickers.
export const createKimiRoutes = (services: Services) => {
    const i = implement(kimiContract).$context<OrpcContext>();
    return {
        models: i.models.handler(() => services.kimiModels.models()),
    };
};
