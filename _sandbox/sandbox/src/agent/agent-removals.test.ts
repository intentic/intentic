import type { GitRunner } from "@intentic/scaffold";
import { describe, expect, test } from "vitest";
import { createRemovalLedger, type FileReader, verifyRemovalsMessage } from "./agent-removals.js";

const NOW = Date.UTC(2026, 7, 28);
const daysAgo = (days: number): number => Math.floor((NOW - days * 86_400_000) / 1000);
const FIELD = "\u001f";

const SLEEP = `await sleep(2000); // let the replica catch up`;

// The tree as it stands NOW, by path. A path absent from it is a file the turn deleted, which is the largest
// removal there is and the one a reader that threw would hide.
const treeReader =
    (tree: Record<string, string>): FileReader =>
    async (path) =>
        tree[path];

const gitSaying = (rows: Record<string, readonly [string, number, string][]>): GitRunner => async (_dir, args) => {
    const searched = args.find((arg) => arg.startsWith("-S"))?.slice(2) ?? "";
    return { stdout: (rows[searched] ?? []).map(([hash, at, subject]) => [hash, String(at), subject].join(FIELD)).join("\n"), stderr: "" };
};

// A git nothing should reach: every call is a subprocess this turn was not supposed to spend.
const noGit: GitRunner = async () => {
    throw new Error("git was asked something");
};

describe("what a turn removed", () => {
    test("the snapshot is the FIRST touch, so a file edited twice is compared against how the turn found it", async () => {
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/a.ts", `${SLEEP}\nconst kept = 1;\n`);
        // The turn's own intermediate state must not become the baseline, or its scaffolding reads as deletions.
        ledger.notePrior("/w/a.ts", `const kept = 1;\n`);
        expect(await ledger.removals(treeReader({ "/w/a.ts": `const kept = 1;\n` }))).toEqual([{ path: "/w/a.ts", lines: [SLEEP] }]);
    });

    test("a line that moved to another file the turn touched is not a removal", async () => {
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/a.ts", `${SLEEP}\nconst kept = 1;\n`);
        ledger.notePrior("/w/b.ts", ``);
        const tree = { "/w/a.ts": `const kept = 1;\n`, "/w/b.ts": `${SLEEP}\n` };
        expect(await ledger.removals(treeReader(tree))).toEqual([]);
    });

    test("a deleted file is every line at once", async () => {
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/a.ts", `${SLEEP}\nconst kept = 1;\n`);
        expect(await ledger.removals(treeReader({}))).toEqual([{ path: "/w/a.ts", lines: [SLEEP, `const kept = 1;`] }]);
    });

    test("a file the turn created has removed nothing, however much it then trimmed", async () => {
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/new.ts", undefined);
        expect(await ledger.removals(treeReader({ "/w/new.ts": `const kept = 1;\n` }))).toEqual([]);
    });
});

describe("the verify-removals follow-up", () => {
    const armed = (prior: string, now: string) => {
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/a.ts", prior);
        return { ledger, read: treeReader({ "/w/a.ts": now }) };
    };

    test("says nothing when the turn removed nothing", async () => {
        const { ledger, read } = armed(`const kept = 1;\n`, `const kept = 1;\nconst added = 2;\n`);
        expect(await verifyRemovalsMessage(ledger, { cwd: "/w", read, git: noGit, now: NOW })).toBeUndefined();
    });

    test("says nothing when what went is ordinary code", async () => {
        const { ledger, read } = armed(`const total = items.length + offset;\n`, ``);
        expect(await verifyRemovalsMessage(ledger, { cwd: "/w", read, git: noGit, now: NOW })).toBeUndefined();
    });

    test("names the file, quotes the line, and carries git's own words", async () => {
        const { ledger, read } = armed(`${SLEEP}\n`, ``);
        const git = gitSaying({ [SLEEP]: [["a91d33", daysAgo(400), "fix: nightly export dies on cold replica"]] });
        const message = await verifyRemovalsMessage(ledger, { cwd: "/w", read, git, now: NOW });
        expect(message).toContain("/w/a.ts");
        expect(message).toContain(SLEEP);
        expect(message).toContain(`a91d33 "fix: nightly export dies on cold replica"`);
        // The whole point of the check: the suite it just ran cannot answer this.
        expect(message).toContain("A passing suite does not settle this");
    });

    /* No cwd is an ACP or translator turn, where there is no repository to ask. The check does not go silent,
     * it falls back to the half that needs no history, which is also the half that is never wrong. */
    test("without a repository, only a removal that defends itself in words is reported", async () => {
        const declared = `// do not remove: the retry below needs this delay`;
        const ledger = createRemovalLedger();
        ledger.notePrior("/w/a.ts", `${declared}\n${SLEEP}\n`);
        const message = await verifyRemovalsMessage(ledger, { read: treeReader({ "/w/a.ts": `` }), git: noGit, now: NOW });
        expect(message).toContain(declared);
        expect(message).not.toContain(SLEEP);
    });
});
