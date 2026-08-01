import { browserSession } from "./browser";
import { coverage, daemon } from "./daemon";
import { DEMO_SANDBOX, DEMO_USER, platform } from "./platform";
import { terminalSession } from "./terminal";
import { installFetch, installWebSocket, installXhr } from "./transport";

/* THE DEMO'S BOOT — everything that has to be true before the real app's own entry runs.
 *
 * Order matters exactly once: the transports and the credentials must both be in place before `../main.ts` is
 * imported, because that module creates the app, and the router's first guard fires a platform call. Hence the
 * dynamic import at the bottom rather than a static one at the top.
 *
 * The credentials are seeded rather than faked in code. `sandboxSession` reads a stored session straight from
 * localStorage and returns it when it is still valid, so writing one there is the whole of "sign in": Google
 * Identity Services is never loaded, no exchange is attempted, and not one line of the auth path is bypassed —
 * it simply finds what it is looking for. The e2e tier signs in the same way. */

const ACTIVE_SANDBOX_KEY = `intentic.activeSandboxId`;
const SESSION_KEY = `intentic.session.${DEMO_SANDBOX.id}`;

const seedCredentials = (): void => {
    localStorage.setItem(ACTIVE_SANDBOX_KEY, DEMO_SANDBOX.id);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: DEMO_USER.email }));
};

const SOCKETS: Record<string, typeof terminalSession> = {
    "/system/terminal": terminalSession,
    "/system/browser-view": browserSession,
};

/* WHERE THE RECORDING OPENS. The app's own default lands a desktop on the workspace, which for someone who has
 * just pressed play on a marketing page is the one screen with nothing in it — an empty tree and a drop zone,
 * because the visitor has no files here and never will. The fleet board is what this product is FOR, and it
 * arrives full: seven agents, one in every lane, two of them waiting on a person.
 *
 * Written into the URL before the app boots rather than routed after it, so there is no first paint of the
 * wrong screen and no entry in history to press Back into. Only the bare base is redirected: every other
 * address — a deep link, a reload, the window the overlay reopens — is a place the visitor chose. */
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
openOnFleet();

const served = coverage();
console.info(`[demo] fixture daemon serving ${served.served} routes of the contract's ${served.contract} — anything else answers 404 and logs here.`);

await import("@intentic-app/web/main");
