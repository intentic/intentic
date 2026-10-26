import { type FunctionalComponent, h } from "vue";
import type { RouteRecordRaw } from "vue-router";
import SplitViewOutline from "../components/SplitViewOutline.vue";
import { SETTINGS_DEFAULT_SECTION, settingsPartHosts } from "../features/settings/settingsNav";

// Route pieces both route tables use: the sandbox shell's (index.ts) and a desktop window's on a folder (localRoutes.ts).

// Words read when the outline draws, not when the routes are built, so a language switch reaches them.
export const hubOutline = (title: () => string, description: () => string, railRows: number): FunctionalComponent => {
    return () => h(SplitViewOutline, { title: title(), description: description(), railRows });
};

// Voice and Data were Settings rows of their own until 2026-10-17; each is drawn at the foot of another section now
// (settingsNav.ts `within`), so its old address opens that section at the part's anchor.
export function settingsPartRoutes(): RouteRecordRaw[] {
    return settingsPartHosts().map(({ part, host }) => ({
        path: `settings/${part}`,
        redirect: (to) => ({ name: `settings`, params: { tab: host === SETTINGS_DEFAULT_SECTION ? undefined : host }, query: to.query, hash: `#${part}` }),
    }));
}
