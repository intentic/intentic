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

export interface SandboxSectionGroup {
    readonly key: string;
    readonly label: string;
    readonly items: readonly SandboxSection[];
}

/** The section a param-less `/sandbox` shows; its row writes no param, so no section has two URLs. */
export const SANDBOX_DEFAULT_SECTION = `overview`;

// No live-status row or badge; Devices' contended-port count is the only thing here anyone looks for.
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
            { slug: `environment`, label: t(`sandbox.words.environment`), icon: `box` },
            { slug: `secrets`, label: t(`sandbox.sandboxNav.secrets`), icon: `key`, maintainer: true },
            { slug: `agent`, label: t(`shared.agent`), icon: `sparkles`, maintainer: true },
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
            { slug: `personas`, label: t(`shared.personas`), icon: `user`, maintainer: true },
            // "Devices", not "Sync": a machine is the thing that has folders, ports and sandboxes on it, and the
            // enrollment this tab used to be named after is one property of one of them.
            { slug: `devices`, label: t(`sandbox.words.devicesSection`), icon: `desktop`, maintainer: true },
        ],
    },
    {
        // The account's other boxes, not this one; last, since nothing here is about the sandbox the hub is named for.
        key: `account`,
        label: t(`sandbox.sandboxNav.yourSandboxes`),
        items: [{ slug: `deleted`, label: t(`sandbox.words.recentlyDeleted`), icon: `trash` }],
    },
];

/**
 * Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name. A
 * function, not a constant: the rows carry words now, and at import time no catalog is registered to read them from.
 */
export const sandboxBuiltInSlugs = (): ReadonlySet<string> =>
    new Set(
        sandboxSectionGroups()
            .flatMap((group) => group.items)
            .map((section) => section.slug),
    );

/** The one section a guest member has business in: their own passkeys, and giving their grant back. */
export const GUEST_SECTION = `access`;

/**
 * The sections this reader can actually open; anything else would land on a row the hub redirects away from. A guest
 * sees one row, since the daemon refuses it every other section's reads.
 */
export const sandboxSections = (canShip: boolean, guest = false): readonly SandboxSection[] =>
    sandboxSectionGroups()
        .flatMap((group) => group.items)
        .filter((section) => (guest ? section.slug === GUEST_SECTION : canShip || section.maintainer !== true));

export const sandboxSectionPath = (slug: string): string => (slug === SANDBOX_DEFAULT_SECTION ? `/sandbox` : `/sandbox/${slug}`);

/**
 * Where a door marked "sandbox" leads for this reader. The hub's own default is a section a guest is refused, and the
 * shell fence (shell/guestPaths.ts) sends it home from the hub root before the hub can redirect — so a guest's door
 * names its one section outright rather than opening on a bounce.
 */
export const sandboxHubPath = (guest: boolean): string => (guest ? sandboxSectionPath(GUEST_SECTION) : `/sandbox`);
