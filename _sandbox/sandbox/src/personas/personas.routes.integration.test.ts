import { STATE_DIR } from "@intentic/constants";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Persona } from "@intentic/sandbox-contract";
import { createApp } from "../app.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryPersonasStore } from "../harness/route-stores.testing.js";

// Persona kit routes over the real HTTP surface and a real temp workspace: files a loader we don't own reads, so what
// matters is that a save lands where it looks, and no kit can be created for a persona that doesn't exist.

const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };

const withStore = (personas: Persona[] = [studio]) => {
    const workspace = tempWorkspace([]);
    const app = createApp(services({ workspace, personas: memoryPersonasStore(personas) }));
    return { client: clientFor(app), root: workspace.root };
};

const kitFile = (root: string, ...tail: string[]): Promise<string | undefined> =>
    readFile(join(root, STATE_DIR, "config", "personas", ...tail), "utf8").catch(() => undefined);

test("a persona with no kit reads as an empty one rather than a failure", async () => {
    const { client } = withStore();

    expect(await client.personas.kit({ id: "studio" })).toEqual({ prompt: "", skills: [] });
});

test("saving a prompt writes it where the persona's turns will read it, and reads back what was typed", async () => {
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

test("writing a kit for a persona that does not exist is refused, and writes nothing", async () => {
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

// The page's writes are committed as they land: left uncommitted they read as the owner's own edits, and a land touching
// the same file was refused as work only the owner could move.
test("a persona's prompt saved on its page is committed on its own, leaving nothing for the owner to save", async () => {
    const workspace = tempWorkspace([]);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: workspace.root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=owner", "-c", "user.email=owner@example.com", "commit", "-q", "--allow-empty", "-m", "Initialize workspace");
    const agentWorktrees = { ...services().agentWorktrees, mainDir: () => workspace.root };
    const client = clientFor(createApp(services({ workspace, personas: memoryPersonasStore([studio]), agentWorktrees })));

    await client.personas.savePrompt({ id: "studio", prompt: "You write release notes." });

    expect(git("log", "-1", "--format=%s")).toBe("Settings: persona Studio prompt");
    expect(git("status", "--porcelain")).toBe("");
});

// A skill an agent's land left in the kit folder, still waiting in Changes, is not the page's to commit: a prompt saved
// over it stays uncommitted with it, for the owner to review.
test("a persona's prompt saved over a kit holding someone else's uncommitted change is left uncommitted", async () => {
    const workspace = tempWorkspace([]);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: workspace.root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=owner", "-c", "user.email=owner@example.com", "commit", "-q", "--allow-empty", "-m", "Initialize workspace");
    const agentWorktrees = { ...services().agentWorktrees, mainDir: () => workspace.root };
    const client = clientFor(createApp(services({ workspace, personas: memoryPersonasStore([studio]), agentWorktrees })));
    const landed = join(workspace.root, STATE_DIR, "config", "personas", "studio", "skills", "notes", "SKILL.md");
    await mkdir(dirname(landed), { recursive: true });
    await writeFile(landed, "---\nname: notes\n---\nTake notes.\n");

    await client.personas.savePrompt({ id: "studio", prompt: "You write release notes." });

    expect(git("log", "-1", "--format=%s")).toBe("Initialize workspace");
    expect(git("status", "--porcelain", "--untracked-files=all").split("\n").toSorted()).toEqual([
        "?? .intentic/config/personas/studio/.claude-plugin/plugin.json",
        "?? .intentic/config/personas/studio/PROMPT.md",
        "?? .intentic/config/personas/studio/skills/notes/SKILL.md",
    ]);
});
