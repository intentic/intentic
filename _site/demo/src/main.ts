// First, before anything that reads storage: the landing page's hero seals its storage here (embed.ts).
import { announceWhenDrawn, embedded } from "./embed";
import { type RawRouteKey, rawRoutePath } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { daemon, sockets } from "./daemon";
import { openTabSnapshot } from "./fixture/openChats";
import { demoMode } from "./mode";
import { demoOutage, withOutage } from "./outage";
import { DEMO_SANDBOX, DEMO_SANDBOXES, DEMO_USER, platform } from "./platform";
import { readsNote, withReads } from "./reads";
import { withFloors } from "./floors";
import { installFetch, installWebSocket, installWebTransport, installXhr } from "./transport";
import { sandboxAddress, sandboxSocket } from "./world/addresses";
import { withWorld } from "./world/fresh";
import { declineLocalShortcut } from "./world/browserSeeds";
import { installIdentity } from "./world/identity";
import { installElementAddresses } from "./world/elements";
import { withPreviewSites } from "./daemon/workspace/previewSites";
import { coverage } from "./unserved";
import { showRailHint } from "./railHint";

// Everything that must be true before the real app's entry runs. Transports and credentials must be in place first,
// hence the dynamic import at the bottom. Credentials are seeded into the real localStorage `sandboxSession` reads,
// never faked or bypassed.

const ACTIVE_SANDBOX_KEY = `intentic.activeSandboxId`;
// Key the app reads to restore a window's open chat tabs (composables/chat/tabSnapshot.ts).
const CHAT_TABS_KEY = `intentic.chatTabs.${DEMO_SANDBOX.id}`;

const seedCredentials = (): void => {
    localStorage.setItem(ACTIVE_SANDBOX_KEY, DEMO_SANDBOX.id);
    for (const sandbox of DEMO_SANDBOXES) {
        localStorage.setItem(`intentic.session.${sandbox.id}`, JSON.stringify({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: DEMO_USER.email }));
        // Declines the local-shortcut offer for every sandbox the rail switches to: no real sandbox here for it to
        // reach faster, and the card would otherwise open on the first switch.
        declineLocalShortcut(sandbox.id);
    }
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

const SOCKETS = new Map(Object.entries(sockets).map(([key, session]) => [rawRoutePath(key as RawRouteKey), session]));

// Redirects the bare base URL to the fleet board (what the app is for) before boot, so there's no wrong first paint or
// Back-able history entry; the landing page's hero opens on the home view its poster shows. Any other address is left alone.
const openOnFleet = (): void => {
    const base = import.meta.env.BASE_URL;
    if (window.location.pathname === base || window.location.pathname === base.replace(/\/$/, ``)) {
        window.history.replaceState(window.history.state, ``, `${base}${embedded ? `home` : `agents`}${window.location.search}${window.location.hash}`);
    }
};

// The outage outside the reads: a sandbox that does not answer has no reads to slow. The tier's floors outside both: a
// refused request is refused before the sandbox is reached, as the daemon's bearer middleware refuses it. The world
// innermost: which sandbox an address is (one the visitor made answers as its own) is the daemon's own knowledge.
// The preview proxy in front of all of it: its hostnames are a started dev server's, not the daemon's API.
const answering = withPreviewSites(withFloors(withOutage(withReads(withWorld(daemon)))));
const handlers = { platform, daemon: answering, sandboxAt: sandboxAddress };
installFetch(handlers);
installXhr(handlers);
installWebSocket((url) => SOCKETS.get(url.pathname), sandboxSocket);
installWebTransport();
// What the editor hands an element rather than fetching (a media source, a download, a preview's frame), answered from the
// same handlers through the demo's element worker (world/elements.ts).
installElementAddresses();
// Google, as the demo's world has it: the visitor is signed in as the demo account (world/identity.ts).
installIdentity();
seedCredentials();
seedOpenChats();
openOnFleet();

if (demoOutage !== undefined) {
    console.info(`[demo] acting out a sandbox outage: ${demoOutage} (?outage=none ends it)`);
}
const reads = readsNote();
if (reads !== undefined) {
    console.info(reads);
}

const served = coverage();
console.info(
    `[demo] ${demoMode.id}: fixture daemon serving ${served.served} of the contract's ${served.contract} routes; anything else answers 404 and logs here, with the reason unserved.ts gives for it.`,
);

announceWhenDrawn();
showRailHint();
await import("@intentic/web/main");
