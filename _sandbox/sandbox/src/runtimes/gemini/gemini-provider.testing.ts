import { unrankedCatalog } from "../../agent/models/model-discovery.js";
import type { GoogleModelAvailability } from "../../agent/providers/google-model-availability.js";
import { selectGeminiModel, type GeminiCatalog } from "./gemini-catalog.js";
import type { GeminiModel } from "./gemini-models.js";
import type { GeminiSlice } from "./gemini-provider.js";

// One typed catalog double for route, turn and helper suites. Rows are the reported account models unless the test
// explicitly supplies an availability verdict; nothing here starts a translator or reads a credential.
const DEFAULT_MODELS: readonly GeminiModel[] = [{ id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text"] }];

export const geminiCatalogFake = (
    models: readonly GeminiModel[] = DEFAULT_MODELS,
    options: { readonly live?: boolean; readonly availability?: GoogleModelAvailability } = {},
): GeminiCatalog => {
    const availability: GoogleModelAvailability = options.availability ?? { state: "verified", accounts: 1, models: models.map((model) => model.id) };
    const advertised = options.live === false ? undefined : models;
    const callable =
        availability.state === "verified" && availability.accounts > 0 && advertised !== undefined
            ? models.filter((model) => availability.models.includes(model.id))
            : [];
    const snapshot = { models: callable, advertised, availability };
    return {
        models: async () => unrankedCatalog(callable),
        live: async () => (advertised === undefined || availability.state !== "verified" ? undefined : callable),
        select: async (model) => selectGeminiModel(snapshot, model),
    };
};

// Gemini's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.
export const geminiSliceFake = () => ({ geminiModels: geminiCatalogFake() }) satisfies Partial<GeminiSlice>;
