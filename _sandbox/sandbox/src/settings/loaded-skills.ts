import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Services } from "../composition.js";
import { parseSkillFile } from "./skill-file.js";

/* THE LOADED-SKILLS FOLDER, in the one place every writer and reader spells it.
 *
 * Skills are written in the Agent Skills format (`<name>/SKILL.md`), which every runtime this daemon serves can
 * read, but each runtime LOOKS in its own place. The folder that converges them is therefore the vendor-neutral
 * `.agents/skills/`: Codex scans it natively (upward from its cwd), Gemini reads it as its interoperable alias,
 * and anything else finds it through the two projections below. `.claude/skills/` is no longer where a skill
 * LIVES, it is where Claude Code LOOKS, so this module keeps a per-skill symlink there (the SDK loader follows
 * them; the same never-clobber rule as session-store.ts's links protects anything real a user dropped in).
 *
 * The second projection is for runtimes with no skill loader at all (OpenCode, Pi, ACP agents): a managed index
 * block in the workspace's AGENTS.md, each skill's name, description and file path, with the instruction to
 * read the file when a task matches. That is the same name+description surface a native loader injects, so a
 * runtime reading it by either route reaches the same place: the SKILL.md under `.agents/skills/`.
 *
 * Both projections are DERIVED, scan-to-converge, and serialized per workspace (a capability apply and the boot
 * reconcile may write concurrently; two interleaved index rebuilds would otherwise let the earlier scan land
 * last and drop the newer skill until something else wrote). Writers await the queue, so "write returned" means
 * every runtime's view is current.
 *
 * CONTENT GOES THROUGH THE FILES SEAM, the tree is walked directly, and the split is not stylistic. A skill file
 * and the index are workspace CONTENT, the seam is what a test replaces to keep a fake workspace off the real
 * disk, and a store that wrote around it put a stray skill into the developer's own /work the first time a route
 * suite exercised a real handler. The links and the scan have no seam to go through and need none: they only
 * ever DESCRIBE what is on disk, so a suite whose content writes went to memory converges the real tree against
 * itself and writes nothing. */

const SKILL_FILE = "SKILL.md";

/* The two writes this store owes the workspace. A structural subset of `Services["files"]` (`ctx.files` on a
 * capability handler is the same object), so every caller already holds one and no caller can pass something
 * that writes somewhere else. */
export type SkillFiles = Pick<Services["files"], "write" | "remove">;

export const loadedSkillsRoot = (root: string): string => join(root, ".agents", "skills");
export const loadedSkillDir = (root: string, name: string): string => join(loadedSkillsRoot(root), name);
export const loadedSkillFile = (root: string, name: string): string => join(loadedSkillDir(root, name), SKILL_FILE);

// Claude Code's own tree, a projection now, holding one symlink per canonical skill.
const claudeSkillsRoot = (root: string): string => join(root, ".claude", "skills");
const claudeSkillLink = (root: string, name: string): string => join(claudeSkillsRoot(root), name);

// Relative on purpose: an isolated turn sees its worktree bind-mounted over the workspace root, and a relative
// link resolves inside whichever tree it was checked out into, an absolute one would reach across the mount.
const linkTarget = (root: string, name: string): string => relative(claudeSkillsRoot(root), loadedSkillDir(root, name));

/* One skill's Claude link, converged. A REAL entry under `.claude/skills/<name>` is left alone, it is something
 * a person put there for Claude specifically, and clobbering it would turn "drop a folder in" into a fight with
 * the daemon. EEXIST on the create is the concurrent writer having just won the same race to the same answer. */
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

// Is this `.claude/skills` entry one of OUR links? Anything pointing into the canonical folder is managed
// namespace, matched on the target rather than on the name, so a link somebody hand-renamed still sweeps.
const isManagedLink = (target: string | undefined): boolean => target !== undefined && target.split(/[\\/]/).includes(".agents");

const skillDirNames = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
};

/* THE AGENTS.md INDEX, the always-on half of progressive disclosure, for runtimes that have no skill loader.
 * Markers rather than whole-file ownership because AGENTS.md is the user's file first: everything outside the
 * block is theirs, and the block regenerates in place wherever they left it. */
const INDEX_START = "<!-- intentic:skills: managed by the sandbox; edits between these markers are overwritten -->";
const INDEX_END = "<!-- /intentic:skills -->";
// Older daemon versions used slightly different prose and punctuation in the opening marker. Match ownership,
// not one spelling, and consume every complete managed block: otherwise each marker revision becomes a block
// the next revision cannot replace, which is how an always-on index grows once per reconcile.
const MANAGED_INDEX = /<!-- intentic:skills\b[\s\S]*?<!-- \/intentic:skills -->\n?/gu;

