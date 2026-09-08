import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Services } from "../composition.js";
import { parseSkillFile } from "./skill-file.js";

// `.agents/skills/` is canonical; Codex reads it directly, other runtimes get a generated catalogue. `.claude/skills/`
// is a derived, per-workspace-serialized symlink projection for Claude Code, never the source of truth. AGENTS.md is
// user-owned and untouched; skill content goes through the files seam, the links and scan touch disk directly.

const SKILL_FILE = "SKILL.md";

// The two writes this store needs; a structural subset of `Services["files"]`, so no caller can pass something that
// writes elsewhere.
export type SkillFiles = Pick<Services["files"], "write" | "remove">;

export const loadedSkillsRoot = (root: string): string => join(root, ".agents", "skills");
export const loadedSkillDir = (root: string, name: string): string => join(loadedSkillsRoot(root), name);
export const loadedSkillFile = (root: string, name: string): string => join(loadedSkillDir(root, name), SKILL_FILE);

export const SKILL_CATALOG_NOTE_HEADER = "## Skills available in this workspace";
export const SKILL_CATALOG_NOTE_TITLE = "Skills available in this workspace";

// Claude Code's tree: a projection holding one symlink per canonical skill.
const claudeSkillsRoot = (root: string): string => join(root, ".claude", "skills");
const claudeSkillLink = (root: string, name: string): string => join(claudeSkillsRoot(root), name);

// Relative on purpose: an isolated turn's worktree is bind-mounted over the workspace root; an absolute link would
// reach across the mount.
const linkTarget = (root: string, name: string): string => relative(claudeSkillsRoot(root), loadedSkillDir(root, name));

// Converges one skill's Claude link; a real (non-symlink) entry is left alone since it's user-owned. EEXIST on create
// just means a concurrent writer got there first.
const ensureClaudeLink = async (root: string, name: string): Promise<void> => {
    const link = claudeSkillLink(root, name);
    const target = linkTarget(root, name);
    const existing = await lstat(link).catch(() => undefined);
    if (existing !== undefined) {
        if (!existing.isSymbolicLink()) {
            return;
        }
        if ((await readlink(link).catch(() => undefined)) === target) {
            return;
        }
        await rm(link, { force: true });
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    });
};

// Whether this `.claude/skills` entry is one of ours: matched on the target pointing into `.agents`, not on name, so a
// renamed link still sweeps.
const isManagedLink = (target: string | undefined): boolean => target !== undefined && target.split(/[\\/]/).includes(".agents");

const skillDirNames = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
};

// Catalogue for a runtime without a skill loader: names and descriptions now, full SKILL.md only when a task matches.
// Paths use the root the agent sees, so an isolated turn never gets a daemon-only worktree path; empty means no note.
export const loadedSkillCatalogNote = async (localRoot: string, agentRoot: string): Promise<string | undefined> => {
    const skills: { name: string; description: string }[] = [];
    for (const name of await skillDirNames(loadedSkillsRoot(localRoot))) {
        const text = await readFile(loadedSkillFile(localRoot, name), "utf8").catch(() => undefined);
        if (text !== undefined) {
            skills.push({ name, description: parseSkillFile(text).description ?? "" });
        }
    }
    if (skills.length === 0) {
        return undefined;
    }
    return [
        SKILL_CATALOG_NOTE_HEADER,
        "",
        "One folder per connected tool, account, or workflow is available below. When a task matches a",
        "description, read that skill's SKILL.md before improvising: it carries the exact commands, endpoints,",
        "and rules.",
        "",
        ...skills.map(
            (skill) =>
                `- **${skill.name}**${skill.description === "" ? "" : `, ${skill.description}`} → \`${join(agentRoot, ".agents", "skills", skill.name, SKILL_FILE)}\``,
        ),
    ].join("\n");
};

// One pass: a Claude link per canonical skill, and no Claude link without one. Only sweeps symlinks that point at the
// canonical folder; a real directory or a link to somewhere else is untouched.
const converge = async (root: string): Promise<void> => {
    const names = await skillDirNames(loadedSkillsRoot(root));
    for (const name of names) {
        await ensureClaudeLink(root, name);
    }
    const canonical = new Set(names);
    const entries = await readdir(claudeSkillsRoot(root), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((candidate) => candidate.isSymbolicLink() && !canonical.has(candidate.name))) {
        const link = join(claudeSkillsRoot(root), entry.name);
        if (isManagedLink(await readlink(link).catch(() => undefined))) {
            await rm(link, { force: true });
        }
    }
};

// Per-root serialization; the stored chain swallows failure so one bad pass never blocks later writes.
const chains = new Map<string, Promise<void>>();

const queueConverge = (root: string): Promise<void> => {
    const next = (chains.get(root) ?? Promise.resolve()).then(() => converge(root));
    chains.set(
        root,
        next.catch(() => undefined),
    );
    return next;
};

// Writes one loaded skill, then converges its loader projection; a runtime without a loader reads the canonical set via
// `loadedSkillCatalogNote` on its next conversation.
export const writeLoadedSkill = async (files: SkillFiles, root: string, name: string, text: string): Promise<void> => {
    await files.write(loadedSkillFile(root, name), text);
    await queueConverge(root);
};

// Removes one loaded skill everywhere it's projected; the link is removed here rather than left to the sweep, so "no
// runtime offers this skill" holds as soon as the promise resolves.
export const removeLoadedSkill = async (files: SkillFiles, root: string, name: string): Promise<void> => {
    await files.remove(loadedSkillDir(root, name));
    const link = claudeSkillLink(root, name);
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink() === true && isManagedLink(await readlink(link).catch(() => undefined))) {
        await rm(link, { force: true });
    }
    await queueConverge(root);
};
