import { expect, test } from "vitest";
import { globScope } from "./search-globs.js";

test("an empty field scopes nothing", () => {
    expect(globScope(undefined)).toEqual({});
    expect(globScope("")).toEqual({});
    expect(globScope(" , ")).toEqual({});
});

test("patterns are the engine's include list, directories widened to their subtree", () => {
    expect(globScope("*.test.ts")).toEqual({ globs: ["*.test.ts"] });
    expect(globScope("_apps/web")).toEqual({ globs: ["_apps/web/"] });
    expect(globScope("_apps/web/")).toEqual({ globs: ["_apps/web/"] });
    expect(globScope("*.test.ts, _apps/web")).toEqual({ globs: ["*.test.ts", "_apps/web/"] });
});

// A path is anchored at the workspace root; a bare name is that folder wherever it sits — the same split the
// engine already makes for wildcards (`*.ts` at any depth, `src/*.ts` only in src).
test("a name with no slash is that directory at any depth", () => {
    expect(globScope("docs")).toEqual({ globs: ["**/docs/"] });
    expect(globScope("docs/")).toEqual({ globs: ["**/docs/"] });
});

test("a leading ! excludes instead", () => {
    expect(globScope("!**/*.test.ts")).toEqual({ notGlobs: ["**/*.test.ts"] });
    expect(globScope("src, !src/generated")).toEqual({ globs: ["**/src/"], notGlobs: ["src/generated/"] });
    // A lone "!" would otherwise widen the search to everything under the workspace root.
    expect(globScope("!")).toEqual({});
});

test("a brace group's comma is the pattern's own, not a separator", () => {
    expect(globScope("*.{ts,py}")).toEqual({ globs: ["*.{ts,py}"] });
    expect(globScope("src/**/*.{ts,tsx}, docs")).toEqual({ globs: ["src/**/*.{ts,tsx}", "**/docs/"] });
});
