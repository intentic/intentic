import type { LocalFace } from "@intentic/web/local";
import { accountKey, sandboxKeys, storeValue } from "@intentic/ui/storage";
import { LOCAL_EMAIL, sandboxIdOf } from "./platform";

// The folder's session, written where the editor's sandbox client reads one: its bearer is the window's grant, which the
// sidecar honours for as long as the window shows the folder. Written through the shared storage layer, never the
// browser's own, since the editor keeps a session in the drawer of the account the browser is signed in to (`intentic@<
// account>/intentic.session.<sandbox>`, @intentic/ui/storage). _(2026-11-09) Written straight into localStorage, the
// session sat outside that drawer once the app had a signed-in account: the window never found it, never connected to
// its folder, and showed a document's spinner for good._

// The editor's own keys (its app/storage/browserStorage.ts), scoped as it scopes them.
const ACTIVE_KEY = accountKey(`intentic.activeSandboxId`);
const sessionKey = sandboxKeys(`intentic.session.`);
// A device key in the editor (client/endpoint/localShortcut.ts): the loopback shortcut is for reaching a sandbox faster,
// and the sidecar is already on loopback.
const shortcutDeclinedKey = (sandboxId: string): string => `intentic.localShortcut.declined.${sandboxId}`;

// Long enough never to end while the window shows the folder; the sidecar decides when the grant does.
const SESSION_LIFE_MS = 365 * 86_400_000;

/** Seeds `face`'s session and declines the loopback offer for it; answers the folder's sandbox id. */
export const seedFolderSession = (face: LocalFace, now = Date.now()): string => {
    const id = sandboxIdOf(face);
    storeValue(sessionKey(id), JSON.stringify({ token: face.token, expiresAt: now + SESSION_LIFE_MS, email: LOCAL_EMAIL }));
    storeValue(shortcutDeclinedKey(id), `yes`);
    return id;
};

/** Seeds `face`'s session and makes its folder the sandbox the editor opens on. */
export const seedFolderWindow = (face: LocalFace): void => {
    storeValue(ACTIVE_KEY, seedFolderSession(face));
};
