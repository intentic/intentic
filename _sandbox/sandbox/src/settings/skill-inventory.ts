import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, SkillSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { enabledExtensions, type InstalledExtension } from "../extensions/installed-extensions.js";
import { accountGroupOf } from "../capabilities/account-skills.js";
import { pluginDir } from "../capabilities/plugin-dirs.js";
import { listPersonaSkills, readPersonaSkill } from "../personas/persona-kit.js";
import { loadedSkillsRoot } from "./loaded-skills.js";
import { parseSkillFile, skillDocument } from "./skill-file.js";
import { bakedSkillNames, bakedSkillText, listOwnSkills, ownSkillDir, ownSkillOn } from "./skills.js";

// Reads everything the agent knows from six sources (baked tools, the owner's store, connections, plugins, extensions,
// personas) directly off disk, not a config projection; an unclaimed file lists as `dropped` rather than being skipped.
// What a row may do follows strictly from its origin:
// baked tools are switchable from the settings list, the owner's own from their loaded copy
// only the owner's own are editable
// `own` and `dropped` are removable; anything else is removed by removing its owner

// `.agents/skills/<name>/SKILL.md` is the shape; a directory without that file is not a skill.
const SKILL_FILE = "SKILL.md";

interface FoundSkill {
    readonly name: string;
    readonly description: string;
}

// Reads one skill's description, or undefined without a readable SKILL.md. The directory name is the skill's name
// everywhere here, not whatever its frontmatter `name:` says.
const readFound = async (services: Services, dir: string, name: string): Promise<FoundSkill | undefined> => {
    const text = await services.files.read(join(dir, name, SKILL_FILE));
    return text === undefined ? undefined : { name, description: parseSkillFile(text).description ?? "" };
};

// Every skill directly under a skills directory, in name order. A missing directory is an empty answer, not a failure.
const scanSkillsDir = async (services: Services, dir: string): Promise<FoundSkill[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found: FoundSkill[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const skill = await readFound(services, dir, entry.name);
        if (skill !== undefined) {
            found.push(skill);
        }
    }
    return found;
};

// Features writing a skill outside the settings gate; a missing entry here just lists as `dropped`.
const FEATURE_SKILLS: Record<string, string> = {
    approvals: "Approvals",
    iq: "Code search",
};

// Resolves a loaded skill's directory name to the capability it names, or, for a shared skill (a kind's own cheatsheet,
// the `identities` roster, a site group), the capability it's derived from. Matched rather than hardcoded, so the owner
// column always names a real entry.
const capabilityFor = (capabilities: readonly Capability[], name: string): Capability | undefined =>
    capabilities.find((capability) => capability.id === name) ??
    capabilities.find((capability) => capability.kind === name) ??
    (name === "identities" ? capabilities.find((capability) => capability.kind === "identity") : undefined) ??
    capabilities.find((capability) => capability.kind === "browser" && accountGroupOf(capability.config).name === name);

// Same directory derivation the turn's plugin/extension list uses, pointed one level deeper at `skills`. Shared with
// the read route below, so the list and the reader always resolve one id to the same file.
const pluginSkillsDir = (root: string, capability: Extract<Capability, { kind: "plugin" }>): string => {
    const checkout = pluginDir(root, capability.id);
    return join(capability.config.path === undefined ? checkout : join(checkout, capability.config.path), "skills");
};

const extensionSkillsDir = (extension: InstalledExtension): string | undefined => {
    const agent = extension.manifest.contributes?.agent;
    return agent === undefined ? undefined : join(agent.path === undefined ? extension.dir : join(extension.dir, agent.path), "skills");
};

const summary = (fields: Omit<SkillSummary, "switchable" | "editable" | "removable"> & Partial<SkillSummary>): SkillSummary => ({
    switchable: false,
    editable: false,
    removable: false,
    ...fields,
});