const indexSection = (skills: readonly { name: string; description: string }[]): string =>
    [
        "## Skills",
        "",
        "One folder per connected tool, account, or workflow under `.agents/skills/`. When a task matches a",
        "description below, read that skill's SKILL.md before improvising: it carries the exact commands,",
        "endpoints, and rules. (A harness that loads Agent Skills natively already surfaces these same files.)",
        "",
        ...skills.map(
            (skill) => `- **${skill.name}**${skill.description === "" ? "" : `, ${skill.description}`} → \`.agents/skills/${skill.name}/SKILL.md\``,
        ),
    ].join("\n");

// Splice the managed block into whatever AGENTS.md already says: replace it where it stands, append it where it
// is missing, and with the last skill gone take the block out again, leaving the file only if the user wrote
// the rest of it. `undefined` section means "no block at all".
const spliceIndex = (existing: string | undefined, section: string | undefined): string | undefined => {
    const block = section === undefined ? undefined : `${INDEX_START}\n${section}\n${INDEX_END}`;
    if (existing === undefined) {
        return block === undefined ? undefined : `${block}\n`;
    }
    if (!MANAGED_INDEX.test(existing)) {
        MANAGED_INDEX.lastIndex = 0;
        return block === undefined ? existing : `${existing.trimEnd()}\n\n${block}\n`;
    }
    MANAGED_INDEX.lastIndex = 0;
    let inserted = false;
    const next = existing.replace(MANAGED_INDEX, () => {
        if (inserted || block === undefined) {
            return "";
        }
        inserted = true;
        return `${block}\n`;
    });
    return next.trim() === "" ? undefined : next;
};

const convergeIndex = async (files: SkillFiles, root: string, names: readonly string[]): Promise<void> => {
    const skills: { name: string; description: string }[] = [];
    for (const name of names) {
        const text = await readFile(loadedSkillFile(root, name), "utf8").catch(() => undefined);
        if (text !== undefined) {
            skills.push({ name, description: parseSkillFile(text).description ?? "" });
        }
    }
    const path = join(root, "AGENTS.md");
    const existing = await readFile(path, "utf8").catch(() => undefined);
    const next = spliceIndex(existing, skills.length === 0 ? undefined : indexSection(skills));
    if (next === existing) {
        return;
    }
    if (next === undefined) {
        await files.remove(path);
        return;
    }
    await files.write(path, next);
};

/* One converge pass: a Claude link per canonical skill, no Claude link without one, and the index current. The
 * sweep only ever deletes SYMLINKS THAT POINT AT THE CANONICAL FOLDER, a real directory (a drop-in meant for
 * Claude alone) and a link somebody made to somewhere else are both outside this pass's ownership. */
const converge = async (files: SkillFiles, root: string): Promise<void> => {
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
    await convergeIndex(files, root, names);
};

/* The serialization, per workspace root. The stored chain swallows its own failure so one bad pass cannot wedge
 * every later write; the RETURNED promise does not, so the caller that triggered the pass still hears about it. */
const chains = new Map<string, Promise<void>>();

const queueConverge = (files: SkillFiles, root: string): Promise<void> => {
    const next = (chains.get(root) ?? Promise.resolve()).then(() => converge(files, root));
    chains.set(
        root,
        next.catch(() => undefined),
    );
    return next;
};

// Write one loaded skill, the canonical file, then both projections. What every writer calls, so a skill
// cannot land where one runtime reads it and not another.
export const writeLoadedSkill = async (files: SkillFiles, root: string, name: string, text: string): Promise<void> => {
    await files.write(loadedSkillFile(root, name), text);
    await queueConverge(files, root);
};

// Remove one loaded skill everywhere it is projected. The link is taken out here rather than left to the sweep
// so the caller's postcondition, "no runtime offers this skill anymore", holds when the promise resolves.
export const removeLoadedSkill = async (files: SkillFiles, root: string, name: string): Promise<void> => {
    await files.remove(loadedSkillDir(root, name));
    const link = claudeSkillLink(root, name);
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink() === true && isManagedLink(await readlink(link).catch(() => undefined))) {
        await rm(link, { force: true });
    }
    await queueConverge(files, root);
};
