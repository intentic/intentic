import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Capability, Persona, SandboxSettings, SkillSummary } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { readSkillText, skillInventory } from "./skill-inventory.js";
import { personaSkillsRoot, writePersonaSkill } from "../personas/persona-kit.js";
import { scanSkillFolders, SKILL_FILE } from "../skill-file.js";
import { reconcileBakedSkills, switchOwnSkill, writeOwnSkill } from "./skills.js";

// The image's own plugin dirs; none by default, as on a bare dev run.
interface BakedPlugins {
    readonly iqPluginDir: string;
    readonly webqPluginDir: string;
}

// A row's origin decides its switch, edit, and delete controls; getting it wrong is a functional bug, not cosmetic.
// Tests build the four directory shapes the inventory reads: loaded folder, owner's store, plugin and extension
// checkouts.
const stubServices = (
    root: string,
    capabilities: readonly Capability[],
    settings: SandboxSettings,
    personas: readonly Persona[] = [],
    baked: BakedPlugins = { iqPluginDir: "", webqPluginDir: "" },
): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", {
            read: (path) => readFile(path, "utf8").catch(() => undefined),
            write: async (path, content) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content);
            },
            // Reconcile removes every baked skill omitted from the enabled list, so a partial list here also exercises
            // removal for other baked tools like fileq.
            remove: (path) => rm(path, { recursive: true, force: true }),
        }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [...capabilities] }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings }),
        config: unstubbed<Services["config"]>("config", { extensionsDir: "", ...baked }),
        // Read on every listing: a persona's kit skills are part of what the agent knows (the `persona` origin). Empty
        // is the default most cases here want.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [...personas] }),
    });

const settingsWith = (skills: readonly string[]): SandboxSettings => SandboxSettingsSchema.parse({ skills: [...skills] });

const writeSkill = async (dir: string, name: string, description: string, body = "Body."): Promise<void> => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, SKILL_FILE), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
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
    expect(rowFor(off, "lsp")).toMatchObject({ origin: "builtin", enabled: false, switchable: true, editable: false, removable: false });
    expect(rowFor(off, "lsp").description).toContain("Rename a TypeScript");

    const on = await skillInventory(stubServices(root, [], settingsWith(["lsp"])));
    expect(rowFor(on, "lsp").enabled).toBe(true);
});

test("an own skill is the only origin that is editable, and reads its enabled state from its loaded copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const services = stubServices(root, [], settingsWith(["release-notes"]));
    const skill = { name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." };
    await writeOwnSkill(services, skill);
    // Named in the settings list yet off: that list has no say over an own skill.
    expect(rowFor(await skillInventory(services), "release-notes").enabled).toBe(false);

    await switchOwnSkill(services, skill, true);
    const rows = await skillInventory(services);
    expect(rowFor(rows, "release-notes")).toMatchObject({
        origin: "own",
        description: "Use when drafting release notes.",
        enabled: true,
        switchable: true,
        editable: true,
        removable: true,
    });
    // Own skills sort first; the list opens on the half that answers to the owner.
    expect(rows[0]?.id).toBe("release-notes");
});

test("a plugin's skills are attributed to that plugin and offer no control of their own", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "my-pack", kind: "plugin", config: { url: "https://example.com/pack.git" } };
    await writeSkill(join(root, ".intentic", "records", "plugins", "my-pack", "skills"), "review", "Use when reviewing a diff.");

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

// A marketplace-hosted plugin's skills sit under its configured subdirectory, not the checkout root.
test("a plugin's subdirectory is honoured", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "market", kind: "plugin", config: { url: "https://example.com/m.git", path: "plugins/beta" } };
    await writeSkill(join(root, ".intentic", "records", "plugins", "market", "plugins", "beta", "skills"), "beta", "Use for beta things.");

    const rows = await skillInventory(stubServices(root, [plugin], settingsWith([])));
    expect(rowFor(rows, "plugin:market:beta").owner).toBe("market");
});

