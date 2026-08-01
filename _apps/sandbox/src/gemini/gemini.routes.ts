import { geminiContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type GeminiRoutesDeps = Pick<Services, "geminiModels">;

// Gemini (Google) — the translator owns the credential (a Google account, connected through /translator/*), so
// the live model catalog for the picker is the only Gemini-specific route, exactly as for Codex.
export const createGeminiRoutes = (services: GeminiRoutesDeps) => {
    const i = implement(geminiContract).$context<OrpcContext>();
    return {
        models: i.models.handler(() => services.geminiModels.models()),
    };
};
