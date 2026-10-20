import { t } from "@intentic/ui/i18n";
import { analyticsAvailable } from "../../app/analyticsConsent";
import type { HubPage, SettingEntry } from "../../workbench/hub/hubSearch";
import type { SettingsSection } from "./settingsNav";

// The settings hub's cards, as the hub's search and the palette find them (workbench/hub/hubSearch.ts): beside
// settingsNav.ts, which names the pages, for the same reason that table exists. Each `id` is the `data-setting` mark on
// the card it names, and hubSearch.test.ts holds the two to each other, so a card renamed, moved or removed here is
// refused there rather than found by a search that lands on nothing.
//
// A card is listed when it is a setting someone comes looking for: a page's state (a plan's checkout, a token just
// minted) is the page's, and the page is the answer. `shown` repeats the page's own `v-if` on the card, so an answer is
// only offered where the page draws it.

/**
 * The hub's pages as the search offers them: each section, then each page drawn at the foot of one (settingsNav.ts
 * `within`) under the section it sits on. A part is opened at its old address, which the router sends to its anchor on
 * that section's page.
 */
export const settingsPages = (sections: readonly SettingsSection[]): readonly HubPage[] =>
    sections.flatMap(({ slug, label, icon, within = [] }) => [
        { slug, label, icon },
        ...within.map((part) => ({ slug: part.slug, label: part.label, icon: part.icon, row: label })),
    ]);

/** The words people use for a page that its name does not hold, by slug. */
export const settingsPageTerms = () =>
    ({
        profile: t(`settings.search.pages.profile`),
        billing: t(`settings.search.pages.billing`),
        appearance: t(`settings.search.pages.appearance`),
        notifications: t(`settings.search.pages.notifications`),
        keybindings: t(`settings.search.pages.keybindings`),
        tokens: t(`settings.search.pages.tokens`),
        organisation: t(`settings.search.pages.organisation`),
        data: t(`settings.search.pages.data`),
    }) satisfies Readonly<Record<string, string>>;

