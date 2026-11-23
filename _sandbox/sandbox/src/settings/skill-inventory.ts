import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { type AgentMount, agentMounts } from "../agent/run/harness/agent-mounts.js";
import type { Services } from "../composition.js";
import { accountGroupOf } from "../capabilities/account-skills.js";
import { listRoleSkills, readRoleSkill, roleSkillsRoot } from "../roles/role-kit.js";
import { loadedSkillsRoot, skillWriterOf } from "../store/loaded-skills.js";
import { readSkillUses } from "../store/skills/skill-uses.js";
import { parseSkillFile, scanSkillFolders, SKILL_FILE, skillDocument } from "../skill-file.js";
import { retiredSkillReason } from "./skill-retirement.js";
import { bakedSkillNames, bakedSkillText, isBakedSkill, listOwnSkills, ownSkillDir, ownSkillOn } from "./skills.js";

// Reads everything the agent knows from six sources (baked tools, the owner's store, connections, plugins, extensions,
// roles) directly off disk, not a config projection; an unclaimed file lists as `dropped` rather than being skipped.
// What a row may do follows strictly from its origin:
// baked tools are switchable from the settings list, the owner's own from their loaded copy
// only the owner's own are editable
// `own` and `dropped` are removable; anything else is removed by removing its owner

// Features writing a skill outside the settings gate; a missing entry here just lists as `dropped`.
const FEATURE_SKILLS: Record<string, string> = {
    approvals: "Approvals",
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
const listedMounts = (services: Services, capabilities: readonly Capability[], roles: readonly Role[]) =>
    agentMounts(services, { capabilities, roles, extensions: undefined });

// Where the SDK's loader finds a mounted plugin's skills.
const skillsDirOf = (mount: AgentMount): string => join(mount.pluginDir, "skills");

// The order the owner reads mounted skills in: what this image ships, what they added, their cards', extensions'.
const MOUNT_ORIGINS = ["builtin", "plugin", "role", "extension"] as const;

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
    const [settings, own, capabilities, roles] = await Promise.all([
        services.sandboxSettings.get(),
        listOwnSkills(services),
        services.capabilities.list(),
        services.roles.list(),
    ]);
    const mounts = await listedMounts(services, capabilities, roles);
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
            const skills = origin === "role" ? await listRoleSkills(root, mount.id) : await scanSkillFolders(skillsDirOf(mount), read);
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

    // Joined by name, the one key a skill tool and a file read both carry; every row answers once the count exists, a
    // skill no turn has loaded since as zero.
    const uses = await readSkillUses(services.config.historyRoot);
    return rows.map((row) => ({ ...row, uses: uses.get(row.name) ?? { week: 0 } }));
};

// A baked tool's description, parsed from the registry's own skill text so there's no second copy to disagree with it;
// read from the registry since an off tool has no file on disk.
const bakedDescription = (name: string): string => parseSkillFile(bakedSkillText(name) ?? "").description ?? "";

// One skill as read by id: its text, the folder it lives in when there is one to list, and that folder as the workspace
// names it when it is the copy the agent reads.
export interface ReadSkill {
    readonly name: string;
    readonly text: string;
    // Absolute; absent for a baked tool, whose text is a string in the registry.
    readonly dir?: string;
    readonly folder?: string;
}

// Reads one skill by id, in the shapes the list mints (bare name, or `<origin>:<owner>:<name>`); always a fresh read,
// since the file may change after the list is drawn. A bare name tries the loaded copy, then the store, then the baked
// registry, in read order.
export const readSkill = async (services: Services, id: string): Promise<ReadSkill | undefined> => {
    const root = services.workspace.root;
    const [scope, owner, name] = id.split(":");
    // A kit skill's `owner` is the role id the list's id carries; the row's label is prettier but not a key.
    if (name !== undefined && owner !== undefined && scope === "role") {
        const skill = await readRoleSkill(root, owner, name);
        const dir = join(roleSkillsRoot(root, owner), name);
        return skill === undefined ? undefined : { name, text: skillDocument(skill.name, skill.description, skill.body), dir, folder: workspaceFolder(root, dir) };
    }
    // Outside the workspace: listed, never offered as a folder to open.
    if (name !== undefined && owner !== undefined && (scope === "builtin" || scope === "plugin" || scope === "extension")) {
        const capabilities = await services.capabilities.list();
        const mount = (await listedMounts(services, capabilities, [])).find((entry) => entry.origin === scope && entry.id === owner);
        if (mount === undefined) {
            return undefined;
        }
        const dir = join(skillsDirOf(mount), name);
        const text = await services.files.read(join(dir, SKILL_FILE));
        return text === undefined ? undefined : { name, text, dir };
    }
    // Any other colon-scope isn't minted here; treated as a literal name, so it just isn't found.
    const bare = scope ?? id;
    const loadedDir = join(loadedSkillsRoot(root), bare);
    const loaded = await services.files.read(join(loadedDir, SKILL_FILE));
    const stored = await services.files.read(join(ownSkillDir(root, bare), SKILL_FILE));
    // The owner's own is written through `skills.save`, which rewrites the loaded copy from the stored one, so its files
    // are listed from the store and no folder is offered: a hand edit to either would be undone or desync the two.
    if (stored !== undefined) {
        return { name: bare, text: loaded ?? stored, dir: ownSkillDir(root, bare) };
    }
    // A baked tool's loaded copy is the registry's string written out, rewritten on every reconcile.
    if (isBakedSkill(bare)) {
        const baked = loaded ?? bakedSkillText(bare);
        return baked === undefined ? undefined : { name: bare, text: baked };
    }
    return loaded === undefined ? undefined : { name: bare, text: loaded, dir: loadedDir, folder: workspaceFolder(root, loadedDir) };
};

/** The text alone, for a caller with no use for where it lives. */
export const readSkillText = async (services: Services, id: string): Promise<{ readonly name: string; readonly text: string } | undefined> => {
    const found = await readSkill(services, id);
    return found === undefined ? undefined : { name: found.name, text: found.text };
};

const workspaceFolder = (root: string, dir: string): string => relative(root, dir).split(sep).join("/");

// Enough for any skill a person wrote; a folder past it is a vendored tree, which a page of names would not help read.
const SKILL_FILES_CAP = 50;

/** The other files in a skill's folder, relative to it, SKILL.md left out, sorted and capped; none for no folder. */
export const skillFolderFiles = async (dir: string | undefined): Promise<string[]> => {
    if (dir === undefined) {
        return [];
    }
    // allow(silent-catch): a folder gone or unreadable since its SKILL.md was read lists nothing, as no folder does
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .filter((path) => path !== SKILL_FILE)
        .toSorted()
        .slice(0, SKILL_FILES_CAP);
};
