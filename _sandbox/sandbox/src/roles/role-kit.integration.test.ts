import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ensureRoleKit,
    listRoleSkills,
    roleKitDir,
    roleKitPlugin,
    readRolePrompt,
    readRoleSkill,
    removeRoleKit,
    removeRolePrompt,
    removeRoleSkill,
    writeRolePrompt,
    writeRoleSkill,
} from "./role-kit.js";

// Real filesystem, not an in-memory seam: the plugin loader we don't own reads this layout, so manifest and skill paths
// are asserted literally rather than through the helpers that build them.

const kitRoot = (): string => mkdtempSync(join(tmpdir(), "role-kit-"));

test("a kit is a plugin the loader can read, named after the card", async () => {
    const root = kitRoot();

    await ensureRoleKit(root, "studio", "Studio");

    const manifest = JSON.parse(await readFile(join(root, ".intentic", "config", "roles", "studio", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("studio");
    expect(manifest.description).toContain("Studio");
    expect(await roleKitPlugin(root, "studio")).toBe(roleKitDir(root, "studio"));
});

test("no kit is not an error anywhere", async () => {
    const root = kitRoot();

    expect(await roleKitPlugin(root, "ghost")).toBeUndefined();
    expect(await readRolePrompt(root, "ghost")).toBeUndefined();
    expect(await listRoleSkills(root, "ghost")).toEqual([]);
    expect(await readRoleSkill(root, "ghost", "voice")).toBeUndefined();
    await removeRoleKit(root, "ghost");
});

test("a folder with no manifest is not offered to a turn", async () => {
    const root = kitRoot();
    await mkdir(join(root, ".intentic", "config", "roles", "half", "skills"), { recursive: true });

    expect(await roleKitPlugin(root, "half")).toBeUndefined();
});

test("a prompt round-trips, and emptying it removes the file rather than storing a blank", async () => {
    const root = kitRoot();

    const prompt = "You write release notes.";
    await writeRolePrompt(root, "studio", "Studio", `${prompt}\n\n`);

    expect(await readRolePrompt(root, "studio")).toBe(prompt);
    expect(await roleKitPlugin(root, "studio")).toEqual(expect.any(String));

    await removeRolePrompt(root, "studio");
    expect(await readRolePrompt(root, "studio")).toBeUndefined();
});

test("a kit skill lands where the loader looks, with frontmatter it can read", async () => {
    const root = kitRoot();

    await writeRoleSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Short sentences." });

    const text = await readFile(join(root, ".intentic", "config", "roles", "studio", "skills", "voice", "SKILL.md"), "utf8");
    expect(text.startsWith("---\nname: voice\ndescription: How we write.\n---")).toBe(true);
    // Body keeps its trailing newline: the composer ends every document with one, and the read doesn't trim it.
    expect(await listRoleSkills(root, "studio")).toEqual([{ name: "voice", description: "How we write.", body: "Short sentences.\n" }]);

    await removeRoleSkill(root, "studio", "voice");
    expect(await listRoleSkills(root, "studio")).toEqual([]);
});

test("the folder name is the skill's name, and a directory with no file is not a skill", async () => {
    const root = kitRoot();
    await mkdir(join(root, ".intentic", "config", "roles", "studio", "skills", "voice"), { recursive: true });
    await writeFile(
        join(root, ".intentic", "config", "roles", "studio", "skills", "voice", "SKILL.md"),
        `---\nname: something-else\n---\n\nBody.\n`,
    );
    await mkdir(join(root, ".intentic", "config", "roles", "studio", "skills", "empty"), { recursive: true });

    expect((await listRoleSkills(root, "studio")).map((skill) => skill.name)).toEqual(["voice"]);
});

test("removing the kit takes the prompt and the skills with it", async () => {
    const root = kitRoot();
    await writeRolePrompt(root, "studio", "Studio", "Text.");
    await writeRoleSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Body." });

    await removeRoleKit(root, "studio");

    expect(await roleKitPlugin(root, "studio")).toBeUndefined();
    expect(await readRolePrompt(root, "studio")).toBeUndefined();
    expect(await listRoleSkills(root, "studio")).toEqual([]);
});
