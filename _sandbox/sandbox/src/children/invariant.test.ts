import { expect, test } from "vitest";
import { checks } from "./invariant.js";

/* The failure the owner pays for: a child the parent has been told is finished, still running against the
 * allowance with nobody supervising it. */

const fail = (message: string): never => {
    throw new Error(message);
};

const NOW = 1_800_000_000_000;

type Ledger = readonly { readonly conversationId: string; readonly parent: string; readonly running: boolean; readonly startedAt: number }[];

const run = async (ledger: Ledger, live: readonly { conversationId: string; startedAt: number }[]): Promise<void> => {
    const [check] = checks({ children: () => ledger, live: () => live, now: () => NOW });
    await check?.run({ moment: "turn-settled", fail });
};

const kid = (conversationId: string, running: boolean) => ({ conversationId, parent: "root", running, startedAt: NOW - 120_000 });

test("a running record with a live turn behind it, and a settled record with none, report nothing", async () => {
    await expect(run([kid("sub-1", true), kid("sub-2", false)], [{ conversationId: "sub-1", startedAt: NOW - 60_000 }])).resolves.toBeUndefined();
});

test("a live turn nobody spawned is somebody's own conversation, not a finding", async () => {
    await expect(run([], [{ conversationId: "own", startedAt: NOW - 60_000 }])).resolves.toBeUndefined();
});

test("a live turn whose record reads settled is named, with the parent that was told it finished", async () => {
    await expect(run([kid("sub-1", false)], [{ conversationId: "sub-1", startedAt: NOW - 60_000 }])).rejects.toThrow(
        /sub-1 \(parent root\).*told they finished/,
    );
});

test("a turn younger than the grace is not yet due", async () => {
    await expect(run([kid("sub-1", false)], [{ conversationId: "sub-1", startedAt: NOW - 1_000 }])).resolves.toBeUndefined();
});

test("a running record with no live turn is deliberately not a finding here", async () => {
    // The pump settles the ledger a tick after the turn is marked done, and nothing stamps when. Pinned so a
    // later change adding the stamp finds this waiting rather than discovering the omission was accidental.
    await expect(run([kid("sub-1", true)], [])).resolves.toBeUndefined();
});
