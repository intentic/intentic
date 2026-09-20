import { describe, expect, test } from "vitest";
import { fenceAllows, fenceCovers, fenceIntersection, fenceReaches, foldPath, pathInsideFolder } from "./slice-paths.js";

describe("foldPath", () => {
    test("folds the spellings of one path into one answer", () => {
        expect(foldPath("a/./b")).toBe("a/b");
        expect(foldPath("a//b/")).toBe("a/b");
        expect(foldPath("./a/b")).toBe("a/b");
        expect(foldPath("a\\b")).toBe("a/b");
        expect(foldPath("a/c/../b")).toBe("a/b");
    });

    test("the workspace root folds to the empty string, which is an answer and not a miss", () => {
        expect(foldPath(".")).toBe("");
        expect(foldPath("")).toBe("");
    });

    // A path that climbs out, or opens at a root, names something this workspace does not own; the fence has no say
    // over it and must not be tricked into answering as if it did.
    test("a path that leaves the workspace has no folded form", () => {
        expect(foldPath("../elsewhere")).toBeUndefined();
        expect(foldPath("a/../../elsewhere")).toBeUndefined();
        expect(foldPath("/etc/passwd")).toBeUndefined();
        expect(foldPath("C:/Windows")).toBeUndefined();
    });
});

describe("pathInsideFolder", () => {
    test("a folder holds itself and everything under it", () => {
        expect(pathInsideFolder("apps/web", "apps/web")).toBe(true);
        expect(pathInsideFolder("apps/web", "apps/web/src/main.ts")).toBe(true);
    });

    // The whole reason this is segment arithmetic rather than a string prefix.
    test("a sibling sharing a prefix is not inside", () => {
        expect(pathInsideFolder("apps/web", "apps/web2/main.ts")).toBe(false);
        expect(pathInsideFolder("app", "app2")).toBe(false);
    });

    test("the workspace root holds every path in the workspace", () => {
        expect(pathInsideFolder("", "anything/at/all")).toBe(true);
    });

    test("a climbing path is inside nothing", () => {
        expect(pathInsideFolder("apps/web", "apps/web/../../secrets")).toBe(false);
    });
});

describe("fenceAllows", () => {
    test("no fence is the whole workspace", () => {
        expect(fenceAllows(undefined, "finance/ledger.csv")).toBe(true);
    });

    // The distinction the type exists for: undefined is "unfenced", [] is "fenced to nothing".
    test("an empty fence admits nothing", () => {
        expect(fenceAllows([], "anything")).toBe(false);
    });

    test("a fence admits its own folders and refuses the rest", () => {
        expect(fenceAllows(["support", "docs"], "support/tickets/1.md")).toBe(true);
        expect(fenceAllows(["support", "docs"], "finance/payroll.csv")).toBe(false);
    });
});

describe("fenceReaches", () => {
    // Without this a fence on `finance/reports` would hide `finance` and leave the folder unreachable in a tree.
    test("an ancestor of an allowed folder may still be listed", () => {
        expect(fenceReaches(["finance/reports"], "finance")).toBe(true);
        expect(fenceReaches(["finance/reports"], "")).toBe(true);
    });

    test("a sibling of an allowed folder is not reachable", () => {
        expect(fenceReaches(["finance/reports"], "finance/payroll")).toBe(false);
    });
});

describe("fenceCovers", () => {
    test("the unfenced cover everything, and are covered by nothing else", () => {
        expect(fenceCovers(undefined, ["anything"])).toBe(true);
        expect(fenceCovers(["anything"], undefined)).toBe(false);
    });

    test("a fence covers another when every folder of it is inside one of its own", () => {
        expect(fenceCovers(["apps"], ["apps/web", "apps/api"])).toBe(true);
        expect(fenceCovers(["apps/web"], ["apps"])).toBe(false);
    });

    test("a fence covers the empty one, since nothing is inside everything", () => {
        expect(fenceCovers(["apps/web"], [])).toBe(true);
    });
});

describe("fenceIntersection", () => {
    test("either side alone narrows to itself", () => {
        expect(fenceIntersection(undefined, ["apps/web"])).toEqual(["apps/web"]);
        expect(fenceIntersection(["apps/web"], undefined)).toEqual(["apps/web"]);
        expect(fenceIntersection(undefined, undefined)).toBeUndefined();
    });

    // The narrower of the pair survives, whichever side it came from, so a persona asking for more than its starter
    // holds gets the starter's answer.
    test("the tighter folder is what survives, from whichever side", () => {
        expect(fenceIntersection(["apps"], ["apps/web"])).toEqual(["apps/web"]);
        expect(fenceIntersection(["apps/web"], ["apps"])).toEqual(["apps/web"]);
    });

    test("disjoint fences meet at nothing, which is a fence admitting nothing", () => {
        expect(fenceIntersection(["apps/web"], ["finance"])).toEqual([]);
    });

    test("overlapping folders are not repeated", () => {
        expect(fenceIntersection(["apps", "apps/web"], ["apps/web"])).toEqual(["apps/web"]);
    });
});
