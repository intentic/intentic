import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// The sandbox hub's index, as a table rather than markup: the hub draws these rows with their live badges, and the
// command palette turns the same rows into "Sandbox: …" destinations. One source, so a section added here cannot be
// reachable by click but not by name.

export interface SandboxSection {
    /** The `:tab` route param this section lives under (`/sandbox/<slug>`). */
    readonly slug: string;
    readonly label: string;
    readonly icon: IconName;
    /** Withheld below maintainer, where the daemon refuses what the section is for. */
    readonly maintainer?: boolean;
    /**
     * The `publisher.name` id of a first-party extension whose `sandbox` view under this same slug the section draws as one
     * of its own parts, rather than as a row of its own. Only that extension's view is taken: a stranger's view under the
     * name would read as the sandbox's own record. Below maintainer, a section that is only that view leaves the index
     * while no view fills it.
     */
    readonly embeds?: string;
    /**
     * Sections this page draws as parts of its own, behind its own switch: no row of their own, since this page is their
     * row, but still destinations by name (the palette's "Sandbox: …"), at their old address, which the router sends to
     * the part (router/index.ts), and names no extension may take.
     */
    readonly within?: readonly SandboxSection[];
}

/**
 * One row for several sections, drawn as tabs above whichever of them is open (workbench/hub/HubLayout.vue). It is the
 * door for pages few readers open, which as rows of their own made the index long for everyone who never does. Each
 * part keeps its own address, gating and organisation lock; the row opens the first part this reader may open, and
 * leaves the index when there is none.
 */
export interface SandboxTabbedRow {
    /** The row's own key, never a route: each of its parts is one. */
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
    readonly parts: readonly SandboxSection[];
}

export type SandboxNavRow = SandboxSection | SandboxTabbedRow;

export const isTabbedRow = (row: SandboxNavRow): row is SandboxTabbedRow => `parts` in row;

export interface SandboxSectionGroup {
    readonly key: string;
    readonly label: string;
    readonly items: readonly SandboxNavRow[];
}

/** The section a param-less `/sandbox` shows; its row writes no param, so no section has two URLs. */
export const SANDBOX_DEFAULT_SECTION = `overview`;

