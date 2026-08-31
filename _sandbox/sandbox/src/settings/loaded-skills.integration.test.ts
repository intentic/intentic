import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import {
    loadedSkillCatalogNote,
    loadedSkillDir,
    loadedSkillFile,
    removeLoadedSkill,
    SKILL_CATALOG_NOTE_HEADER,
    type SkillFiles,
    writeLoadedSkill,
} from "./loaded-skills.js";

// The real writer, as the daemon composes it: these tests assert what lands on disk, so the seam is the
// production one rather than a fake standing in for it.
const FILES: SkillFiles = { write: writeWorkspaceFile, remove: removeWorkspacePath };

/* The filesystem contract of one loaded skill: the canonical file under `.agents/skills/` (Codex reads it
 * directly) and the `.claude/skills/` symlink (Claude Code's loader follows it). Runtimes without either loader
 * receive a catalogue generated from the canonical set, never a third copy in the user's AGENTS.md. */

const SKILL = "---\nname: quill\ndescription: Draws quills. Use when asked for quills.\n---\n\nDraw a quill.\n";

test("writing a skill lands the canonical file and Claude symlink without creating AGENTS.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL);

    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
    const link = join(root, ".claude", "skills", "quill");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(SKILL);
    await expect(stat(join(root, "AGENTS.md"))).rejects.toThrow();
});

test("removing a skill clears both filesystem projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL);
    await removeLoadedSkill(FILES, root, "quill");

    await expect(stat(loadedSkillDir(root, "quill"))).rejects.toThrow();
    await expect(lstat(join(root, ".claude", "skills", "quill"))).rejects.toThrow();
    await expect(stat(join(root, "AGENTS.md"))).rejects.toThrow();
});

test("converging leaves a user-authored AGENTS.md byte-intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const user = "# My rules\n\nAlways be brief.\n";
    await writeFile(join(root, "AGENTS.md"), user);

    await writeLoadedSkill(FILES, root, "quill", SKILL);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(user);
});

test("the prompt catalogue lists every skill name-ordered and reflects rewrites", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "zebra", "---\nname: zebra\ndescription: Z.\n---\n\nZ.\n");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A.\n---\n\nA.\n");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A2.\n---\n\nA.\n");

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

// A real directory under .claude/skills is something a person put there for Claude specifically: the projection
// must not fight them for the name.
test("a real directory in .claude/skills is never replaced by the projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    const theirs = join(root, ".claude", "skills", "quill");
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, "SKILL.md"), "theirs\n");

    await writeLoadedSkill(FILES, root, "quill", SKILL);
    expect((await lstat(theirs)).isDirectory()).toBe(true);
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toBe("theirs\n");
    // The canonical copy still landed for every other runtime.
    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
});

// Self-healing: a managed link whose canonical dir vanished out-of-band (an agent's rm, a partial restore) is
// swept on the next converge instead of dangling in Claude's tree forever.
test("a stale managed link is swept by the next write", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "gone", SKILL);
    await rm(loadedSkillDir(root, "gone"), { recursive: true, force: true });

    await writeLoadedSkill(FILES, root, "kept", SKILL);
    await expect(lstat(join(root, ".claude", "skills", "gone"))).rejects.toThrow();
    expect((await lstat(join(root, ".claude", "skills", "kept"))).isSymbolicLink()).toBe(true);
});
