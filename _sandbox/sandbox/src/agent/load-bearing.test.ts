import type { GitRunner } from "@intentic/scaffold";
import { describe, expect, test } from "vitest";
import { defencesOf, MAX_PROBES, probeCost, probeRank } from "./load-bearing.js";

// A fixed clock, so the age boundary is a fact this file states rather than one it waits for.
const NOW = Date.UTC(2026, 7, 28);
const daysAgo = (days: number): number => Math.floor((NOW - days * 86_400_000) / 1000);

const FIELD = "\u001f";
const logLine = (hash: string, at: number, subject: string): string => [hash, String(at), subject].join(FIELD);

/* A git that answers the pickaxe from a table keyed by the searched line, and RECORDS what it was asked, which
 * is half of what these tests assert: the budget and the candidacy rules are claims about how many subprocesses
 * a turn spends, and a fake that only returned rows could not fail them. */
const fakeGit = (history: Record<string, readonly string[]>) => {
    const asked: string[] = [];
    const git: GitRunner = async (_dir, args) => {
        const searched = args.find((arg) => arg.startsWith("-S"))?.slice(2) ?? "";
        asked.push(searched);
        return { stdout: (history[searched] ?? []).join("\n"), stderr: "" };
    };
    return { git, asked };
};

describe("which lines are worth asking git about", () => {
    test("ordinary code is not, however long", () => {
        expect(probeRank(`const total = items.length + offset;`)).toBeUndefined();
    });

    test("a short line is not, whatever it says", () => {
        // `catch {` matches the construct vocabulary and is still too generic to pickaxe: the query would
        // answer "this file has a history" rather than anything about this line.
        expect(probeRank(`} catch {`)).toBeUndefined();
    });

    test("an instruction outranks an explanation, which outranks a construct", () => {
        expect(probeRank(`// do not remove: the second call needs the cache warm`)).toBe(0);
        expect(probeRank(`// deliberately sequential, the API rate-limits per connection`)).toBe(1);
        expect(probeRank(`await sleep(2000); // let the replica catch up`)).toBe(2);
    });

    test("the cost of a file is its distinct probeable lines, and an instruction costs nothing", () => {
        const lines = [`await sleep(2000); // let the replica catch up`, `  await sleep(2000); // let the replica catch up`, `const x = 1;`];
        expect(probeCost(lines)).toBe(1);
        expect(probeCost([`// do not remove this, the ordering is load-bearing`])).toBe(0);
    });
});

describe("what the history defends", () => {
    test("an instruction defends on its own, without asking git", async () => {
        const { git, asked } = fakeGit({});
        const found = await defencesOf("/repo", "src/a.ts", [`// do not delete: the retry below needs this delay`], MAX_PROBES, NOW, git);
        expect(found.map((defence) => defence.kind)).toEqual(["declared"]);
        expect(asked).toEqual([]);
    });

    test("a line that has entered and left before is contested, and says which commit last moved it", async () => {
        const line = `await sleep(2000); // let the replica catch up`;
        const { git } = fakeGit({
            [line]: [
                logLine("8b0e44", daysAgo(6), "fix: nightly export dies on cold replica"),
                logLine("3f2a1c", daysAgo(12), "refactor: drop redundant waits"),
                logLine("a91d33", daysAgo(400), "feat: export job"),
            ],
        });
        const [defence] = await defencesOf("/repo", "src/a.ts", [line], MAX_PROBES, NOW, git);
        expect(defence?.kind).toBe("contested");
        expect(defence?.detail).toContain("3 times");
        expect(defence?.detail).toContain(`8b0e44 "fix: nightly export dies on cold replica"`);
    });

    test("a line born in a repair is a scar, however young", async () => {
        const line = `await sleep(2000); // let the replica catch up`;
        const { git } = fakeGit({ [line]: [logLine("a91d33", daysAgo(3), "hotfix: export races the replica")] });
        const [defence] = await defencesOf("/repo", "src/a.ts", [line], MAX_PROBES, NOW, git);
        expect(defence?.kind).toBe("scar");
        expect(defence?.detail).toContain("a91d33");
    });

    test("a ticket reference is a repair too, and is read case-sensitively", async () => {
        const scarred = `await sleep(2000); // let the replica catch up`;
        const plain = `const timeout = computeTimeout(config);`;
        const { git } = fakeGit({
            [scarred]: [logLine("a91d33", daysAgo(3), "INC-4821 export")],
            [plain]: [logLine("b22e01", daysAgo(3), "chore: tidy up config-1 handling")],
        });
        const found = await defencesOf("/repo", "src/a.ts", [scarred, plain], MAX_PROBES, NOW, git);
        expect(found.map((defence) => defence.kind)).toEqual(["scar"]);
    });

    test("an old undisturbed line is a survivor, a young one is nothing", async () => {
        const old = `await sleep(2000); // let the replica catch up`;
        const young = `const deadline = Date.now() + 30_000;`;
        const { git } = fakeGit({
            [old]: [logLine("a91d33", daysAgo(400), "feat: export job")],
            [young]: [logLine("c31f77", daysAgo(9), "feat: deadline")],
        });
        const found = await defencesOf("/repo", "src/a.ts", [old, young], MAX_PROBES, NOW, git);
        expect(found.map((defence) => defence.kind)).toEqual(["survivor"]);
        expect(found[0]?.detail).toContain("400 days");
    });

    test("a line git knows nothing about is not defended", async () => {
        const line = `await sleep(2000); // let the replica catch up`;
        const { git } = fakeGit({});
        expect(await defencesOf("/repo", "src/a.ts", [line], MAX_PROBES, NOW, git)).toEqual([]);
    });

    /* A git that cannot answer is not a turn that gets sent back to work. An untracked file, a path outside any
     * repository and a shallow clone all land here, and all of them mean the same thing about the line. */
    test("a failing git reads as no history rather than propagating", async () => {
        const failing: GitRunner = async () => {
            throw new Error("fatal: not a git repository");
        };
        expect(await defencesOf("/repo", "src/a.ts", [`await sleep(2000); // let the replica catch up`], MAX_PROBES, NOW, failing)).toEqual([]);
    });

    test("the budget caps subprocesses, and an instruction is still answered past it", async () => {
        const constructs = Array.from({ length: 5 }, (_, index) => `await sleep(${index}000); // wait for the replica to settle`);
        const { git, asked } = fakeGit({});
        const found = await defencesOf("/repo", "src/a.ts", [...constructs, `// do not remove: ordering is load-bearing here`], 2, NOW, git);
        expect(asked).toHaveLength(2);
        expect(found.map((defence) => defence.kind)).toEqual(["declared"]);
    });

    test("a budget of nothing asks nothing", async () => {
        const { git, asked } = fakeGit({});
        await defencesOf("/repo", "src/a.ts", [`await sleep(2000); // let the replica catch up`], 0, NOW, git);
        expect(asked).toEqual([]);
    });
});
