import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Capability, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { clientFor, errorCode, fakeFiles, memoryCapabilitiesStore, services, tempWorkspace } from "../route-testing.js";

/* THE SKILLS ROUTES over the daemon's real HTTP surface, driven exactly as the browser drives them.
 *
 * What these are actually about is the COUPLING: a save writes text, edits the enabled list, and reconciles the
 * folder the agent reads, all in one call. Sequencing that from the browser would leave windows where a skill has
 * text and is off, or is on with no text — so the thing worth testing is that one call leaves all three in
 * agreement, and that a second door onto the same state (a bare settings write) leaves them agreeing too.
 *
 * Real files and a real settings store, because "what would the next turn actually load" is the question, and both
 * fakes in this harness answer it with a shrug. */
const withStore = (capabilities: Capability[] = []) => {
    const workspace = tempWorkspace([]);
    let stored: SandboxSettings = SandboxSettingsSchema.parse({});
    const app = createApp(
        services({
            workspace,
            capabilities: memoryCapabilitiesStore(capabilities),
            files: fakeFiles({
                read: (path) => readFile(path, "utf8").catch(() => undefined),
                write: async (path, content) => {
                    await mkdir(dirname(path), { recursive: true });
                    await writeFile(path, content);
                },
            }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
                get: async () => stored,
                set: async (next) => {
                    stored = next;
                },
            }),
        }),
    );
    return {
        client: clientFor(app),
        root: workspace.root,
        enabled: (): readonly string[] => stored.skills,
        // What the agent's loader would find — the only account of "is this skill on" that matters.
        loaded: (name: string): string | undefined => {
            try {
                return readFileSync(join(workspace.root, ".agents", "skills", name, "SKILL.md"), "utf8");
            } catch {
                return undefined;
            }
        },
    };
};

test("saving a skill writes it, switches it on, and loads it — all from one call", async () => {
    const { client, enabled, loaded } = withStore();
    await client.skills.save({ name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." });

    expect(enabled()).toContain("release-notes");
    expect(loaded("release-notes")).toContain("description: Use when drafting release notes.");
    expect(loaded("release-notes")).toContain("Run git log.");

    const row = (await client.skills.list()).find((skill) => skill.id === "release-notes");
    expect(row).toMatchObject({ origin: "own", enabled: true, editable: true, removable: true, switchable: true });
});

/* RE-SAVING MUST NOT RESURRECT A SKILL THE OWNER SWITCHED OFF. They turned it off on purpose, and an edit is not a
 * request to turn it back on — but the new text still has to be stored, so that switching it on later loads the
 * edit rather than the version from before it. */
test("editing a switched-off skill keeps it off and still stores the new text", async () => {
    const { client, enabled, loaded } = withStore();
    await client.skills.save({ name: "notes", description: "First.", body: "Body one." });
    const settings = await client.settings.get();
    await client.settings.set({ ...settings, skills: settings.skills.filter((name) => name !== "notes") });
    expect(loaded("notes")).toBeUndefined();

    await client.skills.save({ name: "notes", description: "Second.", body: "Body two." });
    expect(enabled()).not.toContain("notes");
    expect(loaded("notes")).toBeUndefined();

    // Switch it back on through the settings door: the reconcile there has to pick up the edit.
    const current = await client.settings.get();
    await client.settings.set({ ...current, skills: [...current.skills, "notes"] });
    expect(loaded("notes")).toContain("Body two.");
});

test("reading a skill returns its instructions without the declared block", async () => {
    const { client } = withStore();
    await client.skills.save({ name: "notes", description: "Use it.", body: "# Notes\n\nRun `git log`." });
    expect(await client.skills.read({ id: "notes" })).toEqual({ id: "notes", name: "notes", body: "# Notes\n\nRun `git log`.\n" });
    expect(await errorCode(client.skills.read({ id: "ghost" }))).toBe("NOT_FOUND");
});

test("removing a skill clears the text, the loaded copy and the enabled list together", async () => {
    const { client, enabled, loaded } = withStore();
    await client.skills.save({ name: "notes", description: "Use it.", body: "Body." });
    await client.skills.remove({ name: "notes" });

    expect(enabled()).not.toContain("notes");
    expect(loaded("notes")).toBeUndefined();
    expect((await client.skills.list()).some((skill) => skill.id === "notes")).toBe(false);
});

/* THE TWO REFUSALS, and both are about a control that would otherwise appear to work.
 *
 * A skill named after a baked tool would be whichever copy the reconciler wrote last, and would silently claim the
 * switch belonging to the tool. Deleting a skill something else provides would come back on the next reconcile —
 * so the route refuses instead of performing a deletion that undoes itself. */
test("a baked tool's name is refused, and a skill something else provides cannot be deleted", async () => {
    // The connection whose cheatsheet this is. WITHOUT it in the store the same file is a loose one and IS
    // removable — which is right, and is the distinction this test exists to pin down.
    const { client, root } = withStore([{ id: "github", kind: "cli", config: { provider: "github" } }]);
    expect(await errorCode(client.skills.save({ name: "lsp", description: "Mine now.", body: "Body." }))).toBe("CONFLICT");
    expect(await errorCode(client.skills.remove({ name: "lsp" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.skills.remove({ name: "ghost" }))).toBe("BAD_REQUEST");

    mkdirSync(join(root, ".agents", "skills", "github"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "github", "SKILL.md"), "---\nname: github\ndescription: Use for repos.\n---\n\nBody.\n");
    expect((await client.skills.list()).find((skill) => skill.id === "github")).toMatchObject({ origin: "capability", owner: "github" });
    expect(await errorCode(client.skills.remove({ name: "github" }))).toBe("BAD_REQUEST");
});

// The one origin that is removable without being the owner's own: a file sitting in the folder with nothing behind
// it — written by the agent itself, most often — which nothing else would ever clear up.
test("a loose file in the skills folder can be cleared away", async () => {
    const { client, root, loaded } = withStore();
    mkdirSync(join(root, ".agents", "skills", "scratch"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "scratch", "SKILL.md"), "---\nname: scratch\ndescription: Agent wrote this.\n---\n\nBody.\n");

    expect((await client.skills.list()).find((skill) => skill.id === "scratch")).toMatchObject({ origin: "dropped", removable: true });
    await client.skills.remove({ name: "scratch" });
    expect(loaded("scratch")).toBeUndefined();
});

// A name the directory layout cannot hold is refused by the schema at the edge, not by the filesystem halfway
// through a write — an id with a slash in it would otherwise escape the store entirely.
test("a name that is not a slug is refused before anything is written", async () => {
    const { client } = withStore();
    expect(await errorCode(client.skills.save({ name: "../escape", description: "Use it.", body: "Body." }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.skills.save({ name: "Notes", description: "Use it.", body: "Body." }))).toBe("BAD_REQUEST");
});
