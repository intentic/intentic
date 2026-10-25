import type { GitChange } from "@intentic/sandbox-contract/schemas/git/git";
import { countsOf, diffStatOf, rankedModules, sumDiffStats } from "../change-modules.js";

const change = (path: string, additions = 1, deletions = 0): GitChange => ({ path, status: "modified", additions, deletions });

const MODULES = [
    { dir: "_editor/web", name: "@intentic/web" },
    { dir: "_editor/ui", name: "@intentic/ui" },
    { dir: "_sandbox/sandbox", name: "@intentic/sandbox" },
];

test("buckets each change by the package the review would head it with, and counts the stat beside it", () => {
    const stat = diffStatOf(
        [change("_editor/web/src/a.ts", 10, 2), change("_editor/web/src/b.vue", 4), change("_editor/ui/src/i18n/en.json", 1, 1)],
        MODULES,
        "intentic",
    );
    expect(stat).toEqual({ files: 3, insertions: 15, deletions: 3, modules: { "@intentic/web": 2, "@intentic/ui": 1 } });
});

test("a file no package claims counts toward its repository, except a loose file in the workspace root", () => {
    expect(diffStatOf([change("README.md")], MODULES, "intentic").modules).toEqual({ intentic: 1 });
    expect(diffStatOf([change("notes.md")], [], "root").modules).toBeUndefined();
});

test("sums repositories into one conversation's stat", () => {
    const sum = sumDiffStats([
        diffStatOf([change("_editor/web/src/a.ts")], MODULES, "intentic"),
        diffStatOf([change("src/x.ts", 3)], [{ dir: "", name: "docs-site" }], "docs-site"),
        { files: 0, insertions: 0, deletions: 0 },
    ]);
    expect(sum).toEqual({ files: 2, insertions: 4, deletions: 0, modules: { "@intentic/web": 1, "docs-site": 1 } });
});

test("names at most three packages, most-changed first, a tie by name", () => {
    expect(rankedModules({ b: 2, a: 2, c: 5, d: 1 })).toEqual(["c", "a", "b"]);
    expect(rankedModules({})).toBeUndefined();
    expect(rankedModules(undefined)).toBeUndefined();
});

test("the wire's diff carries the counts alone", () => {
    expect(countsOf({ files: 1, insertions: 2, deletions: 3, modules: { web: 1 } })).toEqual({ files: 1, insertions: 2, deletions: 3 });
    expect(countsOf(undefined)).toBeUndefined();
});
