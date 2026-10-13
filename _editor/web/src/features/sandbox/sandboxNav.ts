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
}

/**
 * A row a first-party extension's `sandbox` view fills, filed among the hub's own sections for what it is rather than
 * under "Added by extensions" for who built it. Its words and glyph are the view's own, it shows only while that
 * extension contributes the view, and no other extension may take its slug. The rail does the same for its listed
 * first-party tiles (workbench/views/registry.ts), by view id; this keys on the owner too, since a slot sits beside the
 * audit trail and a stranger's view under the same name would read as the sandbox's own record.
 */
export interface SandboxSlot {
    /** The view's activation key, which is also its `:tab` route param. */
    readonly slug: string;
    /** The `publisher.name` id the view registers under. */
    readonly extension: string;
}

export type SandboxRow = SandboxSection | SandboxSlot;

export const isSandboxSlot = (row: SandboxRow): row is SandboxSlot => `extension` in row;

export interface SandboxSectionGroup {
    readonly key: string;
    readonly label: string;
    readonly items: readonly SandboxRow[];
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
        ],
    },
    {
        // What happened in this box and what it can show for it: the two records, then what an officer files from
        // them. Below Reach, since every row here reads the groups above it; Data protection's measures link back into
        // both. The audit trail was the last Reach row and Data protection a Configuration row until 2026-10-13, and
        // Activity sat under "Added by extensions": one errand, three groups.
        key: `oversight`,
        label: t(`sandbox.sandboxNav.oversight`),
        items: [
            // What woke the agent, what it called and how each turn went. The Activity extension's view, filed here
            // because it is the other half of the record; a member sees it too, narrowed to the conversations they may see.
            { slug: `activity`, extension: `intentic.activity` },
            // Who changed what anywhere above, and who signed in: the audit trail and how it is kept. Core, not an
            // extension: the daemon writes it from every route, and an extension can be switched off. Maintainer, as the
            // daemon refuses it below (it names every member and what they did).
            { slug: `audit`, label: t(`sandbox.sandboxNav.audit`), icon: `list-check`, maintainer: true },
            // What a data protection officer files before the box handles anyone's data, read off everything above it.
            // Maintainer, as the daemon refuses its reads below.
            { slug: `data-protection`, label: t(`sandbox.sandboxNav.dataProtection`), icon: `lock`, maintainer: true },
        ],
    },
    // Recently deleted was a last `account` group here until 2026-10-07; it is the foot of the Devices board now
    // (devices/deleted), since nothing in it is about the sandbox this hub is named for.
];

// The rows the hub draws itself, without the slots. Functions, not constants, here and below: the rows carry words, and
// at import time no catalog is registered to read them from.
const builtInSections = (): readonly SandboxSection[] =>
    sandboxSectionGroups()
        .flatMap((group) => group.items)
        .filter((row): row is SandboxSection => !isSandboxSlot(row));

// Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name.
const builtInSlugs = (): ReadonlySet<string> => new Set(builtInSections().map((section) => section.slug));

/** The slots, each kept for the one extension it names. */
export const sandboxSlots = (): readonly SandboxSlot[] =>
    sandboxSectionGroups()
        .flatMap((group) => group.items)
        .filter(isSandboxSlot);

/**
 * Whether an extension's `sandbox` view may sit on the hub under this key: never a built-in's name, and a slot's only for
 * the extension it is kept for. Asked by the hub and by the palette, so neither offers a row that opens something else.
 */
export const sandboxKeyAllowed = (owner: string, key: string): boolean =>
    !builtInSlugs().has(key) && sandboxSlots().every((slot) => slot.slug !== key || slot.extension === owner);

/** The one section a guest member has business in: their own passkeys, and giving their grant back. */
export const GUEST_SECTION = `access`;

/**
 * The built-in sections this reader can actually open; anything else would land on a row the hub redirects away from. A
 * guest sees one row, since the daemon refuses it every other section's reads. Slots are not here: an extension fills
 * them, and whoever lists the extension's views lists those.
 */
export const sandboxSections = (canShip: boolean, guest = false): readonly SandboxSection[] =>
    builtInSections().filter((section) => (guest ? section.slug === GUEST_SECTION : canShip || section.maintainer !== true));

export const sandboxSectionPath = (slug: string): string => (slug === SANDBOX_DEFAULT_SECTION ? `/sandbox` : `/sandbox/${slug}`);

/**
 * Where a door marked "sandbox" leads for this reader. The hub's own default is a section a guest is refused, and the
 * shell fence (lib/routes/guestPaths.ts) sends it home from the hub root before the hub can redirect — so a guest's door
 * names its one section outright rather than opening on a bounce.
 */
export const sandboxHubPath = (guest: boolean): string => (guest ? sandboxSectionPath(GUEST_SECTION) : `/sandbox`);
