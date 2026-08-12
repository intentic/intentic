import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, SkillSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { enabledExtensions, type InstalledExtension } from "../extensions/installed-extensions.js";
import { pluginDir } from "../capabilities/plugin-dirs.js";
import { loadedSkillsRoot } from "./loaded-skills.js";
import { parseSkillFile } from "./skill-file.js";
import { bakedSkillNames, bakedSkillText, listOwnSkills, ownSkillDir } from "./skills.js";

/* EVERYTHING THE AGENT KNOWS RIGHT NOW, joined from the six places a skill can come from.
 *
 * This is a READ over what is actually on disk, not a projection of what the config asked for, and that is the
 * point: skills arrive from the daemon's own stores, from every connection the owner made, from inside extension
 * checkouts, and from plugin repos — and until this existed the only way to answer "what is my agent carrying"
 * was to open four directories. A skill costs the agent attention whether or not anyone remembers adding it, so
 * the list has to be complete before it can be useful, which is why an unclaimed file lists as `dropped` rather
 * than being skipped.
 *
 * WHAT EACH ROW MAY DO follows from where it came from, and nothing else:
 *   - the settings `skills` list governs baked tools and the owner's own, so those two get the switch
 *   - only the owner's own are editable — anything else would be overwritten by whatever ships it
 *   - `own` and `dropped` are removable; the rest are removed by removing their owner
 * A row that offered a control its origin cannot honour would be worse than one that offers none: the change
 * would appear to take and then come back on the next reconcile. */

// A skill directory that is not a directory of skills. `.agents/skills/<name>/SKILL.md` is the shape; anything
// without that file is a half-written skill the loaders also ignore.
const SKILL_FILE = "SKILL.md";

interface FoundSkill {
    readonly name: string;
    readonly description: string;
}

// Read one skill's declared description, or undefined when there is no readable SKILL.md under this directory.
// The DIRECTORY name is the skill's name everywhere here: it is what the loader keys a skill by, so a
// frontmatter `name:` that disagrees would label a row something the agent never answers to.
const readFound = async (services: Services, dir: string, name: string): Promise<FoundSkill | undefined> => {
    const text = await services.files.read(join(dir, name, SKILL_FILE));
    return text === undefined ? undefined : { name, description: parseSkillFile(text).description ?? "" };
};

// Every skill directly under a skills directory, in name order. A missing directory is an empty answer, not a
// failure: most sandboxes have no plugins, and an extension may ship an agent dir with no skills in it at all.
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

/* CORE FEATURES THAT SHIP A SKILL WITHOUT THE SETTINGS GATE — the two that write into the loaded folder on their
 * own schedule, mapped to the name the owner knows them by.
 *
 * A table, reluctantly, and the reluctance is worth writing down: this is a second place a core feature's skill
 * has to be remembered, which is the shape that goes stale. It is tolerable only because forgetting an entry
 * degrades gracefully — the skill still lists, as `dropped`, with no owner — rather than vanishing or lying. What
 * it buys is that neither of these reads as a loose file the owner is invited to delete, since the feature behind
 * it would simply write it again. */
const FEATURE_SKILLS: Record<string, string> = {
    drafts: "Drafts",
    iq: "Code search",
};

// A capability whose id is a loaded skill's directory name, or — for the connections that share ONE skill across
// every instance (ssh, vpn) — one whose KIND is. Two matches rather than a hardcoded pair of names, so a kind
// that starts writing a shared cheatsheet is attributed without an edit here.
const capabilityFor = (capabilities: readonly Capability[], name: string): Capability | undefined =>
    capabilities.find((capability) => capability.id === name) ?? capabilities.find((capability) => capability.kind === name);

/* WHERE A PLUGIN'S AND AN EXTENSION'S SKILLS SIT — the same two derivations the turn's plugin list makes
 * (plugin-dirs.ts, extensionAgentDirsOf), pointed one level deeper at the `skills` folder inside. Shared with the
 * read route rather than repeated there: the list and the reader must resolve one id to one file, and two
 * spellings of that path is how a row opens something other than what it named. */
export const pluginSkillsDir = (root: string, capability: Extract<Capability, { kind: "plugin" }>): string => {
    const checkout = pluginDir(root, capability.id);
    return join(capability.config.path === undefined ? checkout : join(checkout, capability.config.path), "skills");
};

export const extensionSkillsDir = (extension: InstalledExtension): string | undefined => {
    const agent = extension.manifest.contributes?.agent;
    return agent === undefined ? undefined : join(agent.path === undefined ? extension.dir : join(extension.dir, agent.path), "skills");
};

const summary = (fields: Omit<SkillSummary, "switchable" | "editable" | "removable"> & Partial<SkillSummary>): SkillSummary => ({
    switchable: false,
    editable: false,
    removable: false,
    ...fields,
});

