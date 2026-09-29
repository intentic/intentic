import { assertLinked, UnlinkedCheckoutError, unlinkedMessage } from "./checkout-link.js";

test("a checkout that could not be re-linked stops with the plain reason, naming the repo", async () => {
    const worktrees = { relink: async () => ["tabularium"] };
    await expect(assertLinked(worktrees, "c1", [{ repo: "root" }, { repo: "tabularium" }])).rejects.toThrow(UnlinkedCheckoutError);
    await expect(assertLinked(worktrees, "c1", [{ repo: "tabularium" }])).rejects.toThrow(
        "This agent's copy of tabularium lost its link to your workspace, and it could not be reconnected by itself",
    );
});

test("every checkout linked (or re-linked) lets the caller carry on", async () => {
    await expect(assertLinked({ relink: async () => [] }, "c1", [{ repo: "root" }])).resolves.toBeUndefined();
});

test("the message says Continue will not get past it, and calls the root repo the workspace", () => {
    expect(unlinkedMessage(["root"])).toMatch(/^This agent's copy of the workspace lost its link/);
    expect(unlinkedMessage(["root"])).toContain("Pressing Continue will stop here again.");
});
