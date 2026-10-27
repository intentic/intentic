import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { removeLoadedSkill, stampSkill, writeLoadedSkill } from "../../store/loaded-skills.js";
import { carryGeneratedSkills } from "./generated-skills.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);
const FILES = { write: writeWorkspaceFile, remove: removeWorkspacePath };
const skill = (name: string, body = "Use it."): string => `---\nname: ${name}\ndescription: ${name}.\n---\n${body}\n`;
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

// A main tree with one generated skill and one owner skill (committed, as the owner's are), and an agent's worktree of it.
const setup = async (): Promise<{ main: string; worktree: string }> => {
    const base = await mkdtemp(join(tmpdir(), "generated-skills-"));
    roots.push(base);
    const main = join(base, "work");
    await mkdir(main);
    await sh(main, "init", "-q");
    await writeLoadedSkill(FILES, main, "mine", skill("mine"), "owner");
    await sh(main, "add", "-A");
    await commit(main, "owner skill");
    await writeLoadedSkill(FILES, main, "lsp", skill("lsp"), "baked-tool");
    const worktree = join(base, "agent");
    await sh(main, "worktree", "add", "-q", "-b", "agent", worktree);
    return { main, worktree };
};

test("a worktree gets the main tree's live generated skills and their links, and git sees none of it", async () => {
    const { main, worktree } = await setup();
    expect(await lstat(join(worktree, ".agents", "skills", "lsp")).catch(() => undefined)).toBeUndefined();

    await carryGeneratedSkills(main, worktree);

    expect(await readFile(join(worktree, ".claude", "skills", "lsp", "SKILL.md"), "utf8")).toBe(stampSkill(skill("lsp"), "baked-tool"));
    expect(await readlink(join(worktree, ".claude", "skills", "lsp"))).toBe("../../.agents/skills/lsp");
    expect(await sh(worktree, "status", "--porcelain", "-uall")).toBe("");
    expect(await sh(main, "status", "--porcelain", "-uall")).toBe("");
});

test("a rewrite in the main tree reaches the worktree next turn, and a skill the main tree dropped leaves it", async () => {
    const { main, worktree } = await setup();
    await carryGeneratedSkills(main, worktree);
    await writeLoadedSkill(FILES, main, "lsp", skill("lsp", "Use it differently."), "baked-tool");
    await writeLoadedSkill(FILES, main, "fileq", skill("fileq"), "baked-tool");

    await carryGeneratedSkills(main, worktree);
    expect(await readFile(join(worktree, ".agents", "skills", "lsp", "SKILL.md"), "utf8")).toContain("Use it differently.");
    expect(await readlink(join(worktree, ".claude", "skills", "fileq"))).toBe("../../.agents/skills/fileq");

    await removeLoadedSkill(FILES, main, "lsp");
    await carryGeneratedSkills(main, worktree);
    expect(await lstat(join(worktree, ".agents", "skills", "lsp")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(worktree, ".claude", "skills", "lsp")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(worktree, ".agents", "skills", "mine", "SKILL.md"), "utf8")).toBe(skill("mine"));
    expect(await sh(worktree, "status", "--porcelain", "-uall")).toBe("");
});

test("what the branch itself tracks at a generated skill's path is left exactly as it stands", async () => {
    const { main, worktree } = await setup();
    const committed = stampSkill(skill("lsp", "As committed."), "baked-tool");
    await mkdir(join(worktree, ".agents", "skills", "lsp"), { recursive: true });
    await writeFile(join(worktree, ".agents", "skills", "lsp", "SKILL.md"), committed);
    await mkdir(join(worktree, ".claude", "skills"), { recursive: true });
    await symlink("../../.agents/skills/lsp", join(worktree, ".claude", "skills", "lsp"));
    await sh(worktree, "add", "-f", "-A");
    await commit(worktree, "an old branch's copy");

    await carryGeneratedSkills(main, worktree);
    expect(await readFile(join(worktree, ".agents", "skills", "lsp", "SKILL.md"), "utf8")).toBe(committed);
    expect(await sh(worktree, "status", "--porcelain", "-uall")).toBe("");

    await removeLoadedSkill(FILES, main, "lsp");
    await carryGeneratedSkills(main, worktree);
    expect(await readFile(join(worktree, ".agents", "skills", "lsp", "SKILL.md"), "utf8")).toBe(committed);
});
