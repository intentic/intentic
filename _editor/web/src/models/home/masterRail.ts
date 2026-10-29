import { storedValue, storeValue } from "@intentic/ui/storage";
import { onScopeDispose, ref } from "vue";
import { isNavigationFailure, NavigationFailureType, type RouteLocationNormalized, useRouter } from "vue-router";
import { isHomePath, masterRailAfter } from "../../lib/routes/home";
import { isSteppingInside } from "../../lib/routes/homeDetour";
import { homeFrame, homeSection, sectionOwns } from "../../lib/routes/homeSection";

// Kept for this tab's reloads, so a reload on the section Home was showing comes back in Home's frame, and one on a
// sandbox's page entered for real stays inside.
const FRAME_KEY = `intentic.masterRail`;

// Whether the desktop shell is in the master view: on /home, on the person's own pages opened from there, and on the
// section Home shows of every sandbox (lib/routes/home.ts masterRailAfter, lib/routes/homeSection.ts), until a page of a
// sandbox, or a deliberate step inside one (lib/routes/homeDetour.ts goInside), gives the shell back. The rail wears the
// sandboxes. On Home's own page no chat column is docked beside, since its one chat is its page; around a section, the
// section decides (homeFrame). One reading for every surface that asks.
// allow(module-state): one shell per window, and the master view is a property of that window
export const masterRail = ref(storedValue(FRAME_KEY, `session`) === `1`);

const follow = (to: Pick<RouteLocationNormalized, "path" | "name">, inside: boolean): void => {
    const owned = !isHomePath(to.path) && sectionOwns(homeSection.value, to.path);
    const master = inside ? isHomePath(to.path) : masterRailAfter(masterRail.value, to.path, owned);
    masterRail.value = master;
    homeFrame.value = master && owned ? (to.name === `chat` ? `chat` : `docked`) : undefined;
    storeValue(FRAME_KEY, master ? `1` : `0`, `session`);
};

/** Follows the router; called once, by the desktop shell. */
export function followMasterRail(): void {
    const router = useRouter();
    follow(router.currentRoute.value, false);
    // After each navigation rather than on a watch of the path: a step inside is known only while its navigation runs,
    // and pressing it on the very address Home's frame is showing (a tile double-clicked on its own section) lands as a
    // duplicate, which still leaves the frame.
    const stop = router.afterEach((to, _from, failure) => {
        if (failure === undefined || isNavigationFailure(failure, NavigationFailureType.duplicated)) {
            follow(to, isSteppingInside());
        }
    });
    onScopeDispose(stop);
}
