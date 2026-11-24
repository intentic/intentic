import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { requires } from "@intentic/testing/requires";
import { createIcServe, startIcServe } from "./ic-serve.js";

/* The client over real children: the ic built from this checkout (_hosts/ic, `cargo build`) answering as its own
   process would, and an ic from before `serve` (a script refusing it as clap does) given up for per-call runs. */

const BUILT_IC = join(repoRoot(import.meta.url), "_hosts/ic/target/debug/ic");
const posix = requires(process.platform !== "win32", "POSIX shell scripts");
const built = requires(existsSync(BUILT_IC), "an ic built by `cargo build` in _hosts/ic", {
    absentOnCi: "the TypeScript jobs do not build ic; _hosts/ic/tests/serve.rs checks the same answers from the Rust side",
});

let dir: string;
const HOME_BEFORE = process.env["INTENTIC_HOME"];

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-ic-serve-"));
    // An empty ic home: `sandbox swaps --json` answers `[]` from it, whatever this machine holds.
    process.env["INTENTIC_HOME"] = dir;
});

afterAll(async () => {
    if (HOME_BEFORE === undefined) {
        delete process.env["INTENTIC_HOME"];
    } else {
        process.env["INTENTIC_HOME"] = HOME_BEFORE;
    }
    await rm(dir, { recursive: true, force: true });
});

test.skipIf(!built.runs)(built.title("the built ic serves `sandbox swaps --json` with the bytes and exit code its own process prints"), async () => {
    const logs: string[] = [];
    const serve = createIcServe({ file: async () => ({ path: BUILT_IC, signature: "built" }), start: startIcServe, log: (line) => logs.push(line) });
    try {
        expect(await serve.ask(["sandbox", "swaps", "--json"], 15_000)).toEqual({ code: 0, stdout: "[]\n", stderr: "", output: "[]\n" });
        expect(await serve.ask(["sandbox", "swaps", "--json"], 15_000)).toMatchObject({ stdout: "[]\n" });
        // Not one of the verbs it serves: no answer, and the caller spawns ic for it.
        expect(await serve.ask(["sandbox", "remove", "x", "-y"], 15_000)).toBeUndefined();
        expect(logs).toEqual([]);
    } finally {
        serve.stop();
    }
});

test.skipIf(!posix.runs)(posix.title("an ic from before `serve` is asked per call: no answer, said once, and not started again"), async () => {
    const old = join(dir, "old-ic");
    await writeFile(old, "#!/bin/sh\necho \"error: unrecognized subcommand 'serve'\" >&2\nexit 2\n");
    await chmod(old, 0o755);
    let starts = 0;
    const logs: string[] = [];
    const serve = createIcServe({
        file: async () => ({ path: old, signature: "old" }),
        start: async (path, signature) => {
            starts += 1;
            return await startIcServe(path, signature);
        },
        log: (line) => logs.push(line),
    });
    expect(await serve.ask(["sandbox", "swaps", "--json"], 15_000)).toBeUndefined();
    expect(await serve.ask(["sandbox", "swaps", "--json"], 15_000)).toBeUndefined();
    expect(starts).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("does not serve");
});
