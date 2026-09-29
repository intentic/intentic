import { relative, isAbsolute, join } from "node:path";
import { isCandidatePath } from "@intentic/fileq/formats";
import type { Env } from "./hook-io.js";
import { claimIfDue, pluginRoot, projectSlug, startDetached } from "./runtime.js";

// Document shadows: fileq's markdown rendering of every document in the project, kept fresh in the background so a read
// finds one ready. The sandbox's daemon does this off its file watcher; a plugin has no watcher, so it sweeps when a
// session opens and again every ten minutes a prompt arrives, and derives a document the moment Claude writes one.
// fileq itself decides what is stale (content hash plus deriver version), so a sweep over a converged tree is a walk.

const SWEEP_EVERY_MS = 10 * 60_000;

// The bundled fileq the plugin ships, run with the node that runs the hook.
const fileq = (env: Env): string => join(pluginRoot(env), "dist", "fileq.mjs");

const logOf = (data: string, project: string, what: string): string => join(data, "shadows", `${projectSlug(project)}.${what}.log`);

// fileq keys its shadows by the workspace root it is told about; the project is that root here.
const fileqEnv = (env: Env, project: string): Env => ({ ...env, WORKSPACE_ROOT: project });

// True when a sweep was started.
export const sweepIfDue = (data: string, project: string, env: Env = process.env, now: number = Date.now()): boolean => {
    if (!claimIfDue(join(data, "shadows", `${projectSlug(project)}.stamp`), SWEEP_EVERY_MS, now)) {
        return false;
    }
    startDetached(process.execPath, [fileq(env), "sweep", "--json"], { cwd: project, log: logOf(data, project, "sweep"), env: fileqEnv(env, project) });
    return true;
};

// The project-relative path of a file fileq can render, or undefined for anything else (plain text, or outside).
export const derivablePath = (project: string, file: string): string | undefined => {
    const rel = isAbsolute(file) ? relative(project, file) : file;
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) || !isCandidatePath(rel) ? undefined : rel.split("\\").join("/");
};

export const deriveNow = (data: string, project: string, rel: string, env: Env = process.env): void => {
    startDetached(process.execPath, [fileq(env), "derive", rel], { cwd: project, log: logOf(data, project, "derive"), env: fileqEnv(env, project) });
};
