import { kimiContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type KimiRoutesDeps = Pick<Services, "kimiModels">;

// Kimi Code authentication is translator-owned; this provider route only serves the proxy's model definitions
// in the same catalog shape as the other provider pickers.
export const createKimiRoutes = (services: KimiRoutesDeps) => {
    const i = implement(kimiContract).$context<OrpcContext>();
    return {
        models: i.models.handler(() => services.kimiModels.models()),
    };
};
