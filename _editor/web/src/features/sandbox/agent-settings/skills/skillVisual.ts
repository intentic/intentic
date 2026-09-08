import type { CapabilitySummary, SkillOrigin, SkillSummary } from "@intentic/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { capabilityMark } from "../../../capabilities/model/cards";

// Marks for the skills list, in tiers: a manifest-declared mark from the owning extension or capability card,
// then a word table for rows with no owner (baked tools, the reader's own skills), then the origin's glyph as a
// fallback. A wrong mark is worse than none, so ambiguous words (`linear`, `x`) are left out of the table.

export interface SkillVisual {
    /** A simple-icons slug for <BrandMark>; absent when there's no brand to draw. */
    readonly logo?: string;
    /** Painted under the brand while it loads, on failure, or with no logo; an open string, not a fixed enum. */
    readonly icon: string;
}

/** What the list needs to ask each skill's owner what it looks like; both reads are already cached. */
export interface SkillSources {
    /** The sandbox's connections; a capability skill's `owner` is one of these ids. */
    readonly capabilities: readonly CapabilitySummary[];
    /** The enabled extensions: their manifests and the capability cards they contribute. */
    readonly extensions: readonly ExtensionSummary[];
}

// Slugs verified against the icon CDN; Slack and OpenAI are left out since they already have glyphs below.
const LOGOS: Readonly<Record<string, string>> = {
    github: `github`,
    gitlab: `gitlab`,
    git: `git`,
    discord: `discord`,
    reddit: `reddit`,
    telegram: `telegram`,
    whatsapp: `whatsapp`,
    youtube: `youtube`,
    npm: `npm`,
    npmjs: `npm`,
    docker: `docker`,
    kubernetes: `kubernetes`,
    k8s: `kubernetes`,
    cloudflare: `cloudflare`,
    linux: `linux`,
    macos: `apple`,
    apple: `apple`,
    google: `google`,
    sheets: `googlesheets`,
    notion: `notion`,
    obsidian: `obsidian`,
    figma: `figma`,
    stripe: `stripe`,
    jira: `jira`,
    shopify: `shopify`,
    postgres: `postgresql`,
    postgresql: `postgresql`,
    mysql: `mysql`,
    redis: `redis`,
    mongo: `mongodb`,
    mongodb: `mongodb`,
    python: `python`,
    rust: `rust`,
    node: `nodedotjs`,
    markdown: `markdown`,
    claude: `claude`,
    anthropic: `claude`,
};

// A glyph per kind of work with no brand to borrow, so baked tools and own skills are still told apart.
const GLYPHS: Readonly<Record<string, string>> = {
    lsp: `code`,
    iq: `search`,
    search: `search`,
    approvals: `check-square`,
    notes: `file-edit`,
    review: `list-check`,
    security: `shield`,
    tests: `check-circle`,
    test: `check-circle`,
    deploy: `cloud-upload`,
    release: `box`,
    docs: `book`,
    documenting: `book`,
    documentation: `book`,
    knowledge: `sitemap`,
    memory: `sitemap`,
    database: `database`,
    sql: `database`,
    dataviz: `wave-pulse`,
    charts: `wave-pulse`,
    shell: `terminal`,
    commands: `terminal`,
    browser: `globe`,
    web: `globe`,
    design: `palette`,
    agents: `robot`,
    subagents: `robot`,
    slack: `slack`,
    openai: `sparkles`,
};

// The last tier: what kind of thing put this skill here, used when nothing else recognizes anything.
const ORIGIN_ICONS = {
    own: `pencil`,
    // Same glyph as persona rows and the composer's chip, so it reads as belonging to that card.
    persona: `user`,
    builtin: `box`,
    capability: `link`,
    extension: `sliders-h`,
    plugin: `th-large`,
    dropped: `file`,
} satisfies Record<SkillOrigin, string>;

// Splits a name into words the same way environmentVisual does (`rust-tauri` → rust, tauri), since names are
// spelled inconsistently.
const wordsOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[\s._/-]+/u)
        .filter((word) => word !== ``);

// A mark as declared by the thing that owns the skill; either half may be missing. A connection's mark is shared
// with capabilityMark rather than duplicated.
type Declared = { readonly logo?: string; readonly icon?: string } | undefined;

const declares = (mark: { readonly logo?: string; readonly icon?: string }): Declared =>
    mark.logo === undefined && mark.icon === undefined ? undefined : mark;

// What the owning thing is drawn as elsewhere in the app. Undefined means ask the next tier, whether nothing is
// declared or the list hasn't arrived yet, never a hole.
const declaredMark = (skill: SkillSummary, sources: SkillSources): Declared => {
    if (skill.owner === undefined) {
        return undefined;
    }
    if (skill.origin === `extension`) {
        // Matched by manifest name, which is what the daemon's inventory records.
        const manifest = sources.extensions.find((extension) => extension.manifest.name === skill.owner)?.manifest;
        return manifest === undefined ? undefined : declares(manifest);
    }
    if (skill.origin === `capability` || skill.origin === `plugin`) {
        const capability = sources.capabilities.find((entry) => entry.id === skill.owner);
        return capability === undefined ? undefined : capabilityMark(capability, sources.extensions);
    }
    return undefined;
};

export const skillVisual = (skill: SkillSummary, sources: SkillSources): SkillVisual => {
    const origin = ORIGIN_ICONS[skill.origin];
    const declared = declaredMark(skill, sources);
    if (declared !== undefined) {
        return { logo: declared.logo, icon: declared.icon ?? origin };
    }
    // A glyph found early keeps searching for a logo; a later logo still wins, with the earlier glyph underneath it.
    let glyph: string | undefined;
    for (const word of [...wordsOf(skill.name), ...wordsOf(skill.owner ?? ``)]) {
        glyph ??= GLYPHS[word];
        const logo = LOGOS[word];
        if (logo !== undefined) {
            return { logo, icon: glyph ?? origin };
        }
    }
    return { icon: glyph ?? origin };
};