// An extension's skills attribute to the name its manifest declares, not the capability entry id, since the id is a
// routing handle the owner never chose. `contributes.agent.path` is honoured the same way a plugin's subdirectory is.
test("an extension's skills are attributed by its manifest name", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    // An extension entry pins a full commit sha: exactly the code the owner approved runs in their browser.
    const entry: Capability = { id: "ext-1", kind: "extension", config: { url: "https://example.com/ext.git", ref: "a".repeat(40) } };
    const checkout = join(root, ".intentic", "local", "extensions", "ext-1");
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

// The three-way fallback for an unclaimed directory in the loaded folder: a connection's skill and a loose file must
// not be confused with each other or with an owned one.
test("a connection's skill, a core feature's and a loose file are told apart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const loaded = join(root, ".agents", "skills");
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github" } };
    // Shared across every instance of its kind, so its directory is named for the kind, not one entry.
    const vpn: Capability = { id: "office", kind: "vpn", config: { provider: "wireguard", config: "[Interface]", autoConnect: "off" } };
    await writeSkill(loaded, "github", "Use for GitHub repos.");
    await writeSkill(loaded, "vpn", "Use to reach the office network.");
    await writeSkill(loaded, "approvals", "Use to prepare posts and actions for approval.");
    await writeSkill(loaded, "scratch", "Something the agent wrote itself.");

    const rows = await skillInventory(stubServices(root, [github, vpn], settingsWith([])));
    expect(rowFor(rows, "github")).toMatchObject({ origin: "capability", owner: "github", removable: false });
    expect(rowFor(rows, "vpn")).toMatchObject({ origin: "capability", owner: "office", removable: false });
    expect(rowFor(rows, "approvals")).toMatchObject({ origin: "builtin", owner: "Approvals", removable: false });
    // The `dropped` origin's home is the loaded folder itself, not the owner's store: removable but not editable.
    expect(rowFor(rows, "scratch")).toMatchObject({ origin: "dropped", removable: true, editable: false, switchable: false });
    // The `dropped` origin has no owner to send the reader to.
    expect(rowFor(rows, "scratch").owner).toBeUndefined();
});

// Shared-account skills attribute to the capability they're derived from: `identities` to an identity, a site group's
// skill to the browser account its group resolves to (platform slug for a carded site, home host for a generic one).
test("the identities skill and a site group's skill attribute to the accounts behind them", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const loaded = join(root, ".agents", "skills");
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const reddit: Capability = { id: "reddit-work", kind: "browser", config: { platform: "reddit" } };
    const hunt: Capability = { id: "hunt", kind: "browser", config: { platform: "website", homeUrl: "https://www.producthunt.com/" } };
    await writeSkill(loaded, "identities", "The sandbox's online identities.");
    await writeSkill(loaded, "reddit", "Act on Reddit.");
    await writeSkill(loaded, "producthunt-com", "Act on producthunt.com.");

    const rows = await skillInventory(stubServices(root, [main, reddit, hunt], settingsWith([])));
    expect(rowFor(rows, "identities")).toMatchObject({ origin: "capability", owner: "main", removable: false });
    expect(rowFor(rows, "reddit")).toMatchObject({ origin: "capability", owner: "reddit-work", removable: false });
    expect(rowFor(rows, "producthunt-com")).toMatchObject({ origin: "capability", owner: "hunt", removable: false });
});

// A switched-on baked tool or own skill also sits in the loaded folder; without dedup every controlled row would
// double.
test("a skill already accounted for is not listed a second time from the loaded folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const services = stubServices(root, [], settingsWith(["lsp", "notes"]));
    const notes = { name: "notes", description: "Use it.", body: "Body." };
    await writeOwnSkill(services, notes);
    await reconcileBakedSkills(services, ["lsp"]);
    await switchOwnSkill(services, notes, true);

    const rows = await skillInventory(services);
    expect(rows.filter((row) => row.name === "lsp")).toHaveLength(1);
    expect(rows.filter((row) => row.name === "notes")).toHaveLength(1);
    expect(rowFor(rows, "notes").origin).toBe("own");
});

// Every id `skillInventory` mints must read back the same skill via `readSkillText`; opening the wrong text is worse
// than failing to open. Covers a switched-off own skill (text lives in the store) and a switched-off baked tool (text
// lives in the registry).
test("every id the list mints reads back the right skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const plugin: Capability = { id: "my-pack", kind: "plugin", config: { url: "https://example.com/pack.git" } };
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    const baked = { iqPluginDir: join(root, "iq-plugin"), webqPluginDir: join(root, "webq-plugin") };
    const services = stubServices(root, [plugin], SandboxSettingsSchema.parse({ iqSearch: true }), [studio], baked);
    await writeOwnSkill(services, { name: "notes", description: "Use it.", body: "Stored body." });
    await writeSkill(join(root, ".intentic", "records", "plugins", "my-pack", "skills"), "review", "Use when reviewing.", "Plugin body.");
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });
    await writeSkill(join(baked.iqPluginDir, "skills"), "iq", "Workspace code search.", "Search body.");
    await writeSkill(join(baked.webqPluginDir, "skills"), "webq", "Web pages as markdown.", "Web body.");

    for (const row of await skillInventory(services)) {
        const found = await readSkillText(services, row.id);
        expect(found?.name, `reading ${row.id}`).toBe(row.name);
    }
    // Both switched off; no loaded copy, so the text has to come from the store and the registry.
    expect((await readSkillText(services, "notes"))?.text).toContain("Stored body.");
    expect((await readSkillText(services, "lsp"))?.text).toContain("Rename a TypeScript");
    expect((await readSkillText(services, "plugin:my-pack:review"))?.text).toContain("Plugin body.");
    // A kit skill's id carries the persona id; its row shows the label instead, which is not a key.
    expect((await readSkillText(services, "persona:studio:voice"))?.text).toContain("Kit body.");
    // A plugin the image ships reads from its own dir, never from a loaded or stored skill of the same name.
    expect((await readSkillText(services, "builtin:iq:iq"))?.text).toContain("Search body.");
    expect((await readSkillText(services, "builtin:webq:webq"))?.text).toContain("Web body.");
});

