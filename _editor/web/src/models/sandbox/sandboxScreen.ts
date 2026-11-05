import { watch } from "vue";
import { isNavigationFailure, NavigationFailureType, type RouteLocationNormalized } from "vue-router";
import { onNavigation } from "../../workbench/navigation/navigation";
import { readWindowState, writeWindowState } from "../../workbench/window/windowStore";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { insideScreen, type LandingRole, sandboxEntry } from "../../lib/routes/firstScreens";
import { type HomeSection, homeSection, sectionLink, showsSection } from "../../lib/routes/homeSection";
import { frameOf, isSandboxPage, linkOf, pageOf, routeSandbox, routeSegment, segmentOf, toHome, toInside } from "../../lib/routes/links";

// Remembers which screen each sandbox was last on and lands there on a switch, since a route naming something
// in the outgoing sandbox means nothing in the incoming one. Kept per window. Registered at module scope, like
// sandboxScope, since the active sandbox can change while the shell is unmounted. A screen is kept as its address
// inside the sandbox (`/s/<sandbox>/…`), whichever frame it was seen in, since it is the sandbox's screen either way.

const screenKey = (sandboxId: string): string => `intentic.sandboxScreen.${sandboxId}`;

// A stored screen is a path or nothing; whether it is still a screen of that sandbox is asked where it is read
// (firstScreens.ts `insideScreen`), which also reads one an older build kept in the form addresses had before frames.
const parseScreen = (raw: string): string | undefined => (raw.startsWith(`/`) ? raw : undefined);

const { activeSandboxId } = useSandbox();
// Read on first use rather than on import: the router imports this module, and the role reads a sandbox query.
let role: ReturnType<typeof useRole> | undefined;
const roleNow = (): LandingRole => {
    role ??= useRole();
    return { isGuest: role.isGuest.value, homeOnly: role.homeOnly.value };
};

/**
 * Where opening a sandbox goes, from Home or a link naming it: the screen it was last left on in this window, else its
 * first screen, as an address inside it. Read after the sandbox is selected, since the landing depends on the person's
 * standing in it.
 */
export const sandboxEntryPath = (sandboxId: string): string => sandboxEntry(sandboxId, readWindowState(screenKey(sandboxId), parseScreen), roleNow());

/**
 * Where a sandbox opens in Home's frame, on the section chosen there (lib/routes/homeSection.ts): the screen it was last
 * left on in this window when that is the section's own (a file open in its Workspace), else the section itself.
 */
export const sectionEntryPath = (sandboxId: string, section: Pick<HomeSection, `page`>): string => {
    const stored = readWindowState(screenKey(sandboxId), parseScreen);
    const last = stored === undefined ? undefined : insideScreen(sandboxId, stored);
    const link = last === undefined ? undefined : linkOf(last);
    return toHome(sandboxId, link !== undefined && showsSection(section, link) ? link : sectionLink(section));
};

/** Where a sandbox opens in Home's frame: the section chosen there of it, else its home conversation. */
export const homeEntryPath = (sandboxId: string): string => {
    const section = roleNow().homeOnly ? undefined : homeSection.value;
    return section === undefined ? toHome(sandboxId) : sectionEntryPath(sandboxId, section);
};

// Overrides "land on the last screen" for a switch with a known destination (opening an agent from another
// sandbox's card). Recorded rather than pushed after the switch: the landing watch replaces at flush:post and
// would cancel a concurrent push. Either form of address, read as that sandbox's.
export const landOnAfterSwitch = (sandboxId: string, path: string): void => {
    const screen = insideScreen(sandboxId, path);
    if (screen !== undefined) {
        writeWindowState(screenKey(sandboxId), screen);
    }
};

// A navigation under way whose address names its sandbox selects that sandbox itself (router/shellGates.ts), and the
// selection must not be answered by the landing below as a switch asked for elsewhere: the route already is the answer.
// allow(module-state): the one navigation in flight that chose its sandbox, until it lands or fails
let routeChoosing = false;

