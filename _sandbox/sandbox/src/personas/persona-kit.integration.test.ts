import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    ensurePersonaKit,
    listPersonaSkills,
    personaKitDir,
    personaKitPlugin,
    readPersonaPrompt,
    readPersonaSkill,
    removePersonaKit,
    removePersonaPrompt,
    removePersonaSkill,
    writePersonaPrompt,
    writePersonaSkill,
} from "./persona-kit.js";

// Real filesystem, not an in-memory seam: the plugin loader we don't own reads this layout, so manifest and skill paths
// are asserted literally rather than through the helpers that build them.

const kitRoot = (): string => mkdtempSync(join(tmpdir(), "persona-kit-"));

test("a kit is a plugin the loader can read, named after the card", async () => {
    const root = kitRoot();

    await ensurePersonaKit(root, "studio", "Studio");

    const manifest = JSON.parse(await readFile(join(root, ".intentic", "config", "personas", "studio", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("studio");
    expect(manifest.description).toContain("Studio");
    expect(await personaKitPlugin(root, "studio")).toBe(personaKitDir(root, "studio"));
});

test("no kit is not an error anywhere", async () => {
    const root = kitRoot();

    expect(await personaKitPlugin(root, "ghost")).toBeUndefined();
    expect(await readPersonaPrompt(root, "ghost")).toBeUndefined();
    expect(await listPersonaSkills(root, "ghost")).toEqual([]);
    expect(await readPersonaSkill(root, "ghost", "voice")).toBeUndefined();
    await removePersonaKit(root, "ghost");
});

test("a folder with no manifest is not offered to a turn", async () => {
    const root = kitRoot();
    await mkdir(join(root, ".intentic", "config", "personas", "half", "skills"), { recursive: true });

    expect(await personaKitPlugin(root, "half")).toBeUndefined();
});

test("a prompt round-trips, and emptying it removes the file rather than storing a blank", async () => {
    const root = kitRoot();

    const prompt = "You write release notes.";
    await writePersonaPrompt(root, "studio", "Studio", `${prompt}\n\n`);

    expect(await readPersonaPrompt(root, "studio")).toBe(prompt);
    expect(await personaKitPlugin(root, "studio")).toEqual(expect.any(String));

    await removePersonaPrompt(root, "studio");
    expect(await readPersonaPrompt(root, "studio")).toBeUndefined();
});

test("a kit skill lands where the loader looks, with frontmatter it can read", async () => {
    const root = kitRoot();

    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Short sentences." });

    const text = await readFile(join(root, ".intentic", "config", "personas", "studio", "skills", "voice", "SKILL.md"), "utf8");
    expect(text.startsWith("---\nname: voice\ndescription: How we write.\n---")).toBe(true);
    // Body keeps its trailing newline: the composer ends every document with one, and the read doesn't trim it.
    expect(await listPersonaSkills(root, "studio")).toEqual([{ name: "voice", description: "How we write.", body: "Short sentences.\n" }]);

    await removePersonaSkill(root, "studio", "voice");
    expect(await listPersonaSkills(root, "studio")).toEqual([]);
});

test("the folder name is the skill's name, and a directory with no file is not a skill", async () => {
    const root = kitRoot();
    await mkdir(join(root, ".intentic", "config", "personas", "studio", "skills", "voice"), { recursive: true });
    await writeFile(
        join(root, ".intentic", "config", "personas", "studio", "skills", "voice", "SKILL.md"),
        `---\nname: something-else\n---\n\nBody.\n`,
    );
    await mkdir(join(root, ".intentic", "config", "personas", "studio", "skills", "empty"), { recursive: true });

    expect((await listPersonaSkills(root, "studio")).map((skill) => skill.name)).toEqual(["voice"]);
});

test("removing the kit takes the prompt and the skills with it", async () => {
    const root = kitRoot();
    await writePersonaPrompt(root, "studio", "Studio", "Text.");
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Body." });

    await removePersonaKit(root, "studio");

    expect(await personaKitPlugin(root, "studio")).toBeUndefined();
    expect(await readPersonaPrompt(root, "studio")).toBeUndefined();
    expect(await listPersonaSkills(root, "studio")).toEqual([]);
});