// No live-status row or badge; Extensions' update count is the only thing here anyone looks for.
export const sandboxSectionGroups = (): readonly SandboxSectionGroup[] => [
    {
        key: `box`,
        label: t(`sandbox.sandboxNav.box`),
        items: [
            { slug: `overview`, label: t(`sandbox.sandboxNav.overview`), icon: `info-circle` },
            // Clock, not a bank card: plan allowances and reopen time; billing itself lives in Settings ▸ Billing.
            { slug: `usage`, label: t(`sandbox.sandboxNav.usage`), icon: `clock`, maintainer: true },
        ],
    },
    {
        key: `configuration`,
        label: t(`sandbox.sandboxNav.configuration`),
        items: [
            // What the agent runs on, before how it behaves: every account, subscription, local model and endpoint this
            // box can reach, and the one place a first one is connected. Maintainer, as the daemon holds every sign-in.
            // Above Environment and Secrets: most owners connect a model first; the box plumbing can wait.
            { slug: `models`, label: t(`shared.models`), icon: `sparkles`, maintainer: true },
            { slug: `agent`, label: t(`shared.agent`), icon: `robot`, maintainer: true },
            { slug: `environment`, label: t(`sandbox.words.environment`), icon: `box` },
            { slug: `secrets`, label: t(`sandbox.sandboxNav.secrets`), icon: `key`, maintainer: true },
            // Finding, installing, managing and disabling as one.
            { slug: `extensions`, label: t(`sandbox.sandboxNav.extensions`), icon: `sliders-h` },
        ],
    },
    {
        key: `reach`,
        label: t(`sandbox.sandboxNav.reach`),
        items: [
            // Who may use this box: members, invites, roles. `shield`, not `users` (Personas' glyph, one row below).
            // Access stays below maintainer: revoking your own grant is anyone's.
            { slug: `access`, label: t(`sandbox.words.access`), icon: `shield` },
            // What the folders behind a grant are. Beside Access rather than under Configuration: an area is half of
            // a grant, and reading it as configuration is how somebody edits one without noticing whose reach moved.
            { slug: `areas`, label: t(`sandbox.words.areas`), icon: `folder`, maintainer: true },
            // Who this box acts as outward; not beside `agent` in Configuration, easy to conflate, opposite in stakes.
            // Devices was the last row here until 2026-10-01; it is a rail view of its own now (/devices).
            { slug: `personas`, label: t(`shared.personas`), icon: `user`, maintainer: true },
            // The whole of the group on one drawing: who gets in, the box, and everything it reaches, each line drawn from
            // what the daemon enforces. Last, not first: it sets nothing, and every line on it is changed on one of the
            // rows above (or Models, Secrets, Devices), which its caption links to. It was the group's first row until
            // 2026-10-17, which put a read-only picture ahead of the pages people come to change. A row of its own, not a
            // tab on Access: it draws areas, personas, secrets and everything the box reaches, which Access does not own,
            // and Access is a guest's one section while the map is a maintainer's. Maintainer, as most of what it draws
            // is a maintainer's read (connections, tokens, links).
            { slug: `map`, label: t(`sandbox.sandboxNav.map`), icon: `sitemap`, maintainer: true },
        ],
    },
    {
        // How this box handles what passes through it, and what happened in it: two rows, one for what is set and one for
        // what is read. Few readers open either, so each is a single door with its pages as tabs inside, and every page is
        // still a destination by name in the palette. Until 2026-10-17 they were two groups of six rows (Privacy & safety,
        // then Records), which made the index long for everyone who never opens them; before 2026-10-16 this group was
        // Oversight's three rows.
        key: `oversight`,
        label: t(`sandbox.sandboxNav.oversight`),
        items: [
            {
                // How this box handles what passes through it, as the pages that set it: what a data protection officer
                // reads first, then what may leave the box and in what form, what the agent may do without asking a
                // person, and how long each record is kept and where a copy of the audit trail goes. Each was a part of
                // another page until 2026-10-16 (the shield and the judge were Agent ▸ Safety, retention Agent ▸ Finishing
                // and Audit log ▸ How it is kept), so Data protection's measures led out into pages named for something
                // else. A setting about one thing stays with that thing: a secret's gate on Secrets, a member's role on
                // Access, an area on Areas; Data protection links to them as it links to these.
                // Maintainer, as the daemon refuses their reads and writes below; an organisation's Agent lock holds the
                // three that write settings (organisations/useOrgPolicy.ts), since the daemon files their routes under it.
                key: `privacy`,
                label: t(`sandbox.sandboxNav.privacy`),
                icon: `lock`,
                parts: [
                    { slug: `data-protection`, label: t(`sandbox.sandboxNav.dataProtection`), icon: `lock`, maintainer: true },
                    { slug: `privacy-shield`, label: t(`sandbox.sandboxNav.privacyShield`), icon: `eye-slash`, maintainer: true },
                    { slug: `guardrails`, label: t(`sandbox.sandboxNav.guardrails`), icon: `approvals`, maintainer: true },
                    { slug: `retention`, label: t(`sandbox.sandboxNav.retention`), icon: `history`, maintainer: true },
                ],
            },
            // What happened, split by who did it: what woke the agent, what it called and how each turn went, every
            // command the judge checked and every request the shield masked, then what people did (the audit trail).
            // Read, never set, so below the row that sets what it records. Core, though its turns are the Activity
            // extension's view: the judge's and the shield's records sat at the foot of their settings until 2026-10-16,
            // and an extension can be switched off. A member sees it too, the turns narrowed to the conversations they
            // may see; every other part is a maintainer's.
            {
                slug: `activity`,
                label: t(`sandbox.sandboxNav.activity`),
                icon: `wave-pulse`,
                embeds: `intentic.activity`,
                // Who changed what anywhere above, and who signed in. Core, not an extension: the daemon writes it from
                // every route, and an extension can be switched off. Maintainer, as the daemon refuses it below (it names
                // every member and what they did). A row of its own until 2026-10-17, and how it is kept (reads, a copy
                // forwarded) moved to Retention then, so the part is the record alone.
                within: [{ slug: `audit`, label: t(`sandbox.sandboxNav.audit`), icon: `list-check`, maintainer: true }],
            },
        ],
    },
    // Recently deleted was a last `account` group here until 2026-10-07; it is the foot of the Devices board now
    // (devices/deleted), since nothing in it is about the sandbox this hub is named for.
];

