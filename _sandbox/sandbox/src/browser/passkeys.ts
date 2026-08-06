import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";

/* SANDBOX-HELD WEBAUTHN PASSKEYS, over the same CDP window the daemon already has into every browser.
 *
 * The sites the sandbox signs into are moving their second factor from TOTP codes to WebAuthn (npm has already
 * arrived), and a hardware key on the owner's desk can never reach a Chromium running in this container. So the
 * sandbox holds its own: every page of a platform's logged-in browser gets a CDP virtual authenticator — a
 * software security key Chromium itself provides — restored from that platform's credential store. When the
 * owner clicks "Add security key" on a site's 2FA page (in the guided login window), the enrollment lands on
 * the virtual authenticator, the credentialAdded event hands us the credential, and it is persisted; every
 * later ceremony — the owner approving a publish, the agent answering a CLI's web-auth prompt — finds the key
 * already plugged in and answers without any dialog (presence and user-verification are simulated).
 *
 * The store sits beside the platform's Chromium profile and is exactly as sensitive as it: the profile's
 * cookies already ARE the account, so a private key scoped to one site adds risk of the same kind, not a new
 * kind. 0600, on the /work volume (survives rebuilds), deleted with the session (session-store.clearSession).
 *
 * Two honest limits. The authenticator is per-PAGE (the CDP WebAuthn domain is target-scoped), so arming rides
 * the two places every page already passes through — the guided login's context and browser-sessions' observer
 * attach. And on the agent path that observer attaches moments after Chromium comes up, so a ceremony in the
 * first instants of a turn could miss the authenticator; in practice a WebAuthn prompt is pages deep into any
 * flow, far behind the attach. */

// The CDP WebAuthn.Credential shape, held verbatim (plus nothing): what credentialAdded/credentialAsserted
// deliver is exactly what addCredential takes back, so storing anything else would be a translation layer with
// no second reader. Fields are base64 (`privateKey` is the PKCS#8 EC key — see the module comment on secrecy).
export interface PasskeyCredential {
    readonly credentialId: string;
    readonly isResidentCredential: boolean;
    readonly rpId?: string;
    readonly privateKey: string;
    readonly userHandle?: string;
    readonly signCount: number;
    readonly userName?: string;
    readonly userDisplayName?: string;
}

// The most passkey-like authenticator Chromium can simulate: CTAP2, platform-internal, resident keys (so sites
// can discover the credential without asking for an id), user verification that always succeeds, presence that
// never waits for a touch. This is what lets a ceremony complete with nobody at the (virtual) keyboard.
const AUTHENTICATOR = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
} as const;

export const listPasskeys = async (storePath: string): Promise<PasskeyCredential[]> => {
    const raw = await readFile(storePath, "utf8").catch(() => undefined);
    if (raw === undefined) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as { credentials?: PasskeyCredential[] };
        return parsed.credentials ?? [];
    } catch {
        // An unreadable store must not take the browser down — the cost is re-enrolling, which the site's own
        // 2FA page makes visible, versus a platform whose every page fails to arm.
        return [];
    }
};

/* Writes are serialized per store: two pages of one platform each hold an authenticator, and an enrollment on
 * one racing an assertion on the other is two read-modify-write cycles on the same file. */
const writing = new Map<string, Promise<void>>();

const upsertPasskey = async (storePath: string, credential: PasskeyCredential): Promise<void> => {
    const queued = (writing.get(storePath) ?? Promise.resolve()).then(async () => {
        const kept = (await listPasskeys(storePath)).filter((entry) => entry.credentialId !== credential.credentialId);
        await mkdir(dirname(storePath), { recursive: true });
        await writeFile(storePath, JSON.stringify({ credentials: [...kept, credential] }, null, 4), { mode: 0o600 });
    });
    writing.set(
        storePath,
        queued.catch(() => undefined),
    );
    return queued;
};

/* Plug the platform's software key into one page: virtual authenticator up, stored credentials restored onto
 * it, and both ceremony events wired back into the store — an enrollment persists the new credential, an
 * assertion persists its bumped signature counter (some relying parties treat a counter that went backwards as
 * a cloned key). Resolves once armed; callers fire-and-forget it per page and a page that closed mid-arm simply
 * rejects into their catch. */
export const armPasskeys = async (context: BrowserContext, page: Page, storePath: string): Promise<void> => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
    for (const credential of await listPasskeys(storePath)) {
        // One rotten credential (a site's odd userHandle, a truncated key) must not unplug the rest.
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential }).catch(() => undefined);
    }
    cdp.on("WebAuthn.credentialAdded", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
    cdp.on("WebAuthn.credentialAsserted", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
};