/* The join. Ordered by how much the reader owns: their own first, then what this image ships, then what each
 * thing they added brought, then the loose files — so the list opens on the half that answers to them.
 *
 * `enabled` is read per origin rather than uniformly, because the sources disagree about what "on" means. A baked
 * tool or an own skill is on when the settings list names it. Everything else is on because the thing that ships
 * it is installed and switched on — a disabled extension is already filtered out of `enabledExtensions`, so a
 * row that reaches here at all is loaded. */
export const skillInventory = async (services: Services): Promise<SkillSummary[]> => {
    const root = services.workspace.root;
    const [settings, own, capabilities, extensions] = await Promise.all([
        services.sandboxSettings.get(),
        listOwnSkills(services),
        services.capabilities.list(),
        enabledExtensions(services),
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
                enabled: enabled(skill.name),
                switchable: true,
                editable: true,
                removable: true,
            }),
        );
    }

    /* The baked tools, whether or not they are on — the one place this list shows something that is NOT currently
     * loaded, because a switched-off baked tool is an offer rather than an absence and a list that hid it would
     * make the tool undiscoverable exactly the way an empty `skills` array once made `lsp` undiscoverable. */
    for (const name of bakedSkillNames()) {
        rows.push(summary({ id: name, name, description: bakedDescription(name), origin: "builtin", enabled: enabled(name), switchable: true }));
    }

    // The plugin repos the owner cloned, and the extensions they installed — both read through the same skills
    // dir the SDK's loader reads, so this list cannot claim a skill the agent would not find.
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

    /* THE LOADED FOLDER LAST, for whatever the four passes above have not already accounted for: the cheatsheet a
     * connection wrote, a core feature's skill, or a file somebody dropped in. Claimed names are skipped rather
     * than re-listed — a baked tool that is currently on is present here too, and it is the same skill. */
    const claimed = new Set([...own.map((skill) => skill.name), ...bakedSkillNames()]);
    for (const skill of await scanSkillsDir(services, loadedSkillsRoot(root))) {
        if (claimed.has(skill.name)) {
            continue;
        }
        const feature = FEATURE_SKILLS[skill.name];
        if (feature !== undefined) {
            rows.push(summary({ id: skill.name, name: skill.name, description: skill.description, origin: "builtin", owner: feature, enabled: true }));
            continue;
        }
        const provider = capabilityFor(capabilities, skill.name);
        if (provider !== undefined) {
            rows.push(summary({ id: skill.name, name: skill.name, description: skill.description, origin: "capability", owner: provider.id, enabled: true }));
            continue;
        }
        rows.push(summary({ id: skill.name, name: skill.name, description: skill.description, origin: "dropped", enabled: true, removable: true }));
    }

    return rows;
};

// A baked tool's description, parsed out of the registry's own skill text rather than restated here — that text
// IS the file the agent reads, so there is no second copy to disagree with it. Read from the registry rather than
// from disk because a switched-off baked tool has no file, and its row still has to say what it would teach.
const bakedDescription = (name: string): string => parseSkillFile(bakedSkillText(name) ?? "").description ?? "";

/* ONE SKILL'S TEXT, from whichever of the six places its id names — what the read route answers with.
 *
 * The id shapes are the list's own (SkillSummarySchema): a bare name for anything living in the loaded folder or
 * the owner's store, and `<origin>:<owner>:<name>` for a skill inside a plugin checkout or an extension. Reading
 * is a fresh resolution rather than a lookup against a cached list, because the file may have changed since the
 * list was drawn — an agent editing its own skill mid-session is the normal case, not the exotic one.
 *
 * A bare name is tried in three places, in the order that answers with what the AGENT would read: the loaded copy
 * first, then the owner's store (a skill switched off still has text worth reading), then the baked registry (a
 * switched-off baked tool has no file at all). Undefined when none of them hold it. */
export const readSkillText = async (services: Services, id: string): Promise<{ readonly name: string; readonly text: string } | undefined> => {
    const root = services.workspace.root;
    const [scope, owner, name] = id.split(":");
    if (name !== undefined && owner !== undefined && (scope === "plugin" || scope === "extension")) {
        const dir = scope === "plugin" ? await pluginDirFor(services, owner) : await extensionDirFor(services, owner);
        if (dir === undefined) {
            return undefined;
        }
        const text = await services.files.read(join(dir, name, SKILL_FILE));
        return text === undefined ? undefined : { name, text };
    }
    // A bare name. `id.split` always yields at least one element, and anything with a colon that is not one of the
    // two scopes above is not an id this daemon mints — treat it as the name it claims to be and fail to find it.
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
