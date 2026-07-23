import { codexContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// ChatGPT (Codex) has no sandbox-owned OAuth: it authenticates through the translator on the user's ChatGPT
// subscription (translator.routes.ts). The only Codex-specific route is the model catalog for the picker.
export const createCodexRoutes = (services: Services) => {
    const i = implement(codexContract).$context<OrpcContext>();
    return {
        models: i.models.handler(() => services.codexModels.models()),
    };
};
