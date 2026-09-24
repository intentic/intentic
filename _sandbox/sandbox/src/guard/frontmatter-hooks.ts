import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import { parse } from "yaml";

/* Hooks a skill, subagent or command declares in its frontmatter, under one Claude Code config root (~/.claude, or a
 * project's .claude): the CLI registers them for as long as that definition is in use, beside the settings files'. */

export interface FrontmatterHooks {
    // The definition file, as the turn's namespace names it.
    readonly file: string;
    // The frontmatter's `hooks` value; its raw text when the frontmatter is not YAML this can read.
    readonly hooks: unknown;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const HOOKS_KEY = /^hooks\s*:/mu;

// Failures the CLI, reading the same path as the same user, meets too and so loads nothing from. Any other (EMFILE, EIO)
// is this process's alone and throws: read as "no hooks", it would let a set nobody approved run.
const CLI_SEES_NOTHING = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "ELOOP"]);

export const undefinedIfCliSeesNothing = (error: unknown): undefined => {
    if (CLI_SEES_NOTHING.has(errnoCode(error) ?? "")) {
        return undefined;
    }
    throw error;
};

// The definition files under one root: a skill's SKILL.md per directory (a symlinked one included), and every markdown
// file of the flat subagent and command folders.
const definitionFiles = async (root: string, readable: (path: string) => string): Promise<string[]> => {
    const names = async (dir: string): Promise<string[]> => (await readdir(readable(join(root, dir))).catch(undefinedIfCliSeesNothing)) ?? [];
    const [skills, agents, commands] = await Promise.all([names("skills"), names("agents"), names("commands")]);
    return [
        ...skills.map((name) => join(root, "skills", name, "SKILL.md")),
        ...agents.filter((name) => name.endsWith(".md")).map((name) => join(root, "agents", name)),
        ...commands.filter((name) => name.endsWith(".md")).map((name) => join(root, "commands", name)),
    ].toSorted();
};

// One file's `hooks`, or undefined when it declares none. Frontmatter that is not YAML but still names a hooks key is
// kept as text, so a definition the CLI may read more leniently still counts.
const hooksOf = (text: string): unknown => {
    const frontmatter = FENCE.exec(text)?.[1];
    if (frontmatter === undefined || !HOOKS_KEY.test(frontmatter)) {
        return undefined;
    }
    try {
        const parsed: unknown = parse(frontmatter);
        return typeof parsed === "object" && parsed !== null && "hooks" in parsed ? (parsed as { hooks: unknown }).hooks : frontmatter;
    } catch {
        return frontmatter;
    }
};

export const frontmatterHooks = async (root: string, readable: (path: string) => string): Promise<FrontmatterHooks[]> => {
    const found = await Promise.all(
        (await definitionFiles(root, readable)).map(async (file) => {
            const text = await readFile(readable(file), "utf8").catch(undefinedIfCliSeesNothing);
            const hooks = text === undefined ? undefined : hooksOf(text);
            return hooks === undefined || hooks === null ? [] : [{ file, hooks }];
        }),
    );
    return found.flat();
};
