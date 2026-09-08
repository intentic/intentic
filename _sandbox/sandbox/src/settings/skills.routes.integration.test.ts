import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Capability, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { fakeFiles, tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";

// Drives the skills routes over the real HTTP surface, with real files and a real settings store, since the point is
// that one save call leaves the text and the loaded folder in agreement, and the settings list to the baked tools.
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
                remove: (path) => rm(path, { recursive: true, force: true }),
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
        // What the agent's loader would actually find, the only account of a skill being on that matters.
        loaded: (name: string): string | undefined => {
            try {
                return readFileSync(join(workspace.root, ".agents", "skills", name, "SKILL.md"), "utf8");
            } catch {
                return undefined;
            }
        },
    };
};

test("saving a skill writes it, loads it, and leaves the settings list alone: all from one call", async () => {
    const { client, enabled, loaded } = withStore();
    await client.skills.save({ name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." });

    expect(loaded("release-notes")).toContain("description: Use when drafting release notes.");
    expect(loaded("release-notes")).toContain("Run git log.");
    // The list names baked tools; an own skill's switch is its loaded copy.
    expect(enabled()).not.toContain("release-notes");

    const row = (await client.skills.list()).find((skill) => skill.id === "release-notes");
    expect(row).toMatchObject({ origin: "own", enabled: true, editable: true, removable: true, switchable: true });
});

test("editing a switched-off skill keeps it off and still stores the new text", async () => {
    const { client, loaded } = withStore();
    await client.skills.save({ name: "notes", description: "First.", body: "Body one." });
    await client.skills.switch({ name: "notes", on: false });
    expect(loaded("notes")).toBeUndefined();
    expect((await client.skills.list()).find((skill) => skill.id === "notes")).toMatchObject({ enabled: false, switchable: true });

    await client.skills.save({ name: "notes", description: "Second.", body: "Body two." });
    expect(loaded("notes")).toBeUndefined();

    // Switching it back on must also pick up the stored edit.
    await client.skills.switch({ name: "notes", on: true });
    expect(loaded("notes")).toContain("Body two.");
});

// The settings list is the baked tools' door: a write through it, whatever it names, never reaches an own skill.
test("a settings write never removes an own skill's loaded copy", async () => {
    const { client, loaded } = withStore();
    await client.skills.save({ name: "notes", description: "Use it.", body: "Body." });
    const settings = await client.settings.get();
    await client.settings.set({ ...settings, skills: [] });
    expect(loaded("notes")).toContain("Body.");
    expect(loaded("lsp")).toBeUndefined();
});

test("reading a skill returns its instructions without the declared block", async () => {
    const { client } = withStore();
    await client.skills.save({ name: "notes", description: "Use it.", body: "# Notes\n\nRun `git log`." });
    expect(await client.skills.read({ id: "notes" })).toEqual({ id: "notes", name: "notes", body: "# Notes\n\nRun `git log`.\n" });
    expect(await errorCode(client.skills.read({ id: "ghost" }))).toBe("NOT_FOUND");
});

test("removing a skill clears the text and the loaded copy together", async () => {
    const { client, loaded } = withStore();
    await client.skills.save({ name: "notes", description: "Use it.", body: "Body." });
    await client.skills.remove({ name: "notes" });

    expect(loaded("notes")).toBeUndefined();
    expect((await client.skills.list()).some((skill) => skill.id === "notes")).toBe(false);
});

// Every refusal guards against a control that would appear to work: reusing a baked tool's name would silently claim
// its switch, its switch here would shadow the settings list, and deleting a skill something else provides would just
// come back on the next reconcile.
test("a baked tool's name is refused, its switch is not here, and a skill something else provides cannot be deleted", async () => {
    // Without this capability in the store, the same file would be a loose, removable one; that's the distinction being
    // pinned down.
    const { client, root } = withStore([{ id: "github", kind: "cli", config: { provider: "github" } }]);
    expect(await errorCode(client.skills.save({ name: "lsp", description: "Mine now.", body: "Body." }))).toBe("CONFLICT");
    expect(await errorCode(client.skills.switch({ name: "lsp", on: false }))).toBe("NOT_FOUND");
    expect(await errorCode(client.skills.switch({ name: "ghost", on: true }))).toBe("NOT_FOUND");
    expect(await errorCode(client.skills.remove({ name: "lsp" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.skills.remove({ name: "ghost" }))).toBe("BAD_REQUEST");

    mkdirSync(join(root, ".agents", "skills", "github"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "github", "SKILL.md"), "---\nname: github\ndescription: Use for repos.\n---\n\nBody.\n");
    expect((await client.skills.list()).find((skill) => skill.id === "github")).toMatchObject({ origin: "capability", owner: "github" });
    expect(await errorCode(client.skills.remove({ name: "github" }))).toBe("BAD_REQUEST");
});

// The `dropped` origin: a file with nothing behind it, usually the agent's own writing, that nothing else would clear
// away.
test("a loose file in the skills folder can be cleared away", async () => {
    const { client, root, loaded } = withStore();
    mkdirSync(join(root, ".agents", "skills", "scratch"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "scratch", "SKILL.md"), "---\nname: scratch\ndescription: Agent wrote this.\n---\n\nBody.\n");

    expect((await client.skills.list()).find((skill) => skill.id === "scratch")).toMatchObject({ origin: "dropped", removable: true });
    await client.skills.remove({ name: "scratch" });
    expect(loaded("scratch")).toBeUndefined();
});

// Refused by the schema at the edge, not mid-write; a slash in the name would otherwise escape the store's directory.
test("a name that is not a slug is refused before anything is written", async () => {
    const { client } = withStore();
    expect(await errorCode(client.skills.save({ name: "../escape", description: "Use it.", body: "Body." }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.skills.save({ name: "Notes", description: "Use it.", body: "Body." }))).toBe("BAD_REQUEST");
});
