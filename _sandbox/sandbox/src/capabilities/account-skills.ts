import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserConfig, Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { accountSkillLine, browserToolsNote, identitiesSkill } from "../browser/browser-skill.js";
import { loadedSkillFile, loadedSkillsRoot, removeLoadedSkill, writeLoadedSkill } from "../settings/loaded-skills.js";
import type { CapabilityCtx } from "./capability.js";
import { contributionKey, contributionRegistry, hostOf } from "./contributions.js";
import { extensionRead } from "./extension-dirs.js";

/* THE ACCOUNT SKILLS, CONVERGED, one skill per KIND of thing where there used to be one per account.
 *
 * A connected account used to render its own SKILL.md clone (same template, different id/email), so a sandbox
 * with sixteen identities carried sixteen near-identical catalog lines in every prompt and sixteen directories
 * in the loaded folder. The skills now teach the machinery once and carry the INSTANCES as data:
 *
 *   `identities`       , one file for every identity, each a roster line (browser-skill.ts identitiesSkill).
 *   one per SITE GROUP , a platform pack's SKILL.md rendered once per site, its accounts a roster block.
 *                         The group is the platform slug (`reddit`), except on the GENERIC card, where the
 *                         card says nothing about the site and the account's own home page does: those group
 *                         by host (`producthunt-com`), so four accounts on one site are one skill and two
 *                         sites never share a cheatsheet.
 *
 * SCAN-TO-CONVERGE, whole set every time, because the skills are DERIVED: any identity/browser apply, remove
 * or rename rebuilds every account skill from the capability list as it now stands. The one wrinkle is that
 * the routes run a handler's apply BEFORE the store upsert and its remove BEFORE the store delete, so the
 * caller passes the pending delta and the list is adjusted here rather than trusted to be current.
 *
 * Staleness is swept by MARKER, not by memory: a group whose last account left has no surviving name to be
 * derived from, so every file this module writes carries the marker line and any marked skill the desired set
 * no longer names is removed. A skill without the marker, a hand-dropped folder, another feature's file, is
 * never touched. */

const ACCOUNT_SKILL_MARKER = "<!-- managed by the sandbox: derived from the connected accounts; edits are overwritten -->";

const IDENTITIES_SKILL = "identities";
// The card that carries no site (open-account.ts GENERIC), the one platform that groups by host instead.
const GENERIC_PLATFORM = "website";

// A skill directory name from a host: `www.producthunt.com` → `producthunt-com`. Dots would be fine on disk,
// but skill names travel into loaders and tool matchers that expect slug-shaped names.
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

/* Which skill an account belongs to, the platform slug for a carded site, the home page's host for the
 * generic card. Pure over the config on purpose: the browser handler's status probe and the skill inventory's
 * attribution both need the same answer without a registry in hand. */
export const accountGroupOf = (config: BrowserConfig): { readonly name: string; readonly site: string } => {
    if (config.platform !== GENERIC_PLATFORM) {
        return { name: config.platform, site: config.platform };
    }
    const host = siteHost(config);
    return host === undefined ? { name: GENERIC_PLATFORM, site: "the connected site" } : { name: hostSlug(host), site: host };
};

// The one probe both handlers' status checks make: has the converge landed this entry on its skill? The
// roster lines lead with the backticked id (browser-skill.ts), which is exactly what this looks for.
export const accountSkillNames = (skillText: string | undefined, id: string): boolean => skillText !== undefined && skillText.includes(`- \`${id}\``);

// The pending change the routes have not written yet: apply runs before the upsert, remove before the delete.
export interface AccountSkillDelta {
    readonly upsert?: Capability;
    readonly omit?: string;
}

const effectiveEntries = async (ctx: CapabilityCtx, delta?: AccountSkillDelta): Promise<Capability[]> => {
    const entries = (await ctx.capabilities.list()).filter((entry) => entry.id !== delta?.omit && entry.id !== delta?.upsert?.id);
    return delta?.upsert === undefined ? entries : [...entries, delta.upsert];
};

// Frontmatter surgery on the rendered pack text: the group's name (two instances of one card must not
// register one skill name each, they ARE one skill now), the marker stamped after the frontmatter, and the
// account ids appended to the description so the catalog line says who this skill can act as.
const stampGroupSkill = (source: string, name: string, ids: readonly string[]): string =>
    source
        .replace(/^name: .*$/m, `name: ${name}`)
        .replace(/^(description: .*)$/m, `$1 Connected accounts: ${ids.join(", ")}.`)
        .replace(/^---\n([\s\S]*?)\n---\n/, (frontmatter) => `${frontmatter}\n${ACCOUNT_SKILL_MARKER}\n`);

const stampIdentitiesSkill = (source: string): string =>
    source.replace(/^---\n([\s\S]*?)\n---\n/, (frontmatter) => `${frontmatter}\n${ACCOUNT_SKILL_MARKER}\n`);

/* One site group's skill: the pack's SKILL.md rendered once for ALL of the group's accounts. Three
 * substitutions, `${tools}` (the core driving/connecting note), `${accounts}` (the roster block), `${site}`
 * (the host, for the generic pack whose text can name no site of its own). Per-account form fields are NOT
 * substituted anymore: a value that differs per account is a roster fact, not template material, and a
 * secret never belonged in a skill in any case. Undefined when the pack's file is missing (a rotted install),
 * which apply turns into a failed add rather than an empty skill. */
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
        "Accounts on this skill — each backticked id is the `account` value every browser and accounts tool takes:",
        ...accounts.map((account) => accountSkillLine(account.id, account.config, identities.get(account.config.identity ?? "")?.email)),
    ].join("\n");
    const rendered = source.replaceAll("${tools}", browserToolsNote()).replaceAll("${accounts}", roster).replaceAll("${site}", group.site);
    return stampGroupSkill(
        rendered,
        group.name,
        accounts.map((account) => account.id),
    );
};

// Every marked skill currently in the loaded folder, the sweep's candidates. Names are read off the disk the
// way loaded-skills.ts reads them; content goes through the files seam like every other skill read.
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

/* The converge itself: derive the desired set from the (delta-adjusted) capability list, write what changed,
 * sweep what is marked and no longer desired. Idempotent and whole-set, so callers never reason about which
 * skill their one entry touches, an account moving between groups on a rename is just two groups differing
 * from last time. */
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
        // A group whose extension is gone renders nothing, its skill sweeps below, and the orphaned entries
        // stay visible through their own status rather than through a stale cheatsheet.
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
