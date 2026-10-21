import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneBuildOutputs } from "./build-outputs.js";

let root: string;

const put = (path: string, text = "x"): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
};

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-C", cwd, ...args], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "build-outputs-"));
    git(root, "init", "-q");
    put(".gitignore", "target/\nbuild/\n.gradle/\n.dart_tool/\nnode_modules/\n");
    // A crate deep in the tree, its output ignored.
    put("apps/desktop/src-tauri/Cargo.toml");
    put("apps/desktop/src-tauri/target/debug/app", "binary");
    // Android and Flutter outputs beside their build files.
    put("apps/android/build.gradle.kts");
    put("apps/android/build/outputs/app.apk");
    put("apps/android/.gradle/8.0/cache");
    put("apps/flutter/pubspec.yaml");
    put("apps/flutter/build/app.dill");
    put("apps/flutter/.dart_tool/package_config.json");
    // A `target` that is no build output: no Cargo.toml beside it.
    put("docs/target/notes.md");
    // A `build` directory the repo tracks, beside a build file: force-added past the ignore rule.
    put("tools/gradle-fixture/build.gradle");
    put("tools/gradle-fixture/build/expected.txt");
    // A crate under node_modules: never looked into (an overlay mount point in a real checkout).
    put("node_modules/some-crate/Cargo.toml");
    put("node_modules/some-crate/target/x");
    git(root, "add", "-A");
    git(root, "add", "-f", "tools/gradle-fixture/build/expected.txt");
    git(root, "commit", "-qm", "fixture");
    // A nested repository: its own checkout and its own pass, so this one leaves it alone.
    put("nested/Cargo.toml");
    put("nested/target/x");
    git(join(root, "nested"), "init", "-q");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("removes ignored build output beside its build file and nothing else", async () => {
    const { removed, failed } = await pruneBuildOutputs(root);
    expect(failed).toEqual([]);
    expect(removed.toSorted()).toEqual([
        "apps/android/.gradle",
        "apps/android/build",
        "apps/desktop/src-tauri/target",
        "apps/flutter/.dart_tool",
        "apps/flutter/build",
    ]);
    for (const kept of ["docs/target/notes.md", "tools/gradle-fixture/build/expected.txt", "node_modules/some-crate/target/x", "nested/target/x"]) {
        expect(existsSync(join(root, kept))).toBe(true);
    }
    // The build files themselves and the sources stay.
    expect(existsSync(join(root, "apps/desktop/src-tauri/Cargo.toml"))).toBe(true);
});

test("a second pass finds nothing left, and a missing checkout is no error", async () => {
    await pruneBuildOutputs(root);
    expect(await pruneBuildOutputs(root)).toEqual({ removed: [], failed: [] });
    expect(await pruneBuildOutputs(join(root, "gone"))).toEqual({ removed: [], failed: [] });
});
