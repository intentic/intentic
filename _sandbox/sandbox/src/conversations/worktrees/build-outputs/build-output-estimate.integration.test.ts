import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOutputEstimate, measureBuildOutputs, RUST_TARGET_ESTIMATE, settledEstimate } from "./build-output-estimate.js";

let root: string;

const put = (path: string, bytes = 1): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "x".repeat(bytes));
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "build-estimate-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a repository with no Cargo manifest near its top adds nothing, whatever deeper crates built", async () => {
    put("tools/deep/ic/Cargo.toml");
    put("tools/deep/ic/target/debug/ic", 5000);
    expect(await buildOutputEstimate(root, { measure: async () => 5000 })).toBe(0);
});

test("a Cargo repository is priced at the median until main's own build output is measured, then at that", async () => {
    put("integra/Cargo.toml");
    put("integra/target/debug/app", 3000);
    put("integra/target/debug/deps/lib.rlib", 2000);
    expect(await measureBuildOutputs(root)).toBe(5000);
    // The first ask starts the measurement and does not wait for it.
    expect(await buildOutputEstimate(root, { now: 1 })).toBe(RUST_TARGET_ESTIMATE);
    await settledEstimate(root);
    expect(await buildOutputEstimate(root, { now: 2 })).toBe(5000);
});
