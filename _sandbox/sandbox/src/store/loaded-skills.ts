import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import type { Services } from "../composition.js";
import { scanSkillFolders, SKILL_FILE, skillFolderNames } from "../skill-file.js";

// `.agents/skills/` is canonical; Codex reads it directly, other runtimes get a generated catalogue. `.claude/skills/`
// is a derived, per-workspace-serialized symlink projection for Claude Code, never the source of truth. AGENTS.md is
// user-owned and untouched; skill content goes through the files seam, the links and scan touch disk directly.

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

// Catalogue for a runtime without a skill loader: names and descriptions now, full SKILL.md only when a task matches.
// Paths use the root the agent sees, so an isolated turn never gets a daemon-only worktree path; empty means no note.
export const loadedSkillCatalogNote = async (localRoot: string, agentRoot: string): Promise<string | undefined> => {
    const skills = await scanSkillFolders(loadedSkillsRoot(localRoot), (path) => readFile(path, "utf8").catch(() => undefined), "throw");
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
    // Only a missing folder lists empty: converge sweeps every link this list does not name.
    const names = await skillFolderNames(loadedSkillsRoot(root), "throw");
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

// One pass per root at a time; a failed pass fails only its own caller and never blocks later writes.
const converging = keyedLock<string>();

const queueConverge = (root: string): Promise<void> => converging(root, async () => await converge(root));

// WHO WROTE A LOADED SKILL (2026-10-12). Every daemon writer names itself, and its id is stamped into the file, so a
// later release can tell its own leftovers from the owner's files: a skill no current writer claims is removed at boot
// (settings/skill-retirement.ts), one without a stamp never is. The owner's own skill copy is the owner's text and stays
// unstamped. Adding a writer means adding its id here, and the claim table in skill-retirement.ts is keyed by this
// union, so the typecheck refuses a writer that has not said which names it keeps. Retiring a writer moves its id to
// RETIRED_SKILL_WRITERS there.
export const DAEMON_SKILL_WRITERS = ["approvals", "baked-tool", "account", "cli", "peer", "ssh", "tunnel"] as const;
export type DaemonSkillWriter = (typeof DAEMON_SKILL_WRITERS)[number];
export type SkillWriter = DaemonSkillWriter | "owner";

const markerOf = (writer: string): string => `<!-- intentic:skill-writer=${writer} · written by the sandbox; edits here are overwritten -->`;
const MARKER_LINE = /^<!-- intentic:skill-writer=([a-z0-9-]+) [^\n]*-->$/m;
// Account skills were stamped with this before every writer was (until 2026-10-12); still read as the account writer's.
export const LEGACY_ACCOUNT_SKILL_MARKER = "<!-- managed by the sandbox: derived from the connected accounts; edits are overwritten -->";
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

// The daemon writer a loaded skill's text names, or undefined for an unstamped (owner-authored) file.
export const skillWriterOf = (text: string): string | undefined => {
    const stamped = MARKER_LINE.exec(text)?.[1];
    if (stamped !== undefined) {
        return stamped;
    }
    return text.includes(LEGACY_ACCOUNT_SKILL_MARKER) ? "account" : undefined;
};

// The text with any writer stamp taken out, exactly undoing `stampSkill`: the stamp's line, and the blank line it was
// put under.
const isStampLine = (line: string): boolean => MARKER_LINE.test(line) || line === LEGACY_ACCOUNT_SKILL_MARKER;
const unstamped = (text: string): string => {
    const lines = text.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        if (!isStampLine(line)) {
            kept.push(line);
            continue;
        }
        if (kept.length > 0 && kept.at(-1) === "") {
            kept.pop();
        }
    }
    return kept.join("\n");
};

// The text as `writer` lands it: the stamp on its own line under the frontmatter (above everything without one).
// Idempotent, and a re-stamp replaces the writer rather than adding a second line; the owner's text passes unchanged.
export const stampSkill = (text: string, writer: SkillWriter): string => {
    if (writer === "owner") {
        return text;
    }
    const bare = unstamped(text);
    const marker = markerOf(writer);
    return FRONTMATTER.test(bare) ? bare.replace(FRONTMATTER, (frontmatter) => `${frontmatter}\n${marker}\n`) : `${marker}\n${bare}`;
};

// Writes one loaded skill stamped with its writer, then converges its loader projection; a runtime without a loader
// reads the canonical set via `loadedSkillCatalogNote` on its next conversation.
export const writeLoadedSkill = async (files: SkillFiles, root: string, name: string, text: string, writer: SkillWriter): Promise<void> => {
    await files.write(loadedSkillFile(root, name), stampSkill(text, writer));
    await queueConverge(root);
};

// Removes one loaded skill everywhere it's projected; the link is removed here rather than left to the sweep, so "no
// runtime offers this skill" holds as soon as the promise resolves.
export const removeLoadedSkill = async (files: SkillFiles, root: string, name: string): Promise<void> => {
    await files.remove(loadedSkillDir(root, name));
    await dropClaudeLink(root, name);
};

const dropClaudeLink = async (root: string, name: string): Promise<void> => {
    const link = claudeSkillLink(root, name);
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink() === true && isManagedLink(await readlink(link).catch(() => undefined))) {
        await rm(link, { force: true });
    }
    await queueConverge(root);
};

// A rename, or a copy and erase when the workspace and the history volume are different filesystems.
const relocate = async (from: string, to: string): Promise<void> => {
    try {
        await rename(from, to);
    } catch (failure) {
        if (errnoCode(failure) !== "EXDEV") {
            throw failure;
        }
        await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        await rm(from, { recursive: true, force: true });
    }
};

// Sets one loaded skill aside in the history volume's trash instead of erasing it (convergence rule 5), named
// `skill-<name>-<ms>` like every entry set aside there, so the trash sweep empties it after its while; answers where
// it went, or undefined when nothing was there. Its Claude link goes with it, as with `removeLoadedSkill`.
export const trashLoadedSkill = async (root: string, historyRoot: string, name: string, now: number = Date.now()): Promise<string | undefined> => {
    const dir = loadedSkillDir(root, name);
    if ((await lstat(dir).catch(undefinedIfMissing)) === undefined) {
        return undefined;
    }
    const target = join(historyRoot, "trash", `skill-${name}-${String(now)}`);
    await mkdir(dirname(target), { recursive: true });
    await relocate(dir, target);
    await dropClaudeLink(root, name);
    return target;
};
