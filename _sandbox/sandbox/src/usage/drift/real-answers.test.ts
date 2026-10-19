import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonOr } from "@intentic/base/json";
import { GoogleModelsSchema, googleModelsUsage } from "../google/model-pools.js";
import { codexUsageFromPayload, geminiUsageFromPayload, kimiUsageFromPayload } from "../translator-usage.js";
import { answerPaths } from "./answer-vocabulary.js";

// Each reader against what its endpoint actually answered, redacted, on the date in the file's name (answers/). These
// are the contract the hand-written payloads in each reader's own tests stand in for: when a provider changes its answer,
// the answer watch (answer-vocabulary.ts) says so and keeps a redacted sample, and
// `node scripts/provider-answer-fixtures.mjs` files it here under that day's date, beside the old one, so both shapes
// stay read. Assertions name what each answer meant on its day.

const ANSWERS = join(import.meta.dirname, "answers");
const answer = (name: string) => parseJsonOr(readFileSync(join(ANSWERS, name), "utf8"), null);

test("Google's quota summary on 2026-10-19 names the Claude and GPT pool alone, spent", () => {
    expect(geminiUsageFromPayload(answer("gemini.retrieveUserQuotaSummary.2026-10-19.json"))?.windows).toEqual([
        expect.objectContaining({ kind: "google:3p-weekly", utilization: 100, gates: { models: ["claude", "gpt"] } }),
    ]);
});

test("Google's per-model view on 2026-10-19 reads a Gemini pool with room left and a spent Claude and GPT one", () => {
    const parsed = GoogleModelsSchema.safeParse(answer("gemini.fetchAvailableModels.2026-10-19.json"));
    const windows = parsed.success ? googleModelsUsage(parsed.data)?.windows : undefined;
    expect(windows?.map((window) => [window.kind, Math.round(window.utilization)])).toEqual([
        ["google:models:gemini", 78],
        ["google:models:3p", 100],
    ]);
});

test("a ChatGPT team plan on 2026-10-19 reads its spent session, its week, and a model it has no credits for", () => {
    expect(codexUsageFromPayload(answer("codex.wham.usage.2026-10-19.json"))?.windows.map((window) => [window.kind, window.utilization])).toEqual([
        ["five_hour", 100],
        ["seven_day", 73],
        ["entitlement:gpt-6-astra", 100],
    ]);
});

test("Kimi Code on 2026-10-19 reads its spent week and the 5-hour throttle inside it", () => {
    expect(kimiUsageFromPayload(answer("kimi.usages.2026-10-19.json"))?.windows.map((window) => [window.kind, window.utilization])).toEqual([
        ["seven_day", 100],
        ["five_hour", 34],
    ]);
});

// A file that is not an endpoint's answer, or that holds something an account could be identified by, never lands here.
test("every filed answer is named endpoint.date and carries nothing of the account's own", () => {
    for (const name of readdirSync(ANSWERS)) {
        expect(name).toMatch(/^[a-z]+\.[\w.]+\.\d{4}-\d{2}-\d{2}\.json$/);
        const text = readFileSync(join(ANSWERS, name), "utf8");
        expect(text).not.toMatch(/@|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}/i);
        expect(answerPaths(parseJsonOr(text, null)).length).toBeGreaterThan(0);
    }
});
