import { STATE_DIR } from "@intentic/constants";
import { IGNORES, syncIgnoreMatcher, workspaceSyncIgnores } from "./workspace-sync-ignores.js";

describe("workspaceSyncIgnores", () => {
    test.each([
        "node_modules",
        "app/node_modules/x/index.js",
        "a/b/dist/main.js",
        `${STATE_DIR}/records/sessions/x.jsonl`,
        "refs/some-clone/src/a.ts",
        "intentic/.git/index",
        "app/.env",
        "app/.env.production.local",
        "repo/.intentic/local/cache/db",
        "crate/target/debug/foo",
        "crate/target/x86_64-pc-windows-msvc/release/foo.exe",
        "crate/target/fast/incremental/x",
        "crate/target/x86_64-unknown-linux-gnu/fast/deps/y",
    ])("leaves out %s", (path) => {
        expect(workspaceSyncIgnores(path)).toBe(true);
    });

    test.each([
        "README.md",
        "intentic/_sandbox/sandbox/src/main.ts",
        "repo/.intentic/checks.json",
        "repo/refs/notes.md",
        "app/.env.example",
        "crate/target/fast/my-binary",
        "crate/target/CACHEDIR.TAG",
        "docs/target.md",
    ])("carries %s", (path) => {
        expect(workspaceSyncIgnores(path)).toBe(false);
    });

    test("matches nothing for a spelling it was never taught, which only ever over-signals", () => {
        const matches = syncIgnoreMatcher(["!keep", "a?c", "[ab]"]);
        expect(["keep", "abc", "a"].some(matches)).toBe(false);
    });

    test("understands every pattern the session is created with", () => {
        // Each built-in pattern, spelled as a path, is left out by its own rule.
        for (const pattern of IGNORES) {
            const path = pattern.replace(/^\//, "").replaceAll("**/", "x/").replaceAll("*", "y");
            expect(workspaceSyncIgnores(path), pattern).toBe(true);
        }
    });
});
