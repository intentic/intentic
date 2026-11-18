import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { TurnContext } from "../../../agent/providers/adapter.js";
import { roleSkillsRoot } from "../../../roles/role-kit.js";
import { opt } from "../../../opt.js";
import { loadedSkillsRoot } from "../../../store/loaded-skills.js";
import { cursorSkillsOf, projectKit } from "./cursor-skills.js";

// The skills a Cursor turn's own loader takes: the workspace's, where they already are; the role's kit, laid out as a
// second workspace root the loader reads; and the ones the role withholds, named for the read hook to refuse.

const skill = (root: string, name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\n---\nDo ${name}.\n`);
    return dir;
};

const contextOf = (root: string, role: string | undefined, denied: readonly string[]): Pick<TurnContext, "localCwd" | "base" | "role"> => ({
    localCwd: root,
    base: unstubbed<TurnContext["base"]>("base", { policy: { disallowedTools: denied.map((name) => `Skill(${name})`) } }),
    // SAFETY: cursorSkillsOf reads only the worn role's id.
    ...opt("role", role === undefined ? undefined : ({ role: { id: role } } as TurnContext["role"])),
});

test("a withheld loaded skill is named for the read hook, and the role's kit is listed where the daemon reads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-skills-"));
    skill(loadedSkillsRoot(root), "github");
    skill(loadedSkillsRoot(root), "linear");
    const kitSkill = skill(roleSkillsRoot(root, "reviewer"), "review-checklist");
    expect(await cursorSkillsOf(contextOf(root, "reviewer", ["linear", "Bash"]))).toEqual({ kit: [kitSkill], denied: ["linear"] });
    expect(await cursorSkillsOf(contextOf(root, undefined, []))).toEqual({ kit: [], denied: [] });
});

test("the kit is laid out as Cursor reads a root, and gone once the turn releases it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-skills-"));
    const kitSkill = skill(roleSkillsRoot(root, "reviewer"), "review-checklist");
    const projected = await projectKit({ kit: [kitSkill], denied: [] }, undefined);
    expect(projected.dirs).toHaveLength(1);
    const laid = join(projected.dirs[0] ?? "", ".agents", "skills", "review-checklist", "SKILL.md");
    expect(readFileSync(laid, "utf8")).toContain("Do review-checklist.");
    await projected.release();
    expect(existsSync(projected.dirs[0] ?? "")).toBe(false);
    expect((await projectKit({ kit: [], denied: [] }, undefined)).dirs).toEqual([]);
});
