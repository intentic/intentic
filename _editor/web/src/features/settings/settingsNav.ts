import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { localFace } from "../../app/environments/local";

// The settings hub's index, read by the hub (which draws the rows) and by the command palette (which turns each into a
// "Settings: …" destination), for the reason sandboxNav.ts exists: one table, so a section cannot be reachable by click
// but not by name.

/** The `:tab` route param a section lives under (`/settings/<slug>`), and the key its name is written under. */
export type SettingsSlug = (typeof SETTINGS_SECTIONS)[number][`slug`];

/** A page drawn at the foot of another section's (`within`), and the anchor it answers to there. */
export type SettingsPartSlug = Extract<(typeof SETTINGS_SECTIONS)[number], { within: unknown }>[`within`][number][`slug`];

/** The longer name a section wears while this reader is shown its parts. */
type SettingsWithinLabel = Extract<(typeof SETTINGS_SECTIONS)[number], { withinLabel: unknown }>[`withinLabel`];

/** The heading a section is drawn under, in the order the groups stand. */
export type SettingsGroupKey = (typeof SETTINGS_GROUPS)[number];

interface SettingsGates {
    /** Absent where the platform sells no plan. Present-or-absent, never `false`, so `in` is the whole test. */
    readonly plan?: true;
    /** About a keyboard, so a phone's index leaves it out. Present-or-absent, like `plan`. */
    readonly keyboard?: true;
    /** About what only a desktop-sized window does (listening for the wake word), so a phone's index leaves it out too. */
    readonly desktop?: true;
    /** About what a sandbox does, so a desktop window on a folder of this computer, which has none, leaves it out. */
    readonly sandbox?: true;
    /**
     * A developer's tool (shortcut tables, API tokens), so a reader who does not write code is not shown it in the index.
     * Still reachable by its address and from the command palette: nothing is taken away, only out of the way.
     */
    readonly developer?: true;
}

export interface SettingsPart extends SettingsGates {
    readonly slug: SettingsPartSlug;
    readonly label: string;
    readonly icon: IconName;
}

export interface SettingsSection extends SettingsGates {
    readonly slug: SettingsSlug;
    /** The section's name in the reader's language; resolved per call, so it follows a language change. */
    readonly label: string;
    readonly icon: IconName;
    readonly group: SettingsGroupKey;
    /** What this reader is shown at the foot of the section's page, each under an anchor of its own. Never empty. */
    readonly within?: readonly SettingsPart[];
}

export interface SettingsGroup {
    readonly key: SettingsGroupKey;
    readonly label: string;
    readonly sections: readonly SettingsSection[];
}

/** The section a param-less `/settings` shows. */
export const SETTINGS_DEFAULT_SECTION = `profile`;

// Who you are and what you pay for, then how this app looks and talks to you, then a developer's tools. Account first,
// as the hub is opened from the account's avatar and lands on Profile. Until 2026-10-17 the nine rows stood in one
// unlabelled list in the order they were added, with Voice and Data a single control or two each.
const SETTINGS_GROUPS = [`account`, `preferences`, `developer`] as const;

// Personal preferences for the signed-in account, cross-sandbox. Sandbox-scoped settings (search past chats, import
// memory) live on the Sandbox ▸ Agent section, not here.
//
// No `label` in the table: a name here would be one language's, frozen at module load. The slug is the key its name
// is written under (`settings.section.<slug>`), which is also why this is `as const` — that is what makes the lookup
// below type-check against the catalog instead of being a bare string.
//
// `within` is a page too small to be a row of its own, drawn at the foot of the section it belongs with: it keeps its
// name in the palette ("Settings: Voice") and its old address, which the router sends to the anchor (router/index.ts).
// A section whose parts this reader is shown may wear a longer name (`withinLabel`), so the index says what is on it.
const SETTINGS_SECTIONS = [
    // Data was a row of its own until 2026-10-17: the analytics switch, an export and the account's deletion, which
    // every settings page people know keeps at the foot of the account's own.
    { slug: `profile`, icon: `user`, group: `account`, within: [{ slug: `data`, icon: `database` }] },
    // Named "Billing" for the errand, not the product.
    { slug: `billing`, icon: `credit-card`, group: `account`, plan: true },
    // The organisations this account is in, and the console an organisation admin runs them from (organisations/).
    { slug: `organisation`, icon: `users`, group: `account` },
    { slug: `appearance`, icon: `palette`, group: `preferences` },
    // What a sandbox's daemon pushes to this device (usePushNotifications.ts), and, below it, whether this device
    // listens for the agent's name (chat/wake): its own microphone, heard by the sandbox's model. What this device says
    // and what it hears, both per device; Voice was a row of its own, of one switch, until 2026-10-17.
    {
        slug: `notifications`,
        icon: `volume-up`,
        group: `preferences`,
        sandbox: true,
        within: [{ slug: `voice`, icon: `microphone`, sandbox: true, desktop: true }],
        withinLabel: `notificationsVoice`,
    },
    { slug: `keybindings`, icon: `bolt`, group: `developer`, keyboard: true, developer: true },
    // Account credentials, not this sandbox's: a token minted here acts for the person on every sandbox they own,
    // which is why it lives in the account's Settings rather than on a Sandbox tab.
    { slug: `tokens`, icon: `key`, group: `developer`, developer: true },
] as const satisfies readonly ({
    slug: string;
    icon: IconName;
    group: SettingsGroupKey;
    within?: readonly ({ slug: string; icon: IconName } & SettingsGates)[];
    withinLabel?: string;
} & SettingsGates)[];

