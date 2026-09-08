import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Persona } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryPersonasStore } from "../harness/route-stores.testing.js";

// Persona kit routes over the real HTTP surface and a real temp workspace: files a loader we don't own reads, so what
// matters is that a save lands where it looks, and no kit can be created for a card that doesn't exist.

const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };

const withStore = (personas: Persona[] = [studio]) => {
    const workspace = tempWorkspace([]);
    const app = createApp(services({ workspace, personas: memoryPersonasStore(personas) }));
    return { client: clientFor(app), root: workspace.root };
};

const kitFile = (root: string, ...tail: string[]): Promise<string | undefined> =>
    readFile(join(root, ".intentic", "config", "personas", ...tail), "utf8").catch(() => undefined);

test("a card with no kit reads as an empty one rather than a failure", async () => {
    const { client } = withStore();

    expect(await client.personas.kit({ id: "studio" })).toEqual({ prompt: "", skills: [] });
});

test("saving a prompt writes it where the card's turns will read it, and reads back what was typed", async () => {
    const { client, root } = withStore();

    await client.personas.savePrompt({ id: "studio", prompt: "You write release notes." });

    expect(await kitFile(root, "studio", "PROMPT.md")).toBe("You write release notes.\n");
    expect((await client.personas.kit({ id: "studio" })).prompt).toBe("You write release notes.");
    // Manifest lands too, so the loader reads the folder instead of skipping it.
    expect(await kitFile(root, "studio", ".claude-plugin", "plugin.json")).toContain(`"name": "studio"`);
});

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

test("writing a kit for a card that does not exist is refused, and writes nothing", async () => {
    const { client, root } = withStore([]);

    expect(await errorCode(client.personas.savePrompt({ id: "ghost", prompt: "Text." }))).toBe("NOT_FOUND");
    expect(await errorCode(client.personas.saveSkill({ id: "ghost", name: "voice", description: "d", body: "b" }))).toBe("NOT_FOUND");
    expect(await kitFile(root, "ghost", ".claude-plugin", "plugin.json")).toBeUndefined();
});

test("removing a persona takes its kit with it", async () => {
    const { client, root } = withStore();
    await client.personas.savePrompt({ id: "studio", prompt: "Text." });

    await client.personas.remove({ id: "studio" });

    expect(await kitFile(root, "studio", "PROMPT.md")).toBeUndefined();
});
