import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";

/* SANDBOX-HELD WEBAUTHN PASSKEYS, over the same CDP window the daemon already has into every browser.
 *
 * The sites the sandbox signs into are moving their second factor from TOTP codes to WebAuthn (npm has already
 * arrived), and a hardware key on the owner's desk can never reach a Chromium running in this container. So the
 * sandbox holds its own: every page of a connected account's logged-in browser gets a CDP virtual authenticator,
 * a software security key Chromium itself provides, restored from that ACCOUNT's credential store. When the
 * owner clicks "Add security key" on a site's 2FA page (in the guided login window), the enrollment lands on
 * the virtual authenticator, the credentialAdded event hands us the credential, and it is persisted; every
 * later ceremony, the owner approving a publish, the agent answering a CLI's web-auth prompt, finds the key
 * already plugged in and answers without any dialog (presence and user-verification are simulated).
 *
 * The store sits beside that account's Chromium profile and is exactly as sensitive as it: the profile's
 * cookies already ARE the account, so a private key scoped to one site adds risk of the same kind, not a new
 * kind. Two accounts of one site hold separate stores, as they would separate physical keys. 0600, on the /work
 * volume (survives rebuilds), deleted with the session (session-store.clearSession).
 *
 * Two honest limits. The authenticator is per-PAGE (the CDP WebAuthn domain is target-scoped), so arming rides
 * the two places every page already passes through, the guided login's context and browser-sessions' observer
 * attach. And on the agent path that observer attaches moments after Chromium comes up, so a ceremony in the
 * first instants of a turn could miss the authenticator; in practice a WebAuthn prompt is pages deep into any
 * flow, far behind the attach. */

// The CDP WebAuthn.Credential shape, held verbatim (plus nothing): what credentialAdded/credentialAsserted
// deliver is exactly what addCredential takes back, so storing anything else would be a translation layer with
// no second reader. Fields are base64 (`privateKey` is the PKCS#8 EC key, see the module comment on secrecy).
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
        // An unreadable store must not take the browser down, the cost is re-enrolling, which the site's own
        // 2FA page makes visible, versus a platform whose every page fails to arm.
        return [];
    }
};

/* Writes are serialized per store: two pages of one account each hold an authenticator, and an enrollment on
 * one racing an assertion on the other is two read-modify-write cycles on the same file. */
const writing = new Map<string, Promise<void>>();

/* MERGED ONTO WHAT IS ALREADY STORED, never substituted for it, because a field this file drops is a key that
 * can never be plugged in again. `rpId` is optional to the CDP type and NOT optional to Chromium: addCredential
 * answers a credential without one "The Relying Party ID is a required parameter" and refuses it outright. So a
 * record that loses its rpId cannot be restored onto any later authenticator, every ceremony it should have
 * answered rejects with NotAllowedError, and the relying party renders that as a security-key button that does
 * nothing at all when clicked.
 *
 * That is not a hypothetical: the npmjs account's stored credential was found holding exactly the required
 * fields and none of the optional ones (no rpId, no userHandle, no userName) after five successful assertions,
 * and it had been unusable ever since. What wrote that partial record is not known, and this is the reason not
 * to care: a write that can only ever ADD what it has just learned cannot produce one. */
export const mergePasskey = (existing: PasskeyCredential | undefined, incoming: PasskeyCredential): PasskeyCredential => {
    if (existing === undefined) {
        return incoming;
    }
    // Absent and present-but-undefined are the same fact here, and only the first is what a CDP event actually
    // sends; spreading the raw payload would let the second erase a good field.
    const learned = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
    return { ...existing, ...learned } as PasskeyCredential;
};

const upsertPasskey = async (storePath: string, credential: PasskeyCredential): Promise<void> => {
    const queued = (writing.get(storePath) ?? Promise.resolve()).then(async () => {
        const stored = await listPasskeys(storePath);
        const kept = stored.filter((entry) => entry.credentialId !== credential.credentialId);
        const previous = stored.find((entry) => entry.credentialId === credential.credentialId);
        await mkdir(dirname(storePath), { recursive: true });
        await writeFile(storePath, JSON.stringify({ credentials: [...kept, mergePasskey(previous, credential)] }, null, 4), {
            mode: 0o600,
        });
    });
    writing.set(
        storePath,
        queued.catch(() => undefined),
    );
    return queued;
};

/* THE CDP SESSION IS THE AUTHENTICATOR'S LIFETIME, so it is held rather than dropped on the floor. Chromium
 * destroys a virtual authenticator when the session that created it detaches, and it does that silently: what
 * the page is left with is `isUserVerifyingPlatformAuthenticatorAvailable()` false and every ceremony rejecting
 * NotAllowedError, which is indistinguishable, from the outside, from a button whose click handler is broken.
 * Kept in a WeakMap keyed by the page, so the session stays reachable exactly as long as the page it belongs to
 * and goes away with it.
 *
 * Keying it also makes arming IDEMPOTENT, which it has to be: every caller arms per page, and Chromium refuses
 * a second one with "Chrome only supports one internal authenticator per environment". Under the callers'
 * fire-and-forget catches that refusal was invisible, so a re-arm looked like it had worked. */
interface Arm {
    readonly cdp: CDPSession;
    // The credentials Chromium would not take back. Empty is the only good answer; see armPasskeys.
    readonly refused: readonly string[];
}

const armings = new WeakMap<Page, Promise<Arm>>();

const plugIn = async (context: BrowserContext, page: Page, storePath: string): Promise<Arm> => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
    const refused: string[] = [];
    for (const credential of await listPasskeys(storePath)) {
        // One rotten credential (a truncated key, a record that lost its rpId) must not unplug the rest, so the
        // loop carries on, but it is NOT nothing: it is a key the owner believes is plugged in and is not, and
        // the only symptom downstream is a 2FA prompt that fails for no stated reason. Collected, then raised.
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential }).catch(() => refused.push(credential.credentialId));
    }
    cdp.on("WebAuthn.credentialAdded", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
    cdp.on("WebAuthn.credentialAsserted", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
    return { cdp, refused };
};

/* Plug the platform's software key into one page: virtual authenticator up, stored credentials restored onto
 * it, and both ceremony events wired back into the store, an enrollment persists the new credential, an
 * assertion persists its bumped signature counter (some relying parties treat a counter that went backwards as
 * a cloned key). Resolves once armed; callers fire-and-forget it per page and a page that closed mid-arm simply
 * rejects into their catch.
 *
 * REJECTS WHEN A STORED CREDENTIAL DID NOT GO BACK ON, with the authenticator still up and the credentials that
 * did load still usable. The alternative is what this file used to do, swallow it per credential, and the cost
 * of that was a real afternoon: an account whose key silently never loaded read as a dead button on npm's 2FA
 * page, through a manual takeover, with nothing in any log to say the platform had declined to plug it in. */
export const armPasskeys = async (context: BrowserContext, page: Page, storePath: string): Promise<void> => {
    let arming = armings.get(page);
    if (arming === undefined) {
        arming = plugIn(context, page, storePath);
        armings.set(page, arming);
        // An arm that never got its authenticator up is not remembered as one, or the page could never try
        // again. A credential Chromium refused is different: the authenticator IS up, so that arm stands and
        // only the report below is unhappy.
        arming.catch(() => armings.delete(page));
    }
    const { refused } = await arming;
    if (refused.length > 0) {
        throw new Error(`passkeys Chromium would not restore (a credential with no rpId cannot be): ${refused.join(", ")}`);
    }
};
