import type { IconName } from "@intentic/ui";

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
export const SANDBOX_SECTION_GROUPS: readonly SandboxSectionGroup[] = [
    {
        key: `box`,
        label: `This box`,
        items: [
            { slug: `overview`, label: `Overview`, icon: `info-circle` },
            // Clock, not a bank card: plan allowances and reopen time; billing itself lives in Settings ▸ Billing.
            { slug: `usage`, label: `Usage`, icon: `clock`, maintainer: true },
        ],
    },
    {
        key: `configuration`,
        label: `Configuration`,
        items: [
            { slug: `environment`, label: `Environment`, icon: `box` },
            { slug: `secrets`, label: `Secrets`, icon: `key`, maintainer: true },
            { slug: `agent`, label: `Agent`, icon: `sparkles`, maintainer: true },
            // Finding, installing, managing and disabling as one.
            { slug: `extensions`, label: `Extensions`, icon: `sliders-h` },
        ],
    },
    {
        key: `reach`,
        label: `Reach`,
        items: [
            // Who may use this box: members, invites, roles. `shield`, not `users` (Personas' glyph, one row below).
            // Access stays below maintainer: revoking your own grant is anyone's.
            { slug: `access`, label: `Access`, icon: `shield` },
            // Who this box acts as outward; not beside `agent` in Configuration, easy to conflate, opposite in stakes.
            { slug: `personas`, label: `Personas`, icon: `user`, maintainer: true },
            // "Devices", not "Sync": a machine is the thing that has folders, ports and sandboxes on it, and the
            // enrollment this tab used to be named after is one property of one of them.
            { slug: `devices`, label: `Devices`, icon: `desktop`, maintainer: true },
        ],
    },
];

/** Every built-in slug, derived from the rows themselves so adding a section cannot forget to guard its name. */
export const SANDBOX_BUILT_IN_SLUGS: ReadonlySet<string> = new Set(
    SANDBOX_SECTION_GROUPS.flatMap((group) => group.items).map((section) => section.slug),
);

/** The sections this reader can actually open; anything else would land on a row the hub redirects away from. */
export const sandboxSections = (canShip: boolean): readonly SandboxSection[] =>
    SANDBOX_SECTION_GROUPS.flatMap((group) => group.items).filter((section) => canShip || section.maintainer !== true);

export const sandboxSectionPath = (slug: string): string => (slug === SANDBOX_DEFAULT_SECTION ? `/sandbox` : `/sandbox/${slug}`);
