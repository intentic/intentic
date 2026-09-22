import { describe, test, expect } from "bun:test";
import { coneFor, fencedComposition } from "./worktree-cone.js";

// What a fenced conversation's checkout holds, as arithmetic. The worktree builder turns these answers into
// `git sparse-checkout set --cone`; this pins the answers.

describe("fencedComposition", () => {
    test("an unfenced conversation carries every repository", () => {
        expect(fencedComposition(undefined, ["root", "api", "web"])).toEqual(["root", "api", "web"]);
    });

    // Left out rather than checked out empty: absent is the answer the agent can act on.
    test("a fence drops the repositories it never reaches", () => {
        expect(fencedComposition(["api/src"], ["root", "api", "web"])).toEqual(["root", "api"]);
    });

    test("root is carried whatever the fence, since the others mount into it", () => {
        expect(fencedComposition(["docs"], ["root", "api"])).toEqual(["root"]);
    });
});

describe("coneFor", () => {
    test("no fence means no cone: the repository is checked out whole", () => {
        expect(coneFor(undefined, "api")).toBeUndefined();
    });

    // Cutting a repository the fence already holds entirely would cost a checkout rewrite and change nothing.
    test("a fence holding the whole repository leaves it whole", () => {
        expect(coneFor(["api"], "api")).toBeUndefined();
        expect(coneFor(["api", "docs"], "api")).toBeUndefined();
    });

    test("a fence inside the repository becomes a repo-relative cone", () => {
        expect(coneFor(["api/src", "api/test", "web/app"], "api")).toEqual(["src", "test"]);
    });

    test("the root repo's cone is the fence itself", () => {
        expect(coneFor(["docs", "support/tickets"], "root")).toEqual(["docs", "support/tickets"]);
    });

    // A repo nested inside a held folder is held with it; the cone question only arises where the fence cuts across
    // a repository rather than containing it.
    test("a repository nested inside a held folder is whole too", () => {
        expect(coneFor(["api"], "api/nested")).toBeUndefined();
    });

    // A folder the fence names but the repository does not have is kept in the cone rather than dropped: cone mode
    // accepts a directory that matches nothing, and dropping it here would silently widen a fence of only such
    // folders into "no cone at all".
    test("a named folder the repository does not have still narrows it", () => {
        expect(coneFor(["api/absent"], "api")).toEqual(["absent"]);
    });
});
