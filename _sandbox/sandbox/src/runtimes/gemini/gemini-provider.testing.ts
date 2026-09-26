import type { GeminiSlice } from "./gemini-provider.js";

// Gemini's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const geminiSliceFake = () =>
    ({
        // Per-provider catalog the provider module reads directly; mirrors testProviderCatalogs row for row.
        geminiModels: {
            models: async () => ({
                models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text"] }],
                default: "gemini-pro-agent",
            }),
            live: async () => [{ id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text"] }],
        },
    }) satisfies Partial<GeminiSlice>;