// The table as its entries are read below, every row with the same optional fields.
interface SectionEntry extends SettingsGates {
    readonly slug: SettingsSlug;
    readonly icon: IconName;
    readonly group: SettingsGroupKey;
    readonly within?: readonly ({ readonly slug: SettingsPartSlug; readonly icon: IconName } & SettingsGates)[];
    readonly withinLabel?: SettingsWithinLabel;
}
const ENTRIES: readonly SectionEntry[] = SETTINGS_SECTIONS;

const offered = (gates: SettingsGates, planOffered: boolean, phone: boolean, noSandbox: boolean, plain: boolean): boolean =>
    (planOffered || !(`plan` in gates)) &&
    !(phone && (`keyboard` in gates || `desktop` in gates)) &&
    !(noSandbox && `sandbox` in gates) &&
    !(plain && `developer` in gates);

// Named inside a `computed` by both callers, so `t` is read where a language change can re-run it. `phone` drops the
// sections about a keyboard a phone does not have, `noSandbox` (a desktop window on a folder) the ones about a sandbox,
// `plain` (the hub's index for a reader who does not write code) the developer's tools. Parts are filtered the same way.
export const settingsSections = (
    planOffered: boolean,
    phone = false,
    noSandbox = localFace() !== undefined,
    plain = false,
): readonly SettingsSection[] =>
    ENTRIES.filter((entry) => offered(entry, planOffered, phone, noSandbox, plain)).map(({ within: parts = [], withinLabel, ...rest }) => {
        const within = parts.filter((part) => offered(part, planOffered, phone, noSandbox, plain)).map((part) => ({ ...part, label: t(`settings.section.${part.slug}`) }));
        const shown = within.length > 0;
        const label = shown && withinLabel !== undefined ? t(`settings.section.${withinLabel}`) : t(`settings.section.${rest.slug}`);
        return shown ? { ...rest, label, within } : { ...rest, label };
    });

/** The sections under their headings, in the table's order; a heading with nothing this reader is shown is left out. */
export const settingsGroups = (sections: readonly SettingsSection[]): readonly SettingsGroup[] =>
    SETTINGS_GROUPS.map((key) => ({ key, label: t(`settings.group.${key}`), sections: sections.filter((section) => section.group === key) })).filter(
        (group) => group.sections.length > 0,
    );

const settingsSectionPath = (slug: string): string => (slug === SETTINGS_DEFAULT_SECTION ? `/settings` : `/settings/${slug}`);

/** The section a part is drawn on, by the table rather than this reader's index: an address must not depend on who asks. */
const hostOf = (part: SettingsPartSlug): SettingsSlug => {
    const host = ENTRIES.find((entry) => entry.within?.some((candidate) => candidate.slug === part) === true);
    if (host === undefined) {
        throw new Error(`settings part ${part} is drawn on no section`);
    }
    return host.slug;
};

/** Where a part is reached: its section's page, scrolled to the part's anchor. */
export const settingsPartPath = (part: SettingsPartSlug): string => `${settingsSectionPath(hostOf(part))}#${part}`;

/** Every part's old address (`/settings/<part>`) and the section it now sits at the foot of, for the router. */
export const settingsPartHosts = (): readonly { readonly part: SettingsPartSlug; readonly host: SettingsSlug }[] =>
    ENTRIES.flatMap((entry) => (entry.within ?? []).map((part) => ({ part: part.slug, host: entry.slug })));

/**
 * Every place in Settings this reader can be sent by name (the palette's "Settings: …"): each section, then the parts
 * drawn at its foot, which keep their own names there so "Voice" still finds the wake word.
 */
export const settingsDestinations = (planOffered: boolean): readonly { slug: SettingsSlug | SettingsPartSlug; label: string; icon: IconName; path: string }[] =>
    settingsSections(planOffered).flatMap((section) => [
        { slug: section.slug, label: section.label, icon: section.icon, path: settingsSectionPath(section.slug) },
        ...(section.within ?? []).map((part) => ({ slug: part.slug, label: part.label, icon: part.icon, path: settingsPartPath(part.slug) })),
    ]);
