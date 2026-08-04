import { watch } from "vue";
import type { RouteRecordNormalized } from "vue-router";
import { router } from "../../router";
import { readWindowState, writeWindowState } from "../windowStore";
import { useSandbox } from "./useSandbox";

/* WHICH SCREEN EACH SANDBOX WAS LAST ON, and landing there when the user switches to it (Alt+1…9, or a row in
 * the switcher popover).
 *
 * A switch re-points the entire shell at another machine — sandboxScope re-scopes the client-side state, the
 * liveness probe re-aims, every query key changes — and the SCREEN is part of what it re-points. Two sandboxes
 * are two different pieces of work, and a route that named something in the outgoing one (an agent id, a file
 * path, a browser session) names nothing in the incoming one. Holding the URL across the switch therefore made
 * every jump start with a detour: back to where that sandbox actually was, by hand, from a view that had
 * nothing to show.
 *
 * Per WINDOW (windowStore), like every other "what was this window showing" — two windows are allowed to sit on
 * two sandboxes, and each one's memory of a sandbox is its own.
 *
 * Registered at module scope (imported once from main.ts) next to sandboxScope, for the same reason: the active
 * sandbox also changes while the shell is unmounted (the "add sandbox" flow, on /setup), and a shell-scoped
 * watcher would miss it. */

const screenKey = (sandboxId: string): string => `intentic.sandboxScreen.${sandboxId}`;

/* A screen OF A SANDBOX is a route inside the workspace shell, and every one of them matches the shell record
 * (path `/`) first. The account's own pages — /login, /setup, /invite, /desktop-auth — sit outside it and
 * belong to no sandbox: neither remembering one nor landing on one says anything about the machine that was
 * picked, and answering a switch with a setup screen is the worst of the two. */
const inShell = (matched: readonly RouteRecordNormalized[]): boolean => matched[0]?.path === `/`;

// A stored screen is a path or it is nothing (a hand-edited key, an older build that stored another shape). A
// path this build no longer routes needs no check of its own: the router's catch-all sends it to the same
// landing as a sandbox with no memory at all.
const parseScreen = (raw: string): string | undefined => (raw.startsWith(`/`) ? raw : undefined);

const { activeSandboxId } = useSandbox();

// Recorded on arrival, under whichever sandbox was active when the navigation landed — so the outgoing
// sandbox's screen is already on file by the time a switch reads it back, and deep links and back/forward are
// covered by the same one rule. A FAILED navigation is a screen nobody reached: recording it would land the
// next switch on the view the user was denied (and a canceled one is how the landing below wins its race).
router.afterEach((to, _from, failure) => {
    const sandboxId = activeSandboxId.value;
    if (failure !== undefined || sandboxId === undefined || !inShell(to.matched)) {
        return;
    }
    writeWindowState(screenKey(sandboxId), to.fullPath);
});

/* The landing.
 *
 * `replace`, not `push`: flipping between two sandboxes is something people do a dozen times in a row, and each
 * flip would otherwise leave a back-entry — burying the history that Back is actually for under a stack of
 * screens the user never asked to visit twice.
 *
 * A sandbox this window has never shown lands on the shell's home (`/` redirects per device) rather than
 * holding the current route: with no "last time" to honour, the front door is the honest answer, and it is the
 * only one that cannot carry the outgoing sandbox's ids into a machine that has never heard of them.
 *
 * `flush: post`, because a switch moves several things at once and this has to move last. The workspace strip
 * re-points the URL at the incoming sandbox's open file (useWorkspaceRoute projects the tab strip that
 * sandboxScope has just restored, in a pre-flush watcher), and vue-router gives the tie to whichever navigation
 * STARTS last — so a pre-flush landing would be canceled by that push, and a sandbox last left on /agents would
 * come back on whatever its editor happened to hold. */
watch(
    activeSandboxId,
    (sandboxId) => {
        if (sandboxId === undefined || !inShell(router.currentRoute.value.matched)) {
            return;
        }
        void router.replace(readWindowState(screenKey(sandboxId), parseScreen) ?? `/`);
    },
    { flush: `post` },
);
