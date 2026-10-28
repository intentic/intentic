import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import {
    loadedSkillCatalog,
    loadedSkillCatalogNote,
    skillCatalogNoteOf,
    loadedSkillDir,
    loadedSkillFile,
    removeLoadedSkill,
    SKILL_CATALOG_NOTE_HEADER,
    LEGACY_ACCOUNT_SKILL_MARKER,
    skillWriterOf,
    type SkillFiles,
    stampSkill,
    trashLoadedSkill,
    writeLoadedSkill,
} from "./loaded-skills.js";

// The production write/remove seam, not a fake, since these tests assert what actually lands on disk.
const FILES: SkillFiles = { write: writeWorkspaceFile, remove: removeWorkspacePath };

// Pins the filesystem contract of one loaded skill: a canonical file under `.agents/skills/`, read by Claude Code
// through the one `.claude/skills` link to that tree, and a generated catalogue for runtimes with neither loader, never
// a third copy in the user's AGENTS.md.

const SKILL = "---\nname: quill\ndescription: Draws quills. Use when asked for quills.\n---\n\nDraw a quill.\n";

test("writing a skill lands the canonical file and Claude's one link to the tree without creating AGENTS.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");

    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
    expect(await readlink(join(root, ".claude", "skills"))).toBe("../.agents/skills");
    expect(await readFile(join(root, ".claude", "skills", "quill", "SKILL.md"), "utf8")).toBe(SKILL);
    await expect(stat(join(root, "AGENTS.md"))).rejects.toThrow();
});

test("removing a skill clears both filesystem projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    await removeLoadedSkill(FILES, root, "quill");

    await expect(stat(loadedSkillDir(root, "quill"))).rejects.toThrow();
    await expect(lstat(join(root, ".claude", "skills", "quill"))).rejects.toThrow();
    await expect(stat(join(root, "AGENTS.md"))).rejects.toThrow();
});

test("converging leaves a user-authored AGENTS.md byte-intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const user = "# My rules\n\nAlways be brief.\n";
    await writeFile(join(root, "AGENTS.md"), user);

    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(user);
});

test("the prompt catalogue lists every skill name-ordered and reflects rewrites", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "zebra", "---\nname: zebra\ndescription: Z.\n---\n\nZ.\n", "owner");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A.\n---\n\nA.\n", "owner");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A2.\n---\n\nA.\n", "owner");

    const catalogue = await loadedSkillCatalogNote(root, "/visible/worktree");
    expect(catalogue).toBe(
        [
            SKILL_CATALOG_NOTE_HEADER,
            "",
            "One folder per connected tool, account, or workflow is available below. When a task matches a",
            "description, read that skill's SKILL.md before improvising: it carries the exact commands, endpoints,",
            "and rules. Read it at the path shown, with your file tool: a skill tool of your runtime's own may not",
            "list these, and that does not mean the skill is missing.",
            "",
            "- **apple**, A2. → `/visible/worktree/.agents/skills/apple/SKILL.md`",
            "- **zebra**, Z. → `/visible/worktree/.agents/skills/zebra/SKILL.md`",
        ].join("\n"),
    );
});

// A withheld account's skill stays on disk; offered in the catalogue, it reads as an invitation (2026-10-25: an X-only
// persona was offered `chrome` and asked the owner's own browser for x.com).
test("the prompt catalogue leaves out the skills the turn may not use, and says nothing when none is left", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "x", "---\nname: x\ndescription: X.\n---\n\nX.\n", "owner");
    await writeLoadedSkill(FILES, root, "chrome", "---\nname: chrome\ndescription: Own browser.\n---\n\nC.\n", "owner");
    const skills = await loadedSkillCatalog(root, "/w");
    const note = skillCatalogNoteOf(skills, new Set(["chrome"]));
    expect(note).toContain("- **x**, X.");
    expect(note).not.toContain("chrome");
    expect(skillCatalogNoteOf(skills, new Set(["chrome", "x"]))).toBeUndefined();
});

// The layout before the single link: a `.claude/skills` directory of per-skill links, and the owner's own folders.
const oldClaudeTree = async (root: string, entries: Readonly<Record<string, string>>): Promise<string> => {
    const dir = join(root, ".claude", "skills");
    await mkdir(dir, { recursive: true });
    for (const [name, spec] of Object.entries(entries)) {
        if (spec.startsWith("->")) {
            await symlink(spec.slice(2), join(dir, name));
        } else {
            await mkdir(join(dir, name));
            await writeFile(join(dir, name, "SKILL.md"), spec);
        }
    }
    return dir;
};

