import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offloadRef, type RunnerCommand, type RunnerCommandFrame } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { gunzipSync } from "node:zlib";
import { createTreePool, treeSlotPath } from "./offload/offload-trees.js";
import { createRunnerCommands, offloadTreeOf } from "./runner-command.js";

// One offloaded line on a runner, against real git: the parent's snapshot fetched into the runner's own tree, the line's
// output streamed back, and its end carrying what it changed and what it exported. The git door is a local path here,
// which a runner's fetch reads the same way as the parent's smart-HTTP door.

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A parent repo with one committed file, an uncommitted edit and an untracked file, snapshotted under an offload ref the
// way offload-run does it.
const parent = (): { readonly root: string; readonly ref: string } => {
    const root = mkdtempSync(join(tmpdir(), "offload-parent-"));
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "committed\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "one");
    writeFileSync(join(root, "a.txt"), "edited, not committed\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    writeFileSync(join(root, "ignored.txt"), "never travels\n");
    const index = join(mkdtempSync(join(tmpdir(), "offload-index-")), "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync("git", ["read-tree", "HEAD"], { cwd: root, env });
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
    const commit = git(root, "commit-tree", tree, "-p", "HEAD", "-m", "snapshot");
    const ref = offloadRef("run-00000001");
    git(root, "update-ref", ref, commit);
    return { root, ref };
};

const commands = (root: string, trees = 1) => {
    const offloadRoot = mkdtempSync(join(tmpdir(), "offload-runner-"));
    return {
        offloadRoot,
        runner: createRunnerCommands({ offloadRoot, gitUrl: () => root, gitEnv: process.env, queue: async (line) => line, trees: createTreePool(offloadRoot, trees) }),
    };
};

// The output files the frames carried, put back together the way offload-run does it: each piece one gzip member.
const delivered = (frames: readonly RunnerCommandFrame[]): Map<string, { readonly bytes: Buffer; readonly mode?: number; readonly sha256?: string; readonly same?: boolean }> => {
    const files = new Map<string, { bytes: Buffer; mode?: number; sha256?: string; same?: boolean }>();
    for (const frame of frames) {
        if (frame.kind !== "file") {
            continue;
        }
        const file = files.get(frame.path) ?? { bytes: Buffer.alloc(0) };
        if (frame.data !== undefined) {
            file.bytes = Buffer.concat([file.bytes, gunzipSync(Buffer.from(frame.data, "base64"))]);
        }
        if (frame.end !== undefined) {
            file.mode = frame.end.mode;
            file.sha256 = frame.end.sha256;
        }
        if (frame.same === true) {
            file.same = true;
        }
        files.set(frame.path, file);
    }
    return files;
};

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const input = (ref: string, command: string, extra: Partial<RunnerCommand> = {}): RunnerCommand => ({
    runId: "run-00000001",
    repo: "app",
    ref,
    cwd: "",
    command,
    env: {},
    exports: [],
    outputs: [],
    have: {},
    label: "bun-test",
    ...extra,
});

const all = async (frames: AsyncGenerator<RunnerCommandFrame>): Promise<RunnerCommandFrame[]> => {
    const seen: RunnerCommandFrame[] = [];
    for await (const frame of frames) {
        seen.push(frame);
    }
    return seen;
};

const exitOf = (frames: readonly RunnerCommandFrame[]) => {
    const exit = frames.at(-1);
    if (exit?.kind !== "exit") {
        throw new Error("the last frame is not the exit");
    }
    return exit;
};

describe("an offloaded line", () => {
    test("runs on the parent's tree as it stood, uncommitted and untracked work included and ignored files left behind", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        const frames = await all(runner.run(input(ref, "cat a.txt new.txt; test -e ignored.txt && echo leaked || echo clean")));
        const stdout = frames.flatMap((frame) => (frame.kind === "output" && frame.stream === "stdout" ? [frame.text] : [])).join("");
        expect(stdout).toBe("edited, not committed\nuntracked\nclean\n");
        expect(exitOf(frames)).toMatchObject({ kind: "exit", code: 0, files: {} });
        expect(exitOf(frames).patchBase64).toBeUndefined();
    });

    test("hands back its exit, every file it changed as a patch, and the files it wrote to the variables asked for", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        const frames = await all(
            runner.run(input(ref, 'echo fixed > a.txt; echo made > made.txt; echo \'{"failures":[]}\' > "$REPORT"; echo oops >&2; exit 3', { exports: ["REPORT"] })),
        );
        const exit = exitOf(frames);
        expect(exit.code).toBe(3);
        expect(frames.some((frame) => frame.kind === "output" && frame.stream === "stderr" && frame.text === "oops\n")).toBe(true);
        expect(Buffer.from(exit.files["REPORT"] ?? "", "base64").toString()).toBe('{"failures":[]}\n');
        // The patch applies on the parent's own tree and brings both edits back.
        const patch = join(mkdtempSync(join(tmpdir(), "offload-patch-")), "p.diff");
        writeFileSync(patch, Buffer.from(exit.patchBase64 ?? "", "base64"));
        git(root, "apply", patch);
        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("fixed\n");
        expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("made\n");
    });

    test("keeps what git ignores in its tree between runs, and cleans what a run left untracked", async () => {
        const { root, ref } = parent();
        const { runner, offloadRoot } = commands(root);
        await all(runner.run(input(ref, "echo warm > cache.txt; echo stray > stray.txt; echo cache.txt >> .git/info/exclude")));
        const frames = await all(runner.run(input(ref, "cat cache.txt; test -e stray.txt && echo stray-kept || echo stray-cleaned")));
        const stdout = frames.flatMap((frame) => (frame.kind === "output" ? [frame.text] : [])).join("");
        expect(stdout).toBe("warm\nstray-cleaned\n");
        expect(offloadTreeOf(offloadRoot, "app")).toStartWith(offloadRoot);
    });

    test("stops, with everything it started, when cancelled", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        const started = Date.now();
        // A duration no other suite sleeps for: `ps` sees the whole machine, and the suites running beside this one in
        // the same worker start (and leave dying) `sleep 60`s of their own.
        const sleeper = `sleep ${String(7_000 + Math.floor(Math.random() * 1_000))}`;
        const frames = runner.run(input(ref, `(${sleeper} &); ${sleeper}`));
        const collected: RunnerCommandFrame[] = [];
        for await (const frame of frames) {
            collected.push(frame);
            if (frame.kind === "status" && frame.text.startsWith("running")) {
                setTimeout(() => runner.cancel("run-00000001"), 300);
            }
        }
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(exitOf(collected).failure).toStartWith("stopped");
        expect(execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((line) => line === sleeper)).toEqual([]);
    });

    test("says why when the snapshot cannot be fetched, and runs nothing", async () => {
        const { root } = parent();
        const { runner } = commands(root);
        const exit = exitOf(await all(runner.run(input(offloadRef("run-missing0"), "echo ran"))));
        expect(exit.code).toBe(1);
        expect(exit.failure).toContain("run-missing0");
        expect(exit.ran).toBe(false);
    });

    test("hands back the outputs it was asked for whole, ignored ones and a directory's files included, before its exit", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        const size = 3 * 1024 * 1024 + 17;
        const frames = await all(
            runner.run(
                input(ref, `mkdir -p frames && head -c ${String(size)} /dev/zero | tr '\\0' x > ignored.txt && chmod 755 ignored.txt && echo one > frames/a.png && echo two > frames/b.png`, {
                    outputs: ["ignored.txt", "frames", "never-made.bin"],
                }),
            ),
        );
        const files = delivered(frames);
        const big = "x".repeat(size);
        expect(files.get("ignored.txt")?.bytes.length).toBe(size);
        expect(sha256(files.get("ignored.txt")?.bytes ?? "")).toBe(sha256(big));
        expect(files.get("ignored.txt")?.mode).toBe(0o755);
        expect(files.get("ignored.txt")?.sha256).toBe(sha256(big));
        expect(files.get("frames/a.png")?.bytes.toString()).toBe("one\n");
        expect(files.get("frames/b.png")?.bytes.toString()).toBe("two\n");
        // More than one piece for a file past a MiB, and every file frame before the exit.
        expect(frames.filter((frame) => frame.kind === "file" && frame.path === "ignored.txt" && frame.data !== undefined).length).toBeGreaterThan(1);
        expect(frames.findLastIndex((frame) => frame.kind === "file")).toBeLessThan(frames.length - 1);
        expect(exitOf(frames)).toMatchObject({ code: 0, missing: ["never-made.bin"] });
        expect(exitOf(frames).durationMs).toBeGreaterThanOrEqual(0);
    });

    test("says an output the caller already holds byte for byte instead of sending it", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        const frames = await all(runner.run(input(ref, "echo same > out.bin; echo changed > other.bin", { outputs: ["out.bin", "other.bin"], have: { "out.bin": sha256("same\n"), "other.bin": sha256("stale\n") } })));
        const files = delivered(frames);
        expect(files.get("out.bin")).toMatchObject({ same: true, bytes: Buffer.alloc(0) });
        expect(files.get("other.bin")?.bytes.toString()).toBe("changed\n");
    });

    test("measures the most memory everything the line started held at once", async () => {
        const { root, ref } = parent();
        const { runner } = commands(root);
        // A child shell holding a 64 MiB string for longer than one sample (`node` under bun test is bun, which allocates
        // lazily, so a shell keeps the figure honest).
        const exit = exitOf(await all(runner.run(input(ref, `bash -c 'x=$(head -c 67108864 /dev/zero | tr "\\\\0" x); sleep 2; echo \${#x}'`))));
        expect(exit.peakMemoryMb).toBeGreaterThanOrEqual(60);
    });

    test("runs two lines of one repo at once in trees of their own, and the second waits when the pool is full", async () => {
        const { root, ref } = parent();
        const two = commands(root, 2);
        const [first, second] = await Promise.all([
            all(two.runner.run(input(ref, "pwd; sleep 1", { runId: "run-0000000a" }))),
            all(two.runner.run(input(ref, "pwd; sleep 1", { runId: "run-0000000b" }))),
        ]);
        const where = (frames: readonly RunnerCommandFrame[]): string => frames.flatMap((frame) => (frame.kind === "output" ? [frame.text.trim()] : [])).join("");
        expect(new Set([where(first), where(second)])).toEqual(new Set([treeSlotPath(two.offloadRoot, "app", 0), treeSlotPath(two.offloadRoot, "app", 1)]));

        const one = commands(root, 1);
        const [a, b] = await Promise.all([
            all(one.runner.run(input(ref, "pwd", { runId: "run-0000000c" }))),
            all(one.runner.run(input(ref, "pwd", { runId: "run-0000000d" }))),
        ]);
        expect([where(a), where(b)]).toEqual([treeSlotPath(one.offloadRoot, "app", 0), treeSlotPath(one.offloadRoot, "app", 0)]);
        expect([...a, ...b].some((frame) => frame.kind === "status" && frame.text.includes("waiting for one to come free"))).toBe(true);
    });
});
