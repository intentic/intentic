import { execFile, type ExecFileException } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { requires } from "@intentic/testing/requires";
import { mergeHeavyRules } from "./heavy-rules.cjs";
import { repoRoot } from "../node.mjs";

/* Real node processes started under the hook, the way an agent's command starts them: the heavy one is named by the
   package that publishes it, put in its class before it runs a line of its own, and handed to queue-run (or
   offload-run) with its own argv; anything else runs untouched. queue-run and offload-run are stand-ins that record
   what they were handed and then run it, so the assertions are about the handover, not about locks. */

const run = promisify(execFile);
// Node itself, whatever runs this suite: the hook is a Node preload, and bun ignores NODE_OPTIONS.
const NODE = "node";
const HOOK = join(import.meta.dirname, "heavy-hook.cjs");
const EXEC = join(import.meta.dirname, "heavy-exec.cjs");
const LAUNCH = join(import.meta.dirname, "heavy-launch.cjs");
const SHIMS = join(repoRoot(import.meta.url), "_sandbox/sandbox/bin/heavy-shims");
// The launcher asks the daemon for free memory; these runs judge by the formula, never by this sandbox's daemon.
const NO_DAEMON = { INTENTIC_ROOM_SOCKET: "/nonexistent/room.sock" };

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "heavy-hook-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

// A package publishing one bin, which prints what it was started as: its rank, its niceness, and what covered it.
const reporter = `const { readFileSync } = require("node:fs");
const stat = readFileSync("/proc/self/stat", "utf8");
const nice = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
console.log(JSON.stringify({ argv: process.argv.slice(2), oom: Number(readFileSync("/proc/self/oom_score_adj", "utf8")), nice, held: process.env.INTENTIC_HEAVY_HELD ?? null, slot: process.env.INTENTIC_QUEUE_SLOT ?? null }));
`;

const publish = async (name: string): Promise<string> => {
    const root = join(dir, "node_modules", name);
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name, bin: { [name]: "bin/cli.js" } }));
    await writeFile(join(root, "bin", "cli.js"), reporter);
    return join(root, "bin", "cli.js");
};

