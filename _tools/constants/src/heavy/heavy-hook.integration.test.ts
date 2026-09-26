import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
const SHIMS = join(repoRoot(import.meta.url), "_sandbox/sandbox/bin/heavy-shims");

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
const standIn = async (name: string, runs = true): Promise<string> => {
    const path = join(dir, name);
    const then = runs ? `while [ "$1" != "--" ]; do shift; done; shift\nINTENTIC_QUEUE_SLOT=${JSON.stringify(join(dir, "slot.1"))} exec "$@"\n` : "exit 0\n";
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

const describeLinux = process.platform === "linux" && inherited < KLASS.oomScoreAdj ? describe : describe.skip;

describeLinux("a node program under the hook", () => {
    test("a heavy one is named by its package, classed before it runs, and handed to queue-run with its own argv", async () => {
        const queueRun = await standIn("queue-run");
        const report = await underHook(await publish("vitest"), ["run", "src"], spec({ queue: true, queueRun }));
        expect(report).toEqual({ argv: ["run", "src"], oom: KLASS.oomScoreAdj, nice: 19, held: "vitest", slot: join(dir, "slot.1") });
        const args = (await readFile(join(dir, "queue-run.args"), "utf8")).trim().split("\n");
        expect(args.slice(0, args.indexOf("--"))).toEqual(["--pool", "heavy", "--limit", "2", "--wait", "900", "--memory-gate", "120", "--max-hold", "1800", "--on-deadline", "run", "--label", "vitest"]);
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

describeLinux("a native program behind its wrapper", () => {
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
        const light = JSON.parse((await run(wrapper, ["install"], { env: common })).stdout.trim()) as Record<string, unknown>;
        expect(light).toMatchObject({ argv: ["install"], oom: inherited, held: null });
    });
});