// A turn loads the image's webq plugin always and its iq plugin while iq search is on; neither has a switch on this list.
test("the image's iq and webq plugins list their skills, iq only while its setting is on", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const baked = { iqPluginDir: join(root, "iq-plugin"), webqPluginDir: join(root, "webq-plugin") };
    await writeSkill(join(baked.iqPluginDir, "skills"), "iq", "Workspace code search.");
    await writeSkill(join(baked.webqPluginDir, "skills"), "webq", "Web pages as markdown.");
    const fixed = { origin: "builtin", enabled: true, switchable: false, editable: false, removable: false } as const;

    const off = await skillInventory(stubServices(root, [], settingsWith([]), [], baked));
    expect(off.filter((row) => row.id.includes(":"))).toEqual([
        { id: "builtin:webq:webq", name: "webq", description: "Web pages as markdown.", owner: "Web pages", ...fixed },
    ]);

    const on = await skillInventory(stubServices(root, [], SandboxSettingsSchema.parse({ iqSearch: true }), [], baked));
    expect(on.filter((row) => row.id.includes(":"))).toEqual([
        { id: "builtin:iq:iq", name: "iq", description: "Workspace code search.", owner: "Code search", ...fixed },
        { id: "builtin:webq:webq", name: "webq", description: "Web pages as markdown.", owner: "Web pages", ...fixed },
    ]);
});

// A turn mounts a persona's kit only once its manifest exists, so skills in a folder without one are nothing a turn loads.
test("a persona's skills list only once its kit has the manifest a turn mounts it by", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    const services = stubServices(root, [], settingsWith([]), [studio]);
    await writeSkill(personaSkillsRoot(root, "studio"), "voice", "How we write.");
    expect((await skillInventory(services)).filter((row) => row.origin === "persona")).toEqual([]);

    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });
    expect((await skillInventory(services)).filter((row) => row.origin === "persona").map((row) => row.id)).toEqual(["persona:studio:voice"]);
});

// The one scan every skills folder goes through: the owner's store, a kit, a mounted plugin, the loaded folder.
describe("scanSkillFolders", () => {
    const readAny = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

    it("reads each folder's skill in name order, named by the folder, and skips what is not a skill", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "scan-")), "skills");
        await writeSkill(dir, "beta", "Second.", "Beta body.");
        await writeSkill(dir, "alpha", "First.", "Alpha body.");
        await mkdir(join(dir, "gamma"), { recursive: true });
        await writeFile(join(dir, "gamma", SKILL_FILE), "---\nname: other\n---\nGamma body.\n");
        await mkdir(join(dir, "half-written"), { recursive: true });
        await writeFile(join(dir, "loose.md"), "Not a skill.");

        expect(await scanSkillFolders(dir, readAny)).toEqual([
            { name: "alpha", description: "First.", body: "Alpha body.\n" },
            { name: "beta", description: "Second.", body: "Beta body.\n" },
            { name: "gamma", description: "", body: "Gamma body.\n" },
        ]);
    });

    it("lists an absent folder as none, and one it cannot list as none unless told to throw", async () => {
        const root = mkdtempSync(join(tmpdir(), "scan-"));
        expect(await scanSkillFolders(join(root, "absent"), readAny)).toEqual([]);
        expect(await scanSkillFolders(join(root, "absent"), readAny, "throw")).toEqual([]);
        // A link to itself fails with ELOOP for any user, root included, which is no kind of absence.
        await symlink(join(root, "loop"), join(root, "loop"));
        expect(await scanSkillFolders(join(root, "loop"), readAny)).toEqual([]);
        await expect(scanSkillFolders(join(root, "loop"), readAny, "throw")).rejects.toMatchObject({ code: "ELOOP" });
    });
});

// A kit skill lists, but narrowly: it must not read as available to every chat, and offers no switch since nothing here
// can turn it off, only the persona can.
test("a persona's own skill lists under its card, with no switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "inventory-"));
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    const services = stubServices(root, [], settingsWith([]), [studio]);
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });

    const row = rowFor(await skillInventory(services), "persona:studio:voice");

    expect(row).toMatchObject({ name: "voice", description: "How we write.", origin: "persona", owner: "Studio", enabled: true });
    expect(row.switchable).toBe(false);
    // Edited on the persona's card, like a plugin's skill is edited where it lives, not from this list.
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
