import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Persona } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { clientFor, errorCode, memoryPersonasStore, services, tempWorkspace } from "../route-testing.js";

/* THE PERSONA KIT ROUTES over the daemon's real HTTP surface, on a real temp workspace.
 *
 * These write FILES, unlike the three card routes beside them, and the files are read by a loader this repo does
 * not own — so what is worth testing here is the same thing the store's own suite tests one layer down, asked
 * through the door the browser actually uses: that a save lands where the loader looks, and that a kit cannot be
 * written for a card that does not exist.
 *
 * That last one is the case with teeth. A kit belonging to no persona is unreachable — nothing can wear it — so a
 * route that created one by side effect would put the owner's prose somewhere no list ever shows it. */

const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };

const withStore = (personas: Persona[] = [studio]) => {
    const workspace = tempWorkspace([]);
    const app = createApp(services({ workspace, personas: memoryPersonasStore(personas) }));
    return { client: clientFor(app), root: workspace.root };
};

const kitFile = (root: string, ...tail: string[]): Promise<string | undefined> =>
    readFile(join(root, ".intentic", "personas", ...tail), "utf8").catch(() => undefined);

test("a card with no kit reads as an empty one rather than a failure", async () => {
    const { client } = withStore();

    expect(await client.personas.kit({ id: "studio" })).toEqual({ prompt: "", skills: [] });
});

test("saving a prompt writes it where the card's turns will read it, and reads back what was typed", async () => {
    const { client, root } = withStore();

    await client.personas.savePrompt({ id: "studio", prompt: "You write release notes." });

    expect(await kitFile(root, "studio", "PROMPT.md")).toBe("You write release notes.\n");
    expect((await client.personas.kit({ id: "studio" })).prompt).toBe("You write release notes.");
    // The manifest lands with it, so the loader reads the folder rather than skipping it.
    expect(await kitFile(root, "studio", ".claude-plugin", "plugin.json")).toContain(`"name": "studio"`);
});

// Emptying the box is a decision, and the file going away is what makes it one state instead of two: a card
// still set to "custom" then falls back to the sandbox's prompt rather than running on a blank one.
test("an emptied prompt deletes the file rather than storing a blank", async () => {
    const { client, root } = withStore();
    await client.personas.savePrompt({ id: "studio", prompt: "Text." });

    await client.personas.savePrompt({ id: "studio", prompt: "   " });

    expect(await kitFile(root, "studio", "PROMPT.md")).toBeUndefined();
    expect((await client.personas.kit({ id: "studio" })).prompt).toBe("");
});

test("a kit skill round-trips through the routes and lands where the loader looks", async () => {
    const { client, root } = withStore();

    await client.personas.saveSkill({ id: "studio", name: "voice", description: "How we write.", body: "Short sentences." });

    expect(await kitFile(root, "studio", "skills", "voice", "SKILL.md")).toContain("description: How we write.");
    expect((await client.personas.kit({ id: "studio" })).skills).toEqual([{ name: "voice", description: "How we write." }]);
    expect(await client.personas.readSkill({ id: "studio", name: "voice" })).toMatchObject({ name: "voice", description: "How we write." });

    await client.personas.removeSkill({ id: "studio", name: "voice" });
    expect((await client.personas.kit({ id: "studio" })).skills).toEqual([]);
});

test("a skill that is gone reads as absent rather than as an empty one", async () => {
    const { client } = withStore();

    expect(await errorCode(client.personas.readSkill({ id: "studio", name: "nope" }))).toBe("NOT_FOUND");
});

/* NO KIT WITHOUT A CARD, on either write. The manifest the loader needs carries the card's own label, so there
 * is nothing to write for a persona that does not exist — and creating one by side effect would let this
 * surface mint a persona nobody named. */
test("writing a kit for a card that does not exist is refused, and writes nothing", async () => {
    const { client, root } = withStore([]);

    expect(await errorCode(client.personas.savePrompt({ id: "ghost", prompt: "Text." }))).toBe("NOT_FOUND");
    expect(await errorCode(client.personas.saveSkill({ id: "ghost", name: "voice", description: "d", body: "b" }))).toBe("NOT_FOUND");
    expect(await kitFile(root, "ghost", ".claude-plugin", "plugin.json")).toBeUndefined();
});

// Deleting a card deletes what only that card could reach. Leaving the folder behind would orphan the owner's
// prompt and skills somewhere no surface lists them.
test("removing a persona takes its kit with it", async () => {
    const { client, root } = withStore();
    await client.personas.savePrompt({ id: "studio", prompt: "Text." });

    await client.personas.remove({ id: "studio" });

    expect(await kitFile(root, "studio", "PROMPT.md")).toBeUndefined();
});
