import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EARLIER_SHIPPED_RULES, matchInvocation, mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { fileHeavyCommandsStore } from "./heavy-commands.js";

// The file half: what .intentic/config/heavy-commands.json does on disk. It holds only the owner's overrides, and a file
// of the earlier shape (the whole table, seeded once and never updated) is read as the overrides it amounts to.

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), "heavy-"));

test("an absent file reads as the shipped table, and nothing is written for it", async () => {
    const path = join(await dir(), "heavy-commands.json");
    expect(await fileHeavyCommandsStore(path).read()).toEqual(mergeHeavyRules());
    await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("overrides on disk sit on top of the shipped table, so a fix to a shipped rule still reaches this sandbox", async () => {
    const path = join(await dir(), "heavy-commands.json");
    await writeFile(path, JSON.stringify({ limit: 1, ruleEdits: [{ id: "gradle", pattern: "\\bgradlew?\\b" }] }));
    const loaded = await fileHeavyCommandsStore(path).read();
    expect(matchInvocation("gradlew assembleRelease", loaded)?.id).toBe("gradle");
    expect(matchInvocation("pnpm test", loaded)).toEqual({ id: "package-script", pool: "heavy", limit: 1, maxHold: 1800, onDeadline: "run" });
});

test("a seeded file of the earlier shape reads as today's rules, keeping only what the owner added", async () => {
    const path = join(await dir(), "heavy-commands.json");
    const ownRule = { id: "bun-test", pattern: "\\bbun\\s+test\\b|(?<![-.])\\bsuites\\b(?![-.])", pool: "tests", limit: 4 };
    await writeFile(
        path,
        JSON.stringify({ limit: 2, defaultPool: "heavy", waitSeconds: 900, memoryGateSeconds: 120, maxHoldSeconds: 1800, rules: [...EARLIER_SHIPPED_RULES.slice(0, 3), ownRule] }),
    );
    expect(await fileHeavyCommandsStore(path).read()).toEqual(mergeHeavyRules({ ruleEdits: [ownRule] }));
});

test("an unreadable file reports and falls back to the shipped table rather than queueing nothing", async () => {
    const path = join(await dir(), "heavy-commands.json");
    await writeFile(path, "{ not json");
    const reasons: string[] = [];
    const store = fileHeavyCommandsStore(path, (reason) => reasons.push(reason));
    expect(await store.read()).toEqual(mergeHeavyRules());
    await writeFile(path, JSON.stringify({ limit: -4 }));
    expect(await store.read()).toEqual(mergeHeavyRules());
    expect(reasons).toEqual([expect.stringContaining("limit")]);
});