/** Says a navigation under way is choosing the sandbox its address names; it lands or fails before the next. */
export const routeChoosesSandbox = (): void => {
    routeChoosing = true;
};

// The screen a route shows, as its address inside its sandbox: a page of the sandbox's own, in either frame.
const screenOf = (to: RouteLocationNormalized, sandboxId: string): string | undefined => {
    const shown = pageOf(to);
    if (frameOf(to) === `inside`) {
        return shown === undefined || !isSandboxPage(shown) ? undefined : to.fullPath;
    }
    const link = shown === undefined || !isSandboxPage(shown) ? undefined : linkOf(to.fullPath);
    return link === undefined ? undefined : toInside(sandboxId, link);
};

// The same frame's entry for the sandbox switched to: inside it, its last screen; in Home's frame, what a press on its
// tile opens there. An account's page, or a sandbox's settings seen from Home, stays in view, now of the sandbox
// switched to, since whoever switched named nowhere else.
const entryAfterSwitch = (route: RouteLocationNormalized, sandboxId: string): string | undefined => {
    const shown = pageOf(route);
    const frame = frameOf(route);
    if (shown !== undefined && (!isSandboxPage(shown) || (frame === `home` && shown === `sandboxSettings`))) {
        const link = linkOf(route.fullPath);
        return link === undefined ? undefined : frame === `home` ? toHome(sandboxId, link) : toInside(sandboxId, link);
    }
    return frame === `home` ? homeEntryPath(sandboxId) : sandboxEntryPath(sandboxId);
};

// Both wait for the router (workbench/navigation), which the route table installs after this module has run.
onNavigation((router) => {
    // Recorded on arrival under the sandbox the address names, so it's on file before the next switch reads it back;
    // a failed navigation is not recorded, or the next switch would land on a screen the user was denied.
    router.afterEach((to, _from, failure) => {
        if (!isNavigationFailure(failure, NavigationFailureType.cancelled)) {
            routeChoosing = false;
        }
        const sandboxId = routeSandbox(to);
        const screen = failure !== undefined || sandboxId === undefined ? undefined : screenOf(to, sandboxId);
        if (sandboxId !== undefined && screen !== undefined) {
            writeWindowState(screenKey(sandboxId), screen);
        }
    });
    router.onError(() => {
        routeChoosing = false;
    });

    // `replace`, not `push`, so a switch made without a navigation (the phone's menu, a removal, a card opening an agent
    // of another sandbox) doesn't bury Back under a stack of visits. Only where the address names another sandbox: a
    // switch the route made itself, or one on a page that names none, needs nothing. A sandbox never shown lands on its
    // own first screen. `flush: post` so useWorkspaceRoute's own pre-flush navigation wins the tie instead.
    watch(
        activeSandboxId,
        (sandboxId) => {
            const route = router.currentRoute.value;
            const named = routeSandbox(route);
            if (sandboxId === undefined || routeChoosing || named === undefined || named === sandboxId || frameOf(route) === undefined) {
                return;
            }
            const entry = entryAfterSwitch(route, sandboxId);
            if (entry !== undefined) {
                void router.replace(entry);
            }
        },
        { flush: `post` },
    );

    // The address on screen names its sandbox as the list writes it now (lib/routes/links.ts `segmentOf`): a sandbox
    // renamed while it is shown, or an address the list was not in yet to read, is written again in place.
    watch(
        () => {
            const route = router.currentRoute.value;
            const written = routeSegment(route);
            const sandboxId = routeSandbox(route);
            const current = sandboxId === undefined ? undefined : segmentOf(sandboxId);
            return written === undefined || current === written ? undefined : current;
        },
        (current) => {
            const route = router.currentRoute.value;
            if (current !== undefined && route.name !== undefined && route.name !== null) {
                void router.replace({ name: route.name, params: { ...route.params, sandbox: current }, query: route.query, hash: route.hash });
            }
        },
    );
});
