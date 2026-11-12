import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mainIncrementalRelief, rustBuildRunning } from "./main-incremental.js";

let base: string;
let work: string;
let history: string;

const put = (path: string, ageMs = 0): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
    if (ageMs > 0) {
        const then = (Date.now() - ageMs) / 1000;
        utimesSync(path, then, then);
    }
};

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "main-incremental-"));
    work = join(base, "work");
    history = join(base, "history");
    mkdirSync(history, { recursive: true });
    mkdirSync(work, { recursive: true });
    execFileSync("git", ["-C", work, "init", "-q"]);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("the main checkout's Cargo incremental caches", () => {
    const crate = (): void => {
        put(join(work, "integra/Cargo.toml"));
        writeFileSync(join(work, ".gitignore"), "target/\n");
        put(join(work, "integra/target/debug/incremental/app-1/s-1/dep-graph.bin"));
        put(join(work, "integra/target/wasm32-unknown-unknown/debug/incremental/web-1/query-cache.bin"));
        put(join(work, "integra/target/debug/deps/libbevy.rlib"));
    };

    test("go while no build runs, every profile's, and the compiled dependencies stay", async () => {
        crate();
        const relief = mainIncrementalRelief({ workspaceRoot: work, historyRoot: history, programs: async () => [] });
        expect(await relief.free(async () => false)).toBe(2);
        expect(existsSync(join(work, "integra/target/debug/incremental"))).toBe(false);
        expect(existsSync(join(work, "integra/target/wasm32-unknown-unknown/debug/incremental"))).toBe(false);
        expect(existsSync(join(work, "integra/target/debug/deps/libbevy.rlib"))).toBe(true);
    });

    test("stay while Cargo or rustc runs anywhere, and stop once the disk has room", async () => {
        crate();
        const building = mainIncrementalRelief({ workspaceRoot: work, historyRoot: history, programs: async () => [{ argv: ["/usr/local/cargo/bin/cargo", "build"] }] });
        expect(await building.free(async () => false)).toBe(0);
        expect(existsSync(join(work, "integra/target/debug/incremental"))).toBe(true);
        const quiet = mainIncrementalRelief({ workspaceRoot: work, historyRoot: history, programs: async () => [] });
        expect(await quiet.free(async () => true)).toBe(1);
    });

    test("a wrapped rustc is a build too; a shell standing in the crate is not", () => {
        expect(rustBuildRunning([{ argv: ["sccache", "/usr/local/rustup/toolchains/stable/bin/rustc", "--crate-name", "x"] }])).toBe(true);
        expect(rustBuildRunning([{ argv: ["/bin/zsh"], cwd: "/work/integra" }])).toBe(false);
    });
});
