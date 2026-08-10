import type { CapabilitySummary, SkillOrigin, SkillSummary } from "@intentic-app/api-contract";
import { CAPABILITY_CATALOG } from "@intentic-app/capability-catalog";
import { contributionDiscriminator } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";

/* THE MARK ON A SKILL ROW — what makes "Discord, GitHub, your Windows PC" legible from the left edge alone,
 * instead of thirteen identical grey glyphs down a column where twelve of them said `link`.
 *
 * The Skills list is the one surface where everything the agent carries sits together, so it is the longest list
 * in the hub and the one most often read by scanning ("which of these came with something I connected?"). Every
 * row of it was drawn with its ORIGIN's glyph, which means the column repeated six symbols over and over and
 * distinguished nothing inside a group — the eight connections were eight identical chain links. The environment
 * tab had already solved exactly this (environmentVisual.ts), and this follows its shape: one <BrandMark>, a
 * ladder of tiers, and the glyph kept as what the brand is painted over rather than as the answer.
 *
 * THE TOP TIER IS NOT A TABLE — IT IS WHAT THE OWNER ALREADY DECLARED. A skill that came with an extension or a
 * connection belongs to a thing that has a card, and that card's manifest already carries the mark the rest of
 * the app draws it with (the Extensions tab's rows, the Capabilities grid, the connections list). So this asks
 * that manifest rather than guessing from the skill's name: `linux` gets Tux because the Linux PC card says so,
 * and a Reddit account somebody named `reddit-work` still gets Reddit's mark, which no table keyed on a
 * user-typed name could ever manage.
 *
 * THE WORD TABLE IS THE SECOND TIER, and it is small on purpose. It exists for the rows with no owner to ask —
 * the baked tools and the skills the reader wrote themselves — where the name is all there is. A word is enough
 * (`figma-export` → Figma) and whole names are not, for environmentVisual's reason: nobody spells these the same
 * way twice.
 *
 * A WRONG MARK IS WORSE THAN NO MARK, which is why two obvious entries are missing. `linear` is a slug (the
 * issue tracker) and also an ordinary English word, so a skill about linear algebra would wear a project
 * management brand as though it were a fact; `x` is one character and matches far too much. The glyph tier reads
 * as "no brand for this one", so falling to it costs nothing and claims nothing. */

export interface SkillVisual {
    /** A simple-icons slug for <BrandMark>, absent for anything with no brand to draw. */
    readonly logo?: string;
    /** What is painted under the brand: while it loads, if it fails, and forever when there is no slug. An OPEN
     *  string like <BrandMark>'s own prop, because a manifest may name a glyph this build has never heard of. */
    readonly icon: string;
}

/** What the list needs in hand to ask each skill's owner what it looks like. Both are already-cached reads. */
export interface SkillSources {
    /** The sandbox's connections — a capability skill's `owner` is one of these ids. */
    readonly capabilities: readonly CapabilitySummary[];
    /** The ENABLED extensions: their own manifests, and the capability cards they contribute. */
    readonly extensions: readonly ExtensionSummary[];
}

/* Brands, keyed by every word that should reach them. Slugs are verified against the CDN rather than guessed —
 * a 404 costs a request and degrades to the glyph, which is survivable but is a hole in the column this exists
 * to fill. Slack and OpenAI are deliberately absent: neither is in that set, and both have a glyph in the app's
 * own icon vocabulary below. */
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

// The kinds of work with no brand to borrow — a glyph per KIND, so the baked tools and a reader's own skills are
// still told apart at a glance rather than sharing one box.
const GLYPHS: Readonly<Record<string, string>> = {
    lsp: `code`,
    iq: `search`,
    search: `search`,
    drafts: `file-edit`,
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

/* The last tier: what KIND of thing put this skill in front of the agent. Reached only by a row whose owner
 * declared no mark and whose name says nothing — and it is still the answer for the one origin that has nothing
 * else to say, a loose file nobody claims. */
const ORIGIN_ICONS = {
    own: `pencil`,
    builtin: `box`,
    capability: `link`,
    extension: `sliders-h`,
    plugin: `th-large`,
    dropped: `file`,
} satisfies Record<SkillOrigin, string>;

// `rust-tauri` → rust, tauri · `radarsu-omen` → radarsu, omen · `Code search` → code, search. The same splitter
// the environment's marks use, for the same reason: a name is spelled by whoever typed it.
const wordsOf = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[\s._/-]+/u)
        .filter((word) => word !== ``);

/* A mark as its OWNER declares it: either half may be missing, and the row's own tiers fill the gap — a card
 * with a brand and no glyph still needs something painted under the brand while it loads. */
type Declared = { readonly logo?: string; readonly icon?: string } | undefined;

const declares = (mark: { readonly logo?: string; readonly icon?: string }): Declared =>
    mark.logo === undefined && mark.icon === undefined ? undefined : mark;

/* WHICH CARD A CONNECTION CAME FROM. A kind's cards pin their own id into the instance's config
 * (contributionDiscriminator — `provider` for the CLI cards, `platform` for browsers and computers), so this is
 * the same join the Capabilities view makes to list a card's instances, run backwards. A kind with no
 * discriminator has exactly one card, which is why the static catalog is asked by kind alone. */
const cardMark = (capability: CapabilitySummary, extensions: readonly ExtensionSummary[]): Declared => {
    const key = contributionDiscriminator(capability.kind);
    const cardId = key === undefined ? undefined : String(capability.config[key] ?? ``);
    const contribution = extensions
        .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
        .find((entry) => entry.kind === capability.kind && entry.id === cardId);
    const card = contribution?.catalog ?? CAPABILITY_CATALOG.find((entry) => entry.kind === capability.kind);
    return card === undefined ? undefined : declares(card);
};

// What the thing that ships this skill is drawn as everywhere else in the app. Undefined when it declares
// nothing, or when the list it lives in has not arrived yet — both are "ask the next tier", never a hole.
const declaredMark = (skill: SkillSummary, sources: SkillSources): Declared => {
    if (skill.owner === undefined) {
        return undefined;
    }
    if (skill.origin === `extension`) {
        // The row names an extension by its manifest name, which is what the daemon's inventory puts there.
        const manifest = sources.extensions.find((extension) => extension.manifest.name === skill.owner)?.manifest;
        return manifest === undefined ? undefined : declares(manifest);
    }
    if (skill.origin === `capability` || skill.origin === `plugin`) {
        const capability = sources.capabilities.find((entry) => entry.id === skill.owner);
        return capability === undefined ? undefined : cardMark(capability, sources.extensions);
    }
    return undefined;
};

export const skillVisual = (skill: SkillSummary, sources: SkillSources): SkillVisual => {
    const origin = ORIGIN_ICONS[skill.origin];
    const declared = declaredMark(skill, sources);
    if (declared !== undefined) {
        return { logo: declared.logo, icon: declared.icon ?? origin };
    }
    // A glyph found early is remembered but does not stop the search — environmentVisual's rule: a brand further
    // down the words still wins the top tier, and the glyph it passed becomes what sits under it.
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