// A stand-in for queue-run or offload-run: records its argv, then (queue-run) runs what follows `--` with the slot named,
// or (offload-run, whose command is for another machine) stops there.
const standIn = async (name: string, runs = true, lockSlot = false): Promise<string> => {
    const path = join(dir, name);
    const lock = lockSlot ? `exec 9>>${JSON.stringify(join(dir, "slot.1"))}\nflock 9\n` : "";
    const then = runs ? `${lock}while [ "$1" != "--" ]; do shift; done; shift\nINTENTIC_QUEUE_SLOT=${JSON.stringify(join(dir, "slot.1"))} exec "$@"\n` : "exit 0\n";
    await writeFile(path, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, `${name}.args`))}\n${then}`);
    await chmod(path, 0o755);
    return path;
};

const inherited = Number((await readFile("/proc/self/oom_score_adj", "utf8").catch(() => "0")).trim());
// A class above anything this runner inherited, so a rank that landed reads as itself.
const KLASS = { oomScoreAdj: 999, nice: 19, lowIo: false };

const spec = (over: Record<string, unknown> = {}): string => JSON.stringify({ rules: mergeHeavyRules(), queue: false, klass: KLASS, ...over });

const underHook = async (script: string, args: readonly string[], heavy: string): Promise<Record<string, unknown>> => {
    const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
    const { stdout } = await run(NODE, [script, ...args], { env: { ...env, INTENTIC_HEAVY: heavy, NODE_OPTIONS: `--require ${HOOK}` } });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
};

// Only a rank above what this process inherited can be seen to land, and procfs is Linux's.
const kernel = requires(
    process.platform === "linux" && inherited < KLASS.oomScoreAdj,
    `Linux, with this process ranked below the class under test (it inherited oom_score_adj ${String(inherited)})`,
);

describe.skipIf(!kernel.runs)(kernel.title("a node program under the hook"), () => {
    test("a heavy one is named by its package, classed before it runs, and handed to queue-run with its own argv", async () => {
        const queueRun = await standIn("queue-run");
        const report = await underHook(await publish("vitest"), ["run", "src"], spec({ queue: true, queueRun }));
        expect(report).toEqual({ argv: ["run", "src"], oom: KLASS.oomScoreAdj, nice: 19, held: "vitest", slot: join(dir, "slot.1") });
        const args = (await readFile(join(dir, "queue-run.args"), "utf8")).trim().split("\n");
        // `run src` names what it runs, so the gate prices it as a targeted run.
        expect(args.slice(0, args.indexOf("--"))).toEqual(['--pool', 'heavy', '--limit', '2', '--wait', '900', '--memory-gate', '120', '--max-hold', '1800', '--on-deadline', 'run', '--label', 'vitest', '--size', 'targeted']);
        expect(args.slice(args.indexOf("--") + 1).slice(-3)).toEqual([join(dir, "node_modules/vitest/bin/cli.js"), "run", "src"]);
    });

    test("with the queue off it is still classed, and runs in place", async () => {
        const report = await underHook(await publish("vitest"), ["run"], spec());
        expect(report).toEqual({ argv: ["run"], oom: KLASS.oomScoreAdj, nice: 19, held: "vitest", slot: null });
    });

    test("a program no rule names runs untouched", async () => {
        const report = await underHook(await publish("prettier"), ["--write", "vitest.config.ts"], spec({ queue: true, queueRun: await standIn("queue-run") }));
        expect(report).toMatchObject({ oom: inherited, held: null, slot: null });
    });

    test("a kind the owner sends to a runner goes to offload-run as the command a runner can run, keeping the queue for here", async () => {
        const queueRun = await standIn("queue-run");
        const offloadRun = await standIn("offload-run", false);
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        const heavy = spec({ queue: true, queueRun, offloadRun, offload: { vitest: "runner-omen" } });
        await run(NODE, [await publish("vitest"), "run"], { env: { ...env, INTENTIC_HEAVY: heavy, NODE_OPTIONS: `--require ${HOOK}` } });
        const args = (await readFile(join(dir, "offload-run.args"), "utf8")).trim().split("\n");
        expect(args.slice(0, 6)).toEqual(["--to", "runner-omen", "--label", "vitest", "--here", `${queueRun} --pool heavy --limit 2 --wait 900 --memory-gate 120 --max-hold 1800 --on-deadline run --label vitest -- `]);
        expect(args.slice(args.indexOf("--") + 1)).toEqual(["npx", "--no-install", "vitest", "run"]);
    });

    test("a program already covered by a slot or a heavier parent is not judged again", async () => {
        const script = await publish("vitest");
        const { INTENTIC_QUEUE_SLOT: _slot, ...env } = process.env;
        const { stdout } = await run(NODE, [script], { env: { ...env, INTENTIC_HEAVY: spec(), INTENTIC_HEAVY_HELD: "package-script", NODE_OPTIONS: `--require ${HOOK}` } });
        expect(JSON.parse(stdout.trim())).toMatchObject({ oom: inherited, held: "package-script" });
    });
});

describe.skipIf(!kernel.runs)(kernel.title("the editor's typecheck under a program that already holds a slot"), () => {
    const nested = async (held: Record<string, string>, args: readonly string[]): Promise<{ report: Record<string, unknown>; queued: string[] | undefined }> => {
        const queueRun = await standIn("queue-run");
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        const { stdout } = await run(NODE, [await publish("vue-tsc"), ...args], {
            env: { ...env, ...held, INTENTIC_HEAVY: spec({ queue: true, queueRun }), NODE_OPTIONS: `--require ${HOOK}` },
        });
        const queued = await readFile(join(dir, "queue-run.args"), "utf8").then(
            (text) => text.trim().split("\n"),
            () => undefined,
        );
        // SAFETY: the reporter prints one JSON object as its last line.
        return { report: JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>, queued };
    };

    test("under a heavy slot it still takes the editor's lane, at the editor's price", async () => {
        const { report, queued } = await nested({ INTENTIC_HEAVY_HELD: "package-script" }, ["--noEmit", "-p", "tsconfig.app.json"]);
        expect(report).toMatchObject({ held: "editor-typecheck" });
        expect(queued?.slice(0, queued.indexOf("--"))).toEqual([
            "--pool", "vue-typecheck", "--limit", "1", "--wait", "900", "--memory-gate", "120", "--max-hold", "1800",
            "--on-deadline", "skip", "--label", "editor-typecheck", "--size", "editor-typecheck",
        ]);
    });

    test("under the editor's own lane it runs in place, never waiting on the slot its parent holds", async () => {
        const { report, queued } = await nested({ INTENTIC_HEAVY_HELD: "editor-typecheck" }, ["--noEmit", "-p", "tsconfig.app.json"]);
        expect(report).toMatchObject({ oom: inherited, held: "editor-typecheck" });
        expect(queued).toBeUndefined();
    });

    test("under a slot queue-run took for a script that queued itself, the slot's pool is what is held", async () => {
        const { queued } = await nested({ INTENTIC_QUEUE_SLOT: join(dir, "vue-typecheck", "slot.1") }, ["--noEmit", "-p", "tsconfig.app.json"]);
        expect(queued).toBeUndefined();
    });
});

describe.skipIf(!kernel.runs)(kernel.title("a native program behind its wrapper"), () => {
    test("is judged by its own name and arguments, then becomes the real program found past the wrappers", async () => {
        const bin = join(dir, "real-bin");
        await mkdir(bin);
        await writeFile(join(bin, "bun"), `#!/usr/bin/env bash\nexec node ${JSON.stringify(join(dir, "report.js"))} "$@"\n`);
        await chmod(join(bin, "bun"), 0o755);
        await writeFile(join(dir, "report.js"), reporter);
        const shims = join(dir, "shims");
        await mkdir(shims);
        // A copy, executable: the repository keeps bin scripts without the bit, which the image's COPY sets.
        await copyFile(join(SHIMS, "pnpm"), join(shims, "bun"));
        await chmod(join(shims, "bun"), 0o755);
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        const common = { ...env, PATH: `${shims}:${bin}:${process.env["PATH"] ?? ""}`, INTENTIC_HEAVY: spec(), INTENTIC_HEAVY_EXEC: EXEC };
        // Started by the wrapper's own path: where a caller's PATH lookup starts is the shell's business, not this one's.
        const wrapper = join(shims, "bun");
        const heavy = JSON.parse((await run(wrapper, ["test", "x.test.ts"], { env: common })).stdout.trim()) as Record<string, unknown>;
        expect(heavy).toEqual({ argv: ["test", "x.test.ts"], oom: KLASS.oomScoreAdj, nice: 19, held: "package-script", slot: null });
        // A line no rule names; an install is no longer one, it queues in the `dependency-install` lane.
        const light = JSON.parse((await run(wrapper, ["--version"], { env: common })).stdout.trim()) as Record<string, unknown>;
        expect(light).toMatchObject({ argv: ["--version"], oom: inherited, held: null });
    });
});

