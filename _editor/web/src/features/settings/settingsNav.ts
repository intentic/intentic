import type { IconName } from "@intentic/ui";

// The settings hub's index, read by the hub (which draws the rows) and by the command palette (which turns each into a
// "Settings: …" destination), for the reason sandboxNav.ts exists: one table, so a section cannot be reachable by click
// but not by name.

export interface SettingsSection {
    /** The `:tab` route param this section lives under (`/settings/<slug>`). */
    readonly slug: string;
    readonly label: string;
    readonly icon: IconName;
    /** Absent where the platform sells no plan. */
    readonly plan?: boolean;
}

/** The section a param-less `/settings` shows. */
export const SETTINGS_DEFAULT_SECTION = `profile`;

// Personal preferences for the signed-in account, cross-sandbox. Sandbox-scoped settings (search past chats, import
// memory) live on the Sandbox ▸ Agent section, not here.
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
    { slug: `profile`, label: `Profile`, icon: `user` },
    // Named "Billing" for the errand, not the product.
    { slug: `billing`, label: `Billing`, icon: `credit-card`, plan: true },
    { slug: `appearance`, label: `Appearance`, icon: `palette` },
    { slug: `notifications`, label: `Notifications`, icon: `volume-up` },
    { slug: `keybindings`, label: `Keybindings`, icon: `bolt` },
    { slug: `data`, label: `Data`, icon: `database` },
];

export const settingsSections = (planOffered: boolean): readonly SettingsSection[] =>
    SETTINGS_SECTIONS.filter((section) => planOffered || section.plan !== true);

export const settingsSectionPath = (slug: string): string => (slug === SETTINGS_DEFAULT_SECTION ? `/settings` : `/settings/${slug}`);
