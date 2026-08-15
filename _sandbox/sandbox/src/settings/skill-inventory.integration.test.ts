import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Capability, Persona, SandboxSettings, SkillSummary } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { readSkillText, skillInventory } from "./skill-inventory.js";
import { writePersonaSkill } from "../personas/persona-kit.js";
import { reconcileSkills, writeOwnSkill } from "./skills.js";

/* THE ATTRIBUTION IS THE FEATURE. A row's origin decides whether it gets a switch, whether it can be edited and
 * whether it can be deleted, so getting the origin wrong is not a cosmetic bug — it is a control that appears to
 * work and is undone by the next reconcile, or a skill the reader cannot get rid of.
 *
 * These tests build the four directory shapes the real thing reads — the loaded folder, the owner's store, a plugin
 * checkout and an extension checkout — on a temp root, and assert what each one becomes. The extension half goes
 * through the git-installed path (an `extension`-kind capability whose checkout holds a manifest), because that is
 * the one an integration test can create without an image to bake into. */
const stubServices = (root: string, capabilities: readonly Capability[], settings: SandboxSettings, personas: readonly Persona[] = []): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", {
            read: (path) => readFile(path, "utf8").catch(() => undefined),
            write: async (path, content) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content);
            },
        }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [...capabilities] }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings }),
        config: unstubbed<Services["config"]>("config", { extensionsDir: "" }),
        // Read on every listing, because a persona's kit skills are part of what the agent knows — see the
        // `persona` origin. No cards is the ordinary shape here and the one most of these cases want.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [...personas] }),
    });

const settingsWith = (skills: readonly string[]): SandboxSettings => SandboxSettingsSchema.parse({ skills: [...skills] });

const writeSkill = async (dir: string, name: string, description: string, body = "Body."): Promise<void> => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};

const rowFor = (rows: readonly SkillSummary[], id: string): SkillSummary => {
    const row = rows.find((entry) => entry.id === id);
    if (row === undefined) {
        throw new Error(`no row for "${id}" — got ${rows.map((entry) => entry.id).join(", ")}`);
    }
    return row;
};

test("a baked tool lists whether or not it is switched on, and only ever offers the switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const off = await skillInventory(stubServices(root, [], settingsWith([])));
    // The one row in this list that is NOT currently loaded. Hiding it is what once made `lsp` undiscoverable.
    expect(rowFor(off, "lsp")).toMatchObject({ origin: "builtin", enabled: false, switchable: true, editable: false, removable: false });
    expect(rowFor(off, "lsp").description).toContain("Rename a TypeScript");

    const on = await skillInventory(stubServices(root, [], settingsWith(["lsp"])));
    expect(rowFor(on, "lsp").enabled).toBe(true);
});

test("an own skill is the only origin that is editable, and reads its enabled state from the settings list", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const services = stubServices(root, [], settingsWith(["release-notes"]));
    await writeOwnSkill(services, { name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." });

    const rows = await skillInventory(services);
    expect(rowFor(rows, "release-notes")).toMatchObject({
        origin: "own",
        description: "Use when drafting release notes.",
        enabled: true,
        switchable: true,
        editable: true,
        removable: true,
    });
    // The owner's own come first: the list opens on the half that answers to them.
    expect(rows[0]?.id).toBe("release-notes");
});

test("a plugin's skills are attributed to that plugin and offer no control of their own", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "my-pack", kind: "plugin", config: { url: "https://example.com/pack.git" } };
    await writeSkill(join(root, ".intentic", "plugins", "my-pack", "skills"), "review", "Use when reviewing a diff.");

    const rows = await skillInventory(stubServices(root, [plugin], settingsWith([])));
    expect(rowFor(rows, "plugin:my-pack:review")).toMatchObject({
        name: "review",
        origin: "plugin",
        owner: "my-pack",
        enabled: true,
        switchable: false,
        editable: false,
        removable: false,
    });
});

// A plugin hosted inside a marketplace repo: its skills sit under the configured subdirectory, and reading the
// checkout root instead would list nothing at all.
test("a plugin's subdirectory is honoured", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "market", kind: "plugin", config: { url: "https://example.com/m.git", path: "plugins/beta" } };
    await writeSkill(join(root, ".intentic", "plugins", "market", "plugins", "beta", "skills"), "beta", "Use for beta things.");

    const rows = await skillInventory(stubServices(root, [plugin], settingsWith([])));
    expect(rowFor(rows, "plugin:market:beta").owner).toBe("market");
});

/* An extension's skills are attributed to the extension by the name its MANIFEST declares, not by the capability
 * entry id — the id is a routing handle the owner never chose, and "Extension · knowledge" is what tells them which
 * of six extensions to go and look at. Its `contributes.agent.path` is honoured for the same reason a plugin's
 * subdirectory is: reading the checkout root instead would find nothing. */
test("an extension's skills are attributed by its manifest name", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    // An extension entry pins a full commit sha — the owner approves exactly the code that runs in their browser.
    const entry: Capability = { id: "ext-1", kind: "extension", config: { url: "https://example.com/ext.git", ref: "a".repeat(40) } };
    const checkout = join(root, ".intentic", "extensions", "ext-1");
    await mkdir(checkout, { recursive: true });
    await writeFile(
        join(checkout, "intentic-extension.json"),
        JSON.stringify({
            publisher: "acme",
            name: "knowledge",
            version: "1.0.0",
            icon: "sitemap",
            engines: { intentic: "^2.1.0" },
            contributes: { agent: { path: "plugin" } },
        }),
    );
    await writeSkill(join(checkout, "plugin", "skills"), "knowledge", "Use when the user asks about their notes.");

    const rows = await skillInventory(stubServices(root, [entry], settingsWith([])));
    expect(rowFor(rows, "extension:ext-1:knowledge")).toMatchObject({
        name: "knowledge",
        origin: "extension",
        owner: "knowledge",
        enabled: true,
        switchable: false,
        editable: false,
        removable: false,
    });
});

