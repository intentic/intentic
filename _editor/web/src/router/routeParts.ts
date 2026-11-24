import { type FunctionalComponent, h, type Component } from "vue";
import type { RouteRecordRaw } from "vue-router";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { asyncView } from "../components/asyncView";
import { t } from "@intentic/ui/i18n";
import { SETTINGS_DEFAULT_SECTION, settingsGroups, settingsPartHosts, settingsSections } from "../features/settings/settingsNav";

// Route pieces both route tables use: the sandbox shell's (index.ts, pageRoutes.ts) and a desktop window's on a folder
// (localRoutes.ts).

// Words and the index's groups read when the outline draws, not when the routes are built, so a language switch reaches
// them. `rail` is how many rows each of the index's groups holds, read from the hub's own nav table where it has one.
// `head` says what heads the real index, so its rows land where the outline's bars were: the hubs' settings search
// (HubLayout's `search`), and whether its groups stand under headings.
export const hubOutline = (
    title: () => string,
    description: () => string,
    rail: () => readonly number[],
    head: { readonly search?: boolean; readonly labelled?: boolean } = {},
): FunctionalComponent => {
    return () => h(SplitViewOutline, { title: title(), description: description(), rail: rail(), ...head });
};

// The account's index as SettingsHub draws it for most readers: every section a hosted plan offers, under its headings.
const accountRail = (): readonly number[] => settingsGroups(settingsSections(true)).map((group) => group.sections.length);

/** The account's settings, as both tables draw them; the outline mirrors the page's own heading (SettingsHub.vue). */
export const accountSettingsView = (): Component =>
    asyncView(() => import(`../features/settings/SettingsHub.vue`), hubOutline(() => t(`shared.account`), () => ``, accountRail, { search: true }));

// Voice and Data were Settings rows of their own until 2026-10-17; each is drawn at the foot of another section now
// (settingsNav.ts `within`), so its old address opens that section at the part's anchor. `base` is where the account's
// settings are routed (`account` below a frame), `name` their route, whose other params (the sandbox) ride along.
export function settingsPartRoutes(base: string, name: string): RouteRecordRaw[] {
    return settingsPartHosts().map(({ part, host }) => ({
        path: `${base}/${part}`,
        redirect: (to) => ({
            name,
            params: { ...to.params, tab: host === SETTINGS_DEFAULT_SECTION ? undefined : host },
            query: to.query,
            hash: `#${part}`,
        }),
    }));
}
