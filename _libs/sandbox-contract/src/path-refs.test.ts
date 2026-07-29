import { describe, expect, test } from "vitest";
import { isTestPath, rankRefCandidates, referenceTails } from "./path-refs.js";

describe("referenceTails", () => {
    test("offers the reference itself first, then shorter tails of it", () => {
        expect(referenceTails("_apps/web/src/foo.ts", "/work")).toEqual(["_apps/web/src/foo.ts", "web/src/foo.ts", "src/foo.ts"]);
    });

    test("anchors an absolute path under the workspace root", () => {
        expect(referenceTails("/work/_apps/foo.ts", "/work")[0]).toBe("_apps/foo.ts");
    });

    test("strips an isolated turn's worktree lead by dropping segments", () => {
        // The worktree mirrors the workspace layout below /history/worktrees/<id>, so the real path is a tail.
        expect(referenceTails("/history/worktrees/agent-7/_apps/foo.ts", "/work")).toContain("_apps/foo.ts");
    });

    test("never cuts down to a bare filename — one `index.ts` is as good as another", () => {
        expect(referenceTails("a/b/index.ts", "/work").at(-1)).toBe("b/index.ts");
        expect(referenceTails("index.ts", "/work")).toEqual([]);
    });

    test("normalizes a ./ lead and windows separators", () => {
        expect(referenceTails("./src/foo.ts", "/work")).toEqual(["src/foo.ts"]);
        expect(referenceTails("src\\foo.ts", "/work")).toEqual(["src/foo.ts"]);
    });
});

describe("rankRefCandidates", () => {
    test("keeps only matches that end in the tail on a segment boundary", () => {
        // `mypages/` merely ends with the same characters — the daemon's glob can't tell, so this must.
        expect(rankRefCandidates("pages/Foo.vue", ["app/mypages/Foo.vue", "app/pages/Foo.vue"])).toEqual(["app/pages/Foo.vue"]);
    });

    test("ranks the shallowest match first — the app's file, not a copy in a fixture tree", () => {
        expect(rankRefCandidates("pages/Foo.vue", ["a/b/c/pages/Foo.vue", "a/pages/Foo.vue"])).toEqual(["a/pages/Foo.vue", "a/b/c/pages/Foo.vue"]);
    });

    test("matches the tail as a whole path too", () => {
        expect(rankRefCandidates("src/foo.ts", ["src/foo.ts", "vendor/src/foo.ts"])).toEqual(["src/foo.ts", "vendor/src/foo.ts"]);
    });
});

test("isTestPath: test files, fixture dirs and runner configs — never product code that merely says 'test'", () => {
    for (const path of [
        `src/agents/land.test.ts`,
        `src/pages/Foo.spec.tsx`,
        `_apps/cli/src/cli.e2e.test.ts`,
        `src/e2e-harness.ts`,
        `pkg/__tests__/helper.ts`,
        `_libs/iq-recall/src/__fixtures__/transcripts/a.jsonl`,
        `vitest.config.ts`,
        `_apps/web/vitest.workspace.config.mts`,
        `playwright.config.ts`,
    ]) {
        expect(isTestPath(path), path).toBe(true);
    }
    for (const path of [
        `src/pages/testimonials.vue`,
        `src/latest.ts`,
        `src/test-utils.ts`,
        `contest/results.ts`,
        `src/attestation.spec.md.bak`,
        `docs/testing.md`,
    ]) {
        expect(isTestPath(path), path).toBe(false);
    }
});