describe.skipIf(!kernel.runs)(kernel.title("cargo run behind its wrapper"), () => {
    const cargoRun = async (args: string[], buildExit = 0, heavyOverrides: Record<string, unknown> = {}) => {
        const bin = join(dir, "real-bin");
        const shims = join(dir, "shims");
        await mkdir(bin);
        await mkdir(shims);
        await copyFile(join(SHIMS, "cargo"), join(shims, "cargo"));
        await chmod(join(shims, "cargo"), 0o755);
        await writeFile(join(dir, "cargo.cjs"), `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls"))}, JSON.stringify({ args, held: process.env.INTENTIC_HEAVY_HELD ?? null, slot: process.env.INTENTIC_QUEUE_SLOT ?? null, jobs: process.env.CARGO_BUILD_JOBS ?? null }) + "\\n");
if (args.includes("build")) process.exit(${buildExit});
// The run can acquire the same lock before it starts serving, proving the build slot was released.
if (require("node:child_process").spawnSync("flock", ["-n", ${JSON.stringify(join(dir, "slot.1"))}, "true"]).status !== 0) process.exit(98);
console.log("server-started");
`);
        await writeFile(join(bin, "cargo"), `#!/bin/sh\nexec node ${JSON.stringify(join(dir, "cargo.cjs"))} "$@"\n`);
        await chmod(join(bin, "cargo"), 0o755);
        const queueRun = await standIn("queue-run", true, true);
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        let code = 0;
        try {
            await run(join(shims, "cargo"), args, { env: {
                ...env, ...NO_DAEMON, NODE_OPTIONS: "", PATH: `${shims}:${bin}:${env["PATH"] ?? ""}`, INTENTIC_HEAVY_EXEC: EXEC,
                INTENTIC_HEAVY: spec({ queue: true, queueRun, ...heavyOverrides }),
            } });
        } catch (error) {
            // SAFETY: promisified execFile rejects with its callback's ExecFileException.
            code = Number((error as ExecFileException).code);
        }
        const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        return { calls, code, queueArgs: await readFile(join(dir, "queue-run.args"), "utf8").catch(() => "") };
    };

    test("queues the selected build and starts the original program without a slot or held class", async () => {
        const args = ["+nightly", "run", "--release", "--bin", "web server", "--", "--watch", "a b", "$(literal)"];
        const result = await cargoRun(args);
        expect(result.code).toBe(0);
        // The build's jobs were chosen for it, from the cores and memory here; the run's are cargo's own again.
        expect(result.calls).toEqual([
            { args: ["+nightly", "build", "--release", "--bin", "web server"], held: "cargo", slot: join(dir, "slot.1"), jobs: expect.stringMatching(/^[1-9]\d*$/u) },
            { args, held: null, slot: null, jobs: null },
        ]);
        const queued = result.queueArgs.split("\n");
        expect(queued.slice(0, 17)).toEqual([
            "--pool", "heavy", "--limit", "2", "--wait", "900", "--memory-gate", "120", "--max-hold", "1800",
            "--on-deadline", "run", "--label", "cargo", "--size", "cargo-build", "--",
        ]);
        expect(queued.slice(18, 27)).toEqual([LAUNCH, "--parallel", "cargo", "--slots", "2", "--label", "cargo", "--", join(dir, "real-bin", "cargo")]);
    });

    test("a -j of the agent's own is left as it is", async () => {
        const result = await cargoRun(["run", "-j", "3"]);
        expect(result.calls).toEqual([
            { args: ["build", "-j", "3"], held: "cargo", slot: join(dir, "slot.1"), jobs: null },
            { args: ["run", "-j", "3"], held: null, slot: null, jobs: null },
        ]);
    });

    test("a failed build returns its code and never starts the program", async () => {
        const result = await cargoRun(["run", "--bin", "server"], 42);
        expect(result.code).toBe(42);
        expect(result.calls).toEqual([{ args: ["build", "--bin", "server"], held: "cargo", slot: join(dir, "slot.1"), jobs: expect.any(String) }]);
    });

    test.each([["run", "--future-option"], ["run", "--help"]])("an unsafe translation runs unchanged: %j", async (...args) => {
        const result = await cargoRun(args);
        expect(result.code).toBe(0);
        expect(result.calls).toEqual([{ args, held: null, slot: null, jobs: null }]);
        expect(result.queueArgs).toBe("");
    });

    test("the prebuild stays local when ordinary Cargo builds are offloaded, warming the local run", async () => {
        const result = await cargoRun(["run"], 0, { offload: { cargo: "runner" } });
        expect(result.calls).toEqual([
            { args: ["build"], held: "cargo", slot: join(dir, "slot.1"), jobs: expect.any(String) },
            { args: ["run"], held: null, slot: null, jobs: null },
        ]);
        expect(result.queueArgs).toContain("cargo-build");
    });
});

