import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, type Persona, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { extensionDir } from "../../../capabilities/extension-dirs.js";
import { pluginDir } from "../../../capabilities/plugin-dirs.js";
import type { Services } from "../../../composition.js";
import { personaKitDir, writePersonaSkill } from "../../../personas/persona-kit.js";
import { turnPersona } from "../../../personas/personas.js";
import { skillInventory } from "../../../settings/skill-inventory.js";
import { scanSkillFolders, SKILL_FILE } from "../../../skill-file.js";
import { testConfig } from "../../../testing.js";
import { readWorkspaceFile } from "../../../workspace/files/workspace-files.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import * as harnessCredentialsOriginal from "../../providers/harness-credentials.js";
import { context, harnessServices, turn } from "../turn/turn-plan.testing.js";
import { planHarnessTurn } from "./harness-plan.js";

// Only the credential and the browser bring-up are faked; neither has a say in what a turn mounts.
jest.mock("../../providers/harness-credentials.js", async () => ({
    ...harnessCredentialsOriginal,
    resolveHarnessCredentials: async () => ({ ok: true, credentials: { oauthToken: "***", account: "acc-1" } }),
}));
jest.mock("../../../browser/tools/browser-tools.js", () => ({
    ROUTED_BROWSER_SERVER: "browser",
    ANONYMOUS_BROWSER_SERVER: "web",
    browserServersOf: async () => ({ servers: [], accounts: {}, ports: {}, passkeys: {} }),
    prepareBrowserOwner: jest.fn(),
}));

const writeSkill = async (dir: string, name: string, description: string): Promise<void> => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, SKILL_FILE), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
};

// One skill behind each kind of mount: the image's two plugins, a plugin capability, an extension's agent plugin, a kit.
const workspaceWithEveryMount = async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-mounts-"));
    const iqPluginDir = join(root, "image", "iq-plugin");
    const webqPluginDir = join(root, "image", "webq-plugin");
    await writeSkill(join(iqPluginDir, "skills"), "iq", "Workspace code search.");
    await writeSkill(join(webqPluginDir, "skills"), "webq", "Web pages as markdown.");
    const plugin: Capability = { id: "my-pack", kind: "plugin", config: { url: "https://example.com/pack.git" } };
    await writeSkill(join(pluginDir(root, "my-pack"), "skills"), "review", "Use when reviewing a diff.");
    // An extension entry pins a full commit sha, and its agent plugin sits where `contributes.agent.path` says.
    const extension: Capability = { id: "ext-1", kind: "extension", config: { url: "https://example.com/ext.git", ref: "a".repeat(40) } };
    const checkout = extensionDir(root, "ext-1");
    await mkdir(checkout, { recursive: true });
    const manifest = { publisher: "acme", name: "knowledge", version: "1.0.0", engines: { intentic: "^2.1.0" }, contributes: { agent: { path: "plugin" } } };
    await writeFile(join(checkout, "intentic-extension.json"), JSON.stringify(manifest));
    await writeSkill(join(checkout, "plugin", "skills"), "knowledge", "Use when the user asks about their notes.");
    const studio: Persona = { id: "studio", label: "Studio", capabilities: [] };
    await writePersonaSkill(root, "studio", "Studio", { name: "voice", description: "How we write.", body: "Kit body." });
    const services = harnessServices({
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        config: { ...testConfig, iqPluginDir, webqPluginDir },
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [plugin, extension] }),
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [studio] }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ iqSearch: true }) }),
    });
    return { root, services, plugin, studio, iqPluginDir, webqPluginDir, checkout };
};

test("the Skills list names exactly the skills under the plugin dirs a turn mounts", async () => {
    const { root, services, plugin, studio, iqPluginDir, webqPluginDir, checkout } = await workspaceWithEveryMount();
    const wearing = turnPersona({ personas: [studio], actsAs: "studio", unattended: false });

    const plan = await planHarnessTurn(services, turn(), { ...context, persona: wearing }, [plugin]);
    const mounted = (plan as { request: AgentRequest }).request.tools.plugins ?? [];
    expect(mounted).toEqual([iqPluginDir, webqPluginDir, pluginDir(root, "my-pack"), join(checkout, "plugin"), personaKitDir(root, "studio")]);

    const loaded = await Promise.all(mounted.map((dir) => scanSkillFolders(join(dir, "skills"), readWorkspaceFile)));
    const listed = (await skillInventory(services)).filter((row) => row.id.includes(":"));
    expect(listed.map((row) => row.name).toSorted()).toEqual(
        loaded
            .flat()
            .map((skill) => skill.name)
            .toSorted(),
    );
    expect(listed.map((row) => row.id)).toEqual([
        "builtin:iq:iq",
        "builtin:webq:webq",
        "plugin:my-pack:review",
        "persona:studio:voice",
        "extension:ext-1:knowledge",
    ]);
});

// An extension's agent plugin loads into a turn only when the persona it wears is granted that extension: its
// `extensions` shelf, absent meaning every one, naming the extension, or empty meaning none.
test("a turn loads an extension's agent plugin only when its persona's extensions shelf grants that extension", async () => {
    const { root, services, plugin, iqPluginDir, webqPluginDir, checkout } = await workspaceWithEveryMount();
    const pluginsWearing = async (extensions: readonly string[]): Promise<readonly string[]> => {
        const persona: Persona = { id: "narrow", label: "Narrow", capabilities: [], powers: { ...turnPersona({ personas: [], actsAs: undefined, unattended: false }).powers, extensions: [...extensions] } };
        const wearing = turnPersona({ personas: [persona], actsAs: "narrow", unattended: false });
        const plan = await planHarnessTurn(services, turn(), { ...context, persona: wearing }, [plugin]);
        return (plan as { request: AgentRequest }).request.tools.plugins ?? [];
    };
    expect(await pluginsWearing([])).toEqual([iqPluginDir, webqPluginDir, pluginDir(root, "my-pack")]);
    expect(await pluginsWearing(["someone.else"])).toEqual([iqPluginDir, webqPluginDir, pluginDir(root, "my-pack")]);
    expect(await pluginsWearing(["ext-1"])).toEqual([iqPluginDir, webqPluginDir, pluginDir(root, "my-pack"), join(checkout, "plugin")]);
    // A persona named but missing gets nothing at all, this included.
    const missing = turnPersona({ personas: [], actsAs: "gone", unattended: false });
    const refused = await planHarnessTurn(services, turn(), { ...context, persona: missing }, []);
    expect((refused as { request: AgentRequest }).request.tools.plugins ?? []).not.toContain(join(checkout, "plugin"));
});
