import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { personaSkillsRoot } from "../../personas/persona-kit.js";
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
const context = (disallowedTools: string[], persona?: string) => ({
    localCwd: root,
    effectiveCwd: WORKSPACE_ROOT,
    base: { policy: { disallowedTools } },
    persona: persona === undefined ? undefined : { persona: { id: persona } },
});

test("a Pi turn loads every workspace skill the persona may use, named as Pi sees the tree", async () => {
    // SAFETY: piSkillsOf reads only the fields built here.
    expect(await piSkillsOf(context(["Skill(reddit-work)"]) as never)).toEqual([join(loadedSkillsRoot(WORKSPACE_ROOT), "github")]);
});

test("the worn persona's own kit rides along when it holds any skill", async () => {
    mkdirSync(join(personaSkillsRoot(root, "studio"), "voice"), { recursive: true });
    // SAFETY: piSkillsOf reads only the fields built here.
    const skills = await piSkillsOf(context([], "studio") as never);
    expect(skills.at(-1)).toBe(personaSkillsRoot(WORKSPACE_ROOT, "studio"));
    // SAFETY: as above.
    expect(await piSkillsOf(context([], "empty") as never)).toHaveLength(2);
});
