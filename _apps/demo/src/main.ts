import { coverage, daemon } from "./daemon";
import { DEMO_SANDBOX, DEMO_USER, platform } from "./platform";
import { terminalSession } from "./terminal";
import { installFetch, installWebSocket } from "./transport";

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

installFetch({ platform, daemon });
installWebSocket((url) => (url.pathname === `/system/terminal` ? terminalSession : undefined));
seedCredentials();

const served = coverage();
console.info(`[demo] fixture daemon serving ${served.served} routes of the contract's ${served.contract} — anything else answers 404 and logs here.`);

await import("@intentic-app/web/main");
