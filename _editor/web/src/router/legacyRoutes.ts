import {
    type FloatingPanel,
    FLOATING_PANELS,
    homePath,
    isSandboxPage,
    LEGACY_PATTERNS,
    legacySandbox,
    legacyTarget,
} from "@intentic/sandbox-contract/app-routes";
import type { FunctionalComponent } from "vue";
import { type RouteLocationNormalized, type RouteLocationRaw, type RouteRecordRaw, START_LOCATION } from "vue-router";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { useSandbox } from "../client/sandbox/useSandbox";
import { frameOf, routeSandbox, toFloating, toHome, toInside } from "../lib/routes/links";

// THE ADDRESSES FROM BEFORE FRAMES, STILL ANSWERED (2026-11-04). Until then every page sat at the root (`/agents/<id>`,
// `/sandbox/models`, `/settings/appearance`) and meant "of the sandbox this browser had open last". They are still out
// there: an installed Android or desktop app hands them over, a daemon's push message, a bookmark, an e-mail, and the
// editor's own code until every link is made by lib/routes/links.ts. Each lands on its page (the shared table's
// legacy.ts says which) in the sandbox it names (`?sandbox=`), else the one open, else the first the account lists.
//
// In the frame it was pressed in: from Home's frame an old address of a sandbox's page stays in Home's frame, as a link
// made there would (links.ts `here`), and from inside a sandbox an account page stays inside it. Arriving cold, a page of
// a sandbox opens inside it and an account page in Home's frame, where it needs no sandbox at all.

// Never drawn: the guard below always sends the navigation on. A record needs a view to hold a guard of its own.
const NOTHING: FunctionalComponent = () => null;

// The first sandbox the account lists, when none is open: the list's own choice of one (useSandbox `reconcileActive`).
const sandboxToOpen = async (): Promise<string | undefined> => {
    const sandboxes = useSandbox();
    // allow(silent-catch): a list the platform could not give leaves nothing to open, and the address lands on Home.
    await sandboxes.list().catch(() => undefined);
    return activeSandboxId.value;
};

/** Where an old address lands, seen from the route it was asked from (none on arrival). */
const legacyLanding = async (
    to: Pick<RouteLocationNormalized, `fullPath`>,
    from: RouteLocationNormalized | undefined,
): Promise<RouteLocationRaw> => {
    const target = legacyTarget(to.fullPath);
    if (target === undefined) {
        return homePath();
    }
    const pressedIn = from === undefined ? undefined : frameOf(from);
    const sandbox =
        legacySandbox(to.fullPath) ?? (from === undefined ? undefined : routeSandbox(from)) ?? activeSandboxId.value ?? (await sandboxToOpen());
    if (!isSandboxPage(target.link.page)) {
        return pressedIn === `inside` && sandbox !== undefined ? toInside(sandbox, target.link) : homePath(undefined, target.link);
    }
    if (sandbox === undefined) {
        return homePath();
    }
    return (pressedIn ?? target.frame) === `home` ? toHome(sandbox, target.link) : toInside(sandbox, target.link);
};

const fromShown = (from: RouteLocationNormalized): RouteLocationNormalized | undefined => (from === START_LOCATION ? undefined : from);

/** The shell's child records for every old address, each sending its navigation on to the page it meant. */
// None carries the name its page's route had before frames (`workspace`, `sandbox`, …): every link is built from the
// table now (lib/routes/links.ts), so a location naming a retired route fails where it is pushed rather than landing
// through an old address.
export const legacyRoutes = (): RouteRecordRaw[] =>
    LEGACY_PATTERNS.map((pattern) => ({ path: pattern, component: NOTHING, beforeEnter: (to, from) => legacyLanding(to, fromShown(from)) }));

// A floating window's address before frames, `/floating/<panel>`: a desktop app remembers the windows it had open.
// The live app's own window became a tab of Browsers (2026-10-08), so `preview` is that panel's.
const floatingLanding = async (panel: FloatingPanel, fullPath: string): Promise<RouteLocationRaw> => {
    const sandbox = legacySandbox(fullPath) ?? activeSandboxId.value ?? (await sandboxToOpen());
    return sandbox === undefined ? homePath() : toFloating(sandbox, panel);
};

/** The top-level records of a floating window's old address, behind the guards a floating window has (`entry`). */
export const legacyFloatingRoutes = (entry: readonly ((to: RouteLocationNormalized) => Promise<boolean | RouteLocationRaw>)[]): RouteRecordRaw[] => [
    {
        // allow(route-literal): the old address itself, routed so that what still asks for it lands.
        path: `/floating/:panel(${FLOATING_PANELS.join(`|`)}|preview)`,
        component: NOTHING,
        beforeEnter: [
            ...entry,
            (to) => {
                const asked = [to.params[`panel`]].flat()[0];
                return floatingLanding(FLOATING_PANELS.find((panel) => panel === asked) ?? `browsers`, to.fullPath);
            },
        ],
    },
];
