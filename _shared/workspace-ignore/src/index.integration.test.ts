import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIgnoreScope } from "./index.js";

/* descend() against a real tree: a missing .gitignore adds no rules, an unreadable one is not read as missing. */

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workspace-ignore-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

test("a directory's .gitignore layers its rules, and a directory without one adds none", async () => {
    writeFileSync(join(root, ".gitignore"), "build/\n");
    mkdirSync(join(root, "plain"));
    const scope = await (await createIgnoreScope().descend(root, "")).descend(join(root, "plain"), "plain");
    expect(scope.isIgnored("build", "plain/build", true)).toBe(true);
    expect(scope.isIgnored("src", "plain/src", true)).toBe(false);
});

test("a .gitignore that cannot be read fails the descend instead of reading as no rules", async () => {
    mkdirSync(join(root, ".gitignore"));
    await expect(createIgnoreScope().descend(root, "")).rejects.toMatchObject({ code: "EISDIR" });
});
