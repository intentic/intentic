import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { personaSkillsRoot } from "../../../personas/persona-kit.js";
import { loadedSkillsRoot } from "../../../store/loaded-skills.js";
import { catalogFor, skillsUnseen, turnSkillCatalog } from "./turn-skills.js";

// One skill set per turn: what each runtime's loader does not read by itself is named in the opening note, with its
// path as the agent sees it, and only the kit of the persona the turn wears.

let root: string;

const skill = (dir: string, name: string): void => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: about ${name}\n---\n`);
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "turn-skills-"));
    skill(loadedSkillsRoot(root), "github");
    skill(personaSkillsRoot(root, "studio"), "voice");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const roots = () => ({ localCwd: root, effectiveCwd: WORKSPACE_ROOT, builtIn: join(root, "baked") });
const PERSONAS = [{ id: "studio" }, { id: "plain" }];

test("a loader that reads every origin leaves nothing to name", async () => {
    const every = { workspace: true, builtIn: true, kit: true };
    expect(skillsUnseen(every)).toBe(false);
    expect(await turnSkillCatalog(every, roots(), PERSONAS)).toEqual({ workspace: [], builtIn: [], kits: {} });
});

test("the origins a loader leaves are read with the agent's paths, and each persona's kit stays its own", async () => {
    // As OpenCode's: the server reads the workspace's and the image's skills, never a persona's kit.
    const workspaceOnly = await turnSkillCatalog({ workspace: true, builtIn: true, kit: false }, roots(), PERSONAS);
    expect(workspaceOnly).toEqual({
        workspace: [],
        builtIn: [],
        kits: { studio: [{ name: "voice", description: "about voice", path: join(personaSkillsRoot(WORKSPACE_ROOT, "studio"), "voice", "SKILL.md") }] },
    });
    expect(catalogFor(workspaceOnly, "studio").map(({ name }) => name)).toEqual(["voice"]);
    expect(catalogFor(workspaceOnly, "plain")).toEqual([]);
    expect(catalogFor(workspaceOnly, undefined)).toEqual([]);
});

test("a runtime with no loader is told the workspace's and the image's skills, a workspace skill standing in for a built-in of its name", async () => {
    skill(join(root, "baked"), "github");
    skill(join(root, "baked"), "intentic");
    const none = await turnSkillCatalog({ workspace: false, builtIn: false, kit: true }, roots(), PERSONAS);
    expect(none.workspace).toEqual([{ name: "github", description: "about github", path: join(WORKSPACE_ROOT, ".agents", "skills", "github", "SKILL.md") }]);
    expect(catalogFor(none, undefined).map(({ path }) => path)).toEqual([
        join(WORKSPACE_ROOT, ".agents", "skills", "github", "SKILL.md"),
        join(root, "baked", "intentic", "SKILL.md"),
    ]);
});
