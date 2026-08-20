import { browserSession } from "./browser";
import { coverage, daemon } from "./daemon";
import { openTabSnapshot } from "./fixture/openChats";
import { demoMode } from "./mode";
import { DEMO_SANDBOX, DEMO_USER, platform } from "./platform";
import { installSwitcher } from "./switcher";
import { terminalSession } from "./terminal";
import { installFetch, installWebSocket, installXhr } from "./transport";

/* THE DEMO'S BOOT, everything that has to be true before the real app's own entry runs.
 *
 * Order matters exactly once: the transports and the credentials must both be in place before `../main.ts` is
 * imported, because that module creates the app, and the router's first guard fires a platform call. Hence the
 * dynamic import at the bottom rather than a static one at the top.
 *
 * The credentials are seeded rather than faked in code. `sandboxSession` reads a stored session straight from
 * localStorage and returns it when it is still valid, so writing one there is the whole of "sign in": Google
 * Identity Services is never loaded, no exchange is attempted, and not one line of the auth path is bypassed,
 * it simply finds what it is looking for. The e2e tier signs in the same way. */

const ACTIVE_SANDBOX_KEY = `intentic.activeSandboxId`;
const SESSION_KEY = `intentic.session.${DEMO_SANDBOX.id}`;
// Where the app restores a window's open chat tabs from (composables/chat/tabSnapshot.ts).
const CHAT_TABS_KEY = `intentic.chatTabs.${DEMO_SANDBOX.id}`;

const seedCredentials = (): void => {
    localStorage.setItem(ACTIVE_SANDBOX_KEY, DEMO_SANDBOX.id);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: DEMO_USER.email }));
    /* ANSWER THE ONE QUESTION THIS WORLD CANNOT MEAN. The app offers to reach a sandbox running on the reader's
     * own computer by its local address instead of through the tunnel, and asks once per sandbox before the
     * browser's own permission dialog appears (composables/sandbox/localShortcut.ts). There is no sandbox here
     *, the daemon is a fixture in this tab, so the offer is one a visitor can only decline, raised over a
     * recording that would not go any faster either way. Recorded as a decline, in the key the composable
     * reads, which is also what keeps it out of every marketing screenshot taken off this build. */
    localStorage.setItem(`intentic.localShortcut.declined.${DEMO_SANDBOX.id}`, `yes`);
};

/* THE CHATS THIS WINDOW OPENS HOLDING, the featured run, focused, and one chat per persona behind it
 * (fixture/openChats.ts explains the choice of both).
 *
 * Seeded exactly like the credentials above: written where the app already looks, so nothing is faked and no
 * code path is bypassed, `readTabSnapshot` finds a blob and rehydrates three ordinary tabs.
 *
 * Into sessionStorage as well as localStorage, because the window's own store is the authority and the seed is
 * only read by a window that has never held any (windowStore.ts). Writing one and not the other would put the
 * personas on a visitor's first load and never again.
 *
 * Skipped in the emptiest mode, whose whole claim is one agent and nothing else. */
const seedOpenChats = (): void => {
    if (!demoMode.openChats) {
        return;
    }
    const blob = JSON.stringify(openTabSnapshot());
    sessionStorage.setItem(CHAT_TABS_KEY, blob);
    localStorage.setItem(CHAT_TABS_KEY, blob);
};

const SOCKETS: Record<string, typeof terminalSession> = {
    "/system/terminal": terminalSession,
    "/system/browser-view": browserSession,
};

/* WHERE THE RECORDING OPENS. The app's own default lands a desktop on the workspace, which for someone who has
 * just pressed play on a marketing page is the one screen with nothing in it, an empty tree and a drop zone,
 * because the visitor has no files here and never will. The fleet board is what this product is FOR, and it
 * arrives occupied, with as much of the fleet as the demo mode carries (mode.ts).
 *
 * Written into the URL before the app boots rather than routed after it, so there is no first paint of the
 * wrong screen and no entry in history to press Back into. Only the bare base is redirected: every other
 * address, a deep link, a reload, the window the overlay reopens, is a place the visitor chose. */
const openOnFleet = (): void => {
    const base = import.meta.env.BASE_URL;
    if (window.location.pathname === base || window.location.pathname === base.replace(/\/$/, ``)) {
        window.history.replaceState(window.history.state, ``, `${base}agents${window.location.search}${window.location.hash}`);
    }
};

installFetch({ platform, daemon });
installXhr({ platform, daemon });
installWebSocket((url) => SOCKETS[url.pathname]);
seedCredentials();
seedOpenChats();
openOnFleet();
// Before the app, not after it: the switcher is the demo's own chrome, so a cold load carries it from its first
// frame rather than gaining it once the bundle has finished parsing.
installSwitcher();

const served = coverage();
console.info(
    `[demo] ${demoMode.id} — fixture daemon serving ${served.served} routes of the contract's ${served.contract}; anything else answers 404 and logs here.`,
);

await import("@intentic-app/web/main");
