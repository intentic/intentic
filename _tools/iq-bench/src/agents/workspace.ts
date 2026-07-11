import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "@intentic/iq-engine";
import type { BenchConfig } from "../configs.js";
import { cacheDir, monorepoRoot, packageRoot, repoRoot } from "../repos.js";
import type { Task } from "../schema.js";

// Both arms get an instruction file so *presence* is controlled and only content differs.
const BASELINE_NOTES = "# Workspace notes\n\nAnswer using standard tools like grep/rg/find and reading files.\n";

export type Arm =
    { readonly name: string; readonly kind: "baseline" } | { readonly name: string; readonly kind: "iq"; readonly config?: BenchConfig };

const skillNotes = (): string => {
    const raw = readFileSync(join(monorepoRoot, "_apps/sandbox/skills/iq/SKILL.md"), "utf8");
    const body = raw.replace(/^---[\s\S]*?---\n/, "");
    return `# Workspace notes\n\nThis workspace has \`iq\` on PATH — ALWAYS prefer it over grep/find/Glob chains.\n${body}`;
};

const shimDir = (): string => {
    const cliPath = join(monorepoRoot, "_apps/iq/dist/cli.js");
    if (!existsSync(cliPath)) {
        throw new Error("iq-bench: _apps/iq is not built — run `pnpm build` at the repo root first");
    }
    const dir = join(cacheDir, "bin");
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, "iq");
    writeFileSync(shim, `#!/bin/sh\nexec node ${cliPath} "$@"\n`);
    chmodSync(shim, 0o755);
    return dir;
};

export interface PreparedWorkspace {
    readonly dir: string;
    readonly env: NodeJS.ProcessEnv;
    readonly indexBuildMs?: number;
    cleanup(): void;
}

export const prepareWorkspace = async (task: Task, runId: string, arm: Arm, models: string | undefined): Promise<PreparedWorkspace> => {
    const root = repoRoot(task.repo);
    const dir = join(cacheDir, "worktrees", runId);
    mkdirSync(join(cacheDir, "worktrees"), { recursive: true });
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", dir, "HEAD"]);
    const cleanup = (): void => {
        execFileSync("git", ["-C", root, "worktree", "remove", "--force", dir]);
    };
    // The bench must not be discoverable inside its own tasks: committed task/dataset files contain the prompts
    // verbatim AND the grader anchors, and they ranked #1 in every intentic `ask` before this was stripped.
    rmSync(join(dir, "_tools/iq-bench"), { recursive: true, force: true });
    if (task.setup !== undefined) {
        execFileSync("git", ["-C", dir, "apply", join(packageRoot, "tasks", task.setup.patch)]);
        // Amend the patch into HEAD so `git diff`/`git show` don't hand the agent the introduced bug.
        execFileSync("git", ["-C", dir, "add", "-A"]);
        execFileSync("git", ["-C", dir, "-c", "user.name=iq-bench", "-c", "user.email=iq-bench@local", "commit", "-q", "--amend", "--no-edit"]);
    }
    // Tests in fix tasks need the clone's installed dependencies; worktrees don't carry untracked dirs.
    const nodeModules = join(root, "node_modules");
    if (existsSync(nodeModules) && !existsSync(join(dir, "node_modules"))) {
        symlinkSync(nodeModules, join(dir, "node_modules"));
    }
    const notes = arm.kind === "baseline" ? BASELINE_NOTES : skillNotes();
    writeFileSync(join(dir, "CLAUDE.md"), notes);
    writeFileSync(join(dir, "AGENTS.md"), notes);
    if (arm.kind === "baseline") {
        return { dir, env: { ...process.env }, cleanup };
    }
    const spec = arm.config?.spec;
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${shimDir()}:${process.env["PATH"] ?? ""}`,
        WORKSPACE_ROOT: dir,
        ...(models !== undefined ? { IQ_MODEL_DIR: models } : {}),
        ...(spec !== undefined ? { IQ_FEATURES: spec } : {}),
    };
    // Pre-built at the CLI's default location; build time is recorded separately, never charged to the agent.
    const start = Date.now();
    await createEngine({ root: dir, ...(models !== undefined ? { modelDir: models } : {}) }).indexRebuild();
    return { dir, env, indexBuildMs: Date.now() - start, cleanup };
};
