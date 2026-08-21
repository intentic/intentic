import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import { loadedSkillDir, loadedSkillFile, removeLoadedSkill, type SkillFiles, writeLoadedSkill } from "./loaded-skills.js";

// The real writer, as the daemon composes it: these tests assert what lands on disk, so the seam is the
// production one rather than a fake standing in for it.
const FILES: SkillFiles = { write: writeWorkspaceFile, remove: removeWorkspacePath };

/* The three-way contract of one loaded skill: the canonical file under `.agents/skills/` (Codex and Gemini read
 * it there directly), the `.claude/skills/` symlink (Claude Code's loader follows it), and the AGENTS.md index
 * entry (the runtimes with no skill loader). A writer that landed one projection and not another would be a
 * skill only SOME of the agents know they have: the exact split this module exists to close. */

const SKILL = "---\nname: quill\ndescription: Draws quills. Use when asked for quills.\n---\n\nDraw a quill.\n";

test("writing a skill lands the canonical file, the Claude symlink, and the AGENTS.md index entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL);

    expect(await readFile(loadedSkillFile(root, "quill"), "utf8")).toBe(SKILL);
    const link = join(root, ".claude", "skills", "quill");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(SKILL);
    const index = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(index).toContain("**quill**, Draws quills. Use when asked for quills.");
    expect(index).toContain("`.agents/skills/quill/SKILL.md`");
});

test("removing a skill clears all three projections, deleting an AGENTS.md that was only the index", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "quill", SKILL);
    await removeLoadedSkill(FILES, root, "quill");

    await expect(stat(loadedSkillDir(root, "quill"))).rejects.toThrow();
    await expect(lstat(join(root, ".claude", "skills", "quill"))).rejects.toThrow();
    await expect(stat(join(root, "AGENTS.md"))).rejects.toThrow();
});

// AGENTS.md is the user's file first: the index is a marked block spliced in place, and everything around it:
// including their trailing prose when the block goes: must come through every rewrite byte-intact.
test("the index block leaves the user's own AGENTS.md text alone, coming and going", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeFile(join(root, "AGENTS.md"), "# My rules\n\nAlways be brief.\n");

    await writeLoadedSkill(FILES, root, "quill", SKILL);
    const withIndex = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(withIndex).toContain("# My rules\n\nAlways be brief.");
    expect(withIndex).toContain("**quill**");

    await removeLoadedSkill(FILES, root, "quill");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("Always be brief.");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).not.toContain("**quill**");
});

test("the index lists every skill, name-ordered, and re-writing converges rather than appending", async () => {
    const root = mkdtempSync(join(tmpdir(), "loaded-skills-"));
    await writeLoadedSkill(FILES, root, "zebra", "---\nname: zebra\ndescription: Z.\n---\n\nZ.\n");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A.\n---\n\nA.\n");
    await writeLoadedSkill(FILES, root, "apple", "---\nname: apple\ndescription: A2.\n---\n\nA.\n");

    const index = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(index.indexOf("**apple**")).toBeLessThan(index.indexOf("**zebra**"));
    expect(index).toContain("A2.");
    expect(index).not.toContain("— A. ");
    expect(index.match(/## Skills/g)).toHaveLength(1);
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
