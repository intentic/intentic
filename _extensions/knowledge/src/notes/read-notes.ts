import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { buildIndex, type KnowledgeIndex } from "./index-notes.js";
import type { NoteFile } from "./note.js";

/* THE KNOWLEDGE BASE ON DISK — the only file-touching module in this directory, so everything else stays pure and
 * testable, and the browser half can import note/query types without dragging node:fs into the web bundle.
 *
 * Shared by the extension's BACKEND and by the `kb` CLI the agent runs. That sharing is the point: one reader,
 * one parser, one index, so the panel and the agent can never describe the same knowledge base differently. */

// Where the notes live, relative to the workspace root, unless the owner points the setting elsewhere.
export const DEFAULT_FOLDER = "knowledge";

// Directories a knowledge base never keeps notes in — the editor's own state, a checkout, a dependency tree. Walked past
// rather than read: an Obsidian knowledge base synced in here carries a .obsidian/ full of JSON that is not knowledge.
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", ".intentic", "node_modules", ".cache"]);

/* WHICH FOLDER, resolved the same way on both sides. The daemon injects the setting into the agent's shell as
 * KB_FOLDER (contributes.settings `env`), so the CLI needs no config file of its own; the backend reads the same
 * value out of the settings the daemon persists. Both fall back to the default folder, so a knowledge base works before
 * anybody has opened the settings page. */
export const knowledgeRoot = (workspaceRoot: string, configured: string | undefined): string => {
    const folder = configured?.trim();
    if (folder === undefined || folder === "" || folder.split("/").includes("..") || folder.startsWith("/")) {
        return join(workspaceRoot, DEFAULT_FOLDER);
    }
    return join(workspaceRoot, folder);
};

// The owner's chosen folder, from the settings file the daemon keeps. Absent, unreadable or not this
// extension's key all mean the same thing — the default — so a settings file that has never been written is
// silent rather than an error path.
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

// A caller-supplied relative path resolved inside `dir`, or undefined when it escapes. The daemon's
// resolveWithin, carried along with the code that depends on it (the memory extension does the same).
const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) ? undefined : target;
};

// The absolute path of one note, or undefined when the name escapes the knowledge base or is not a markdown file. Notes
// are markdown by construction, and the restriction keeps these routes unable to write anything else anywhere.
export const resolveNote = (root: string, name: string): string | undefined => {
    const target = resolveWithin(root, name);
    return target === undefined || !target.toLowerCase().endsWith(".md") ? undefined : target;
};

// Every markdown file in the knowledge base, read. A knowledge base that does not exist yet reads as empty rather than as an
// error: "no notes yet" is the first state of every knowledge base, and the panel says so far better than a 500 does.
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
                    // Raced a delete, or is not readable — the knowledge base simply does not contain it this round.
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
