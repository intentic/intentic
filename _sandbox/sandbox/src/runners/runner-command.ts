import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { RunnerCommand, RunnerCommandFrame } from "@intentic/sandbox-contract";
import { endSession } from "../seams/session-processes.js";

/* ONE OFFLOADED LINE, RUN ON THIS RUNNER FOR ITS PARENT (settings `offload`, the parent's offload/ service).

   The code arrives as a snapshot commit of the parent's tree, uncommitted and untracked work included, which this runner
   fetches through the parent's git door into a tree of its own under /history/offload/<repo>. That tree is kept between
   runs and never cleaned of what git ignores, so node_modules, emitted declarations and build caches stay warm: only a
   changed lockfile or manifest reinstalls, and only a changed tree re-runs the repository's own `offload:prepare`
   script (its build outputs, the part of a tree git does not carry). It lives outside /work, so this runner's own
   daemon never reconciles it or checks it after an install.

   The line runs under this runner's own heavy queue, in a session of its own, so a cancel or a timeout ends everything
   it started. Its output streams back as it comes; its end carries the exit, every file it changed as a binary patch
   against the snapshot (formatters, a regenerated lock, a fixer's edit), and the files it wrote to the variables the
   parent asked for back. */

const execFileAsync = promisify(execFile);

// Past this the change is not an edit a command made; it is a build output nobody ignored, and it stays here.
const PATCH_CEILING_BYTES = 32 * 1024 * 1024;
const EXPORT_CEILING_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
// The files whose change means the install is stale. Found anywhere in the tree for manifests, at its root for locks.
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"] as const;
const INSTALLS: Readonly<Record<(typeof LOCKFILES)[number], string>> = {
    "pnpm-lock.yaml": "pnpm install --frozen-lockfile --prefer-offline",
    "package-lock.json": "npm ci --prefer-offline --no-audit --no-fund",
    "yarn.lock": "yarn install --frozen-lockfile",
    "bun.lock": "bun install --frozen-lockfile",
    "bun.lockb": "bun install --frozen-lockfile",
};
const RUNNERS: Readonly<Record<(typeof LOCKFILES)[number], string>> = {
    "pnpm-lock.yaml": "pnpm",
    "package-lock.json": "npm",
    "yarn.lock": "yarn",
    "bun.lock": "bun",
    "bun.lockb": "bun",
};
// Stamps in the offload tree's own git dir: which install and which prepared tree it already has.
const INSTALLED_STAMP = "intentic-offload-installed";
const PREPARED_STAMP = "intentic-offload-prepared";
const PREPARE_SCRIPT = "offload:prepare";

export interface RunnerCommandDeps {
    // Where offload trees live, one per repo.
    readonly offloadRoot: string;
    // The parent's git door for a repo, and the environment that authenticates a fetch through it.
    readonly gitUrl: (repo: string) => string;
    readonly gitEnv: NodeJS.ProcessEnv;
    // Runs a line under this runner's heavy table (agent-terminals.ts queueWhole): its heavy programs queue here as they start.
    readonly queue: (line: string) => Promise<string>;
}

