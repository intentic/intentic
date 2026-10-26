import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitChange } from "@intentic/sandbox-contract/schemas/git/git";
import { changedFiles, changesAgainstBase } from "../../git/changes/changes.js";
import { stageAll } from "../../git/changes/changes-index.js";
import { commitRootBaseline, ensureRootRepo } from "../../git/remote/root-repo.js";
import { repoGitDir, syncRootExcludes } from "../../workspace/layout/git-layout.js";
import { removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { loadedSkillDir, removeLoadedSkill, writeLoadedSkill } from "../loaded-skills.js";
import { syncSkillLinkExcludes } from "./skill-link-excludes.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const FILES = { write: writeWorkspaceFile, remove: removeWorkspacePath };
const SKILL = "---\nname: quill\ndescription: Draws quills.\n---\nDraw a quill.\n";
const roots: string[] = [];
const temp = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "skill-link-excludes-"));
    roots.push(root);
    return root;
};
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

test("generated links stay out of workspace changes, agent deltas, stage-all and the history scope after excludes refresh", async () => {
    const base = await temp();
    const work = join(base, "work");
    const history = join(base, "history");
    await mkdir(work);
    await ensureRootRepo(workspacePaths(work), history);
    await commitRootBaseline(workspacePaths(work));
    const head = await sh(work, "rev-parse", "HEAD");
    await writeLoadedSkill(FILES, work, "quill", SKILL, "owner");
    const scopeGit = join(history, "scopes", "root.git");
    await mkdir(join(scopeGit, "info"), { recursive: true });
    await syncRootExcludes(history, ["app"]);

    const canonical: GitChange = { path: ".agents/skills/quill/SKILL.md", status: "added", additions: 5, deletions: 0 };
    expect((await changedFiles(work)).unstaged).toEqual([canonical]);
    expect(await changesAgainstBase(work, head)).toEqual([canonical]);
    await stageAll(work);
    expect(await sh(work, "ls-files")).toBe(canonical.path);
    expect(await readFile(join(scopeGit, "info", "exclude"), "utf8")).toBe(
        await readFile(join(repoGitDir(history, "root"), "info", "exclude"), "utf8"),
    );
    expect((await lstat(join(work, ".claude", "skills", "quill"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(work, ".claude", "skills", "quill", "SKILL.md"), "utf8")).toBe(SKILL);
});

test("convergence clears an existing phantom addition whose canonical skill was already committed", async () => {
    const root = await temp();
    await sh(root, "init", "-q");
    await writeWorkspaceFile(join(loadedSkillDir(root, "quill"), "SKILL.md"), SKILL);
    await sh(root, "add", "-A");
    await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "skill");
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink("../../.agents/skills/quill", join(root, ".claude", "skills", "quill"));
    expect(await sh(root, "status", "--porcelain", "-uall")).toBe("?? .claude/skills/quill");

    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    expect((await changedFiles(root)).unstaged).toEqual([]);
    expect(await sh(root, "status", "--porcelain", "-uall")).toBe("");
});

test("a local repo keeps owner skills, unrelated links and excludes, and releases a projection's path when removed", async () => {
    const root = await temp();
    await sh(root, "init", "-q");
    const exclude = join(root, ".git", "info", "exclude");
    await writeFile(exclude, "# owner rules\n*.private\n");
    const skills = join(root, ".claude", "skills");
    await mkdir(join(skills, "mine"), { recursive: true });
    await writeFile(join(skills, "mine", "SKILL.md"), "owner skill\n");
    await symlink("mine", join(skills, "my-link"));
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    const first = await readFile(exclude, "utf8");
    await syncSkillLinkExcludes(root);
    expect(await readFile(exclude, "utf8")).toBe(first);
    expect(first.startsWith("# owner rules\n*.private\n")).toBe(true);
    expect((await sh(root, "ls-files", "--others", "--exclude-standard")).split("\n")).toEqual([
        ".agents/skills/quill/SKILL.md",
        ".claude/skills/mine/SKILL.md",
        ".claude/skills/my-link",
    ]);
    await removeLoadedSkill(FILES, root, "quill");
    expect(await readFile(exclude, "utf8")).toBe("# owner rules\n*.private\n");
    await writeFile(join(skills, "quill"), "owner file\n");
    expect((await sh(root, "ls-files", "--others", "--exclude-standard")).split("\n")).toContain(".claude/skills/quill");
});

test("the common excludes serve linked worktrees without hiding real directories at a projected name", async () => {
    const root = await temp();
    await sh(root, "init", "-q");
    await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    await writeLoadedSkill(FILES, root, "quill", SKILL, "owner");
    const linked = join(await temp(), "linked");
    await sh(root, "worktree", "add", "-q", "-b", "linked", linked);
    await mkdir(join(linked, ".claude", "skills"), { recursive: true });
    await symlink("../../.agents/skills/quill", join(linked, ".claude", "skills", "quill"));
    await syncSkillLinkExcludes(linked);
    expect(await sh(linked, "status", "--porcelain", "-uall")).toBe("");
    await rm(join(linked, ".claude", "skills", "quill"));
    await mkdir(join(linked, ".claude", "skills", "quill"));
    await writeFile(join(linked, ".claude", "skills", "quill", "SKILL.md"), "owner skill\n");
    expect(await sh(linked, "status", "--porcelain", "-uall")).toBe("?? .claude/skills/quill/SKILL.md");
    expect(await readFile(join(loadedSkillDir(root, "quill"), "SKILL.md"), "utf8")).toBe(SKILL);
});