// The words are read by the entries' own functions, when a search asks, since at import time no catalog is registered
// to read them from.
export const SETTINGS_CARDS: readonly SettingEntry[] = [
    // Profile.
    { id: `display-name`, slug: `profile`, title: () => t(`settings.settingsProfile.displayName`), terms: () => [t(`settings.search.displayName`)] },
    {
        id: `sign-in`,
        slug: `profile`,
        title: () => t(`settings.settingsProfile.signIn`),
        terms: () => [t(`settings.settingsProfile.emailCode`), t(`settings.settingsProfile.google`), t(`settings.search.signIn`)],
    },

    // Appearance: the page's first card, then its look one row at a time, since each row is a setting of its own that
    // people name outright ("theme", "language"), then the developer's cards a maker's page leaves out.
    {
        id: `audience`,
        slug: `appearance`,
        title: () => t(`settings.words.group`),
        terms: () => [t(`settings.words.iWriteCode`), t(`settings.search.audience`)],
    },
    { id: `language`, slug: `appearance`, title: () => t(`settings.appearance.look.language`), terms: () => [t(`settings.search.language`)] },
    { id: `theme`, slug: `appearance`, title: () => t(`settings.appearance.look.theme`), terms: () => [t(`settings.search.theme`)] },
    { id: `wallpaper`, slug: `appearance`, title: () => t(`settings.appearance.look.wallpaper`), terms: () => [t(`settings.search.wallpaper`)] },
    { id: `accent-colour`, slug: `appearance`, title: () => t(`settings.appearance.look.colour`), terms: () => [t(`settings.search.accentColour`)] },
    { id: `motion`, slug: `appearance`, title: () => t(`settings.appearance.motion.title`), terms: () => [t(`settings.search.motion`)] },
    { id: `text-size`, slug: `appearance`, title: () => t(`settings.appearance.look.textSize`), terms: () => [t(`settings.search.textSize`)] },
    {
        id: `icon-rail`,
        slug: `appearance`,
        title: () => t(`settings.appearance.look.iconRail`),
        terms: () => [t(`settings.search.iconRail`)],
        shown: (reader) => !reader.phone,
    },
    {
        id: `file-tree`,
        slug: `appearance`,
        title: () => t(`settings.appearance.explorer.group`),
        terms: () => [
            t(`settings.appearance.explorer.title`),
            t(`settings.appearance.explorer.fileNesting`),
            t(`settings.appearance.explorer.showIgnored`),
            t(`settings.appearance.explorer.hideTests`),
            t(`settings.appearance.explorer.hideTechnical`),
        ],
        shown: (reader) => !reader.maker,
    },
    {
        id: `changes-list`,
        slug: `appearance`,
        title: () => t(`shared.changes`),
        terms: () => [
            t(`settings.appearance.changes.groupByModule`),
            t(`settings.appearance.changes.largestFirst`),
            t(`settings.appearance.changes.diffOpen`),
            t(`settings.search.changesList`),
        ],
        shown: (reader) => !reader.maker,
    },
    {
        id: `tool-calls`,
        slug: `appearance`,
        title: () => t(`chat.words.showToolCalls`),
        terms: () => [t(`settings.search.toolCalls`)],
        shown: (reader) => !reader.maker,
    },
    {
        id: `status-bar`,
        slug: `appearance`,
        title: () => t(`settings.appearance.statusBar.group`),
        terms: () => [t(`settings.appearance.statusBar.liveMetrics`), t(`settings.search.statusBar`)],
        // A phone has no status bar and draws no gauges (SettingsAppearance.vue).
        shown: (reader) => !reader.maker && !reader.phone,
    },

    // Notifications: the desktop app's own notices, then what a phone or a browser is sent, then what the tab or the
    // app's icon shows, then the sounds.
    {
        id: `desktop-notifications`,
        slug: `notifications`,
        title: () => t(`settings.settingsNotifications.desktopNotices`),
        terms: () => [t(`settings.settingsNotifications.chimeAsks`), t(`settings.settingsNotifications.chimeFinished`)],
        shown: (reader) => reader.app,
    },
    {
        id: `push-notifications`,
        slug: `notifications`,
        title: () => t(`settings.settingsNotifications.pushNotifications`),
        terms: () => [t(`settings.settingsNotifications.notifyDevice`), t(`settings.search.pushNotifications`)],
    },
    {
        id: `status-badge`,
        slug: `notifications`,
        title: (reader) => (reader.app ? t(`settings.settingsNotifications.appIcon`) : t(`settings.settingsNotifications.browserTab`)),
        terms: () => [t(`settings.search.statusBadge`)],
    },
    {
        id: `sounds`,
        slug: `notifications`,
        title: () => t(`settings.settingsNotifications.sounds`),
        terms: () => [t(`settings.settingsNotifications.chimeAsks`), t(`settings.settingsNotifications.chimeFinished`), t(`settings.search.sounds`)],
    },

    // Voice, drawn at the foot of Notifications (settingsNav.ts `within`): one card, and only where a desktop-sized
    // window can listen, as the part itself is.
    {
        id: `wake-word`,
        slug: `notifications`,
        partLabel: () => t(`settings.section.voice`),
        title: () => t(`settings.settingsVoice.group`),
        terms: () => [t(`settings.search.wakeWord`)],
        shown: (reader) => !reader.phone,
    },
    {
        id: `microphone`,
        slug: `notifications`,
        partLabel: () => t(`settings.section.voice`),
        title: () => t(`settings.settingsVoice.micGroup`),
        terms: () => [t(`settings.search.wakeWord`)],
        shown: (reader) => !reader.phone,
    },

    // Data, drawn at the foot of Profile.
    {
        id: `product-analytics`,
        slug: `profile`,
        partLabel: () => t(`settings.section.data`),
        title: () => t(`settings.analytics.title`),
        terms: () => [t(`settings.search.productAnalytics`)],
        shown: () => analyticsAvailable(),
    },
    {
        id: `export-data`,
        slug: `profile`,
        partLabel: () => t(`settings.section.data`),
        title: () => t(`settings.settingsData.exportMyData`),
        terms: () => [t(`settings.search.exportData`)],
    },
    {
        id: `delete-account`,
        slug: `profile`,
        partLabel: () => t(`settings.section.data`),
        title: () => t(`settings.settingsData.deleteAccount`),
        terms: () => [t(`settings.search.deleteAccount`)],
    },
];
