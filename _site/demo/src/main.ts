import { browserSession } from "./browser";
import { coverage, daemon } from "./daemon";
import { openTabSnapshot } from "./fixture/openChats";
import { demoMode } from "./mode";
import { DEMO_SANDBOX, DEMO_USER, platform } from "./platform";
import { installSwitcher } from "./switcher";
import { terminalSession } from "./terminal";
import { installFetch, installWebSocket, installXhr } from "./transport";

// Everything that must be true before the real app's entry runs. Transports and credentials must be in place first,
// hence the dynamic import at the bottom. Credentials are seeded into the real localStorage `sandboxSession` reads,
// never faked or bypassed.

const ACTIVE_SANDBOX_KEY = `intentic.activeSandboxId`;
const SESSION_KEY = `intentic.session.${DEMO_SANDBOX.id}`;
// Key the app reads to restore a window's open chat tabs (composables/chat/tabSnapshot.ts).
const CHAT_TABS_KEY = `intentic.chatTabs.${DEMO_SANDBOX.id}`;

const seedCredentials = (): void => {
    localStorage.setItem(ACTIVE_SANDBOX_KEY, DEMO_SANDBOX.id);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: DEMO_USER.email }));
    // Declines the local-shortcut offer: no real sandbox here for it to reach faster.
    localStorage.setItem(`intentic.localShortcut.declined.${DEMO_SANDBOX.id}`, `yes`);
};

// Seeds tabs the same way as credentials: writes where the app already looks, in both session and local storage since
// the window store only reads a seed once. Skipped in the emptiest demo mode.
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

// Redirects the bare base URL to the fleet board (what the app is for) before boot, so there's no wrong first paint or
// Back-able history entry. Any other address is left alone.
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
// Before the app: the switcher is demo chrome and must be in the first frame.
installSwitcher();

const served = coverage();
console.info(
    `[demo] ${demoMode.id}: fixture daemon serving ${served.served} routes of the contract's ${served.contract}; anything else answers 404 and logs here.`,
);

await import("@intentic/web/main");
