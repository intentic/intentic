import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { buildIndex, type KnowledgeIndex } from "./index-notes.js";
import type { NoteFile } from "./note.js";

// The only file-touching module in this directory, so everything else stays pure, testable, and free of node:fs for the
// browser half. Shared by the backend and the `kb` CLI, so the panel and the agent always read the same knowledge base.

// Notes live here, relative to the workspace root, unless the owner's setting says otherwise.
export const DEFAULT_FOLDER = "knowledge";

// Directories a knowledge base never keeps notes in; walked past, not read (editor state, checkouts).
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", ".intentic", "node_modules", ".cache"]);

// Resolved the same way on both sides: the CLI gets it via the daemon-injected KB_FOLDER env var, the backend reads the
// same persisted setting. Both fall back to the default folder.
export const knowledgeRoot = (workspaceRoot: string, configured: string | undefined): string => {
    const folder = configured?.trim();
    if (folder === undefined || folder === "" || folder.split("/").includes("..") || folder.startsWith("/")) {
        return join(workspaceRoot, DEFAULT_FOLDER);
    }
    return join(workspaceRoot, folder);
};

// Absent, unreadable, or another extension's key all mean the same thing: fall back, silently.
export const configuredFolder = async (workspaceRoot: string): Promise<string | undefined> => {
    try {
        const raw = JSON.parse(await readFile(join(workspaceRoot, ".intentic/config/extension-settings.json"), "utf8")) as Record<
            string,
            Record<string, unknown> | undefined
        >;
        const value = raw["intentic.knowledge"]?.["folder"];
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
};

// A caller-supplied relative path resolved inside `dir`, or undefined if it escapes.
const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) ? undefined : target;
};

// Absolute path of a note, or undefined if the name escapes the knowledge base or isn't markdown.
export const resolveNote = (root: string, name: string): string | undefined => {
    const target = resolveWithin(root, name);
    return target === undefined || !target.toLowerCase().endsWith(".md") ? undefined : target;
};

// Every markdown file, read; a knowledge base that doesn't exist yet reads as empty, not an error.
export const readNotes = async (root: string): Promise<NoteFile[]> => {
    const files: NoteFile[] = [];
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        await Promise.all(
            entries.map(async (entry) => {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) {
                        await walk(full);
                    }
                    return;
                }
                if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
                    return;
                }
                try {
                    const [content, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
                    files.push({
                        path: relative(root, full).split(sep).join("/"),
                        content,
                        modifiedAt: Math.round(info.mtimeMs),
                        sizeBytes: info.size,
                    });
                } catch {
                    // Raced a delete, or unreadable; the knowledge base simply omits it this round.
                }
            }),
        );
    };
    await walk(root);
    return files;
};

export const indexNotes = async (root: string): Promise<KnowledgeIndex> => buildIndex(await readNotes(root));

export const writeNote = async (root: string, name: string, content: string): Promise<boolean> => {
    const target = resolveNote(root, name);
    if (target === undefined) {
        return false;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    return true;
};

export const deleteNote = async (root: string, name: string): Promise<boolean> => {
    const target = resolveNote(root, name);
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
