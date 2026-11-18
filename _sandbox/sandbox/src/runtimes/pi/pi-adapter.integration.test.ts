import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { roleSkillsRoot } from "../../roles/role-kit.js";
import { loadedSkillsRoot } from "../../store/loaded-skills.js";
import { piSkillsOf } from "./pi-adapter.js";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-skills-"));
    for (const name of ["github", "reddit-work"]) {
        mkdirSync(join(loadedSkillsRoot(root), name), { recursive: true });
        writeFileSync(join(loadedSkillsRoot(root), name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    }
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

// A planned turn's context as piSkillsOf reads it: the tree on both sides, what the turn may not use, who it acts as.
const context = (disallowedTools: string[], role?: string) => ({
    localCwd: root,
    effectiveCwd: WORKSPACE_ROOT,
    base: { policy: { disallowedTools } },
    role: role === undefined ? undefined : { role: { id: role } },
});

test("a Pi turn loads every workspace skill the role may use, named as Pi sees the tree, and the image's own", async () => {
    const baked = join(root, "baked");
    for (const name of ["github", "intentic"]) {
        mkdirSync(join(baked, name), { recursive: true });
    }
    // SAFETY: piSkillsOf reads only the fields built here.
    expect(await piSkillsOf(context(["Skill(reddit-work)"]) as never, baked)).toEqual([
        join(loadedSkillsRoot(WORKSPACE_ROOT), "github"),
        // The workspace's `github` stands in for the image's of that name.
        join(baked, "intentic"),
    ]);
});

test("the worn role's own kit rides along when it holds any skill", async () => {
    mkdirSync(join(roleSkillsRoot(root, "studio"), "voice"), { recursive: true });
    // SAFETY: piSkillsOf reads only the fields built here.
    const skills = await piSkillsOf(context([], "studio") as never, "");
    expect(skills.at(-1)).toBe(roleSkillsRoot(WORKSPACE_ROOT, "studio"));
    // SAFETY: as above.
    expect(await piSkillsOf(context([], "empty") as never, "")).toHaveLength(2);
});
