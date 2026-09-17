import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// The settings hub's index, read by the hub (which draws the rows) and by the command palette (which turns each into a
// "Settings: …" destination), for the reason sandboxNav.ts exists: one table, so a section cannot be reachable by click
// but not by name.

/** The `:tab` route param a section lives under (`/settings/<slug>`), and the key its name is written under. */
export type SettingsSlug = (typeof SETTINGS_SECTIONS)[number][`slug`];

export interface SettingsSection {
    readonly slug: SettingsSlug;
    /** The section's name in the reader's language; resolved per call, so it follows a language change. */
    readonly label: string;
    readonly icon: IconName;
    /** Absent where the platform sells no plan. Present-or-absent, never `false`, so `in` is the whole test. */
    readonly plan?: true;
}

/** The section a param-less `/settings` shows. */
export const SETTINGS_DEFAULT_SECTION = `profile`;

// Personal preferences for the signed-in account, cross-sandbox. Sandbox-scoped settings (search past chats, import
// memory) live on the Sandbox ▸ Agent section, not here.
//
// No `label` in the table: a name here would be one language's, frozen at module load. The slug is the key its name
// is written under (`settings.section.<slug>`), which is also why this is `as const` — that is what makes the lookup
// below type-check against the catalog instead of being a bare string.
const SETTINGS_SECTIONS = [
    { slug: `profile`, icon: `user` },
    // Named "Billing" for the errand, not the product.
    { slug: `billing`, icon: `credit-card`, plan: true },
    { slug: `appearance`, icon: `palette` },
    { slug: `notifications`, icon: `volume-up` },
    { slug: `keybindings`, icon: `bolt` },
    { slug: `data`, icon: `database` },
] as const satisfies readonly { slug: string; icon: IconName; plan?: true }[];

// Named inside a `computed` by both callers, so `t` is read where a language change can re-run it.
export const settingsSections = (planOffered: boolean): readonly SettingsSection[] =>
    SETTINGS_SECTIONS.filter((section) => planOffered || !(`plan` in section)).map((section) => ({
        ...section,
        label: t(`settings.section.${section.slug}`),
    }));

export const settingsSectionPath = (slug: string): string => (slug === SETTINGS_DEFAULT_SECTION ? `/settings` : `/settings/${slug}`);