/* THE LOADED FOLDER'S LEFTOVERS — the three-way fallback that decides what an unclaimed directory is. Together in
 * one test because what matters is that they are told APART: a connection's cheatsheet must not read as a loose
 * file the reader is invited to delete, and a loose file must not read as something with an owner to go to. */
test("a connection's skill, a core feature's and a loose file are told apart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const loaded = join(root, ".agents", "skills");
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github" } };
    // Shared across every instance of its kind, so its directory is named for the KIND, not for any one entry.
    const vpn: Capability = { id: "office", kind: "vpn", config: { provider: "wireguard", config: "[Interface]", autoConnect: "off" } };
    await writeSkill(loaded, "github", "Use for GitHub repos.");
    await writeSkill(loaded, "vpn", "Use to reach the office network.");
    await writeSkill(loaded, "drafts", "Use to prepare posts.");
    await writeSkill(loaded, "scratch", "Something the agent wrote itself.");

    const rows = await skillInventory(stubServices(root, [github, vpn], settingsWith([])));
    expect(rowFor(rows, "github")).toMatchObject({ origin: "capability", owner: "github", removable: false });
    expect(rowFor(rows, "vpn")).toMatchObject({ origin: "capability", owner: "office", removable: false });
    expect(rowFor(rows, "drafts")).toMatchObject({ origin: "builtin", owner: "Drafts", removable: false });
    // The only origin that is removable without being editable — its home is the folder, not the owner's store.
    expect(rowFor(rows, "scratch")).toMatchObject({ origin: "dropped", removable: true, editable: false, switchable: false });
    // And the only one with nobody to send the reader to, which is what its row has to say instead of an owner.
    expect(rowFor(rows, "scratch").owner).toBeUndefined();
});

// A switched-on baked tool and a switched-on own skill are both present in the loaded folder too. Listing them
// twice — once as themselves and once as a loose file — would double every row the owner actually controls.
test("a skill already accounted for is not listed a second time from the loaded folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const services = stubServices(root, [], settingsWith(["lsp", "notes"]));
    await writeOwnSkill(services, { name: "notes", description: "Use it.", body: "Body." });
    await reconcileSkills(services, ["lsp", "notes"]);

    const rows = await skillInventory(services);
    expect(rows.filter((row) => row.name === "lsp")).toHaveLength(1);
    expect(rows.filter((row) => row.name === "notes")).toHaveLength(1);
    expect(rowFor(rows, "notes").origin).toBe("own");
});

/* READING RESOLVES THE SAME ID THE LIST MINTED. This is the pairing that makes the surface trustworthy: a row that
 * opened someone else's text would be worse than a row that failed to open. Includes the switched-off own skill,
 * whose text lives only in the store, and the switched-off baked tool, whose text lives only in the registry. */
test("every id the list mints reads back the right skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "my-pack", kind: "plugin", config: { url: "https://example.com/pack.git" } };
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    const services = stubServices(root, [plugin], settingsWith([]), [studio]);
    await writeOwnSkill(services, { name: "notes", description: "Use it.", body: "Stored body." });
    await writeSkill(join(root, ".intentic", "plugins", "my-pack", "skills"), "review", "Use when reviewing.", "Plugin body.");
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });

    for (const row of await skillInventory(services)) {
        const found = await readSkillText(services, row.id);
        expect(found?.name, `reading ${row.id}`).toBe(row.name);
    }
    // Switched off, so there is no loaded copy — the text has to come out of the store and the registry.
    expect((await readSkillText(services, "notes"))?.text).toContain("Stored body.");
    expect((await readSkillText(services, "lsp"))?.text).toContain("Rename a TypeScript");
    expect((await readSkillText(services, "plugin:my-pack:review"))?.text).toContain("Plugin body.");
    // A kit skill's id carries the persona ID; its row shows the LABEL, which is not a key.
    expect((await readSkillText(services, "persona:studio:voice"))?.text).toContain("Kit body.");
});

/* A KIT SKILL IS LISTED, AND LISTED AS THE NARROW THING IT IS. The promise of this surface is that it shows
 * everything the agent knows — but a skill only some turns reach must not read as one every chat has, and it
 * must offer no switch, because nothing here can turn it off: it is on exactly when its persona is worn. */
test("a persona's own skill lists under its card, with no switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    const services = stubServices(root, [], settingsWith([]), [studio]);
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });

    const row = rowFor(await skillInventory(services), "persona:studio:voice");

    expect(row).toMatchObject({ name: "voice", description: "How we write.", origin: "persona", owner: "Studio", enabled: true });
    expect(row.switchable).toBe(false);
    // Edited on the card, like a plugin's skill is edited where it lives — not from this list.
    expect(row.editable).toBe(false);
    expect(row.removable).toBe(false);
});

test("an id naming nothing reads as absent rather than as an empty skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const services = stubServices(root, [], settingsWith([]));
    expect(await readSkillText(services, "nope")).toBeUndefined();
    expect(await readSkillText(services, "plugin:gone:review")).toBeUndefined();
    expect(await readSkillText(services, "extension:gone:review")).toBeUndefined();
});
