import type { AccountUsage, UsageWindow, WindowGates } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { namedPeriod, wordsOf } from "@intentic/sandbox-contract/models/plan-pools";
import { z } from "zod";
import { clampPercent, resetFromIso, statedPeriod } from "../payload.js";

// Which models a Google pool gates, and the pools Google's per-model view (`fetchAvailableModels`) reads as. The quota
// summary itself is parsed in translator-usage.ts.

// Gates come from words in the group/bucket names: `gemini` gates gemini only, `claude`/`gpt`/`3p`/etc gate the other
// family, and an unrecognized name gates everything rather than being ignored.
const GEMINI_WORDS = new Set(["gemini"]);
const THIRD_PARTY_WORDS = new Set(["claude", "gpt", "3p", "third", "party", "anthropic", "openai"]);
export const googleGates = (...names: (string | undefined)[]): WindowGates => {
    const words = new Set(names.flatMap((name) => (name === undefined ? [] : wordsOf(name))));
    if ([...GEMINI_WORDS].some((word) => words.has(word))) {
        return { models: ["gemini"] };
    }
    if ([...THIRD_PARTY_WORDS].some((word) => words.has(word))) {
        return { models: ["claude", "gpt"] };
    }
    return "all";
};

export const sameGates = (left: WindowGates, right: WindowGates): boolean => JSON.stringify(left) === JSON.stringify(right);

// How long a quota-summary bucket's window runs: its own `window` field where it sends one (`"weekly"`, 2026-10-19),
// else the period its id and name spell (`pro-five-hour`, "Weekly Limit"). Words either way, since Google states no
// figure: read here once, as the bucket is filed, rather than on every judgement (UsageWindow.periodSeconds).
export const googleBucketPeriod = (stated: string | undefined, bucketId: string, bucketName: string | undefined): { readonly periodSeconds?: number } =>
    statedPeriod((stated === undefined ? undefined : namedPeriod({ kind: stated }))?.seconds ?? namedPeriod({ kind: bucketId, label: bucketName })?.seconds);

// The model families Google meters apart, as googleGates names them. A model naming neither (the editor's tab
// completion, an internal chat model) is no pool a turn here spends.
export const GOOGLE_FAMILIES = [
    { key: "gemini", label: "Gemini models", gates: googleGates("gemini") },
    { key: "3p", label: "Claude and GPT models", gates: googleGates("claude") },
] as const;

type GoogleFamily = (typeof GOOGLE_FAMILIES)[number];

// As much of the per-model view as a pool needs. A model whose quota is malformed is skipped, never read as spent: a
// missing fraction means zero left (below), so a fraction that failed to parse must not fall through to that.
export const GoogleModelsSchema = z.object({
    models: z.record(
        z.string(),
        z
            .object({
                quotaInfo: z.object({ remainingFraction: z.number().optional(), resetTime: z.string().optional() }).optional().catch(undefined),
            })
            .catch({}),
    ),
});
export type GoogleModels = z.infer<typeof GoogleModelsSchema>;

// How long a per-model reading's window runs. The view states no length, but it reads the weekly allowance: Claude's
// `resetTime` there is the instant the summary's `3p-weekly` bucket resets (drift/answers, 2026-10-19), and an untouched
// family resets exactly seven days after it is read (32 accounts, 2026-11-22). Stated so a family read here and the same
// family read off the summary on another account are one allowance to whatever sums them (chatCapacity.ts pooledPools):
// unstated, four fresh accounts read this way drew a second "Claude and GPT models" lane at 100% left beside the
// summary's weekly one at 0% for the other 28.
const MODEL_VIEW_PERIOD_S = 7 * 86_400;

// The family's pool, read off its fullest model: every pool of a family gates the whole family (googleGates), so only
// the fullest could ever bind.
const familyPool = (models: GoogleModels["models"], family: GoogleFamily): UsageWindow | undefined => {
    let fullest: { remaining: number; resetsAt: number | undefined } | undefined;
    for (const [id, { quotaInfo }] of Object.entries(models)) {
        if (quotaInfo === undefined || !sameGates(googleGates(id), family.gates)) {
            continue;
        }
        const resetsAt = resetFromIso(quotaInfo.resetTime);
        // Proto3 JSON drops a zero, so a metered model (one with a reset) naming no fraction has none left: Claude reads
        // `{ resetTime }` alone exactly while the summary's own bucket for it says `remainingFraction: 0`.
        const remaining = quotaInfo.remainingFraction ?? (resetsAt === undefined ? undefined : 0);
        if (remaining !== undefined && (fullest === undefined || remaining < fullest.remaining)) {
            fullest = { remaining, resetsAt };
        }
    }
    if (fullest === undefined) {
        return undefined;
    }
    const pool: UsageWindow = {
        kind: `google:models:${family.key}`,
        label: family.label,
        utilization: clampPercent((1 - fullest.remaining) * 100),
        ...statedPeriod(MODEL_VIEW_PERIOD_S),
        gates: family.gates,
    };
    return fullest.resetsAt === undefined ? pool : { ...pool, resetsAt: fullest.resetsAt };
};

// Each model's own `quotaInfo`, the reading the Antigravity app draws its meters from, one pool per family. The quota
// summary names pools and is read first; this stands in for a family it leaves out, which since October 2026 is Gemini
// on every account.
export const googleModelsUsage = (models: GoogleModels, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const windows = GOOGLE_FAMILIES.flatMap((family) => familyPool(models.models, family) ?? []);
    return windows.length === 0 ? undefined : { windows, measuredAt };
};
