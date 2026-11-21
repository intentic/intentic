import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { commonDirOf, gitDirOf } from "./git-dir.js";
import { textFile } from "../plain-files/text-file.js";

// Files an ignore rule hid until a land changed the rules, kept hidden as they were (conversations/land/unhidden/unhidden.ts):
// a marked block of exact paths in the repository's own info/exclude, which every checkout of it reads and nothing
// commits. The workspace history's scopes read their own exclude files, so the block is carried onto them too
// (syncRootExcludes, history.ts), or a restore point would hash every one of them: 4,992 build files once took 263 s,
// and a discard queued behind that snapshot held the repo lock for three minutes (2026-11-21).

const START = "# intentic: kept hidden after a land changed the ignore rules that hid them";
const END = "# intentic: end kept hidden";
const BLOCK = new RegExp(`^${START}\\n[\\s\\S]*?^${END}\\n?`, "m");

// The block as it stands in `content`, markers included; empty when there is none.
export const keptHiddenBlock = (content: string): string => BLOCK.exec(content)?.[0] ?? "";

// `content` with its block made exactly `block`, the rest of the file as it was.
const withKeptHiddenBlock = (content: string, block: string): string => {
    const bare = content.replace(BLOCK, "");
    return `${bare}${bare === "" || bare.endsWith("\n") || block === "" ? "" : "\n"}${block}`;
};

const patternsOf = (block: string): string[] => block.split("\n").filter((line) => line !== "" && !line.startsWith("#"));

const blockOf = (patterns: readonly string[]): string => (patterns.length === 0 ? "" : `${START}\n${patterns.join("\n")}\n${END}\n`);

// A gitignore line matching exactly `path` (worktree-relative) and nothing else: anchored, every wildcard and escape
// character escaped, trailing spaces kept. A name with a line break cannot be written as a pattern. Also how the
// history scopes list the large files their snapshots leave out (history/large-files.ts).
export const literalPattern = (path: string): string | undefined => {
    if (/[\n\r]/u.test(path)) {
        return undefined;
    }
    const escaped = path.replaceAll(/[\\*?[\]!#]/gu, (char) => `\\${char}`).replace(/ +$/u, (spaces) => spaces.replaceAll(" ", "\\ "));
    return `/${escaped}`;
};

// A pattern's path as it stands in the checkout: patterns are anchored literals (literalPattern).
const pathOf = (pattern: string): string => pattern.slice(1).replaceAll(/\\(.)/gu, "$1");

// The info/exclude every checkout of the repository at `checkout` reads; undefined for a folder with no git.
export const commonExcludeOf = async (checkout: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    return gitDir === undefined ? undefined : join(await commonDirOf(gitDir), "info", "exclude");
};

// Adds `patterns` to the block of the repository at `checkout`, dropping any whose path is gone from the checkout (a
// folder deleted since): the block only ever names what is still there to hide.
export const keepHidden = async (checkout: string, patterns: readonly string[]): Promise<void> => {
    const exclude = await commonExcludeOf(checkout);
    if (exclude === undefined || patterns.length === 0) {
        return;
    }
    const current = await textFile(exclude).read();
    const wanted = [...new Set([...patternsOf(keptHiddenBlock(current)), ...patterns])];
    const present = await Promise.all(wanted.map(async (pattern) => (await lstat(join(checkout, pathOf(pattern))).catch(undefinedIfMissing)) !== undefined));
    const kept = wanted.filter((_, index) => present[index] === true);
    await textFile(exclude).update((latest) => {
        const next = withKeptHiddenBlock(latest, blockOf(kept));
        return next === latest ? undefined : next;
    });
};

// Carries the block of `from` (a repository's exclude) onto `to` (its history scope's), leaving the rest of `to` alone.
export const mirrorKeptHidden = async (from: string, to: string): Promise<void> => {
    const block = keptHiddenBlock(await textFile(from).read());
    await textFile(to).update((current) => {
        const next = withKeptHiddenBlock(current, block);
        return next === current ? undefined : next;
    });
};
