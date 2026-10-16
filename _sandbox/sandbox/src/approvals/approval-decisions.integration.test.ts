import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionApprovalSummary } from "@intentic/sandbox-contract";
import { type ApprovalRoots, approvalStandings, recordApproval, spendApprovals } from "./approval-decisions.js";

// Spending a yes is the claim whoever acts on it makes: it removes the yes only when the yes covers the item as it stands
// now, in one serialized change of the ledger on the history volume, so two claims cannot both win and an edited item
// cannot be claimed at all.

const item: ActionApprovalSummary = {
    id: "e-urzad-1",
    kind: "action",
    summary: "EZD RP: add 1 file(s) to case sprawa-1",
    details: "Adds the draft.",
    instructions: "Nothing for a turn to run.",
    performer: { extension: "intentic.e-urzad", digest: "a".repeat(64) },
    status: "approved",
    createdAt: 1,
};

let roots: ApprovalRoots;

beforeEach(async () => {
    roots = { historyRoot: await mkdtemp(join(tmpdir(), "spend-history-")), workspaceRoot: await mkdtemp(join(tmpdir(), "spend-work-")) };
});

afterEach(async () => {
    await rm(roots.historyRoot, { recursive: true, force: true });
    await rm(roots.workspaceRoot, { recursive: true, force: true });
});

test("a yes is spent once, with who gave it and when, however many claim it at once", async () => {
    await recordApproval(roots, item, "urzednik@example.gov.pl", 1_760_000_000_000);
    const claims = await Promise.all([spendApprovals(roots, [item]), spendApprovals(roots, [item]), spendApprovals(roots, [item])]);
    expect(claims.map((spent) => spent.size).toSorted()).toEqual([0, 0, 1]);
    expect(claims.find((spent) => spent.size === 1)?.get(item.id)).toEqual({ approver: "urzednik@example.gov.pl", approvedAt: 1_760_000_000_000 });
    expect(await (await approvalStandings(roots))(item)).toBe("unapproved");
});

test("an item changed since its yes is not spent, and its yes stays on record as changed", async () => {
    await recordApproval(roots, item, "urzednik@example.gov.pl");
    const edited = { ...item, performer: { extension: "intentic.e-urzad", digest: "b".repeat(64) } };
    expect((await spendApprovals(roots, [edited])).size).toBe(0);
    expect(await (await approvalStandings(roots))(edited)).toBe("changed");
});

test("an item nobody approved is not spent: writing approved into it is no claim", async () => {
    expect((await spendApprovals(roots, [item])).size).toBe(0);
});
