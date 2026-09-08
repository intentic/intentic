import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserConfig, Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { accountSkillLine, browserToolsNote, identitiesSkill, rosterSummary } from "../browser/tools/browser-skill.js";
import { loadedSkillFile, loadedSkillsRoot, removeLoadedSkill, writeLoadedSkill } from "../settings/loaded-skills.js";
import type { CapabilityCtx } from "./capability.js";
import { contributionKey, contributionRegistry, hostOf } from "./contributions.js";
import { extensionRead } from "./extension-dirs.js";

// One skill per kind, not per account: `identities` lists every identity as a roster line, each site group renders
// once.
// Whole set rebuilt on every apply/remove/rename; routes pass a pending delta since apply runs before the upsert.
// Staleness swept by marker, not memory: every written skill carries ACCOUNT_SKILL_MARKER; unmarked files are
// untouched.

const ACCOUNT_SKILL_MARKER = "<!-- managed by the sandbox: derived from the connected accounts; edits are overwritten -->";

const IDENTITIES_SKILL = "identities";
// Card with no site of its own (open-account.ts GENERIC); the only platform grouped by host instead of slug.
const GENERIC_PLATFORM = "website";

// Skill directory name from a host: www.producthunt.com to producthunt-com; names must be slug-shaped for loaders and
// matchers.
const hostSlug = (host: string): string =>
    host
        .replace(/^www\./, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

const siteHost = (config: BrowserConfig): string | undefined => {
    const url = config["homeUrl"] ?? config["loginUrl"];
    if (url === undefined || url === "") {
        return undefined;
    }
    try {
        return new URL(url).host.replace(/^www\./, "");
    } catch {
        return undefined;
    }
};

// Which skill an account belongs to: the platform slug for a carded site, or the home page's host for the generic card.
// Pure over the config, since the status probe and skill inventory both need this without a registry in hand.
export const accountGroupOf = (config: BrowserConfig): { readonly name: string; readonly site: string } => {
    if (config.platform !== GENERIC_PLATFORM) {
        return { name: config.platform, site: config.platform };
    }
    const host = siteHost(config);
    return host === undefined ? { name: GENERIC_PLATFORM, site: "the connected site" } : { name: hostSlug(host), site: host };
};

// Whether the converge has landed this entry on its skill: checks for the roster line's backticked id.
export const accountSkillNames = (skillText: string | undefined, id: string): boolean => skillText !== undefined && skillText.includes(`- \`${id}\``);

// Pending change the routes haven't written yet: apply runs before the upsert, remove before the delete.
export interface AccountSkillDelta {
    readonly upsert?: Capability;
    readonly omit?: string;
}

const effectiveEntries = async (ctx: CapabilityCtx, delta?: AccountSkillDelta): Promise<Capability[]> => {
    const entries = (await ctx.capabilities.list()).filter((entry) => entry.id !== delta?.omit && entry.id !== delta?.upsert?.id);
    return delta?.upsert === undefined ? entries : [...entries, delta.upsert];
};

// Frontmatter surgery on the rendered pack: sets the group's name (one skill per group, not per card instance), stamps
// the marker, and appends account ids to the description via rosterSummary (paid every call, unlike the roster block).
const stampGroupSkill = (source: string, name: string, ids: readonly string[]): string =>
    source
        .replace(/^name: .*$/m, `name: ${name}`)
        .replace(/^(description: .*)$/m, `$1 Connected accounts: ${rosterSummary(ids)}.`)
        .replace(/^---\n([\s\S]*?)\n---\n/, (frontmatter) => `${frontmatter}\n${ACCOUNT_SKILL_MARKER}\n`);

const stampIdentitiesSkill = (source: string): string =>
    source.replace(/^---\n([\s\S]*?)\n---\n/, (frontmatter) => `${frontmatter}\n${ACCOUNT_SKILL_MARKER}\n`);

// Renders one site group's skill for all its accounts: substitutes ${tools}, ${accounts} (roster block) and ${site}.
// Undefined when the pack's file is missing (a rotted install), which apply turns into a failed add.
const renderGroupSkill = async (
    ctx: CapabilityCtx,
    group: { readonly name: string; readonly site: string },
    accounts: readonly { readonly id: string; readonly config: BrowserConfig }[],
    identities: ReadonlyMap<string, IdentityConfig>,
): Promise<string | undefined> => {
    const registry = await contributionRegistry(hostOf(ctx));
    const contribution = registry.get(contributionKey("browser", accounts[0]?.config.platform ?? ""));
    if (contribution === undefined || !("skill" in contribution.spec)) {
        return undefined;
    }
    const source = await extensionRead(join(contribution.extension.dir, contribution.spec.skill));
    if (source === undefined) {
        return undefined;
    }
    const roster = [
        "Accounts on this skill: each backticked id is the `account` value every browser and accounts tool takes:",
        ...accounts.map((account) => accountSkillLine(account.id, account.config, identities.get(account.config.identity ?? "")?.email)),
    ].join("\n");
    const rendered = source.replaceAll("${tools}", browserToolsNote()).replaceAll("${accounts}", roster).replaceAll("${site}", group.site);
    return stampGroupSkill(
        rendered,
        group.name,
        accounts.map((account) => account.id),
    );
};

// Every marked skill in the loaded folder, the sweep's candidates; names read like loaded-skills.ts, content through
// the files seam.
const markedSkillNames = async (ctx: CapabilityCtx): Promise<string[]> => {
    const entries = await readdir(loadedSkillsRoot(ctx.workspace.root), { withFileTypes: true }).catch(() => []);
    const marked: string[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        const text = await ctx.files.read(loadedSkillFile(ctx.workspace.root, entry.name));
        if (text !== undefined && text.includes(ACCOUNT_SKILL_MARKER)) {
            marked.push(entry.name);
        }
    }
    return marked;
};

// Derives the desired skill set from the (delta-adjusted) capability list, writes what changed, sweeps the rest.
// Idempotent and whole-set: callers never reason about which skill one entry touches; a rename is two groups differing.
export const convergeAccountSkills = async (ctx: CapabilityCtx, delta?: AccountSkillDelta): Promise<void> => {
    const entries = await effectiveEntries(ctx, delta);
    const identityEntries = entries.filter((entry): entry is Extract<Capability, { kind: "identity" }> => entry.kind === "identity");
    const accountEntries = entries.filter((entry): entry is Extract<Capability, { kind: "browser" }> => entry.kind === "browser");
    const identities = new Map(identityEntries.map((entry) => [entry.id, entry.config]));

    const desired = new Map<string, string>();
    if (identityEntries.length > 0) {
        desired.set(IDENTITIES_SKILL, stampIdentitiesSkill(identitiesSkill(identityEntries)));
    }
    interface SkillGroup {
        readonly group: { readonly name: string; readonly site: string };
        readonly accounts: { id: string; config: BrowserConfig }[];
    }
    const groups = new Map<string, SkillGroup>();
    for (const entry of accountEntries) {
        const group = accountGroupOf(entry.config);
        const existing = groups.get(group.name) ?? { group, accounts: [] };
        existing.accounts.push({ id: entry.id, config: entry.config });
        groups.set(group.name, existing);
    }
    for (const { group, accounts } of groups.values()) {
        accounts.sort((a, b) => a.id.localeCompare(b.id));
        const text = await renderGroupSkill(ctx, group, accounts, identities);
        // A group whose extension is gone renders nothing; orphaned entries stay visible via their own status instead.
        if (text !== undefined) {
            desired.set(group.name, text);
        }
    }

    for (const name of await markedSkillNames(ctx)) {
        if (!desired.has(name)) {
            await removeLoadedSkill(ctx.files, ctx.workspace.root, name);
        }
    }
    for (const [name, text] of desired) {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, name))) !== text) {
            await writeLoadedSkill(ctx.files, ctx.workspace.root, name, text);
        }
    }
};
