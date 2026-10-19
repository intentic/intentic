import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { answerPaths, fileAnswerWatch, sampleOf } from "./answer-vocabulary.js";

// Google's quota summary before and after 2026-10-19, trimmed: same field names, one group fewer.
const SUMMARY_BEFORE = {
    groups: [
        { displayName: "Gemini models", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.5, resetTime: "2026-10-24T19:26:36Z" }] },
        { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", remainingFraction: 0, resetTime: "2026-10-24T12:03:10Z" }] },
    ],
};
const SUMMARY_AFTER = { groups: [SUMMARY_BEFORE.groups[1] ?? {}] };

test("an answer's paths name each pool by its identity, so a pool that goes changes them though no field name does", () => {
    expect(answerPaths(SUMMARY_AFTER)).toEqual([
        "groups[displayName=Claude and GPT models].buckets[bucketId=3p-weekly].bucketId",
        "groups[displayName=Claude and GPT models].buckets[bucketId=3p-weekly].remainingFraction",
        "groups[displayName=Claude and GPT models].buckets[bucketId=3p-weekly].resetTime",
        "groups[displayName=Claude and GPT models].displayName",
    ]);
    expect(answerPaths(SUMMARY_BEFORE).filter((path) => !answerPaths(SUMMARY_AFTER).includes(path))).toHaveLength(4);
    // A null adds nothing: one plan's absent pool is no new field beside another plan's present one.
    expect(answerPaths({ rate_limit: { secondary_window: null } })).toEqual([]);
    expect(answerPaths({ seven_day_opus: 4 })).toEqual(["seven_day_opus"]);
});

test("nothing that could be the account's own reaches a path or a sample", () => {
    const answer = {
        "radarsu@example.com": { id: "0dd22358-eaec-45f2-83d9-4b9943bb9ca1", prompt: "x".repeat(400), used: 12 },
        limits: [{ name: "a-token-that-is-long-enough-to-be-one-0123456789" }],
        // Codex's own, 2026-10-19: short enough to pass for a name, and still an account's.
        user_id: "user-fzKHgAEGwonHdpL1uIZhEprH",
        project: "short-1",
        plan: "gpt-oss-120b-medium",
    };
    expect(answerPaths(answer)).toEqual(["*.id", "*.prompt", "*.used", "limits[name=*].name", "plan", "project", "user_id"]);
    expect(sampleOf(answer)).toEqual({ "*": { id: "*", prompt: "*", used: 12 }, limits: [{ name: "*" }], user_id: "*", project: "*", plan: "gpt-oss-120b-medium" });
});

// Nested configuration (prompt experiments, MIME lists) is one leaf: its churn changes nothing a reader parses.
test("objects past the depth a reader parses are one path", () => {
    const models = { models: { "gemini-3-flash": { quotaInfo: { remainingFraction: 0.4 }, modelExperiments: { experiments: { A: { stringValue: "{}" } } } } } };
    expect(answerPaths(models)).toEqual(["models.gemini-3-flash.modelExperiments.experiments", "models.gemini-3-flash.quotaInfo.remainingFraction"]);
});

const watching = () => {
    const written: string[] = [];
    const path = join(mkdtempSync(join(tmpdir(), "provider-answers-")), "provider-answers.json");
    return { watch: fileAnswerWatch(path, pino({ level: "info" }, { write: (line: string) => written.push(line) })), written, path };
};

const settled = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

test("the first answer is the baseline, a pool never seen before is said once, and the answer that brought it is kept", async () => {
    const { watch, written, path } = watching();
    watch.observe("gemini:retrieveUserQuotaSummary", SUMMARY_AFTER);
    await settled();
    expect(written).toEqual([]);

    watch.observe("gemini:retrieveUserQuotaSummary", SUMMARY_BEFORE);
    await settled();
    expect(written).toEqual([expect.stringContaining("never seen from this endpoint before")]);
    expect(written[0]).toContain("gemini-weekly");

    watch.observe("gemini:retrieveUserQuotaSummary", SUMMARY_BEFORE);
    await settled();
    expect(written).toHaveLength(1);

    const stored = z.record(z.string(), z.object({ sample: z.string() })).parse(JSON.parse(await readFile(path, "utf8")));
    expect(JSON.parse(stored["gemini:retrieveUserQuotaSummary"]?.sample ?? "null")).toEqual(SUMMARY_BEFORE);
});

test("two sources disagreeing about one pool is said, once an hour", () => {
    const { watch, written } = watching();
    watch.disagree("gemini:quota-sources", "Claude and GPT models", [100, 40]);
    watch.disagree("gemini:quota-sources", "Claude and GPT models", [100, 41]);
    expect(written).toEqual([expect.stringContaining("disagree about one pool")]);
});