const gitIn = async (deps: RunnerCommandDeps, cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> => {
    const { stdout } = await execFileAsync("git", [...args], { cwd, env: { ...deps.gitEnv, ...env }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    return stdout;
};

export const offloadTreeOf = (offloadRoot: string, repo: string): string => join(offloadRoot, encodeURIComponent(repo));

// A frame channel: producers push, the generator drains, `end` closes it once the last frame is in.
const channel = () => {
    const frames: RunnerCommandFrame[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const nudge = (): void => {
        const pending = wake;
        wake = undefined;
        pending?.();
    };
    return {
        push: (frame: RunnerCommandFrame): void => {
            frames.push(frame);
            nudge();
        },
        end: (): void => {
            closed = true;
            nudge();
        },
        async *drain(): AsyncGenerator<RunnerCommandFrame> {
            for (;;) {
                const next = frames.shift();
                if (next !== undefined) {
                    yield next;
                    continue;
                }
                if (closed) {
                    return;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
};

// Ends a line started in a session of its own: the leader too, which endSession spares (it is a job pane's runner
// there), since `bash -c` execs its last command in place and the leader is often the very process to stop.
const endLine = async (pid: number): Promise<void> => {
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // allow(silent-catch): a leader already gone is what the signal was for
    }
    // allow(silent-catch): a leader already gone or session ended needs no further cleanup
    await endSession(pid).catch(() => false);
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // allow(silent-catch): likewise; it usually left on the TERM
    }
};

// Runs one setup line in the tree (an install, the prepare script), its output narrated as status; throws on failure.
const setupLine = (cwd: string, line: string, say: (text: string) => void, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", line], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const tail: string[] = [];
        const read = (chunk: Buffer): void => {
            for (const text of chunk.toString("utf8").split("\n")) {
                if (text.trim() !== "") {
                    tail.push(text);
                    tail.splice(0, Math.max(0, tail.length - 20));
                    say(text);
                }
            }
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        const stop = (): void => void (child.pid === undefined ? undefined : endLine(child.pid));
        signal.addEventListener("abort", stop, { once: true });
        child.on("error", reject);
        child.on("close", (code) => {
            signal.removeEventListener("abort", stop);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`\`${line}\` exited ${String(code)}:\n${tail.join("\n")}`));
            }
        });
    });

// The lockfile a tree installs from, at its root, first found.
const lockfileOf = (tree: string): (typeof LOCKFILES)[number] | undefined => LOCKFILES.find((name) => existsSync(join(tree, name)));

const readStamp = async (path: string): Promise<string> => ((await readFile(path, "utf8").catch(undefinedIfMissing)) ?? "").trim();

// Brings the offload tree to the snapshot: fetched through the git door, checked out over whatever the last run left,
// untracked files cleaned but ignored ones kept; then installed and prepared when what they depend on moved.
const prepareTree = async (deps: RunnerCommandDeps, input: RunnerCommand, say: (text: string) => void, signal: AbortSignal): Promise<string> => {
    const tree = offloadTreeOf(deps.offloadRoot, input.repo);
    await mkdir(tree, { recursive: true });
    if (!existsSync(join(tree, ".git"))) {
        say(`${input.repo}: first offloaded run here, fetching the whole repository once`);
        await gitIn(deps, tree, ["init", "--quiet"]);
    }
    say(`${input.repo}: fetching the snapshot…`);
    await gitIn(deps, tree, ["fetch", "--no-tags", "--quiet", deps.gitUrl(input.repo), `+${input.ref}:refs/offload/snapshot`]);
    await gitIn(deps, tree, ["checkout", "--force", "--detach", "--quiet", "refs/offload/snapshot"]);
    await gitIn(deps, tree, ["clean", "-fd", "--quiet"]);
    const gitDir = (await gitIn(deps, tree, ["rev-parse", "--absolute-git-dir"])).trim();

    const lockfile = lockfileOf(tree);
    if (lockfile !== undefined) {
        // What an install depends on: the lockfile and every manifest, by their blob ids in the snapshot.
        const listing = await gitIn(deps, tree, ["ls-tree", "-r", "HEAD"]);
        const inputs = listing
            .split("\n")
            .filter((line) => line.endsWith(`\t${lockfile}`) || /(?:^|\/)package\.json$/u.test(line.split("\t")[1] ?? ""))
            .join("\n");
        const installed = await readStamp(join(gitDir, INSTALLED_STAMP));
        if (installed !== inputs || !existsSync(join(tree, "node_modules"))) {
            say(`${input.repo}: installing dependencies (${INSTALLS[lockfile]})…`);
            await setupLine(tree, INSTALLS[lockfile], say, signal);
            await writeFile(join(gitDir, INSTALLED_STAMP), inputs);
        }
        const scripts = (JSON.parse(await readFile(join(tree, "package.json"), "utf8").catch(() => "{}")) as { scripts?: Record<string, string> }).scripts;
        const treeId = (await gitIn(deps, tree, ["rev-parse", "HEAD^{tree}"])).trim();
        if (scripts?.[PREPARE_SCRIPT] !== undefined && (await readStamp(join(gitDir, PREPARED_STAMP))) !== treeId) {
            say(`${input.repo}: preparing what git does not carry (${RUNNERS[lockfile]} run ${PREPARE_SCRIPT})…`);
            await setupLine(tree, `${RUNNERS[lockfile]} run ${PREPARE_SCRIPT}`, say, signal);
            await writeFile(join(gitDir, PREPARED_STAMP), treeId);
        }
    }
    return tree;
};

// Every file the line changed against the snapshot, tracked or new, as a binary patch; ignored files never. Built in a
// scratch index so the tree's own index is untouched.
const changesOf = async (deps: RunnerCommandDeps, tree: string, scratch: string): Promise<string> => {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await gitIn(deps, tree, ["read-tree", "HEAD"], env);
    await gitIn(deps, tree, ["add", "-A"], env);
    return await gitIn(deps, tree, ["diff", "--cached", "--binary", "HEAD"], env);
};

export interface RunningCommands {
    readonly run: (input: RunnerCommand) => AsyncGenerator<RunnerCommandFrame>;
    readonly cancel: (runId: string) => void;
}

export const createRunnerCommands = (deps: RunnerCommandDeps): RunningCommands => {
    const running = new Map<string, AbortController>();

    const run = (input: RunnerCommand): AsyncGenerator<RunnerCommandFrame> => {
        const out = channel();
        const controller = new AbortController();
        running.set(input.runId, controller);
        const say = (text: string): void => out.push({ kind: "status", text });
        const timer = setTimeout(() => controller.abort(new Error("timed out")), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        timer.unref();

        void (async () => {
            const scratch = await mkdtemp(join(tmpdir(), "offload-"));
            try {
                let tree: string;
                try {
                    tree = await prepareTree(deps, input, say, controller.signal);
                } catch (error) {
                    out.push({ kind: "exit", code: 1, failure: error instanceof Error ? error.message : String(error), ran: false, files: {} });
                    return;
                }
                const exported = Object.fromEntries(input.exports.map((name) => [name, join(scratch, `export-${name}`)]));
                const line = await deps.queue(input.command);
                say(`running \`${input.label}\` here`);
                const child = spawn("bash", ["-c", line], {
                    cwd: join(tree, input.cwd),
                    // A session of its own, so a cancel ends the line and every group it started (turbo's tasks, bun's
                    // workers), not just the shell.
                    detached: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    env: { ...process.env, ...input.env, ...exported },
                });
                const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
                for (const stream of ["stdout", "stderr"] as const) {
                    child[stream].on("data", (chunk: Buffer) => {
                        const text = decoders[stream].write(chunk);
                        if (text !== "") {
                            out.push({ kind: "output", stream, text });
                        }
                    });
                }
                const stop = (): void => void (child.pid === undefined ? undefined : endLine(child.pid));
                controller.signal.addEventListener("abort", stop, { once: true });
                const ended = await new Promise<{ code: number; signal?: string }>((resolve) => {
                    child.on("error", () => resolve({ code: 127 }));
                    child.on("close", (code, signal) => resolve(signal === null ? { code: code ?? 1 } : { code: 128 + 15, signal }));
                });
                controller.signal.removeEventListener("abort", stop);
                // The line is back, so nothing it started should outlive it here either.
                if (child.pid !== undefined) {
                    // allow(silent-catch): a process already exited needs no further session cleanup
                    await endSession(child.pid).catch(() => false);
                }
                const patch = await changesOf(deps, tree, scratch);
                const files: Record<string, string> = {};
                for (const [name, path] of Object.entries(exported)) {
                    const bytes = await readFile(path).catch(undefinedIfMissing);
                    if (bytes !== undefined && bytes.length <= EXPORT_CEILING_BYTES) {
                        files[name] = bytes.toString("base64");
                    }
                }
                const tooBig = Buffer.byteLength(patch) > PATCH_CEILING_BYTES;
                if (tooBig) {
                    say(`the line changed ${String(Math.round(Buffer.byteLength(patch) / 1024 / 1024))} MB of tracked files; too much to be an edit, so it stays on this runner`);
                }
                out.push({
                    kind: "exit",
                    ran: true,
                    code: ended.code,
                    ...(ended.signal === undefined ? {} : { signal: ended.signal }),
                    ...(controller.signal.aborted ? { failure: `stopped: ${String((controller.signal.reason as Error | undefined)?.message ?? "cancelled")}` } : {}),
                    ...(patch !== "" && !tooBig ? { patchBase64: Buffer.from(patch).toString("base64") } : {}),
                    files,
                });
            } catch (error) {
                out.push({ kind: "exit", code: 1, failure: error instanceof Error ? error.message : String(error), ran: true, files: {} });
            } finally {
                clearTimeout(timer);
                running.delete(input.runId);
                await rm(scratch, { recursive: true, force: true });
                out.end();
            }
        })();
        return out.drain();
    };

    return {
        run,
        cancel: (runId) => running.get(runId)?.abort(new Error("cancelled")),
    };
};
