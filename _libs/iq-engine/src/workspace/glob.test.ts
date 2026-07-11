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
