import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offloadRef, type RunnerCommand, type RunnerCommandFrame } from "@intentic/sandbox-contract";
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

const commands = (root: string) => {
    const offloadRoot = mkdtempSync(join(tmpdir(), "offload-runner-"));
    return {
        offloadRoot,
        runner: createRunnerCommands({ offloadRoot, gitUrl: () => root, gitEnv: process.env, queue: async (line) => line }),
    };
};

const input = (ref: string, command: string, extra: Partial<RunnerCommand> = {}): RunnerCommand => ({
    runId: "run-00000001",
    repo: "app",
    ref,
    cwd: "",
    command,
    env: {},
    exports: [],
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
        const frames = runner.run(input(ref, "(sleep 60 &); sleep 60"));
        const collected: RunnerCommandFrame[] = [];
        for await (const frame of frames) {
            collected.push(frame);
            if (frame.kind === "status" && frame.text.startsWith("running")) {
                setTimeout(() => runner.cancel("run-00000001"), 300);
            }
        }
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(exitOf(collected).failure).toStartWith("stopped");
        expect(execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((line) => line === "sleep 60")).toEqual([]);
    });

    test("says why when the snapshot cannot be fetched, and runs nothing", async () => {
        const { root } = parent();
        const { runner } = commands(root);
        const exit = exitOf(await all(runner.run(input(offloadRef("run-missing0"), "echo ran"))));
        expect(exit.code).toBe(1);
        expect(exit.failure).toContain("run-missing0");
        expect(exit.ran).toBe(false);
    });
});
