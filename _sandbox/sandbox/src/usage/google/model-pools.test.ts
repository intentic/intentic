import { GoogleModelsSchema, googleModelsUsage } from "./model-pools.js";

// Google's per-model view as `fetchAvailableModels` answered it on 2026-10-19, trimmed to the fields a pool reads: every
// Gemini model shares one fraction, Claude and GPT-OSS carry a reset and no fraction (proto3 drops the zero), and the
// editor's own completion models are unmetered.
const PER_MODEL = {
    models: {
        "gemini-3.8-flash-tiered": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", quotaInfo: { remainingFraction: 0.4699792, resetTime: "2026-10-24T19:26:36Z" } },
        "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.4699792, resetTime: "2026-10-24T19:26:36Z" } },
        "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)", quotaInfo: { resetTime: "2026-10-24T12:03:10Z" } },
        "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", quotaInfo: { resetTime: "2026-10-24T12:03:10Z" } },
        tab_flash_lite_preview: { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", quotaInfo: { remainingFraction: 1 } },
        chat_20706: { apiProvider: "API_PROVIDER_INTERNAL", quotaInfo: { remainingFraction: 1 } },
    },
    defaultAgentModelId: "claude-sonnet-4-6",
};

const read = (payload: unknown) => {
    const parsed = GoogleModelsSchema.safeParse(payload);
    return parsed.success ? googleModelsUsage(parsed.data, 1_000) : undefined;
};

test("reads one pool per model family off Google's per-model view, a missing fraction on a metered model as none left", () => {
    expect(read(PER_MODEL)).toEqual({
        measuredAt: 1_000,
        windows: [
            {
                kind: "google:models:gemini",
                label: "Gemini models",
                utilization: (1 - 0.4699792) * 100,
                resetsAt: Date.parse("2026-10-24T19:26:36Z") / 1000,
                gates: { models: ["gemini"] },
            },
            {
                kind: "google:models:3p",
                label: "Claude and GPT models",
                utilization: 100,
                resetsAt: Date.parse("2026-10-24T12:03:10Z") / 1000,
                gates: { models: ["claude", "gpt"] },
            },
        ],
    });
});

// Every pool of a family gates the whole family, so the fullest is the only one that can bind a turn.
test("a family split across pools reads as its fullest", () => {
    const usage = read({
        models: {
            "gemini-pro": { quotaInfo: { remainingFraction: 0.2, resetTime: "2026-10-20T00:00:00Z" } },
            "gemini-flash": { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-21T00:00:00Z" } },
        },
    });
    expect(usage?.windows).toEqual([
        expect.objectContaining({ kind: "google:models:gemini", utilization: 80, resetsAt: Date.parse("2026-10-20T00:00:00Z") / 1000 }),
    ]);
});

// A malformed quota costs that model, never reads as spent; a missing fraction with no reset says nothing either.
test("skips a model whose quota is malformed or unmetered, and answers nothing for a shape it cannot read", () => {
    expect(
        read({
            models: {
                "gemini-a": { quotaInfo: { remainingFraction: "lots", resetTime: "2026-10-20T00:00:00Z" } },
                "gemini-b": { quotaInfo: {} },
                "gemini-c": "not a model",
                "claude-x": {},
            },
        }),
    ).toBeUndefined();
    expect(read({ groups: [] })).toBeUndefined();
    expect(read("not a payload")).toBeUndefined();
});