test("the main tree's old .claude/skills directory hands the owner's folders to .agents/skills and becomes the link", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await oldClaudeTree(root, { mine: "mine\n", alias: "->mine", gone: "->../../.agents/skills/gone" });

    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    expect(await readlink(join(root, ".claude", "skills"))).toBe("../.agents/skills");
    expect(await readFile(loadedSkillFile(root, "mine"), "utf8")).toBe("mine\n");
    // Moved at the same depth, the owner's relative link still names their folder.
    expect(await readFile(join(loadedSkillDir(root, "alias"), "SKILL.md"), "utf8")).toBe("mine\n");
    await expect(lstat(loadedSkillDir(root, "gone"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".claude", "skills", "quill", "SKILL.md"), "utf8")).toBe(SKILL);
});

// Moving it would overwrite the canonical copy, so the directory stays, and Claude is given a link per skill instead.
test("an owner's folder at a name .agents/skills already holds is never replaced; the rest is linked one by one", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const dir = await oldClaudeTree(root, { quill: "theirs\n", gone: "->../../.agents/skills/gone" });

    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    await writeLoadedSkill(FILES, root, "kept", SKILL, "owner");
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await readFile(join(dir, "quill", "SKILL.md"), "utf8")).toBe("theirs\n");
    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
    expect(await readlink(join(dir, "kept"))).toBe("../../.agents/skills/kept");
    await expect(lstat(join(dir, "gone"))).rejects.toMatchObject({ code: "ENOENT" });

    await removeLoadedSkill(FILES, root, "kept");
    await expect(lstat(join(dir, "kept"))).rejects.toMatchObject({ code: "ENOENT" });
});

// The per-skill fallback sweeps every link the canonical listing does not name, so a listing that failed must not read
// as "no skills".
test("a canonical folder that cannot be listed fails the converge instead of sweeping every link", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const dir = await oldClaudeTree(root, { quill: "theirs\n" });
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    await writeLoadedSkill(FILES, root, "apple", SKILL, "owner");
    const canonical = join(root, ".agents", "skills");
    await rename(canonical, `${canonical}-moved`);
    // A link to itself: listing it fails with ELOOP, not ENOENT, whoever runs the test.
    await symlink(canonical, canonical);

    await expect(removeLoadedSkill({ ...FILES, remove: async () => undefined }, root, "quill")).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readlink(join(dir, "apple"))).toBe("../../.agents/skills/apple");
});

// Every daemon writer stamps its id, so a later release can tell its own leftovers from the owner's files
// (settings/skill-retirement.ts); the owner's own copy stays byte-for-byte theirs.
test("a daemon writer's skill lands stamped with its id under the frontmatter, the owner's lands as written", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "approvals");
    await writeLoadedSkill(FILES, root, "mine", SKILL, "owner");

    const stamped = await readFile(loadedSkillFile(root, "quill"), "utf8");
    expect(stamped).toBe(
        "---\nname: quill\ndescription: Draws quills. Use when asked for quills.\n---\n\n<!-- intentic:skill-writer=approvals · written by the sandbox; edits here are overwritten -->\n\nDraw a quill.\n",
    );
    expect(skillWriterOf(stamped)).toBe("approvals");
    expect(await readFile(loadedSkillFile(root, "mine"), "utf8")).toBe(SKILL);
    expect(skillWriterOf(SKILL)).toBeUndefined();
});

test("stamping is idempotent, a re-stamp replaces the writer, and the account skills' old stamp still reads as theirs", () => {
    const once = stampSkill(SKILL, "cli");
    expect(stampSkill(once, "cli")).toBe(once);
    expect(stampSkill(once, "peer")).toBe(stampSkill(SKILL, "peer"));
    expect(once.match(/intentic:skill-writer=/g)?.length).toBe(1);

    const legacy = SKILL.replace("---\n\n", `---\n\n${LEGACY_ACCOUNT_SKILL_MARKER}\n\n`);
    expect(skillWriterOf(legacy)).toBe("account");
    // Restamping drops the old line rather than carrying both.
    expect(stampSkill(legacy, "account")).toBe(stampSkill(SKILL, "account"));
    expect(stampSkill("no frontmatter\n", "ssh")).toBe(
        "<!-- intentic:skill-writer=ssh · written by the sandbox; edits here are overwritten -->\nno frontmatter\n",
    );
});

test("trashing a skill moves its folder into the history trash, and Claude stops offering it", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const history = mkdtempSync(join(tmpdir(), "loaded-skills-history-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "approvals");

    const to = await trashLoadedSkill(root, history, "quill", 1_760_000_000_000);
    expect(to).toBe(join(history, "trash", "skill-quill-1760000000000"));
    expect(await readFile(join(history, "trash", "skill-quill-1760000000000", "SKILL.md"), "utf8")).toBe(stampSkill(SKILL, "approvals"));
    await expect(stat(loadedSkillDir(root, "quill"))).rejects.toThrow();
    await expect(lstat(join(root, ".claude", "skills", "quill"))).rejects.toThrow();
    expect(await trashLoadedSkill(root, history, "quill")).toBeUndefined();
});