// (2026-11-19, the shinobi-society audit) A project's own heavy script, declared in its `.intentic/heavy.json`, takes the
// queue the way a build does, whatever starts it: an interpreter's wrapper by the script's path, node's hook by the file
// it runs.
describe.skipIf(!kernel.runs)(kernel.title("a project's declared script"), () => {
    const capture = { id: "capture", scripts: ["scripts/capture.py"], memory: "6G", exclusive: true };

    const interpreter = async (args: readonly string[], words: string): Promise<{ report: Record<string, unknown>; queued: string[] | undefined; stderr: string }> => {
        const bin = join(dir, "real-bin");
        const shims = join(dir, "interpreters");
        await mkdir(bin, { recursive: true });
        await mkdir(shims, { recursive: true });
        await writeFile(join(dir, "report.js"), reporter);
        await writeFile(join(bin, "python3"), `#!/usr/bin/env bash\nexec node ${JSON.stringify(join(dir, "report.js"))} "$@"\n`);
        await chmod(join(bin, "python3"), 0o755);
        await copyFile(join(SHIMS, "interpreters", "python3"), join(shims, "python3"));
        await chmod(join(shims, "python3"), 0o755);
        const queueRun = await standIn("queue-run");
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        const { stdout, stderr } = await run(join(shims, "python3"), args, {
            cwd: dir,
            env: {
                ...env,
                NODE_OPTIONS: "",
                PATH: `${shims}:${bin}:${env["PATH"] ?? ""}`,
                INTENTIC_HEAVY_EXEC: EXEC,
                INTENTIC_HEAVY_WORDS: words,
                INTENTIC_HEAVY: JSON.stringify({ rules: mergeHeavyRules({}, [capture]), queue: true, queueRun, klass: KLASS }),
            },
        });
        const queued = await readFile(join(dir, "queue-run.args"), "utf8").then(
            (text) => text.trim().split("\n"),
            () => undefined,
        );
        // SAFETY: the reporter prints one JSON object as its last line.
        return { report: JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>, queued, stderr };
    };

    test("python3 running it is queued in its class's own pool, alone, at its declared price, and says so", async () => {
        const { report, queued, stderr } = await interpreter(["./scripts/capture.py", "--frames", "600"], "capture.py");
        expect(report).toMatchObject({ argv: ["./scripts/capture.py", "--frames", "600"], held: "capture" });
        expect(queued?.slice(0, queued.indexOf("--"))).toEqual([
            "--pool", "capture", "--limit", "1", "--wait", "900", "--memory-gate", "120", "--max-hold", "1800",
            "--on-deadline", "run", "--label", "capture", "--exclusive", "--size", "6144m",
        ]);
        expect(queued?.slice(queued.indexOf("--") + 1)).toEqual([join(dir, "real-bin", "python3"), "./scripts/capture.py", "--frames", "600"]);
        expect(stderr).toContain("[heavy] capture: a heavy command this project declares (.intentic/heavy.json, scripts/capture.py)");
    });

    test("the interpreter is the real one at once for anything else: an inline script, or a file no class names", async () => {
        const inline = await interpreter(["-c", "import scripts.capture"], "capture.py");
        expect(inline).toMatchObject({ report: { held: null }, queued: undefined });
        const other = await interpreter(["tools/capture.py"], "capture.py");
        expect(other).toMatchObject({ report: { held: null }, queued: undefined });
    });

    test("a node script is matched by the file node runs", async () => {
        const queueRun = await standIn("queue-run");
        await mkdir(join(dir, "scripts"));
        await writeFile(join(dir, "scripts", "render.mjs"), reporter.replace(`const { readFileSync } = require("node:fs");`, `import { readFileSync } from "node:fs";`));
        const rules = mergeHeavyRules({}, [{ id: "render", scripts: ["scripts/render.mjs"] }]);
        const report = await underHook(join(dir, "scripts", "render.mjs"), ["--all"], spec({ rules, queue: true, queueRun }));
        expect(report).toMatchObject({ argv: ["--all"], held: "render" });
    });
});

describe.skipIf(!kernel.runs)(kernel.title("a kind the owner sends to a runner"), () => {
    test("INTENTIC_OFFLOAD=0 keeps one command here, behind this sandbox's queue", async () => {
        const queueRun = await standIn("queue-run");
        const offloadRun = await standIn("offload-run", false);
        const { INTENTIC_QUEUE_SLOT: _slot, INTENTIC_HEAVY_HELD: _held, ...env } = process.env;
        const heavy = spec({ queue: true, queueRun, offloadRun, offload: { vitest: "runner-omen" } });
        await run(NODE, [await publish("vitest"), "run"], { env: { ...env, INTENTIC_OFFLOAD: "0", INTENTIC_HEAVY: heavy, NODE_OPTIONS: `--require ${HOOK}` } });
        await expect(readFile(join(dir, "offload-run.args"), "utf8")).rejects.toThrow();
        expect(await readFile(join(dir, "queue-run.args"), "utf8")).toContain("--label\nvitest\n");
    });
});
