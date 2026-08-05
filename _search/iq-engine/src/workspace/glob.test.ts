import { expect, test } from "vitest";
import { globToRegExp } from "./glob.js";

test("globToRegExp matches like ripgrep -g", () => {
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(true); // no-slash glob matches anywhere
    expect(globToRegExp("*.ts").test("src/a.tsx")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("**/*.test.ts").test("a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("src/**/util.ts").test("src/a/b/util.ts")).toBe(true);
    expect(globToRegExp("docs/").test("docs/guide.md")).toBe(true);
    expect(globToRegExp("a?c.md").test("abc.md")).toBe(true);
    expect(globToRegExp("*.{ts,py}").test("x/app.py")).toBe(true);
    expect(globToRegExp("*.{ts,py}").test("x/app.rb")).toBe(false);
});

// `**` crosses whole directories, never half a name — the difference between "an api anywhere" and "anything
// ending in api", which is what the search box's file filter leans on for every name it is given.
test("a globstar spans complete directories only", () => {
    expect(globToRegExp("**/api").test("_apps/api")).toBe(true);
    expect(globToRegExp("**/api").test("api")).toBe(true); // zero directories is a match too
    expect(globToRegExp("**/api").test("_apps/napi")).toBe(false);
    expect(globToRegExp("**/api/**").test("_apps/api/src/app.ts")).toBe(true);
    expect(globToRegExp("**/api/**").test("_apps/napi/src/app.ts")).toBe(false);
    expect(globToRegExp("**/package.json").test("_editor/web/package.json")).toBe(true);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**").test("srcish/a.ts")).toBe(false);
    expect(globToRegExp("src/**/util.ts").test("src/util.ts")).toBe(true); // ** may span nothing
});