// Functions, not constants, here and below: the rows carry words, and at import time no catalog is registered to read
// them from.
// A tabbed row's parts and a page's own parts are sections like any other here: addresses, palette destinations, names
// no extension may take.
const builtInSections = (): readonly SandboxSection[] =>
    sandboxSectionGroups()
        .flatMap((group) => group.items)
        .flatMap((row) => (isTabbedRow(row) ? row.parts : [row]))
        .flatMap((section) => [section, ...(section.within ?? [])]);

// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name. The hub also
// asks it which sections an organisation's lock may wrap (organisations/OrgHeldSection.vue).
export const sandboxBuiltInSlugs = (): ReadonlySet<string> => new Set(builtInSections().map((section) => section.slug));

/** The extension whose view a section draws as one of its parts, if it draws one. */
export const sandboxEmbedOf = (slug: string): string | undefined => builtInSections().find((section) => section.slug === slug)?.embeds;

/**
 * Whether an extension's `sandbox` view may sit on the hub as a row of its own under this key: never a built-in's name.
 * A section that embeds one extension's view under its own name takes it through `sandboxEmbedOf`, not as a row. Asked
 * by the hub and by the palette, so neither offers a row that opens something else.
 */
export const sandboxKeyAllowed = (key: string): boolean => !sandboxBuiltInSlugs().has(key);

/** The one section a guest member has business in: their own card and their own passkeys (Access ▸ People, Sign-in). */
export const GUEST_SECTION = `access`;

/**
 * The built-in sections this reader can actually open; anything else would land on a row the hub redirects away from. A
 * guest sees one row, since the daemon refuses it every other section's reads.
 */
export const sandboxSections = (canShip: boolean, guest = false, orgHidden: ReadonlySet<string> = new Set()): readonly SandboxSection[] =>
    builtInSections()
        .filter((section) => (guest ? section.slug === GUEST_SECTION : canShip || section.maintainer !== true))
        // What the sandbox's organisation hides (organisations/useOrgPolicy.ts) is no destination either.
        .filter((section) => !orgHidden.has(section.slug));

export const sandboxSectionPath = (slug: string): string => (slug === SANDBOX_DEFAULT_SECTION ? `/sandbox` : `/sandbox/${slug}`);

/**
 * Where a door marked "sandbox" leads for this reader. The hub's own default is a section a guest is refused, and the
 * shell fence (lib/routes/guestPaths.ts) sends it home from the hub root before the hub can redirect — so a guest's door
 * names its one section outright rather than opening on a bounce.
 */
export const sandboxHubPath = (guest: boolean): string => (guest ? sandboxSectionPath(GUEST_SECTION) : `/sandbox`);

/**
 * Access's parts (features/sandbox/access/SandboxAccess.vue), drawn as tabs and kept in the query as Agent's and
 * Activity's are; the first writes no param. Who may come in and what they are told, how they prove it, what reaches the
 * box with nobody signing in, and what conversations were allowed past their persona or area. One page of ten groups until
 * 2026-10-19, which read as one long list of everything that has to do with getting in.
 */
export const ACCESS_PARTS = [`people`, `sign-in`, `programs`, `allowed`] as const;
export type AccessPart = (typeof ACCESS_PARTS)[number];

/** The parts drawn below maintainer: the reader's own card, the people here now, and their own passkeys. */
export const MEMBER_ACCESS_PARTS: readonly AccessPart[] = [`people`, `sign-in`];

/** One part of Access by address; People, the first, writes no param. */
export const accessPath = (part: AccessPart = `people`): string =>
    part === `people` ? sandboxSectionPath(`access`) : `${sandboxSectionPath(`access`)}?${new URLSearchParams({ section: part }).toString()}`;

// Where a sandbox's Linked sandboxes section is reached from outside the Access page: the hash marks a reader who came
// for it, as a task handed over from another sandbox and waiting for its owner's yes sends them here. The page opens the
// part that holds it for this hash alone too, since a link made before the parts had none.
export const LINKED_SANDBOXES_ANCHOR = `linked-sandboxes`;

/** That section on the named sandbox's own Access page, the switch to that sandbox included (router/sandboxArrival.ts). */
export const linkedSandboxesHref = (sandboxId: string): string =>
    `${sandboxSectionPath(`access`)}?${new URLSearchParams({ section: `programs` satisfies AccessPart, sandbox: sandboxId }).toString()}#${LINKED_SANDBOXES_ANCHOR}`;
