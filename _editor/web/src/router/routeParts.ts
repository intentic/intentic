import { type FunctionalComponent, h, type Component } from "vue";
import type { RouteRecordRaw } from "vue-router";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { asyncView } from "../components/asyncView";
import { t } from "@intentic/ui/i18n";
import { SETTINGS_DEFAULT_SECTION, settingsPartHosts } from "../features/settings/settingsNav";

// Route pieces both route tables use: the sandbox shell's (index.ts, pageRoutes.ts) and a desktop window's on a folder
// (localRoutes.ts).

// Words read when the outline draws, not when the routes are built, so a language switch reaches them.
export const hubOutline = (title: () => string, description: () => string, railRows: number): FunctionalComponent => {
    return () => h(SplitViewOutline, { title: title(), description: description(), railRows });
};

/** The account's settings, as both tables draw them; the outline mirrors the page's own heading (SettingsHub.vue). */
export const accountSettingsView = (): Component =>
    asyncView(() => import(`../features/settings/SettingsHub.vue`), hubOutline(() => t(`shared.settings`), () => ``, 5));

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
