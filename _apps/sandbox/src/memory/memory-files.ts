import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { MemoryFileEntry } from "@intentic/sandbox-contract";
import { resolveWithin } from "../workspace/workspace-files.js";

/* The agent's persistent memory notes: <workspace>/.intentic/claude/projects/<project>/memory/*.md — MEMORY.md
 * (the index) plus one markdown file per fact, written by the agent across sessions (~/.claude/projects is a
 * symlink to that tree; see main.ts). The tree's other contents (session transcripts, provider state) are
 * control-plane (workspace-files.ts denies them to the generic file API), so everything here is scoped hard:
 * only `<project>/memory/**` is ever listed, read, written, or deleted, and only .md files can be written. */

export const memoryRoot = (workspaceRoot: string): string => join(workspaceRoot, ".intentic", "claude", "projects");

// A project slug is a single path segment (the agent's cwd with separators dashed, e.g. "-history-gits-root").
const isValidProject = (project: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project) || /^-[A-Za-z0-9._-]+$/.test(project);

// The absolute path of one memory file; undefined when the project slug is malformed or the name escapes the
// project's memory dir (→ 404, same shape as the logs routes).
const resolveMemoryFile = (root: string, project: string, name: string): string | undefined =>
    isValidProject(project) ? resolveWithin(join(root, project, "memory"), name) : undefined;

// Every memory file across every project, newest first. Projects without a memory dir (most worktree slugs)
// simply contribute nothing.
export const listMemoryFiles = async (root: string): Promise<MemoryFileEntry[]> => {
    let projects: string[];
    try {
        projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
    const entries = await Promise.all(
        projects.map(async (project): Promise<MemoryFileEntry[]> => {
            const dir = join(root, project, "memory");
            let files;
            try {
                files = await readdir(dir, { recursive: true, withFileTypes: true });
            } catch {
                return [];
            }
            const stats = await Promise.all(
                files
                    .filter((entry) => entry.isFile())
                    .map(async (entry) => {
                        const path = join(entry.parentPath, entry.name);
                        try {
                            const info = await stat(path);
                            return {
                                project,
                                name: relative(dir, path).split(sep).join("/"),
                                sizeBytes: info.size,
                                modifiedAt: Math.round(info.mtimeMs),
                            };
                        } catch {
                            // Raced a delete — the file is simply gone.
                            return undefined;
                        }
                    }),
            );
            return stats.filter((entry) => entry !== undefined);
        }),
    );
    return entries.flat().toSorted((a, b) => b.modifiedAt - a.modifiedAt);
};

export const readMemoryFile = async (
    root: string,
    project: string,
    name: string,
): Promise<{ content: string; sizeBytes: number; modifiedAt: number } | undefined> => {
    const target = resolveMemoryFile(root, project, name);
    if (target === undefined) {
        return undefined;
    }
    try {
        const [content, info] = await Promise.all([readFile(target, "utf8"), stat(target)]);
        return { content, sizeBytes: info.size, modifiedAt: Math.round(info.mtimeMs) };
    } catch {
        return undefined;
    }
};

// Write (or create) one memory note. Only .md files: memory is markdown by construction, and the restriction
// keeps this route unable to plant anything executable-adjacent in the control-plane tree.
export const writeMemoryFile = async (root: string, project: string, name: string, content: string): Promise<boolean> => {
    const target = resolveMemoryFile(root, project, name);
    if (target === undefined || !target.endsWith(".md")) {
        return false;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    return true;
};

export const deleteMemoryFile = async (root: string, project: string, name: string): Promise<boolean> => {
    const target = resolveMemoryFile(root, project, name);
    if (target === undefined) {
        return false;
    }
    try {
        if (!(await stat(target)).isFile()) {
            return false;
        }
    } catch {
        return false;
    }
    await rm(target);
    return true;
};