// Joins every source, ordered by how much the reader owns: their own first, then what ships in this image, then what
// they added, then loose files. `enabled` is read per origin, since each source means something different by "on".
export const skillInventory = async (services: Services): Promise<SkillSummary[]> => {
    const root = services.workspace.root;
    const [settings, own, capabilities, extensions, personas] = await Promise.all([
        services.sandboxSettings.get(),
        listOwnSkills(services),
        services.capabilities.list(),
        enabledExtensions(services),
        services.personas.list(),
    ]);
    const enabled = (name: string): boolean => settings.skills.includes(name);
    const rows: SkillSummary[] = [];

    for (const skill of own) {
        rows.push(
            summary({
                id: skill.name,
                name: skill.name,
                description: skill.description,
                origin: "own",
                // On exactly while its loaded copy exists; the settings list has no say over the owner's files.
                enabled: await ownSkillOn(services, skill.name),
                switchable: true,
                editable: true,
                removable: true,
            }),
        );
    }

    // Baked tools list even when off: an off switch is an offer, not an absence, and hiding it would make the tool
    // undiscoverable.
    for (const name of bakedSkillNames()) {
        rows.push(summary({ id: name, name, description: bakedDescription(name), origin: "builtin", enabled: enabled(name), switchable: true }));
    }

    // Plugin repos and installed extensions are both read through the same skills dir the SDK's loader reads, so the
    // list can't claim a skill the agent wouldn't find.
    for (const capability of capabilities.filter((entry) => entry.kind === "plugin")) {
        for (const skill of await scanSkillsDir(services, pluginSkillsDir(root, capability))) {
            rows.push(
                summary({
                    id: `plugin:${capability.id}:${skill.name}`,
                    name: skill.name,
                    description: skill.description,
                    origin: "plugin",
                    owner: capability.id,
                    enabled: true,
                }),
            );
        }
    }

    // Persona kit skills list too: a skill only some turns reach is still something the agent knows. No switch, since a
    // kit skill is on exactly when its persona is worn (persona-kit.ts); edited on the card, not here.
    for (const persona of personas) {
        for (const skill of await listPersonaSkills(root, persona.id)) {
            rows.push(
                summary({
                    id: `persona:${persona.id}:${skill.name}`,
                    name: skill.name,
                    description: skill.description,
                    origin: "persona",
                    owner: persona.label ?? persona.id,
                    enabled: true,
                }),
            );
        }
    }

    for (const extension of extensions) {
        const dir = extensionSkillsDir(extension);
        if (dir === undefined) {
            continue;
        }
        for (const skill of await scanSkillsDir(services, dir)) {
            rows.push(
                summary({
                    id: `extension:${extension.id}:${skill.name}`,
                    name: skill.name,
                    description: skill.description,
                    origin: "extension",
                    owner: extension.manifest.name,
                    enabled: true,
                }),
            );
        }
    }

    // Loaded folder scanned last, for whatever the passes above didn't claim: a connection's cheatsheet, a core
    // feature's skill, or a dropped file. Claimed names are skipped rather than relisted; an already-on baked tool is
    // the same skill, not a duplicate.
    const claimed = new Set([...own.map((skill) => skill.name), ...bakedSkillNames()]);
    for (const skill of await scanSkillsDir(services, loadedSkillsRoot(root))) {
        if (claimed.has(skill.name)) {
            continue;
        }
        const feature = FEATURE_SKILLS[skill.name];
        if (feature !== undefined) {
            rows.push(
                summary({ id: skill.name, name: skill.name, description: skill.description, origin: "builtin", owner: feature, enabled: true }),
            );
            continue;
        }
        const provider = capabilityFor(capabilities, skill.name);
        if (provider !== undefined) {
            rows.push(
                summary({
                    id: skill.name,
                    name: skill.name,
                    description: skill.description,
                    origin: "capability",
                    owner: provider.id,
                    enabled: true,
                }),
            );
            continue;
        }
        rows.push(summary({ id: skill.name, name: skill.name, description: skill.description, origin: "dropped", enabled: true, removable: true }));
    }

    return rows;
};

// A baked tool's description, parsed from the registry's own skill text so there's no second copy to disagree with it;
// read from the registry since an off tool has no file on disk.
const bakedDescription = (name: string): string => parseSkillFile(bakedSkillText(name) ?? "").description ?? "";

// Reads one skill's text by id, in the shapes the list mints (bare name, or `<origin>:<owner>:<name>`); always a fresh
// read, since the file may change after the list is drawn. A bare name tries the loaded copy, then the store, then the
// baked registry, in read order.
export const readSkillText = async (services: Services, id: string): Promise<{ readonly name: string; readonly text: string } | undefined> => {
    const root = services.workspace.root;
    const [scope, owner, name] = id.split(":");
    // A kit skill's `owner` is the persona id the list's id carries; the row's label is prettier but not a key.
    if (name !== undefined && owner !== undefined && scope === "persona") {
        const skill = await readPersonaSkill(root, owner, name);
        return skill === undefined ? undefined : { name, text: skillDocument(skill.name, skill.description, skill.body) };
    }
    if (name !== undefined && owner !== undefined && (scope === "plugin" || scope === "extension")) {
        const dir = scope === "plugin" ? await pluginDirFor(services, owner) : await extensionDirFor(services, owner);
        if (dir === undefined) {
            return undefined;
        }
        const text = await services.files.read(join(dir, name, SKILL_FILE));
        return text === undefined ? undefined : { name, text };
    }
    // Any other colon-scope isn't minted here; treated as a literal name, so it just isn't found.
    const bare = scope ?? id;
    const loaded = await services.files.read(join(loadedSkillsRoot(root), bare, SKILL_FILE));
    if (loaded !== undefined) {
        return { name: bare, text: loaded };
    }
    const stored = await services.files.read(join(ownSkillDir(root, bare), SKILL_FILE));
    if (stored !== undefined) {
        return { name: bare, text: stored };
    }
    const baked = bakedSkillText(bare);
    return baked === undefined ? undefined : { name: bare, text: baked };
};

const pluginDirFor = async (services: Services, id: string): Promise<string | undefined> => {
    const capability = (await services.capabilities.list()).find((entry) => entry.kind === "plugin" && entry.id === id);
    return capability?.kind === "plugin" ? pluginSkillsDir(services.workspace.root, capability) : undefined;
};

const extensionDirFor = async (services: Services, id: string): Promise<string | undefined> => {
    const extension = (await enabledExtensions(services)).find((entry) => entry.id === id);
    return extension === undefined ? undefined : extensionSkillsDir(extension);
};
