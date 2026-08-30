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

/* THE KIT IS A DIRECTORY ON DISK AND ITS SHAPE IS THE FEATURE, which is why this suite touches a real one: the
 * whole promise is that the runtime's own plugin loader reads what we write, so an assertion against an
 * in-memory seam would prove only that this module is self-consistent.
 *
 * What is actually load-bearing is the LAYOUT: a manifest where the loader looks, skills under `skills/<name>/
 * SKILL.md`. Those two paths are the contract with a loader this repo does not own, so they are asserted
 * literally rather than through the helpers that build them. */

const kitRoot = (): string => mkdtempSync(join(tmpdir(), "persona-kit-"));

test("a kit is a plugin the loader can read, named after the card", async () => {
    const root = kitRoot();

    await ensurePersonaKit(root, "studio", "Studio");

    const manifest = JSON.parse(await readFile(join(root, ".intentic", "config", "personas", "studio", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("studio");
    expect(manifest.description).toContain("Studio");
    // The dir is offered to the turn only once that manifest exists: a folder the loader would refuse is worse
    // on the turn path than no folder at all.
    expect(await personaKitPlugin(root, "studio")).toBe(personaKitDir(root, "studio"));
});

// A card nobody has written a kit for is the ordinary case, and must cost the turn nothing and refuse nothing.
test("no kit is not an error anywhere", async () => {
    const root = kitRoot();

    expect(await personaKitPlugin(root, "ghost")).toBeUndefined();
    expect(await readPersonaPrompt(root, "ghost")).toBeUndefined();
    expect(await listPersonaSkills(root, "ghost")).toEqual([]);
    expect(await readPersonaSkill(root, "ghost", "voice")).toBeUndefined();
    // Removing what was never there is a no-op, not a throw: the card's delete path calls it unconditionally.
    await removePersonaKit(root, "ghost");
});

/* A DIRECTORY THE LOADER WOULD SKIP MUST NOT BE OFFERED. Somebody making the folder by hand and leaving it:
 * or an interrupted write: is the shape that reaches the turn path as "this persona is broken" rather than as
 * "no kit yet", and only the manifest can tell the two apart. */
test("a folder with no manifest is not offered to a turn", async () => {
    const root = kitRoot();
    await mkdir(join(root, ".intentic", "config", "personas", "half", "skills"), { recursive: true });

    expect(await personaKitPlugin(root, "half")).toBeUndefined();
});

test("a prompt round-trips, and emptying it removes the file rather than storing a blank", async () => {
    const root = kitRoot();

    await writePersonaPrompt(root, "studio", "Studio", "You write release notes.\n\n");

    // Trailing whitespace is dropped on the way in AND on the way out, so a re-read equals what was typed and
    // the editor does not open showing an unsaved change it cannot explain.
    expect(await readPersonaPrompt(root, "studio")).toBe("You write release notes.");
    // Writing a prompt brings the kit into existence, so the loader will read the skills beside it.
    expect(await personaKitPlugin(root, "studio")).toEqual(expect.any(String));

    await removePersonaPrompt(root, "studio");
    // Absent, not empty: "custom with nothing written" is one state, which personaPrompt falls back from.
    expect(await readPersonaPrompt(root, "studio")).toBeUndefined();
});

test("a kit skill lands where the loader looks, with frontmatter it can read", async () => {
    const root = kitRoot();

    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Short sentences." });

    const text = await readFile(join(root, ".intentic", "config", "personas", "studio", "skills", "voice", "SKILL.md"), "utf8");
    expect(text.startsWith("---\nname: voice\ndescription: How we write.\n---")).toBe(true);
    // The body comes back as the file holds it: the composer ends every document with a newline, and the read
    // is deliberately not trimming what the loader will read.
    expect(await listPersonaSkills(root, "studio")).toEqual([{ name: "voice", description: "How we write.", body: "Short sentences.\n" }]);

    await removePersonaSkill(root, "studio", "voice");
    expect(await listPersonaSkills(root, "studio")).toEqual([]);
});

/* THE DIRECTORY NAME WINS over a `name:` that disagrees, because the directory is what the loader keys the skill
 * by: a row named something the agent never answers to is a row that lies. Half-written directories are skipped
 * for the same reason the sandbox's own skills store skips them: they are not a skill that does nothing. */
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

// Deleting a card deletes its kit: a folder no persona can reach is a folder no list shows, and leaving the
// owner's prose orphaned on disk is worse than deleting what they just asked to delete.
test("removing the kit takes the prompt and the skills with it", async () => {
    const root = kitRoot();
    await writePersonaPrompt(root, "studio", "Studio", "Text.");
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Body." });

    await removePersonaKit(root, "studio");

    expect(await personaKitPlugin(root, "studio")).toBeUndefined();
    expect(await readPersonaPrompt(root, "studio")).toBeUndefined();
    expect(await listPersonaSkills(root, "studio")).toEqual([]);
});
