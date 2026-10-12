import { join } from "node:path";
import type { Capability, Persona, SandboxSettings, SkillSummary } from "@intentic/sandbox-contract";
import { type AgentMount, agentMounts } from "../agent/run/harness/agent-mounts.js";
import type { Services } from "../composition.js";
import { accountGroupOf } from "../capabilities/account-skills.js";
import { listPersonaSkills, readPersonaSkill } from "../personas/persona-kit.js";
import { loadedSkillsRoot, skillWriterOf } from "../store/loaded-skills.js";
import { parseSkillFile, scanSkillFolders, SKILL_FILE, skillDocument } from "../skill-file.js";
import { retiredSkillReason } from "./skill-retirement.js";
import { bakedSkillNames, bakedSkillText, listOwnSkills, ownSkillDir, ownSkillOn } from "./skills.js";

// Reads everything the agent knows from six sources (baked tools, the owner's store, connections, plugins, extensions,
// personas) directly off disk, not a config projection; an unclaimed file lists as `dropped` rather than being skipped.
// What a row may do follows strictly from its origin:
// baked tools are switchable from the settings list, the owner's own from their loaded copy
// only the owner's own are editable
// `own` and `dropped` are removable; anything else is removed by removing its owner

// Features writing a skill outside the settings gate; a missing entry here just lists as `dropped`.
const FEATURE_SKILLS: Record<string, string> = {
    approvals: "Approvals",
    iq: "Code search",
};

// Owner labels for a loaded skill the sandbox wrote that nothing above claims: one a release retired (it goes at the next
// restart), and one a daemon writer stamped whose source is not otherwise named.
export const RETIRED_OWNER = "Retired by this release, removed at the next restart";
export const SANDBOX_OWNER = "Sandbox";

// Who a loaded skill nothing above claimed belongs to, in this order: a core feature, a daemon leftover the next boot's
// retirement pass takes away (settings/skill-retirement.ts), a connection, any other skill a daemon writer stamped, and
// only then the owner's own drop, the one row removable here.
const loadedOrigin = (
    name: string,
    text: string | undefined,
    capabilities: readonly Capability[],
): Pick<SkillSummary, "origin"> & Partial<Pick<SkillSummary, "owner" | "removable">> => {
    const feature = FEATURE_SKILLS[name];
    if (feature !== undefined) {
        return { origin: "builtin", owner: feature };
    }
    if (text !== undefined && retiredSkillReason(name, text) !== undefined) {
        return { origin: "builtin", owner: RETIRED_OWNER };
    }
    const provider = capabilityFor(capabilities, name);
    if (provider !== undefined) {
        return { origin: "capability", owner: provider.id };
    }
    if (text !== undefined && skillWriterOf(text) !== undefined) {
        return { origin: "builtin", owner: SANDBOX_OWNER };
    }
    return { origin: "dropped", removable: true };
};

// Resolves a loaded skill's directory name to the capability it names, or, for a shared skill (a kind's own cheatsheet,
// the `identities` roster, a site group), the capability it's derived from. Matched rather than hardcoded, so the owner
// column always names a real entry.
const capabilityFor = (capabilities: readonly Capability[], name: string): Capability | undefined =>
    capabilities.find((capability) => capability.id === name) ??
    capabilities.find((capability) => capability.kind === name) ??
    (name === "identities" ? capabilities.find((capability) => capability.kind === "identity") : undefined) ??
    capabilities.find((capability) => capability.kind === "browser" && accountGroupOf(capability.config).name === name);

// What a turn wearing any card may mount, from the call the turn itself makes; the list and the reader resolve ids by it.
const listedMounts = (services: Services, settings: SandboxSettings, capabilities: readonly Capability[], personas: readonly Persona[]) =>
    agentMounts(services, { iqLoaded: settings.iqSearch, capabilities, personas, extensions: undefined });

// Where the SDK's loader finds a mounted plugin's skills.
const skillsDirOf = (mount: AgentMount): string => join(mount.pluginDir, "skills");

// The order the owner reads mounted skills in: what this image ships, what they added, their cards', extensions'.
const MOUNT_ORIGINS = ["builtin", "plugin", "persona", "extension"] as const;

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
    const [settings, own, capabilities, personas] = await Promise.all([
        services.sandboxSettings.get(),
        listOwnSkills(services),
        services.capabilities.list(),
        services.personas.list(),
    ]);
    const mounts = await listedMounts(services, settings, capabilities, personas);
    const read = (path: string): Promise<string | undefined> => services.files.read(path);
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

    // Read from each mount's own skills dir, so the list can't claim a skill the agent wouldn't find; a kit's is on while worn.
    for (const origin of MOUNT_ORIGINS) {
        for (const mount of mounts.filter((entry) => entry.origin === origin)) {
            const skills = origin === "persona" ? await listPersonaSkills(root, mount.id) : await scanSkillFolders(skillsDirOf(mount), read);
            for (const skill of skills) {
                const id = `${origin}:${mount.id}:${skill.name}`;
                rows.push(summary({ id, name: skill.name, description: skill.description, origin, owner: mount.owner, enabled: true }));
            }
        }
    }

    // Loaded folder scanned last, for whatever the passes above didn't claim: a connection's cheatsheet, a core
    // feature's skill, or a dropped file. Claimed names are skipped rather than relisted; an already-on baked tool is
    // the same skill, not a duplicate.
    const claimed = new Set([...own.map((skill) => skill.name), ...bakedSkillNames()]);
    for (const skill of await scanSkillFolders(loadedSkillsRoot(root), read)) {
        if (!claimed.has(skill.name)) {
            const text = await read(join(loadedSkillsRoot(root), skill.name, SKILL_FILE));
            rows.push(summary({ id: skill.name, name: skill.name, description: skill.description, enabled: true, ...loadedOrigin(skill.name, text, capabilities) }));
        }
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
    if (name !== undefined && owner !== undefined && (scope === "builtin" || scope === "plugin" || scope === "extension")) {
        const [settings, capabilities] = await Promise.all([services.sandboxSettings.get(), services.capabilities.list()]);
        const mount = (await listedMounts(services, settings, capabilities, [])).find((entry) => entry.origin === scope && entry.id === owner);
        if (mount === undefined) {
            return undefined;
        }
        const text = await services.files.read(join(skillsDirOf(mount), name, SKILL_FILE));
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
