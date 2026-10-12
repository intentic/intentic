import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import {
    loadedSkillCatalogNote,
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

// Pins the filesystem contract of one loaded skill: a canonical file under `.agents/skills/`, a `.claude/skills/`
// symlink for Claude Code, and a generated catalogue for runtimes with neither loader, never a third copy in the user's
// AGENTS.md.

const SKILL = "---\nname: quill\ndescription: Draws quills. Use when asked for quills.\n---\n\nDraw a quill.\n";

test("writing a skill lands the canonical file and Claude symlink without creating AGENTS.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");

    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
    const link = join(root, ".claude", "skills", "quill");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(SKILL);
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
            "and rules.",
            "",
            "- **apple**, A2. → `/visible/worktree/.agents/skills/apple/SKILL.md`",
            "- **zebra**, Z. → `/visible/worktree/.agents/skills/zebra/SKILL.md`",
        ].join("\n"),
    );
});

test("a real directory in .claude/skills is never replaced by the projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const theirs = join(root, ".claude", "skills", "quill");
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, "SKILL.md"), "theirs\n");

    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    expect((await lstat(theirs)).isDirectory()).toBe(true);
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toBe("theirs\n");
    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
});

test("a stale managed link is swept by the next write", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "gone", SKILL, "owner");
    await rm(loadedSkillDir(root, "gone"), { recursive: true, force: true });

    await writeLoadedSkill(FILES, root, "kept", SKILL, "owner");
    await expect(lstat(join(root, ".claude", "skills", "gone"))).rejects.toThrow();
    expect((await lstat(join(root, ".claude", "skills", "kept"))).isSymbolicLink()).toBe(true);
});

// The sweep removes every managed link the canonical listing does not name, so a listing that failed must not read as
// "no skills".
test("a canonical folder that cannot be listed fails the converge instead of sweeping every link", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    await writeLoadedSkill(FILES, root, "apple", SKILL, "owner");
    const canonical = join(root, ".agents", "skills");
    await rename(canonical, `${canonical}-moved`);
    // A link to itself: listing it fails with ELOOP, not ENOENT, whoever runs the test.
    await symlink(canonical, canonical);

    await expect(removeLoadedSkill({ ...FILES, remove: async () => undefined }, root, "quill")).rejects.toMatchObject({ code: "ELOOP" });
    expect((await lstat(join(root, ".claude", "skills", "apple"))).isSymbolicLink()).toBe(true);
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

test("trashing a skill moves its folder into the history trash and takes its Claude link with it", async () => {
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
