import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { localFace } from "../../app/environments/local";

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
    // What a sandbox's daemon pushes to this device (usePushNotifications.ts).
    { slug: `notifications`, icon: `volume-up`, sandbox: true },
    // Whether this device listens for the agent's name (chat/wake): its own microphone, heard by the sandbox's model.
    { slug: `voice`, icon: `microphone`, sandbox: true, desktop: true },
    { slug: `keybindings`, icon: `bolt`, keyboard: true, developer: true },
    // Account credentials, not this sandbox's: a token minted here acts for the person on every sandbox they own,
    // which is why it lives beside the account's own rows rather than on a Sandbox tab.
    { slug: `tokens`, icon: `key`, developer: true },
    // The organisations this account is in, and the console an organisation admin runs them from (organisations/).
    { slug: `organisation`, icon: `users` },
    { slug: `data`, icon: `database` },
] as const satisfies readonly { slug: string; icon: IconName; plan?: true; keyboard?: true; desktop?: true; sandbox?: true; developer?: true }[];

// Named inside a `computed` by both callers, so `t` is read where a language change can re-run it. `phone` drops the
// sections about a keyboard a phone does not have, `noSandbox` (a desktop window on a folder) the ones about a sandbox,
// `plain` (the hub's index for a reader who does not write code) the developer's tools.
export const settingsSections = (
    planOffered: boolean,
    phone = false,
    noSandbox = localFace() !== undefined,
    plain = false,
): readonly SettingsSection[] =>
    SETTINGS_SECTIONS.filter(
        (section) =>
            (planOffered || !(`plan` in section)) &&
            !(phone && (`keyboard` in section || `desktop` in section)) &&
            !(noSandbox && `sandbox` in section) &&
            !(plain && `developer` in section),
    ).map((section) => ({
        ...section,
        label: t(`settings.section.${section.slug}`),
    }));

export const settingsSectionPath = (slug: string): string => (slug === SETTINGS_DEFAULT_SECTION ? `/settings` : `/settings/${slug}`);
